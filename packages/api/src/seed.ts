import { TransactionType } from '@prisma/client'
import type { Prisma } from '@prisma/client'

import { prisma } from './lib/db.js'
import type { Tx } from './lib/db.js'
import {
  LEDGER_SOURCE,
  PARTNER,
  SEED_EARNING_RULES,
  SEED_HISTORY,
  SEED_ORPHAN_DELIVERIES,
  SEED_REWARDS,
  SEED_USERS,
} from './seed-data.js'

/**
 * Loads the development dataset.
 *
 * Destructive and deliberately so: it clears every table first, because a seed
 * that merges into whatever is already there produces a different database
 * depending on how many times it has been run, and "works on my machine" starts
 * exactly there. Re-running this always produces the same state.
 *
 * The whole load runs in one transaction. A half-seeded database is worse than
 * an empty one — it looks usable right up until the missing half matters.
 */

/**
 * Writes one ledger entry and moves the cached balance with it.
 *
 * This mirrors what `ledger.appendEntry` will do in Phase 2, and it exists
 * mostly so the seed exercises the same invariant the application will: the
 * balance is written in the same transaction as the row that changes it, and
 * `CHECK (balance >= 0)` is therefore evaluated at every intermediate step
 * rather than only against the final total. Seeding a history that dips
 * negative in the middle fails here rather than passing quietly.
 *
 * Phase 2 replaces this with a call to the real ledger service.
 */
async function appendSeedEntry(
  tx: Tx,
  entry: {
    userId: string
    delta: number
    type: TransactionType
    description: string
    createdAt: Date
    externalEventId?: string
    redemptionId?: string
    ruleId?: string
    reversesId?: string
    // Prisma's own JSON input type rather than Record<string, unknown>: the
    // latter permits values Postgres cannot store, and the mismatch would
    // surface at runtime instead of here.
    metadata?: Prisma.InputJsonObject
  },
): Promise<{ id: string }> {
  const created = await tx.pointTransaction.create({
    data: {
      userId: entry.userId,
      delta: entry.delta,
      type: entry.type,
      source: entry.type === TransactionType.EARN ? LEDGER_SOURCE : 'system',
      externalEventId: entry.externalEventId ?? null,
      redemptionId: entry.redemptionId ?? null,
      ruleId: entry.ruleId ?? null,
      reversesId: entry.reversesId ?? null,
      description: entry.description,
      metadata: entry.metadata ?? undefined,
      createdAt: entry.createdAt,
    },
    select: { id: true },
  })

  // Materialise the row at zero, then move it. Two statements rather than one
  // upsert carrying the delta, for a reason that is not obvious:
  //
  // PostgreSQL evaluates CHECK constraints against the tuple an INSERT proposes
  // *before* it detects the unique-key conflict that would divert it to the
  // update path. So `create: { balance: -250 }` is rejected by
  // CHECK (balance >= 0) even when the row already exists and only the
  // increment would ever have run. The first debit against an existing balance
  // fails with a constraint error describing a row that was never going to be
  // written.
  //
  // Inserting zero always satisfies the constraint, and the increment that
  // follows is checked against the real resulting value. This is the same
  // pattern the ledger service uses, where it is needed for a second reason as
  // well: FOR UPDATE locks nothing when the row does not yet exist, so the row
  // has to be made to exist before it can be locked.
  await tx.userBalance.upsert({
    where: { userId: entry.userId },
    create: { userId: entry.userId, balance: 0 },
    update: {},
  })

  // `increment` keeps the arithmetic in the database rather than
  // read-modify-writing a value another writer could have changed underneath.
  await tx.userBalance.update({
    where: { userId: entry.userId },
    data: { balance: { increment: entry.delta } },
  })

  return created
}

