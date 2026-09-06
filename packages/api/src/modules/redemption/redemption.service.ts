import { randomUUID } from 'node:crypto'

import { TransactionType } from '@prisma/client'
import type { PrismaClient, RedemptionStatus } from '@prisma/client'

import type { Tx } from '../../lib/db.js'
import { appendEntry, lockBalance, reverseEntry } from '../ledger/ledger.service.js'
import { fulfill } from './fulfillment.js'

/**
 * Redemption: the only operation in this system that destroys value.
 *
 * Everything else either creates points from a partner event or reads them. This
 * one takes them away, hands the user something in exchange, and does so across
 * a boundary we do not control. It has to survive being called twice, called
 * concurrently, and called again by a client that timed out and genuinely cannot
 * tell whether the first attempt worked.
 *
 * TWO PHASES, and the split is the whole design.
 *
 * Phase 1 is one transaction: claim the idempotency key, lock the balance, read
 * the reward, take a stock unit, write the redemption as RESERVED, debit the
 * ledger. Everything that must be atomic is in here and nothing else is.
 *
 * Phase 2 is outside any transaction: call fulfilment, then record what
 * happened. Holding a transaction open across a third party's network call
 * would hold the balance row lock for the duration of their latency — so one
 * slow provider stalls every other redemption for that user, and a pile-up
 * spreads from there. Worse, their timeout would roll back a debit for a voucher
 * that may already have been issued: we would have given away the reward and
 * kept the points.
 *
 * The cost of the split is a real state, RESERVED, that a crash can strand. That
 * is why `reservedAt` exists, and why the sweeper is written down as a known gap
 * rather than pretended away.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RewardNotFoundError extends Error {
  readonly code = 'reward_not_found'
  constructor(readonly rewardId: string) {
    super(`No reward with id ${rewardId}.`)
    this.name = 'RewardNotFoundError'
  }
}

export class RewardUnavailableError extends Error {
  constructor(
    readonly code: 'out_of_stock' | 'reward_inactive',
    message: string,
  ) {
    super(message)
    this.name = 'RewardUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RedeemInput = {
  userId: string
  rewardId: string
  idempotencyKey: string
}

export type RedemptionOutcome = {
  redemptionId: string
  status: RedemptionStatus
  rewardName: string
  costPoints: number
  balanceAfter: number
  fulfillmentRef: string | null
  failureReason: string | null
  /** True when this request did no work — an earlier one with the same key did. */
  replay: boolean
}

/**
 * Caps how long any single statement in a redemption transaction may run.
 *
 * Scoped with SET LOCAL so it applies to this transaction and is released with
 * it, rather than being a global setting that quietly changes behaviour for
 * every other query in the pool.
 *
 * It exists because of the blocking replay path below: a second request with the
 * same key waits on a row lock held by the first. That wait is normally
 * milliseconds. If the first request is genuinely stuck, this turns an
 * indefinite hang into a loud error — every retry queueing forever behind one
 * wedged transaction is a much worse failure than one 500.
 */
const REDEMPTION_STATEMENT_TIMEOUT = '10s'

// ---------------------------------------------------------------------------
// Phase 1
// ---------------------------------------------------------------------------

type ReservationRow = {
  id: string
  status: RedemptionStatus
  cost_points_snapshot: number
  reward_name_snapshot: string
  fulfillment_ref: string | null
  failure_reason: string | null
}

/**
 * Claims the idempotency key by inserting the redemption row.
 *
 * The claim IS the redemption row, because the unique constraint that enforces
 * idempotency lives on it — which is why the reward has to be read just before
 * this rather than just after: the row cannot be written without its snapshots.
 * A read touches nothing valuable, so nothing is at risk in that ordering.
 *
 * Returns the row it inserted, or the existing row if someone else got there
 * first.
 */
