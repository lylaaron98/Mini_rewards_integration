import { randomUUID } from 'node:crypto'

import { TransactionType } from '@prisma/client'
import type { Prisma } from '@prisma/client'

import type { Tx } from '../../lib/db.js'

/**
 * The ledger.
 *
 * This file is the ONLY place in the codebase permitted to write
 * `point_transactions` or `user_balances`. Redemption, the webhook and any
 * future backfill reach points through `appendEntry` rather than touching the
 * tables. That is what lets module isolation and atomicity hold at the same
 * time: the caller opens one transaction and threads it through here, so a
 * redemption's debit, its ledger row and its stock decrement commit together
 * while redemption still knows nothing about how the ledger is stored.
 *
 * Nothing in this file opens a transaction. Every function takes `tx` first.
 *
 * ===========================================================================
 * LOCK ORDERING INVARIANT — balance first, then rewards. Always.
 * ===========================================================================
 *
 * Any flow that touches both a user's balance and a reward's stock must take
 * them in that order. Redemption does: it calls `lockBalance` before it
 * conditionally decrements stock.
 *
 * The failure this prevents is neither hypothetical nor gradual. Two flows
 * taking the same two rows in opposite orders deadlock as soon as they overlap
 * — one holds the balance and wants the reward, the other holds the reward and
 * wants the balance, and Postgres kills one of them. Under light load it never
 * happens; under real load it happens constantly. The mistake cannot be seen by
 * reading either flow on its own, only by comparing them, which is why the rule
 * is written down here in the file they both call.
 */

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A debit that would take a balance below zero.
 *
 * Typed rather than a generic Error so routes can map it to a status code
 * without string-matching a message. It carries the numbers because "you need
 * 750 and have 355" is the only version of this message a user can act on.
 *
 * Thrown as a JavaScript error before any failing statement reaches the
 * database, so the surrounding transaction is still healthy when it propagates.
 * A caller may catch it and keep using the same `tx` — unlike a constraint
 * violation, which would leave the transaction aborted.
 */
export class InsufficientPointsError extends Error {
  readonly code = 'insufficient_points'

  constructor(
    readonly userId: string,
    readonly balance: number,
    readonly requested: number,
  ) {
    super(`User ${userId} has ${balance} points but ${requested} are required.`)
    this.name = 'InsufficientPointsError'
  }
}

/** A reversal was requested for a ledger entry that does not exist. */
export class LedgerEntryNotFoundError extends Error {
  readonly code = 'ledger_entry_not_found'

