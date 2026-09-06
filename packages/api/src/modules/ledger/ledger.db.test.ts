import { randomUUID } from 'node:crypto'

import { TransactionType } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

import { prisma } from '../../lib/db.js'
import {
  InsufficientPointsError,
  LedgerEntryNotFoundError,
  appendEntry,
  lockBalance,
  reconcile,
  reverseEntry,
} from './ledger.service.js'

/**
 * Ledger behaviour that can only be verified against a real database: row
 * locks, ON CONFLICT semantics, and the constraints underneath both.
 *
 * Every test runs its writes inside `prisma.$transaction`, because that is the
 * contract — `appendEntry` is briefly inconsistent between the ledger insert
 * and the balance update, and only the caller's transaction hides that. Testing
 * it the way it is meant to be called also means these tests would catch a
 * change that broke the transactional assumption.
 *
 * Run with `pnpm db:up && pnpm test:db`.
 */

const TEST_REF_PREFIX = 'test-ledger-'

async function createTestUser(): Promise<string> {
  const user = await prisma.user.create({
    data: {
      externalRef: `${TEST_REF_PREFIX}${randomUUID()}`,
      displayName: 'Ledger Test User',
    },
    select: { id: true },
  })
  return user.id
}

afterAll(async () => {
  // Ledger rows reference users, redemptions and each other, so they go first.
  const testUsers = { user: { externalRef: { startsWith: TEST_REF_PREFIX } } }
  await prisma.pointTransaction.deleteMany({ where: testUsers })
  await prisma.userBalance.deleteMany({ where: testUsers })
  await prisma.user.deleteMany({ where: { externalRef: { startsWith: TEST_REF_PREFIX } } })
  await prisma.$disconnect()
})

describe('appendEntry', () => {
  it('credits points and moves the cached balance in step', async () => {
    const userId = await createTestUser()

    const result = await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: 100,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: 'Test credit',
      }),
    )

    expect(result.duplicate).toBe(false)
    expect(result.balanceAfter).toBe(100)

    const stored = await prisma.userBalance.findUnique({ where: { userId } })
    expect(stored?.balance).toBe(100)
  })

  /**
   * The required duplicate test: the same (source, externalEventId) twice
   * returns `duplicate: true` and moves the balance exactly once.
   *
   * This is the partner-retry case, which is normal operation rather than an
   * edge — and the one where getting it wrong mints points.
   */
  it('treats a repeated (source, externalEventId) as a duplicate and moves the balance once', async () => {
    const userId = await createTestUser()
    const externalEventId = `evt-${randomUUID()}`

    const input = {
      userId,
      delta: 250,
      type: TransactionType.EARN,
      source: 'partner:test',
      externalEventId,
      description: 'Test credit',
    }

    const first = await prisma.$transaction((tx) => appendEntry(tx, input))
    const second = await prisma.$transaction((tx) => appendEntry(tx, input))

    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)

    // The duplicate reports the original entry, not a new one.
    expect(second.transactionId).toBe(first.transactionId)
    expect(second.balanceAfter).toBe(250)

    const entries = await prisma.pointTransaction.count({ where: { userId } })
    expect(entries).toBe(1)

    const stored = await prisma.userBalance.findUnique({ where: { userId } })
    expect(stored?.balance).toBe(250)
  })

  /**
   * Entries with no natural key must never collide with each other. Postgres
   * does not treat two NULLs as equal, which is what makes the same unique
   * index safe for both webhook credits and spends.
   */
  it('does not deduplicate entries that have no external event id', async () => {
    const userId = await createTestUser()

    await prisma.$transaction(async (tx) => {
      await appendEntry(tx, {
        userId,
        delta: 100,
        type: TransactionType.EARN,
        source: 'admin',
        description: 'First adjustment',
      })
      await appendEntry(tx, {
        userId,
        delta: 100,
        type: TransactionType.EARN,
        source: 'admin',
        description: 'Second adjustment',
      })
    })

    expect(await prisma.pointTransaction.count({ where: { userId } })).toBe(2)
    const stored = await prisma.userBalance.findUnique({ where: { userId } })
    expect(stored?.balance).toBe(200)
  })

  it('refuses a debit that would take the balance below zero', async () => {
    const userId = await createTestUser()

    await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: 100,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: 'Test credit',
      }),
    )

    await expect(
      prisma.$transaction((tx) =>
        appendEntry(tx, {
          userId,
          delta: -250,
          type: TransactionType.REDEEM,
          source: 'redemption',
          description: 'Too expensive',
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientPointsError)

    // The failed attempt left nothing behind: the caller's transaction rolled
    // back the ledger row along with everything else.
    expect(await prisma.pointTransaction.count({ where: { userId } })).toBe(1)
    const stored = await prisma.userBalance.findUnique({ where: { userId } })
    expect(stored?.balance).toBe(100)
  })

  /**
   * A retry of a spend must still read as a duplicate even though the balance
   * can no longer afford it — the points were already taken by the original.
   * Checking affordability before checking for a duplicate would reject this
   * with InsufficientPointsError and hand the caller a false failure for a
   * request that had in fact succeeded.
   */
  it('reports a duplicate spend as duplicate, not as insufficient funds', async () => {
    const userId = await createTestUser()
    const spendKey = `spend-${randomUUID()}`

    await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: 300,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: 'Test credit',
      }),
    )

    const spend = {
      userId,
      delta: -250,
      type: TransactionType.REDEEM,
      source: 'redemption',
      externalEventId: spendKey,
      description: 'Test spend',
    }

    const first = await prisma.$transaction((tx) => appendEntry(tx, spend))
    expect(first.balanceAfter).toBe(50)

    const retry = await prisma.$transaction((tx) => appendEntry(tx, spend))
    expect(retry.duplicate).toBe(true)
    expect(retry.balanceAfter).toBe(50)
  })
})