async function claimIdempotencyKey(
  tx: Tx,
  input: RedeemInput,
  reward: { id: string; name: string; costPoints: number },
): Promise<{ claimed: true; row: ReservationRow } | { claimed: false; row: ReservationRow }> {
  const insert = async (): Promise<ReservationRow | undefined> => {
    const rows = await tx.$queryRaw<ReservationRow[]>`
      INSERT INTO redemptions (
        id, user_id, reward_id, status,
        cost_points_snapshot, reward_name_snapshot, idempotency_key,
        reserved_at, created_at
      )
      VALUES (
        ${randomUUID()}, ${input.userId}, ${reward.id}, 'RESERVED',
        ${reward.costPoints}, ${reward.name}, ${input.idempotencyKey},
        now(), now()
      )
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
      RETURNING id, status, cost_points_snapshot, reward_name_snapshot,
                fulfillment_ref, failure_reason
    `
    return rows[0]
  }

  const inserted = await insert()
  if (inserted) return { claimed: true, row: inserted }

  /**
   * Someone else holds this key. Wait for them rather than refusing.
   *
   * The realistic cause is a double-clicked button, where the second request is
   * milliseconds behind the first — so the wait is short and resolves cleanly.
   * Answering 409 would push a retry loop onto the client for a race the server
   * can settle itself, and the client would have no way to tell that race apart
   * from a genuine failure.
   *
   * `SELECT ... FOR UPDATE` blocks until the holder's transaction ends. It also
   * serialises this read against phase 2 updating the same row, so a replay
   * cannot observe a half-written state.
   */
  const waited = await tx.$queryRaw<ReservationRow[]>`
    SELECT id, status, cost_points_snapshot, reward_name_snapshot,
           fulfillment_ref, failure_reason
    FROM redemptions
    WHERE user_id = ${input.userId} AND idempotency_key = ${input.idempotencyKey}
    FOR UPDATE
  `

  const existing = waited[0]
  if (existing) return { claimed: false, row: existing }

  /**
   * Zero rows after a conflict means the holder ROLLED BACK. Their row only ever
   * existed inside a transaction that aborted, so in committed state it never
   * existed at all — and our conflict was with a tuple that is now gone.
   *
   * (ON CONFLICT DO NOTHING already waits for an in-flight conflicting insert
   * and would have inserted had the holder aborted before we reached it, so this
   * window is narrow. It is not empty, and the failure mode if unhandled is an
   * undefined row dereferenced under load — a mysterious null in production
   * that no test would reproduce.)
   *
   * Re-attempt the claim exactly once. Bounded, never a loop: if a single retry
   * does not settle it, something is wrong in a way that retrying will not fix,
   * and spinning would turn a bug into an outage.
   */
  const retried = await insert()
  if (retried) return { claimed: true, row: retried }

  const afterRetry = await tx.$queryRaw<ReservationRow[]>`
    SELECT id, status, cost_points_snapshot, reward_name_snapshot,
           fulfillment_ref, failure_reason
    FROM redemptions
    WHERE user_id = ${input.userId} AND idempotency_key = ${input.idempotencyKey}
    FOR UPDATE
  `

  const settled = afterRetry[0]
  if (settled) return { claimed: false, row: settled }

  throw new Error(
    `Idempotency key ${input.idempotencyKey} could not be claimed or read after one retry.`,
  )
}

type ReserveResult =
  | { replay: true; outcome: RedemptionOutcome }
  | {
      replay: false
      redemptionId: string
      ledgerEntryId: string
      rewardId: string
      rewardSku: string
      rewardName: string
      costPoints: number
      balanceAfter: number
    }

/**
 * Phase 1, in the caller's transaction. Takes the points and holds the stock.
 */