async function seed(tx: Tx): Promise<void> {
  // Deleted in dependency order: ledger entries reference redemptions, rules and
  // users, so they go first. Doing this with deleteMany rather than TRUNCATE
  // keeps the foreign keys enforced while it happens, which means a mistake in
  // this ordering fails loudly instead of leaving dangling references.
  await tx.pointTransaction.deleteMany()
  await tx.redemption.deleteMany()
  await tx.userBalance.deleteMany()
  await tx.webhookDelivery.deleteMany()
  await tx.earningRule.deleteMany()
  await tx.reward.deleteMany()
  await tx.user.deleteMany()

  // --- Reference data -------------------------------------------------------

  const userIdByRef = new Map<string, string>()
  for (const user of SEED_USERS) {
    const created = await tx.user.create({ data: user, select: { id: true } })
    userIdByRef.set(user.externalRef, created.id)
  }

  const ruleIdByKey = new Map<string, string>()
  const pointsByRuleKey = new Map<string, number>()
  for (const rule of SEED_EARNING_RULES) {
    const created = await tx.earningRule.create({
      data: {
        activityType: rule.activityType,
        points: rule.points,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
        active: rule.active,
      },
      select: { id: true },
    })
    ruleIdByKey.set(rule.key, created.id)
    pointsByRuleKey.set(rule.key, rule.points)
  }

  const rewardIdBySku = new Map<string, string>()
  const rewardBySku = new Map<string, (typeof SEED_REWARDS)[number]>()
  for (const reward of SEED_REWARDS) {
    const created = await tx.reward.create({ data: reward, select: { id: true } })
    rewardIdBySku.set(reward.sku, created.id)
    rewardBySku.set(reward.sku, reward)
  }

  // --- History --------------------------------------------------------------

  for (const entry of SEED_HISTORY) {
    const userId = userIdByRef.get(entry.userRef)
    if (!userId) throw new Error(`Seed history references unknown user ${entry.userRef}`)

    if (entry.kind === 'earn') {
      const ruleId = ruleIdByKey.get(entry.ruleKey)
      const points = pointsByRuleKey.get(entry.ruleKey)
      if (!ruleId || points === undefined) {
        throw new Error(`Seed history references unknown rule ${entry.ruleKey}`)
      }

      const rule = SEED_EARNING_RULES.find((candidate) => candidate.key === entry.ruleKey)
      if (!rule) throw new Error(`Seed history references unknown rule ${entry.ruleKey}`)

      // Every credited entry has a delivery behind it. A ledger full of earnings
      // with an empty deliveries table would be an inconsistent story, and the
      // deliveries view is where a support question actually starts.
      await tx.webhookDelivery.create({
        data: {
          partner: PARTNER,
          externalEventId: entry.eventId,
          status: 'PROCESSED',
          rawPayload: JSON.stringify({
            event_id: entry.eventId,
            user_ref: entry.userRef,
            activity_type: rule.activityType,
            occurred_at: entry.occurredAt.toISOString(),
          }),
          userRef: entry.userRef,
          activityType: rule.activityType,
          receivedAt: entry.occurredAt,
          processedAt: entry.occurredAt,
        },
      })

      await appendSeedEntry(tx, {
        userId,
        delta: points,
        type: TransactionType.EARN,
        description: entry.description,
        createdAt: entry.occurredAt,
        externalEventId: entry.eventId,
        ruleId,
        // The ledger has no occurredAt column: when something happened is a fact
        // about the partner's event, not about our accounting entry. Keeping it
        // here preserves the provenance without implying the ledger is ordered
        // by it.
        metadata: { occurredAt: entry.occurredAt.toISOString(), partner: PARTNER },
      })

      continue
    }

    const rewardId = rewardIdBySku.get(entry.sku)
    const reward = rewardBySku.get(entry.sku)
    if (!rewardId || !reward) throw new Error(`Seed history references unknown reward ${entry.sku}`)

    const failed = entry.outcome === 'failed-and-reversed'

    const redemption = await tx.redemption.create({
      data: {
        userId,
        rewardId,
        status: failed ? 'FAILED' : 'FULFILLED',
        // Snapshotted at redemption time. These are what the receipt shows, so
        // that renaming or repricing the reward later cannot rewrite what the
        // user was told they paid.
        costPointsSnapshot: reward.costPoints,
        rewardNameSnapshot: reward.name,
        idempotencyKey: entry.idempotencyKey,
        fulfillmentRef: failed ? null : `seed-fulfilment-${entry.idempotencyKey}`,
        failureReason: entry.failureReason ?? null,
        reservedAt: entry.occurredAt,
        createdAt: entry.occurredAt,
        fulfilledAt: failed ? null : entry.occurredAt,
      },
      select: { id: true },
    })

    const debit = await appendSeedEntry(tx, {
      userId,
      delta: -reward.costPoints,
      type: TransactionType.REDEEM,
      description: `Redeemed ${reward.name}`,
      createdAt: entry.occurredAt,
      redemptionId: redemption.id,
    })

    // Stock moves with the reservation, exactly as the real flow does: held on
    // reserve, returned on failure. Modelling it as a net decrement for
    // successes only would produce the same final number by different means and
    // hide the compensating step this data exists to demonstrate.
    if (reward.stock !== null) {
      await tx.reward.update({ where: { id: rewardId }, data: { stock: { decrement: 1 } } })
    }

    if (!failed) continue

    // Fulfilment failed after the points were already debited. The correction is
    // a new entry that reverses the old one — never an edit to it, and never a
    // delete. The ledger stays a record of what happened, including the part
    // that went wrong.
    await appendSeedEntry(tx, {
      userId,
      delta: reward.costPoints,
      type: TransactionType.REVERSAL,
      description: `Refund: ${reward.name} could not be fulfilled`,
      createdAt: new Date(entry.occurredAt.getTime() + 2_000),
      redemptionId: redemption.id,
      reversesId: debit.id,
    })

    if (reward.stock !== null) {
      await tx.reward.update({ where: { id: rewardId }, data: { stock: { increment: 1 } } })
    }
  }

  // --- Deliveries that produced no ledger entry ------------------------------

  for (const delivery of SEED_ORPHAN_DELIVERIES) {
    await tx.webhookDelivery.create({
      data: {
        partner: PARTNER,
        externalEventId: delivery.eventId,
        status: delivery.status,
        unmatchedReason: delivery.unmatchedReason,
        rawPayload: delivery.rawPayload,
        userRef: delivery.userRef,
        activityType: delivery.activityType,
        error: delivery.error,
        receivedAt: delivery.receivedAt,
      },
    })
  }
}

