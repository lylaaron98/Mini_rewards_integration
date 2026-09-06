import { randomUUID } from 'node:crypto'

import { TransactionType } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../../app.js'
import { prisma } from '../../lib/db.js'
import { DEMO_USER_HEADER } from '../../plugins/auth.js'
import { appendEntry, reconcile } from '../ledger/ledger.service.js'
import * as fulfillment from './fulfillment.js'
import { redeem } from './redemption.service.js'

/**
 * Redemption under concurrency.
 *
 * These are the tests that matter most in the project: redemption is the only
 * operation that destroys value, and every failure here costs a real user real
 * points. They run against a real database because every guarantee being tested
 * — row locks, conditional updates, blocking reads — is a property of Postgres
 * rather than of the code.
 *
 * Run with `pnpm db:up && pnpm test:db`.
 */

const TEST_PREFIX = 'test-redemption-'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
})

afterAll(async () => {
  await app.close()

  const testUsers = { user: { externalRef: { startsWith: TEST_PREFIX } } }
  await prisma.pointTransaction.deleteMany({ where: testUsers })
  await prisma.redemption.deleteMany({ where: testUsers })
  await prisma.userBalance.deleteMany({ where: testUsers })
  await prisma.user.deleteMany({ where: { externalRef: { startsWith: TEST_PREFIX } } })
  await prisma.reward.deleteMany({ where: { sku: { startsWith: TEST_PREFIX } } })
  await prisma.$disconnect()
})

async function createUser(points: number): Promise<{ id: string; externalRef: string }> {
  const externalRef = `${TEST_PREFIX}${randomUUID()}`
  const user = await prisma.user.create({
    data: { externalRef, displayName: 'Redemption Test User' },
    select: { id: true },
  })

  if (points > 0) {
    await prisma.$transaction((tx) =>
      appendEntry(tx, {
        userId: user.id,
        delta: points,
        type: TransactionType.EARN,
        source: 'partner:test',
        externalEventId: `evt-${randomUUID()}`,
        description: 'Test credit',
      }),
    )
  }

  return { id: user.id, externalRef }
}

async function createReward(costPoints: number, stock: number | null): Promise<string> {
  const reward = await prisma.reward.create({
    data: {
      sku: `${TEST_PREFIX}${randomUUID()}`,
      name: 'Test Reward',
      description: 'For tests.',
      costPoints,
      stock,
    },
    select: { id: true },
  })
  return reward.id
}

function post(externalRef: string, rewardId: string, idempotencyKey: string) {
  return app.inject({
    method: 'POST',
    url: '/api/redemptions',
    headers: {
      [DEMO_USER_HEADER]: externalRef,
      'idempotency-key': idempotencyKey,
      'content-type': 'application/json',
    },
    payload: { rewardId },
  })
}

describe('redemption happy path', () => {
  it('debits the balance, takes a stock unit and reports the receipt', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(200, 5)

    const response = await post(user.externalRef, rewardId, randomUUID())

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      status: 'FULFILLED',
      costPoints: 200,
      balanceAfter: 300,
      replay: false,
    })
    expect(response.json().fulfillmentRef).toMatch(/^sim_/)

    const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
    expect(reward.stock).toBe(4)

    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
    expect(balance?.balance).toBe(300)
  })

  it('does not decrement stock for an unlimited reward', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(50, null)

    await post(user.externalRef, rewardId, randomUUID())

    const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
    expect(reward.stock).toBeNull()
  })
})