async function reserve(tx: Tx, input: RedeemInput): Promise<ReserveResult> {
  await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${REDEMPTION_STATEMENT_TIMEOUT}'`)

  /**
   * A replay wins over everything, including the catalogue.
   *
   * This lookup comes before the reward is read or validated, and the ordering
   * is load-bearing. Validating the reward first makes the replay path
   * unreachable whenever the reward has been deactivated or removed since the
   * original request — so a client retrying a request that already succeeded is
   * told 409, having already been charged. The client that retries is precisely
   * the client whose first attempt timed out, so it cannot know it succeeded and
   * has no way to discover it.
   *
   * Read-only, so it claims nothing and touches nothing valuable. The
   * authoritative claim is still the INSERT ... ON CONFLICT below, which is what
   * settles a genuine race; this is the fast path for a request whose work is
   * already done.
   */
  const prior = await findRedemptionByKey(tx, input)
  if (prior) {
    return {
      replay: true,
      outcome: await toReplayOutcome(tx, input.userId, prior),
    }
  }

  /**
   * Read the reward INSIDE the transaction.
   *
   * A price read before the transaction could be stale by the time the debit
   * runs — the catalogue could be repriced in between — and the user would be
   * charged an amount that never matched what they were shown or what the
   * receipt records. Reading here means the price that is snapshotted, the price
   * that is debited and the price that is displayed are the same number, read
   * once.
   */
  const reward = await tx.reward.findUnique({
    where: { id: input.rewardId },
    select: { id: true, sku: true, name: true, costPoints: true, stock: true, active: true },
  })

  if (!reward) throw new RewardNotFoundError(input.rewardId)

  if (!reward.active) {
    throw new RewardUnavailableError('reward_inactive', `${reward.name} is no longer available.`)
  }

  const claim = await claimIdempotencyKey(tx, input, reward)

  if (!claim.claimed) {
    // Lost the race to a concurrent request with the same key. Same answer as
    // the fast path above, reached by blocking on the holder rather than by
    // finding committed work.
    return { replay: true, outcome: await toReplayOutcome(tx, input.userId, claim.row) }
  }

  /**
   * LOCK ORDERING: balance before rewards. See ledger.service.ts.
   *
   * This call looks redundant — `appendEntry` takes the same lock a few lines
   * below — and it is not. Without it the locks would be taken in the order
   * (reward stock, then balance), because the stock decrement comes first, while
   * every other flow in the system takes the balance first. Two orderings across
   * two resources is exactly the shape that deadlocks under load, and it would
   * never show up in a test that runs one redemption at a time.
   */
  await lockBalance(tx, input.userId)

  /**
   * The UPDATE *is* the concurrency check.
   *
   * `WHERE stock > 0` and the affected-row count together make overselling
   * impossible: there is no window between reading the count and decrementing
   * it, because there is no read. Checking `stock > 0` first and then
   * decrementing would be the classic race, and with the last unit of a popular
   * reward it is not a rare one.
   *
   * A null stock means unlimited and is skipped entirely — decrementing it would
   * turn "unlimited" into a number.
   */
  if (reward.stock !== null) {
    const decremented = await tx.$executeRaw`
      UPDATE rewards SET stock = stock - 1 WHERE id = ${reward.id} AND stock > 0
    `

    if (decremented === 0) {
      throw new RewardUnavailableError('out_of_stock', `${reward.name} is out of stock.`)
    }
  }

  /**
   * The debit. Throws InsufficientPointsError if the balance will not cover it,
   * which rolls the whole transaction back — including the stock unit taken
   * above, so a refused redemption never quietly consumes inventory.
   */
  const entry = await appendEntry(tx, {
    userId: input.userId,
    delta: -reward.costPoints,
    type: TransactionType.REDEEM,
    source: 'redemption',
    redemptionId: claim.row.id,
    description: `Redeemed ${reward.name}`,
  })

  return {
    replay: false,
    redemptionId: claim.row.id,
    ledgerEntryId: entry.transactionId,
    rewardId: reward.id,
    rewardSku: reward.sku,
    rewardName: reward.name,
    costPoints: reward.costPoints,
    balanceAfter: entry.balanceAfter,
  }
}

/** The committed redemption for this key, if the work has already been done. */
async function findRedemptionByKey(tx: Tx, input: RedeemInput): Promise<ReservationRow | undefined> {
  const rows = await tx.$queryRaw<ReservationRow[]>`
    SELECT id, status, cost_points_snapshot, reward_name_snapshot,
           fulfillment_ref, failure_reason
    FROM redemptions
    WHERE user_id = ${input.userId} AND idempotency_key = ${input.idempotencyKey}
  `
  return rows[0]
}

/**
 * The body a replay answers with: the redemption's CURRENT state.
 *
 * That may be RESERVED, because the claim commits with phase 1 while fulfilment
 * is still running. Two identical requests can therefore return different bodies
 * — the first eventually says FULFILLED, the second may say RESERVED — and that
 * is correct rather than a race: each reports the truth at the moment it
 * answered. Reporting a guessed final state instead would be the actual bug.
 */
async function toReplayOutcome(
  tx: Tx,
  userId: string,
  row: ReservationRow,
): Promise<RedemptionOutcome> {
  return {
    redemptionId: row.id,
    status: row.status,
    rewardName: row.reward_name_snapshot,
    costPoints: row.cost_points_snapshot,
    balanceAfter: await currentBalance(tx, userId),
    fulfillmentRef: row.fulfillment_ref,
    failureReason: row.failure_reason,
    replay: true,
  }
}