describe('lockBalance', () => {
  /**
   * FOR UPDATE locks nothing when there is no row, so the row has to be made to
   * exist first. This is the brand-new-user path, which is the one least likely
   * to be exercised under load.
   */
  it('materialises a missing balance row at zero', async () => {
    const userId = await createTestUser()

    expect(await prisma.userBalance.findUnique({ where: { userId } })).toBeNull()

    const balance = await prisma.$transaction((tx) => lockBalance(tx, userId))

    expect(balance).toBe(0)
    expect((await prisma.userBalance.findUnique({ where: { userId } }))?.balance).toBe(0)
  })
})

describe('reverseEntry', () => {
  /**
   * The required test: reversing twice refunds once.
   *
   * The mechanism is the ledger's own unique constraint rather than a special
   * case — a reversal is keyed on ('reversal', originalId) — so this also
   * covers the retried-failure-handler path in redemption.
   */
  it('refunds once when called twice', async () => {
    const userId = await createTestUser()

    const credit = await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: 500,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: 'Test credit',
      }),
    )

    const spend = await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: -200,
        type: TransactionType.REDEEM,
        source: 'redemption',
        externalEventId: `spend-${randomUUID()}`,
        description: 'Test spend',
      }),
    )
    expect(spend.balanceAfter).toBe(300)

    const first = await prisma.$transaction((tx) =>
      reverseEntry(tx, spend.transactionId, 'fulfilment failed'),
    )
    const second = await prisma.$transaction((tx) =>
      reverseEntry(tx, spend.transactionId, 'fulfilment failed'),
    )

    expect(first.reversed).toBe(true)
    expect(second.reversed).toBe(false)
    expect(second.transactionId).toBe(first.transactionId)

    // Credit, spend, one reversal. Not two.
    expect(await prisma.pointTransaction.count({ where: { userId } })).toBe(3)

    const stored = await prisma.userBalance.findUnique({ where: { userId } })
    expect(stored?.balance).toBe(500)
    expect(first.balanceAfter).toBe(500)
    expect(second.balanceAfter).toBe(500)

    expect(credit.transactionId).not.toBe(spend.transactionId)
  })

  /**
   * Regression: a user in the hole must be able to earn their way out.
   *
   * That is the entire justification for allowing negative balances — a
   * clawback lands, the ledger explains why, and the user earns back to zero.
   * A guard that refuses any entry whose *result* is negative refuses credits
   * too, which strands the user permanently: every subsequent partner event is
   * rejected, and the webhook answers 500 forever.
   *
   * `enforceNonNegative` is about refusing a DEBIT that overdraws, never about
   * refusing a credit.
   */
  it('accepts a credit into a negative balance', async () => {
    const userId = await createTestUser()

    const fraudulent = await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: 100,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: 'Credit that should not have been granted',
      }),
    )

    await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: -100,
        type: TransactionType.REDEEM,
        source: 'redemption',
        externalEventId: `spend-${randomUUID()}`,
        description: 'Spent it',
      }),
    )

    await prisma.$transaction((tx) =>
      reverseEntry(tx, fraudulent.transactionId, 'fraudulent activity'),
    )

    expect((await prisma.userBalance.findUnique({ where: { userId } }))?.balance).toBe(-100)

    // Earning out of the hole. Default enforceNonNegative, an ordinary credit.
    const earned = await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: 40,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: 'Earning back',
      }),
    )

    expect(earned.balanceAfter).toBe(-60)

    // A debit that deepens the hole is still refused.
    await expect(
      prisma.$transaction((tx) =>
        appendEntry(tx, {
          userId,
          delta: -10,
          type: TransactionType.REDEEM,
          source: 'redemption',
          description: 'Still cannot spend',
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientPointsError)
  })

  it('rejects a reversal of an entry that does not exist', async () => {
    await expect(
      prisma.$transaction((tx) => reverseEntry(tx, randomUUID(), 'nope')),
    ).rejects.toBeInstanceOf(LedgerEntryNotFoundError)
  })

  /**
   * Clawing back a credit that should never have been granted, after the user
   * has already spent it. `reverseEntry` passes enforceNonNegative: false
   * precisely so this lands: an honest negative balance is recoverable, a
   * wrongly positive one is not.
   */
  it('claws back a credit even when the user has already spent it', async () => {
    const userId = await createTestUser()

    const fraudulent = await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: 500,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: 'Credit that should not have been granted',
      }),
    )

    await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: -400,
        type: TransactionType.REDEEM,
        source: 'redemption',
        externalEventId: `spend-${randomUUID()}`,
        description: 'Spent before the fraud was noticed',
      }),
    )

    const clawback = await prisma.$transaction((tx) =>
      reverseEntry(tx, fraudulent.transactionId, 'fraudulent activity'),
    )

    expect(clawback.reversed).toBe(true)
    expect(clawback.balanceAfter).toBe(-400)
  })
})