  constructor(readonly transactionId: string) {
    super(`Ledger entry ${transactionId} does not exist.`)
    this.name = 'LedgerEntryNotFoundError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppendEntryInput = {
  userId: string
  /** Signed. Positive credits, negative debits. Never zero. */
  delta: number
  type: TransactionType
  /** "partner:acme" for webhook credits, "redemption" for spends, and so on. */
  source: string
  /**
   * The partner's event id, or any other caller-supplied key that makes this
   * entry idempotent. Null for entries with no natural key — Postgres treats
   * NULLs as distinct, so those always insert.
   */
  externalEventId?: string | null
  redemptionId?: string | null
  ruleId?: string | null
  reversesId?: string | null
  description: string
  metadata?: Prisma.InputJsonObject
  /**
   * Whether to refuse a debit that would take the balance below zero.
   *
   * Defaults to true, which is right for every ordinary spend. `reverseEntry`
   * passes false: clawing back a credit that should never have been granted has
   * to land even when the user has already spent it. An honest negative balance
   * is recoverable — the user earns their way out of it and the ledger explains
   * exactly why. A wrongly positive one is not: it is indistinguishable from
   * points that were legitimately earned, so it stays wrong forever.
   *
   * There is no longer a database-level floor underneath this — the
   * `CHECK (balance >= 0)` that used to sit here was dropped, because a
   * row-level constraint sees a number and cannot tell a spend from a
   * correction, so it blocked clawbacks too. This check is now the only thing
   * preventing an overdrawn spend. It is race-free because it runs while the
   * caller holds the balance row lock taken by `lockBalance`; nothing can slip
   * between the read and the write.
   */
  enforceNonNegative?: boolean
  /**
   * When this entry should be dated. Defaults to now.
   *
   * Supplied only when reconstructing history that already happened — the
   * development seed backdates entries so the transaction list looks like
   * months of activity rather than a single afternoon. Ordinary callers must
   * leave it unset: a credit is dated when it is credited, and letting a
   * partner choose the timestamp on a ledger row would put an untrusted value
   * on the audit trail.
   */
  createdAt?: Date
}

export type AppendEntryResult = {
  transactionId: string
  balanceAfter: number
  /**
   * True when this exact (source, externalEventId) had already been credited.
   * The call was a no-op: no new row, no balance movement, and `transactionId`
   * points at the original entry.
   */
  duplicate: boolean
}

export type ReverseEntryResult = AppendEntryResult & {
  /** False when the entry had already been reversed by an earlier call. */
  reversed: boolean
}

export type BalanceDiscrepancy = {
  userId: string
  displayName: string
  cachedBalance: number
  ledgerBalance: number
  difference: number
}

/** Source recorded on reversal entries. See `reverseEntry`. */
export const REVERSAL_SOURCE = 'reversal'

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/**
 * Takes the row lock on a user's balance and returns its current value.
 *
 * MATERIALISE, THEN LOCK. The insert is not an optimisation — it is what makes
 * the lock work at all.
 *
 * `SELECT ... FOR UPDATE` locks rows that exist. A user who has never earned
 * anything has no balance row, so `FOR UPDATE` matches nothing and locks
 * nothing. Two concurrent first-ever credits would both find no row, both
 * decide to create one, and one would either lose its update or fail on the
 * primary key. The bug appears only for brand-new users, which is exactly the
 * population least likely to be load-tested.
 *
 * Inserting zero first guarantees there is a row to lock. `ON CONFLICT DO
 * NOTHING` makes that insert safe to race: the loser raises no error, so the
 * transaction stays healthy and both callers go on to the lock.
 *
 * Zero specifically, never the delta — and the reason generalises beyond this
 * table. Postgres validates CHECK constraints against the tuple an INSERT
 * proposes *before* it detects the conflict that would divert it to the update
 * path. An upsert of the form `INSERT ... VALUES (delta) ON CONFLICT DO UPDATE
 * SET x = x + delta` is therefore rejected by any CHECK on that column whenever
 * the *proposed* value violates it, even though the row already exists and only
 * the update would ever have run. The error names a row that was never going to
 * be written, which makes it a genuinely confusing thing to debug. Materialise
 * at a value the constraint accepts, then move it. `rewards.stock` still carries
 * such a constraint, so the same care applies there.
 */
export async function lockBalance(tx: Tx, userId: string): Promise<number> {
  await tx.$executeRaw`
    INSERT INTO user_balances (user_id, balance, updated_at)
    VALUES (${userId}, 0, now())
    ON CONFLICT (user_id) DO NOTHING
  `

  const rows = await tx.$queryRaw<Array<{ balance: number }>>`
    SELECT balance FROM user_balances WHERE user_id = ${userId} FOR UPDATE
  `

  const row = rows[0]
  if (!row) {
    // Unreachable: the insert above guarantees the row exists, and we are in a
    // transaction so nothing can delete it underneath us. Checked anyway,
    // because the alternative is a silent undefined becoming NaN in a balance.
    throw new Error(`Balance row for user ${userId} vanished after materialising it.`)
  }

  return row.balance
}

// ---------------------------------------------------------------------------
// Appending
// ---------------------------------------------------------------------------

/**
 * Writes one ledger entry and moves the cached balance with it, inside the
 * caller's transaction. The only way points ever change.
 *
 * MUST be called inside a transaction. `Tx` is structurally satisfied by
 * `PrismaClient`, so nothing stops a caller passing `prisma` directly — that is
 * deliberate for read-only paths, and wrong here. Between the ledger insert and
 * the balance update this function is briefly inconsistent, and only the
 * caller's transaction makes that invisible.
 *
 * ORDER OF OPERATIONS: lock, then claim, then check, then move.
 *
 * The balance lock is taken first, before anything else is read or written, for
 * two reasons.
 *
 * It makes the lock ordering invariant at the top of this file total rather
 * than partial: the balance is the first lock *any* flow acquires, so there is
 * no ordering to compare between flows and therefore no cycle to deadlock on.
 * Claiming the ledger row first would mean appendEntry takes a unique-index
 * lock before the balance while redemption takes the balance before rewards,
 * and mixed orderings across resources are exactly where deadlocks come from.
 *
 * And the insufficient-funds check must come after the duplicate check, not
 * before. A retried redemption is the case that proves it: the user redeemed
 * 250 from a balance of 300, so a retry arrives when only 50 remain. Checking
 * affordability first would reject that retry with InsufficientPointsError when
 * the correct answer is `duplicate: true` and no movement at all. Holding the
 * lock across both means the balance cannot change between them.
 *
 * The cost is that a duplicate briefly takes a lock it does not need. That is
 * cheap, and it buys an ordering rule with no exceptions.
 */
export async function appendEntry(tx: Tx, input: AppendEntryInput): Promise<AppendEntryResult> {
  const enforceNonNegative = input.enforceNonNegative ?? true
  const transactionId = randomUUID()
  const metadata = input.metadata === undefined ? null : JSON.stringify(input.metadata)

  // Lock, then read. Reading first and locking second is the classic lost
  // update: two debits both read 500, both conclude 500 - 250 is affordable,
  // and the second write silently overwrites the first. Read Committed does not
  // prevent that on its own.
  const balanceBefore = await lockBalance(tx, input.userId)

  /**
   * Claim the entry.
   *
   * `ON CONFLICT DO NOTHING RETURNING` rather than catching a unique violation.
   * In Postgres *any* statement error aborts the surrounding transaction, so
   * catching a P2002 here and then querying for the original entry would fail
   * with "current transaction is aborted" — the recovery path would be broken
   * in precisely the situation it exists for. ON CONFLICT raises nothing, so
   * there is no aborted-transaction recovery to get wrong.
   *
   * Raw SQL because Prisma's `create` has no ON CONFLICT.
   *
   * When `external_event_id` is NULL the unique index does not conflict —
   * Postgres does not consider two NULLs equal — so entries with no natural
   * key, such as spends, always insert.
   */
  const claimed = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO point_transactions (
      id, user_id, delta, type, source, external_event_id,
      redemption_id, rule_id, reverses_id, description, metadata, created_at
    )
    VALUES (
      ${transactionId},
      ${input.userId},
      ${input.delta},
      CAST(${input.type} AS "TransactionType"),
      ${input.source},
      ${input.externalEventId ?? null},
      ${input.redemptionId ?? null},
      ${input.ruleId ?? null},
      ${input.reversesId ?? null},
      ${input.description},
      CAST(${metadata} AS jsonb),
      ${input.createdAt ?? new Date()}
    )
    ON CONFLICT (source, external_event_id) DO NOTHING
    RETURNING id
  `

  const inserted = claimed[0]

  if (!inserted) {
    /**
     * Already credited. Return the original entry and move nothing.
     *
     * Safe against a concurrent first writer because of how ON CONFLICT DO
     * NOTHING behaves: meeting a conflicting row that is still uncommitted, it
     * waits for that transaction to finish rather than skipping ahead. By the
     * time control reaches here the winning row is committed, and under READ
     * COMMITTED — Prisma's default — this statement takes a fresh snapshot and
     * sees it. Under REPEATABLE READ it would not, and this would find nothing.
     *
     * `balanceAfter` is the balance we already hold the lock on, so it is
     * current by construction rather than by a second read that could race.
     * Note this is the balance *now*, not the balance immediately after the
     * original entry, which is recorded nowhere — and for a retry, now is the
     * more useful number: it is what the caller would read next.
     */
    const original = await tx.pointTransaction.findFirst({
      where: { source: input.source, externalEventId: input.externalEventId ?? null },
      select: { id: true },
    })

    if (!original) {
      throw new Error(
        `Insert for (${input.source}, ${String(input.externalEventId)}) conflicted but no ` +
          `existing entry was found. This should be impossible under READ COMMITTED.`,
      )
    }

    return { transactionId: original.id, balanceAfter: balanceBefore, duplicate: true }
  }

  const balanceAfter = balanceBefore + input.delta

  /**
   * Refuses a DEBIT that overdraws — never a credit.
   *
   * The `input.delta < 0` half is load-bearing and its absence was a real bug.
   * Testing only whether the *result* is negative also rejects credits once the
   * balance is already below zero, which strands a clawed-back user
   * permanently: every subsequent partner event is refused and the webhook
   * answers 500 forever. That directly contradicts the reason negative balances
   * are allowed at all — the user is supposed to be able to earn their way out
   * of the hole, and the ledger explains why they are in it.
   *
   * A credit is never a reason to refuse. It can only ever move the balance
   * toward zero.
   */
  if (enforceNonNegative && input.delta < 0 && balanceAfter < 0) {
    throw new InsufficientPointsError(input.userId, balanceBefore, Math.abs(input.delta))
  }

  // Writes the value just validated rather than an increment. We hold the row
  // lock, so the two are equivalent — but writing the checked number means the
  // value asserted about and the value stored cannot drift apart.
  await tx.$executeRaw`
    UPDATE user_balances
    SET balance = ${balanceAfter}, updated_at = now()
    WHERE user_id = ${input.userId}
  `

  return { transactionId: inserted.id, balanceAfter, duplicate: false }
}

// ---------------------------------------------------------------------------
// Reversing
// ---------------------------------------------------------------------------

/**
 * Undoes an earlier entry by writing a new one that mirrors it.
 *
 * Never an update, never a delete. The ledger records what happened, and a
 * failed fulfilment is something that happened. Editing the original debit away
 * would leave a balance nobody can explain from the rows.
 *
 * IDEMPOTENT, by the same mechanism as everything else rather than a special
 * one: the reversal is keyed on (source, externalEventId) = ('reversal',
 * originalId), so the ledger's own unique constraint makes a second call a
 * no-op. A retried failure handler cannot refund twice. The unique index on
 * `reverses_id` is a second, independent guard on the same property.
 */
export async function reverseEntry(
  tx: Tx,
  originalId: string,
  reason: string,
): Promise<ReverseEntryResult> {
  const original = await tx.pointTransaction.findUnique({
    where: { id: originalId },
    select: { id: true, userId: true, delta: true, redemptionId: true },
  })

  if (!original) {
    throw new LedgerEntryNotFoundError(originalId)
  }

  const result = await appendEntry(tx, {
    userId: original.userId,
    // Mirrors whatever it undoes, which is why the sign constraint lets
    // REVERSAL go either way: reversing a spend credits, reversing a credit
    // debits.
    delta: -original.delta,
    type: TransactionType.REVERSAL,
    source: REVERSAL_SOURCE,
    externalEventId: originalId,
    reversesId: originalId,
    redemptionId: original.redemptionId,
    description: `Reversal: ${reason}`,
    metadata: { reversedTransactionId: originalId, reason },
    // See AppendEntryInput. A clawback has to land even when the user has
    // already spent the points it is taking back.
    enforceNonNegative: false,
  })

  return { ...result, reversed: !result.duplicate }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Every user whose cached balance disagrees with the sum of their ledger.
 *
 * An empty array means healthy. This is what makes "balances are a cache" an
 * auditable claim rather than a comment: a cache that cannot be compared
 * against its source of truth is just a second source of truth that nobody has
 * noticed diverging yet.
 *
 * Users with neither ledger entries nor a balance row are consistent at zero
 * and are not reported.
 *
 * SUM() returns bigint in Postgres, which Prisma surfaces as a JavaScript
 * BigInt: it would not compare with `!==` against a number and would throw on
 * JSON serialisation. Cast to int here, where the value is a point balance and
 * cannot overflow, rather than making every caller deal with it.
 */
export async function reconcile(tx: Tx): Promise<BalanceDiscrepancy[]> {
  return tx.$queryRaw<BalanceDiscrepancy[]>`
    SELECT
      u.id                            AS "userId",
      u.display_name                  AS "displayName",
      COALESCE(b.balance, 0)::int     AS "cachedBalance",
      COALESCE(SUM(t.delta), 0)::int  AS "ledgerBalance",
      (COALESCE(b.balance, 0) - COALESCE(SUM(t.delta), 0))::int AS "difference"
    FROM users u
    LEFT JOIN user_balances b ON b.user_id = u.id
    LEFT JOIN point_transactions t ON t.user_id = u.id
    GROUP BY u.id, u.display_name, b.balance
    HAVING COALESCE(b.balance, 0) <> COALESCE(SUM(t.delta), 0)
    ORDER BY u.display_name
  `
}