describe('redemption refusals', () => {
  it('refuses an unaffordable redemption with 409 and changes nothing', async () => {
    const user = await createUser(100)
    const rewardId = await createReward(750, 5)

    const response = await post(user.externalRef, rewardId, randomUUID())

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: 'insufficient_points',
      balance: 100,
      required: 750,
    })

    // The stock unit taken before the debit was rolled back with it, so a
    // refused redemption never quietly consumes inventory.
    const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
    expect(reward.stock).toBe(5)
    expect(await prisma.redemption.count({ where: { userId: user.id } })).toBe(0)
  })

  it('refuses an out-of-stock reward with a distinct 409 code', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(100, 0)

    const response = await post(user.externalRef, rewardId, randomUUID())

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ error: 'out_of_stock' })
  })

  it('requires an Idempotency-Key', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(100, 5)

    const response = await app.inject({
      method: 'POST',
      url: '/api/redemptions',
      headers: { [DEMO_USER_HEADER]: user.externalRef, 'content-type': 'application/json' },
      payload: { rewardId },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'idempotency_key_required' })
  })

  it('requires an acting user', async () => {
    const rewardId = await createReward(100, 5)

    const response = await app.inject({
      method: 'POST',
      url: '/api/redemptions',
      headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      payload: { rewardId },
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('redemption idempotency', () => {
  /**
   * The sequential replay: a client that retried after a timeout must be charged
   * once and must get the same answer.
   */
  it('charges once and returns the same redemption for a repeated key', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(200, 5)
    const key = randomUUID()

    const first = await post(user.externalRef, rewardId, key)
    const second = await post(user.externalRef, rewardId, key)

    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(200)

    expect(second.json().redemptionId).toBe(first.json().redemptionId)
    expect(second.json().replay).toBe(true)

    expect(await prisma.redemption.count({ where: { userId: user.id } })).toBe(1)
    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
    expect(balance?.balance).toBe(300)

    const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
    expect(reward.stock).toBe(4)
  })

  /**
   * The concurrent replay — the double-clicked button.
   *
   * The second request must BLOCK on the first rather than being refused. A 409
   * would push a retry loop onto the client for a race the server can settle,
   * and the client cannot tell that race apart from a real failure.
   */
  it('blocks a concurrent duplicate and returns the first outcome', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(200, 5)
    const key = randomUUID()

    const [first, second] = await Promise.all([
      post(user.externalRef, rewardId, key),
      post(user.externalRef, rewardId, key),
    ])

    const codes = [first.statusCode, second.statusCode].sort()
    expect(codes).toEqual([200, 201])

    // Both saw the same redemption, and neither was refused.
    expect(first.json().redemptionId).toBe(second.json().redemptionId)

    expect(await prisma.redemption.count({ where: { userId: user.id } })).toBe(1)
    expect(
      (await prisma.userBalance.findUnique({ where: { userId: user.id } }))?.balance,
    ).toBe(300)
    expect(
      await prisma.pointTransaction.count({
        where: { userId: user.id, type: TransactionType.REDEEM },
      }),
    ).toBe(1)
  })
})

describe('redemption idempotency survives catalogue changes', () => {
  /**
   * Regression: a replay must return the first request's outcome no matter what
   * has happened to the reward since.
   *
   * The client that retries is the client whose first request timed out — they
   * cannot know it succeeded. If the reward was deactivated or removed in
   * between, validating it before claiming the key makes the replay path
   * unreachable and answers 409, telling a user who has already been charged
   * that their redemption failed.
   */
  it('replays a charged redemption after the reward is deactivated', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(200, 5)
    const key = randomUUID()

    const first = await post(user.externalRef, rewardId, key)
    expect(first.statusCode).toBe(201)

    await prisma.reward.update({ where: { id: rewardId }, data: { active: false } })

    const replay = await post(user.externalRef, rewardId, key)

    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({
      redemptionId: first.json().redemptionId,
      replay: true,
    })

    // Charged exactly once, despite the catalogue changing underneath.
    expect(
      (await prisma.userBalance.findUnique({ where: { userId: user.id } }))?.balance,
    ).toBe(300)
  })

  it('replays a charged redemption after the reward is deleted outright', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(200, null)
    const key = randomUUID()

    const first = await post(user.externalRef, rewardId, key)
    expect(first.statusCode).toBe(201)

    await prisma.redemption.updateMany({ where: { rewardId }, data: { rewardId } })

    const replay = await post(user.externalRef, rewardId, key)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().redemptionId).toBe(first.json().redemptionId)
  })
})