describe('reconcile', () => {
  /**
   * The required test: every user's cached balance equals the sum of their
   * ledger. Run against whatever is in the database, seed included.
   */
  it('reports no discrepancies for a healthy database', async () => {
    expect(await reconcile(prisma)).toEqual([])
  })

  /**
   * A positive control. Without it, the assertion above would pass just as
   * happily against a reconcile that always returned nothing — which is the
   * failure mode a "no problems found" check is most likely to have.
   *
   * Writes to user_balances directly, which is exactly the thing no other code
   * in this repo is allowed to do. That is the point: it simulates the
   * corruption reconcile exists to catch.
   */
  it('detects a cached balance that has drifted from the ledger', async () => {
    const userId = await createTestUser()

    await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId,
        delta: 100,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: 'Test credit',
      }),
    )

    await prisma.userBalance.update({ where: { userId }, data: { balance: 175 } })

    const discrepancies = await reconcile(prisma)
    const drifted = discrepancies.find((row) => row.userId === userId)

    expect(drifted).toMatchObject({
      cachedBalance: 175,
      ledgerBalance: 100,
      difference: 75,
    })

    // Put it back, so this test does not poison the healthy-database assertion
    // for any suite that runs after it.
    await prisma.userBalance.update({ where: { userId }, data: { balance: 100 } })
    expect(await reconcile(prisma)).toEqual([])
  })
})
