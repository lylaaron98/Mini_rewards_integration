import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { prisma } from '../../lib/db.js'
import { DEMO_USER_HEADER } from '../../plugins/auth.js'

/**
 * The read endpoints, against the seeded dataset.
 *
 * Run with `pnpm db:up && pnpm db:seed && pnpm test:db`.
 */

const TEST_PREFIX = 'test-reads-'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
})

afterAll(async () => {
  await app.close()
  await prisma.user.deleteMany({ where: { externalRef: { startsWith: TEST_PREFIX } } })
  await prisma.$disconnect()
})

describe('GET /api/me', () => {
  it('returns the acting user and their cached balance', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { [DEMO_USER_HEADER]: 'acme-user-001' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      externalRef: 'acme-user-001',
      displayName: 'Ada Lovelace',
      balance: 355,
    })
  })

  /**
   * A user with no activity has no `user_balances` row at all. That must read as
   * zero rather than as an error or a null — the seeded dataset contains one
   * specifically so this path is exercised.
   */
  it('reports zero for a user who has never earned anything', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { [DEMO_USER_HEADER]: 'acme-user-003' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ displayName: 'Alan Turing', balance: 0 })
  })

  it('answers 401 without an acting user', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me' })
    expect(response.statusCode).toBe(401)
  })

  /**
   * A header naming somebody we do not have is treated exactly like no header.
   * Distinguishing them would let anyone probe which user references exist.
   */
  it('answers 401 for a header naming an unknown user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { [DEMO_USER_HEADER]: `${TEST_PREFIX}nobody` },
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('GET /api/rewards', () => {
  it('returns active rewards cheapest first', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/rewards' })

    expect(response.statusCode).toBe(200)

    const rewards = response.json()
    expect(rewards.length).toBeGreaterThan(0)

    const costs = rewards.map((reward: { costPoints: number }) => reward.costPoints)
    expect(costs).toEqual([...costs].sort((a: number, b: number) => a - b))
  })

  /**
   * The client is told whether it can redeem, never the raw count. Exposing the
   * count would publish inventory levels and would push the "null means
   * unlimited" rule into every client that has to reimplement it.
   */
  it('exposes inStock and never the raw stock count', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/rewards' })
    const rewards = response.json()

    for (const reward of rewards) {
      expect(reward).toHaveProperty('inStock')
      expect(typeof reward.inStock).toBe('boolean')
      expect(reward).not.toHaveProperty('stock')
    }

    // The unlimited reward reads as in stock, which is the case a client
    // reimplementing the rule gets backwards.
    const unlimited = rewards.find((r: { sku: string }) => r.sku === 'WALLPAPER-PACK')
    expect(unlimited?.inStock).toBe(true)
  })
})

describe('GET /api/demo/users', () => {
  it('lists users for the demo switcher without requiring one', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/demo/users' })

    expect(response.statusCode).toBe(200)
    expect(response.json().length).toBeGreaterThanOrEqual(3)
    expect(response.json()[0]).toHaveProperty('externalRef')
  })
})
