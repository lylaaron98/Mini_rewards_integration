import { TransactionType } from '@prisma/client'

import { prisma } from './lib/db.js'
import type { Tx } from './lib/db.js'
import { hashPassword } from './modules/auth/auth.service.js'
import { REVERSAL_SOURCE, appendEntry, reconcile } from './modules/ledger/ledger.service.js'
import { resolveDeliveryKey } from './modules/webhook/webhook.service.js'
import {
  LEDGER_SOURCE,
  PARTNER,
  SEED_EARNING_RULES,
  SEED_HISTORY,
  SEED_ORPHAN_DELIVERIES,
  SEED_PASSWORD,
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
 * Every ledger write in this file goes through `ledger.appendEntry`, like every
 * other caller in the codebase. `ledger.service.ts` is the only file permitted
 * to write `point_transactions` or `user_balances`, and a seed script writing
 * them directly would make that rule a thing that is mostly true — which is the
 * same as not true, since the value of the rule is being able to rely on it.
 *
 * The useful side effect is that seeding exercises the real code path: the
 * balance lock, the dedupe claim and the same balance arithmetic the webhook
 * will use. A seed that reimplemented those would be a second implementation to
 * keep in step, and the first place a divergence would hide.
 */

async function seed(tx: Tx): Promise<void> {
  // Deleted in dependency order: ledger entries reference redemptions, rules and
  // users, so they go first. Doing this with deleteMany rather than TRUNCATE
  // keeps the foreign keys enforced while it happens, which means a mistake in
  // this ordering fails loudly instead of leaving dangling references.
  await tx.pointTransaction.deleteMany()
  await tx.redemption.deleteMany()
  await tx.session.deleteMany()
  await tx.userBalance.deleteMany()
  await tx.webhookDelivery.deleteMany()
  await tx.earningRule.deleteMany()
  await tx.reward.deleteMany()
  await tx.user.deleteMany()

  // --- Reference data -------------------------------------------------------

  /**
   * Every seeded account shares one password, hashed properly rather than
   * stored as-is — the seed goes through the same `hashPassword` the
   * registration route uses, so logging in as a seeded user exercises the real
   * verification path rather than a shortcut that only works here.
   *
   * Hashed once and reused across the three users. scrypt is deliberately slow,
   * and doing it per user would add most of a second to every seed for no
   * benefit, since the password is identical and the salt is inside the hash.
   */
  const seededPasswordHash = await hashPassword(SEED_PASSWORD)

  const userIdByRef = new Map<string, string>()
  for (const user of SEED_USERS) {
    const created = await tx.user.create({
      data: { ...user, passwordHash: seededPasswordHash },
      select: { id: true },
    })
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

      await appendEntry(tx, {
        userId,
        delta: points,
        type: TransactionType.EARN,
        source: LEDGER_SOURCE,
        externalEventId: entry.eventId,
        ruleId,
        description: entry.description,
        createdAt: entry.occurredAt,
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

    // No externalEventId: a spend has no partner event behind it, and Postgres
    // treats NULLs as distinct, so these always insert. Idempotency for a
    // redemption is carried by the Idempotency-Key on the Redemption row.
    const debit = await appendEntry(tx, {
      userId,
      delta: -reward.costPoints,
      type: TransactionType.REDEEM,
      source: 'redemption',
      redemptionId: redemption.id,
      description: `Redeemed ${reward.name}`,
      createdAt: entry.occurredAt,
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
    //
    // Shaped exactly as `ledger.reverseEntry` would shape it — same source, same
    // dedupe key, same reversesId — but written through appendEntry directly
    // because reverseEntry dates its output now, and this history needs to be
    // backdated to look like something that happened last week.
    const reason = entry.failureReason ?? 'fulfilment failed'
    await appendEntry(tx, {
      userId,
      delta: reward.costPoints,
      type: TransactionType.REVERSAL,
      source: REVERSAL_SOURCE,
      externalEventId: debit.transactionId,
      reversesId: debit.transactionId,
      redemptionId: redemption.id,
      description: `Reversal: ${reason}`,
      createdAt: new Date(entry.occurredAt.getTime() + 2_000),
      metadata: { reversedTransactionId: debit.transactionId, reason },
      enforceNonNegative: false,
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
        // Derived with the same function ingestion uses, so the seeded rows are
        // exactly what a real delivery would have produced. The malformed one
        // gets a content-hash key, because there is no readable event id in it
        // to use — which is the whole reason that fallback exists.
        externalEventId: resolveDeliveryKey(delivery.rawPayload),
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
 * Uses the real `reconcile()` rather than a check written for the seed, so the
 * seed is validated by the same query that will run in production. Inconsistent
 * data would make every later test suspect, and the failure would surface a long
 * way from the cause.
 *
 * Running it inside the transaction means a bad seed rolls back rather than
 * landing and then being reported.
 */
async function verifyBalancesMatchLedger(tx: Tx): Promise<void> {
  const discrepancies = await reconcile(tx)

  if (discrepancies.length > 0) {
    const detail = discrepancies
      .map((row) => `${row.displayName}: ledger ${row.ledgerBalance}, cached ${row.cachedBalance}`)
      .join('; ')

    throw new Error(`Seed produced balances that disagree with the ledger — ${detail}`)
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