async function currentBalance(tx: Tx, userId: string): Promise<number> {
  const row = await tx.userBalance.findUnique({ where: { userId }, select: { balance: true } })
  return row?.balance ?? 0
}

// ---------------------------------------------------------------------------
// Phase 2
// ---------------------------------------------------------------------------

/**
 * Compensates a reservation whose fulfilment failed.
 *
 * Idempotent through a conditional status transition, the same shape as the
 * stock decrement and the backfill claim: only the caller that moves the row out
 * of RESERVED does the compensating work. Without that guard a retried failure
 * handler would refund twice and return two stock units for one reservation.
 * (`reverseEntry` is independently idempotent, so the ledger is safe either way
 * — the guard is what protects the stock.)
 *
 * Order inside the transaction is balance before rewards, per the invariant:
 * `reverseEntry` takes the balance lock, and the stock increment follows.
 */
async function compensate(
  tx: Tx,
  reservation: { redemptionId: string; ledgerEntryId: string; rewardId: string },
  reason: string,
): Promise<void> {
  await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${REDEMPTION_STATEMENT_TIMEOUT}'`)

  const claimed = await tx.$executeRaw`
    UPDATE redemptions
    SET status = 'FAILED', failure_reason = ${reason}
    WHERE id = ${reservation.redemptionId} AND status = 'RESERVED'
  `

  if (claimed === 0) return

  await reverseEntry(tx, reservation.ledgerEntryId, reason)

  // Only for limited rewards. Incrementing an unlimited one would invent stock
  // out of nothing, since it was never decremented.
  await tx.$executeRaw`
    UPDATE rewards SET stock = stock + 1 WHERE id = ${reservation.rewardId} AND stock IS NOT NULL
  `
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * The whole redemption, both phases.
 *
 * Takes a `PrismaClient` rather than a `Tx`, and it is the one service function
 * in the codebase that does. Every other service accepts an open transaction
 * because the caller owns the boundary — but a two-phase operation has no single
 * boundary to hand it. There are two, with a third party's network call in
 * between, and only this function is in a position to know where each one ends.
 *
 * The tx-first convention still holds underneath: `reserve` and `compensate`
 * both take `tx` and neither opens a transaction. This function owns the
 * boundaries and does nothing else with the database.
 */
export async function redeem(client: PrismaClient, input: RedeemInput): Promise<RedemptionOutcome> {
  const reservation = await client.$transaction((tx) => reserve(tx, input), {
    /**
     * Longer than REDEMPTION_STATEMENT_TIMEOUT, on purpose.
     *
     * Prisma's default interactive-transaction timeout is 5 seconds — shorter
     * than the 10-second statement timeout this code sets — so without this the
     * documented bound could never fire. A blocked replay would be killed by
     * Prisma with an opaque P2028 at 5s instead of by Postgres with the
     * statement timeout it was given, and the comment explaining the 10 seconds
     * would be describing something that never happens.
     *
     * `maxWait` is how long to wait for a connection from the pool before even
     * starting, which under a burst of concurrent redemptions is a real wait.
     */
    timeout: 15_000,
    maxWait: 10_000,
  })

  if (reservation.replay) return reservation.outcome

  // --- Phase 2, deliberately outside any transaction ------------------------

  const result = await fulfill({
    redemptionId: reservation.redemptionId,
    rewardSku: reservation.rewardSku,
    userExternalRef: input.userId,
  })

  const shared = {
    redemptionId: reservation.redemptionId,
    rewardName: reservation.rewardName,
    costPoints: reservation.costPoints,
    replay: false,
  }

  if (result.ok) {
    await client.redemption.update({
      where: { id: reservation.redemptionId },
      data: { status: 'FULFILLED', fulfillmentRef: result.reference, fulfilledAt: new Date() },
    })

    return {
      ...shared,
      status: 'FULFILLED',
      balanceAfter: reservation.balanceAfter,
      fulfillmentRef: result.reference,
      failureReason: null,
    }
  }

  await client.$transaction((tx) => compensate(tx, reservation, result.reason))

  return {
    ...shared,
    status: 'FAILED',
    // The reversal put the points back, so the balance returns to what it was
    // before the debit. Read rather than reconstructed, because anything else
    // that moved in between belongs in this number too.
    balanceAfter: await currentBalance(client, input.userId),
    fulfillmentRef: null,
    failureReason: result.reason,
  }
}