/**
 * Proves the cache agrees with the ledger before the seed is allowed to commit.
 *
 * This is the same property `reconcile()` will check in production, applied to
 * the data this script just wrote. A seed that produces an inconsistent balance
 * would make every later test suspect, and the failure would surface somewhere
 * far from here.
 */
async function verifyBalancesMatchLedger(tx: Tx): Promise<void> {
  const ledgerTotals = await tx.pointTransaction.groupBy({
    by: ['userId'],
    _sum: { delta: true },
  })
  const balances = await tx.userBalance.findMany({ select: { userId: true, balance: true } })

  const balanceByUser = new Map(balances.map((row) => [row.userId, row.balance]))

  for (const total of ledgerTotals) {
    const expected = total._sum.delta ?? 0
    const actual = balanceByUser.get(total.userId) ?? 0

    if (expected !== actual) {
      throw new Error(
        `Seed produced an inconsistent balance for user ${total.userId}: ` +
          `ledger sums to ${expected}, cached balance is ${actual}`,
      )
    }
  }
}

async function main(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await seed(tx)
      await verifyBalancesMatchLedger(tx)
    },
    // The default interactive-transaction timeout is 5 seconds, which a cold
    // database on a laptop can exceed on the first run.
    { maxWait: 10_000, timeout: 60_000 },
  )

  const [users, transactions, deliveries, rewards] = await Promise.all([
    prisma.user.count(),
    prisma.pointTransaction.count(),
    prisma.webhookDelivery.count(),
    prisma.reward.count(),
  ])

  const balances = await prisma.userBalance.findMany({
    select: { balance: true, user: { select: { displayName: true } } },
    orderBy: { balance: 'desc' },
  })

  console.log('Seed complete.')
  console.log(
    `  ${users} users, ${transactions} ledger entries, ${deliveries} deliveries, ${rewards} rewards`,
  )
  for (const row of balances) {
    console.log(`  ${row.user.displayName}: ${row.balance} points`)
  }
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
