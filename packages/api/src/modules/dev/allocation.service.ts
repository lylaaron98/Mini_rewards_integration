import { TransactionType } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'

import { InsufficientPointsError, appendEntry, reverseEntry } from '../ledger/ledger.service.js'
import {
  RewardNotFoundError,
  RewardUnavailableError,
  redeem,
} from '../redemption/redemption.service.js'

/**
 * Allocating a reward to users, as an administrator.
 *
 * "Give this person a reward" has to become something the ledger can explain,
 * because the ledger is the only account of why a balance is what it is. A
 * comped reward with no ledger entry would be invisible in the user's own
 * history — they would receive something and see no record of it — and a
 * redemption row recording a price nobody paid is a receipt that lies.
 *
 * So an allocation is two real entries: an ADJUSTMENT credit for the reward's
 * cost, then the ordinary redemption that spends it. The user ends up holding
 * the reward, their balance is unchanged, stock decrements through the same
 * conditional update as any other redemption, and both rows appear in their
 * history saying exactly what happened. Nothing here is special-cased, which is
 * the point: an admin grant goes through the code every other redemption goes
 * through.
 */

export type AllocationOutcome = {
  userId: string
  displayName: string
  status: 'ALLOCATED' | 'FAILED'
  /** Present when the allocation did not complete. Safe to show an operator. */
  reason?: string
}

export type AllocateRewardInput = {
  rewardId: string
  userIds: string[]
  /**
   * One key per allocation attempt, supplied by the caller.
   *
   * Both halves derive their idempotency from it — the credit through the
   * ledger's `(source, externalEventId)` constraint and the redemption through
   * `(userId, idempotencyKey)` — so an administrator who double-clicks, or a
   * browser that retries, allocates once. Generating it here would defeat that
   * entirely, for the same reason the redemption route refuses to mint its own.
   */
  allocationKey: string
}

const ADMIN_SOURCE = 'admin'

/**
 * Allocates one reward to many users.
 *
 * Users are processed one at a time rather than in parallel. Each allocation
 * takes the balance row lock and then the reward's stock row, and running them
 * concurrently would have several transactions contending for the same stock
 * row while each holds a different balance — more lock contention for no gain,
 * since an admin allocating to a handful of people is not a throughput problem.
 *
 * Every user gets an independent outcome. One person failing — out of stock, or
 * a balance so far in debt that the credit does not cover the cost — must not
 * abandon the rest, and an operator needs to know precisely who did not get
 * theirs.
 */
export async function allocateReward(
  client: PrismaClient,
  input: AllocateRewardInput,
): Promise<AllocationOutcome[]> {
  const reward = await client.reward.findUnique({
    where: { id: input.rewardId },
    select: { id: true, name: true, costPoints: true },
  })

  if (!reward) throw new RewardNotFoundError(input.rewardId)

  const users = await client.user.findMany({
    where: { id: { in: input.userIds } },
    select: { id: true, displayName: true },
  })

  const outcomes: AllocationOutcome[] = []

  for (const user of users) {
    // Scoped per user, so allocating to Ada and Grace under one key produces two
    // distinct credits and two distinct redemptions rather than colliding.
    const perUserKey = `${input.allocationKey}:${user.id}`

    /**
     * The credit, in its own transaction so the redemption that follows sees a
     * committed balance to spend.
     *
     * ADJUSTMENT rather than EARN: this did not come from partner activity, and
     * labelling it as though it did would put a fiction in the audit trail. The
     * sign constraint permits either direction for an adjustment precisely
     * because an operator correction can go either way.
     */
    const credit = await client.$transaction((tx) =>
      appendEntry(tx, {
        userId: user.id,
        delta: reward.costPoints,
        type: TransactionType.ADJUSTMENT,
        source: ADMIN_SOURCE,
        externalEventId: perUserKey,
        description: `Allocated by admin: ${reward.name}`,
        metadata: { rewardId: reward.id, allocationKey: input.allocationKey },
      }),
    )

    try {
      const outcome = await redeem(client, {
        userId: user.id,
        rewardId: reward.id,
        idempotencyKey: perUserKey,
      })

      outcomes.push({
        userId: user.id,
        displayName: user.displayName,
        status: outcome.status === 'FAILED' ? 'FAILED' : 'ALLOCATED',
        ...(outcome.status === 'FAILED'
          ? { reason: outcome.failureReason ?? 'Fulfilment failed.' }
          : {}),
      })
    } catch (error) {
      /**
       * The redemption did not happen, so the credit that was meant to pay for
       * it must not stand — otherwise an out-of-stock allocation quietly hands
       * the user free points instead of the reward.
       *
       * `reverseEntry` is idempotent and writes a compensating row rather than
       * deleting the credit, so the history shows the attempt and its reversal
       * instead of pretending neither happened.
       */
      const reason = describeFailure(error)

      await client.$transaction((tx) =>
        reverseEntry(tx, credit.transactionId, `Allocation failed: ${reason}`),
      )

      outcomes.push({
        userId: user.id,
        displayName: user.displayName,
        status: 'FAILED',
        reason,
      })
    }
  }

  return outcomes
}

function describeFailure(error: unknown): string {
  if (error instanceof RewardUnavailableError) return error.message

  /**
   * Reachable, despite the credit being exactly the reward's price: a user whose
   * balance is negative after a clawback may still not afford it. Worth saying
   * plainly rather than reporting as an unexpected error, because the operator's
   * next question is why.
   */
  if (error instanceof InsufficientPointsError) {
    return `Balance is ${error.balance} after the credit, which does not cover ${error.requested}.`
  }

  return error instanceof Error ? error.message : 'Unknown error.'
}