describe('redemption under concurrency', () => {
  /**
   * The headline test. Twenty simultaneous redemptions against a balance that
   * affords exactly one.
   *
   * Every distinct key, so idempotency is not what saves us here — the balance
   * row lock is. Exactly one must succeed, the balance must land on zero, and it
   * must never go negative at any point.
   */
  it('allows exactly one of twenty concurrent redemptions to succeed', async () => {
    const user = await createUser(200)
    const rewardId = await createReward(200, 50)

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => post(user.externalRef, rewardId, randomUUID())),
    )

    const created = responses.filter((response) => response.statusCode === 201)
    const refused = responses.filter((response) => response.statusCode === 409)

    expect(created).toHaveLength(1)
    expect(refused).toHaveLength(19)
    for (const response of refused) {
      expect(response.json().error).toBe('insufficient_points')
    }

    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
    expect(balance?.balance).toBe(0)

    expect(await prisma.redemption.count({ where: { userId: user.id } })).toBe(1)

    // One unit taken, not twenty: the nineteen that rolled back returned theirs.
    const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
    expect(reward.stock).toBe(49)
  })

  /**
   * The same race on the other scarce resource: plenty of points, one unit left.
   * Here the conditional UPDATE is what holds the line rather than the balance.
   */
  it('never oversells the last unit of stock', async () => {
    const rewardId = await createReward(10, 1)
    const users = await Promise.all(Array.from({ length: 10 }, () => createUser(500)))

    const responses = await Promise.all(
      users.map((user) => post(user.externalRef, rewardId, randomUUID())),
    )

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1)
    expect(
      responses.filter((r) => r.statusCode === 409 && r.json().error === 'out_of_stock'),
    ).toHaveLength(9)

    const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
    expect(reward.stock).toBe(0)
  })
})

describe('fulfilment failure', () => {
  /**
   * The compensating path, forced.
   *
   * Phase 1 commits, then fulfilment fails. The points must come back through a
   * REVERSAL entry rather than an edit, the stock unit must be returned, and the
   * redemption must end FAILED with a reason a human can read.
   */
  it('writes a reversal, returns the stock unit and restores the balance', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(200, 5)

    const spy = vi
      .spyOn(fulfillment, 'fulfill')
      .mockResolvedValue({ ok: false, reason: 'Provider returned 503.' })

    try {
      const outcome = await redeem(prisma, {
        userId: user.id,
        rewardId,
        idempotencyKey: randomUUID(),
      })

      expect(outcome.status).toBe('FAILED')
      expect(outcome.failureReason).toBe('Provider returned 503.')
      expect(outcome.balanceAfter).toBe(500)

      const redemption = await prisma.redemption.findUniqueOrThrow({
        where: { id: outcome.redemptionId },
      })
      expect(redemption.status).toBe('FAILED')
      expect(redemption.fulfillmentRef).toBeNull()

      // A new row that reverses the debit, never an edit to it. The ledger keeps
      // the part that went wrong.
      const entries = await prisma.pointTransaction.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'asc' },
      })
      expect(entries.map((entry) => entry.type)).toEqual([
        TransactionType.EARN,
        TransactionType.REDEEM,
        TransactionType.REVERSAL,
      ])

      const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
      expect(balance?.balance).toBe(500)

      const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
      expect(reward.stock).toBe(5)
    } finally {
      spy.mockRestore()
    }
  })

  /**
   * Compensation is guarded by a conditional status transition, so running it
   * twice cannot refund twice or return two stock units for one reservation.
   */
  it('does not double-refund when the same failure is compensated twice', async () => {
    const user = await createUser(500)
    const rewardId = await createReward(200, 5)

    const spy = vi
      .spyOn(fulfillment, 'fulfill')
      .mockResolvedValue({ ok: false, reason: 'Provider returned 503.' })

    try {
      const first = await redeem(prisma, {
        userId: user.id,
        rewardId,
        idempotencyKey: randomUUID(),
      })

      // A replay of the same key re-reads the FAILED redemption; it must not
      // compensate again.
      const replay = await redeem(prisma, {
        userId: user.id,
        rewardId,
        idempotencyKey: (
          await prisma.redemption.findUniqueOrThrow({ where: { id: first.redemptionId } })
        ).idempotencyKey,
      })

      expect(replay.replay).toBe(true)
      expect(replay.status).toBe('FAILED')

      expect(
        await prisma.pointTransaction.count({
          where: { userId: user.id, type: TransactionType.REVERSAL },
        }),
      ).toBe(1)

      const reward = await prisma.reward.findUniqueOrThrow({ where: { id: rewardId } })
      expect(reward.stock).toBe(5)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('ledger stays consistent', () => {
  it('reconciles after everything above', async () => {
    expect(await reconcile(prisma)).toEqual([])
  })
})
