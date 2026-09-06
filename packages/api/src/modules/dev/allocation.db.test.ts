import { randomUUID } from 'node:crypto'

import { TransactionType } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

import { prisma } from '../../lib/db.js'
import { reconcile } from '../ledger/ledger.service.js'
import { allocateReward } from './allocation.service.js'

/**
 * Allocating rewards as an administrator.
 *
 * An allocation is a credit followed by the ordinary redemption that spends it,
 * so these assert the property that makes that design honest: the recipient ends
 * up holding the reward, their balance is unchanged, and the ledger explains
 * both halves.
 *
 * Run with `pnpm db:up && pnpm test:db`.
 */

const TEST_PREFIX = 'test-alloc-'

async function createUser(name: string): Promise<{ id: string; displayName: string }> {
  return prisma.user.create({
    data: { externalRef: `${TEST_PREFIX}${randomUUID()}`, displayName: name },
    select: { id: true, displayName: true },
  })
}

async function createReward(costPoints: number, stock: number | null): Promise<string> {
  const reward = await prisma.reward.create({
    data: {
      sku: `${TEST_PREFIX}${randomUUID()}`,
      name: 'Allocatable Reward',
      description: 'For allocation tests.',
      costPoints,
      stock,
    },
    select: { id: true },
  })
  return reward.id
}

const balanceOf = async (userId: string) =>
  (await prisma.userBalance.findUnique({ where: { userId } }))?.balance ?? 0

afterAll(async () => {
  const testUsers = { user: { externalRef: { startsWith: TEST_PREFIX } } }
  await prisma.pointTransaction.deleteMany({ where: testUsers })
  await prisma.redemption.deleteMany({ where: testUsers })
  await prisma.userBalance.deleteMany({ where: testUsers })
  await prisma.user.deleteMany({ where: { externalRef: { startsWith: TEST_PREFIX } } })
  await prisma.reward.deleteMany({ where: { sku: { startsWith: TEST_PREFIX } } })
  await prisma.$disconnect()
})

describe('allocateReward', () => {
  /**
   * The defining property: the user holds the reward and is no richer or poorer
   * for it. A credit with no matching debit would be a points grant dressed up
   * as an allocation.
   */
  it('leaves the balance unchanged and the reward held', async () => {
    const user = await createUser('Recipient')
    const rewardId = await createReward(250, 10)

    const before = await balanceOf(user.id)

    const outcomes = await allocateReward(prisma, {
      rewardId,
      userIds: [user.id],
      allocationKey: randomUUID(),
    })

    expect(outcomes).toEqual([
      { userId: user.id, displayName: 'Recipient', status: 'ALLOCATED' },
    ])
    expect(await balanceOf(user.id)).toBe(before)

    const redemption = await prisma.redemption.findFirst({ where: { userId: user.id } })
    expect(redemption?.status).toBe('FULFILLED')
    expect(redemption?.costPointsSnapshot).toBe(250)

    // Stock moves exactly as it would for a redemption the user paid for.
    const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
    expect(reward.stock).toBe(9)
  })

  /**
   * Both halves are visible. A grant the recipient cannot see in their own
   * history is a grant they have no way to verify.
   */
  it('records the credit and the spend as two ledger entries', async () => {
    const user = await createUser('Auditable')
    const rewardId = await createReward(120, 5)

    await allocateReward(prisma, {
      rewardId,
      userIds: [user.id],
      allocationKey: randomUUID(),
    })

    const entries = await prisma.pointTransaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    })

    expect(entries.map((entry) => entry.type)).toEqual([
      TransactionType.ADJUSTMENT,
      TransactionType.REDEEM,
    ])
    expect(entries[0]?.delta).toBe(120)
    expect(entries[0]?.description).toContain('Allocated by admin')
    expect(entries[1]?.delta).toBe(-120)
  })

  it('allocates to several users in one call', async () => {
    const users = await Promise.all([
      createUser('First'),
      createUser('Second'),
      createUser('Third'),
    ])
    const rewardId = await createReward(80, 10)

    const outcomes = await allocateReward(prisma, {
      rewardId,
      userIds: users.map((user) => user.id),
      allocationKey: randomUUID(),
    })

    expect(outcomes).toHaveLength(3)
    expect(outcomes.every((outcome) => outcome.status === 'ALLOCATED')).toBe(true)

    const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
    expect(reward.stock).toBe(7)
  })

  /**
   * The same allocation key twice must not allocate twice. Both halves derive
   * their idempotency from it — the ledger's (source, externalEventId) for the
   * credit, and (userId, idempotencyKey) for the redemption — so a double-click
   * costs one unit of stock, not two.
   */
  it('is idempotent under the same allocation key', async () => {
    const user = await createUser('Double Clicker')
    const rewardId = await createReward(200, 10)
    const allocationKey = randomUUID()

    await allocateReward(prisma, { rewardId, userIds: [user.id], allocationKey })
    await allocateReward(prisma, { rewardId, userIds: [user.id], allocationKey })

    expect(await prisma.pointTransaction.count({ where: { userId: user.id } })).toBe(2)
    expect(await prisma.redemption.count({ where: { userId: user.id } })).toBe(1)

    const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
    expect(reward.stock).toBe(9)
  })

  /**
   * The partial-failure case, and the reason the route answers 200 with per-user
   * outcomes rather than a single status. Three recipients, one unit of stock.
   */
  it('reports per-user outcomes when stock runs out mid-allocation', async () => {
    const users = await Promise.all([createUser('Lucky'), createUser('Late'), createUser('Later')])
    const rewardId = await createReward(60, 1)

    const outcomes = await allocateReward(prisma, {
      rewardId,
      userIds: users.map((user) => user.id),
      allocationKey: randomUUID(),
    })

    expect(outcomes.filter((outcome) => outcome.status === 'ALLOCATED')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.status === 'FAILED')).toHaveLength(2)

    for (const failure of outcomes.filter((outcome) => outcome.status === 'FAILED')) {
      expect(failure.reason).toContain('out of stock')
    }
  })

  /**
   * A failed allocation must not leave the credit standing, or an out-of-stock
   * reward quietly becomes free points instead.
   */
  it('reverses the credit when the reward cannot be issued', async () => {
    const lucky = await createUser('Takes The Last One')
    const unlucky = await createUser('Gets Nothing')
    const rewardId = await createReward(300, 1)

    await allocateReward(prisma, {
      rewardId,
      userIds: [lucky.id, unlucky.id],
      allocationKey: randomUUID(),
    })

    // Credited, then reversed — so the attempt is in the history and the points
    // are not.
    expect(await balanceOf(unlucky.id)).toBe(0)

    const entries = await prisma.pointTransaction.findMany({
      where: { userId: unlucky.id },
      orderBy: { createdAt: 'asc' },
    })

    expect(entries.map((entry) => entry.type)).toEqual([
      TransactionType.ADJUSTMENT,
      TransactionType.REVERSAL,
    ])
    expect(entries[1]?.description).toContain('Allocation failed')

    expect(await prisma.redemption.count({ where: { userId: unlucky.id } })).toBe(0)
  })

  it('leaves every balance reconciled with the ledger', async () => {
    expect(await reconcile(prisma)).toEqual([])
  })
})
