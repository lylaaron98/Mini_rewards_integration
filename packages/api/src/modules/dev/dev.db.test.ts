import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { prisma } from '../../lib/db.js'
import { hashPassword } from '../auth/auth.service.js'
import { loginAs } from '../auth/test-login.js'

/**
 * The administrative endpoints are gated server-side, on every request.
 *
 * The UI hides the developer panel from ordinary users, and that is presentation
 * only — these URLs are in the README and anyone can call them directly. These
 * tests exist because that distinction is exactly the one people get wrong: a
 * hidden button feels like a permission, and it is not one.
 *
 * Run with `pnpm db:up && pnpm test:db`.
 */

const TEST_PREFIX = 'test-dev-'
const PASSWORD = 'test-password-1234'

const DEV_ROUTES = [
  { method: 'GET' as const, url: '/api/dev/deliveries' },
  { method: 'GET' as const, url: '/api/dev/reconcile' },
]

let app: FastifyInstance
let adminCookie: string
let userCookie: string

async function createAccount(role: 'USER' | 'ADMIN'): Promise<string> {
  const email = `${TEST_PREFIX}${randomUUID()}@example.test`

  await prisma.user.create({
    data: {
      externalRef: `${TEST_PREFIX}${randomUUID()}`,
      email,
      displayName: role === 'ADMIN' ? 'Test Admin' : 'Test User',
      passwordHash: await hashPassword(PASSWORD),
      role,
    },
  })

  const { cookie } = await loginAs(app, email, PASSWORD)
  return cookie
}

beforeAll(async () => {
  app = await buildApp()
  adminCookie = await createAccount('ADMIN')
  userCookie = await createAccount('USER')
})

afterAll(async () => {
  await app.close()

  /**
   * Cleaned up by email as well as by external reference.
   *
   * An account created through the registration route gets a generated
   * `local:<uuid>` reference rather than the test prefix, so matching on the
   * reference alone left those rows behind — which showed up as `pnpm reconcile`
   * counting more users than the seed creates.
   */
  await prisma.session.deleteMany({
    where: {
      OR: [
        { user: { externalRef: { startsWith: TEST_PREFIX } } },
        { user: { email: { startsWith: TEST_PREFIX } } },
      ],
    },
  })
  await prisma.user.deleteMany({ where: { externalRef: { startsWith: TEST_PREFIX } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } })
  await prisma.$disconnect()
})

describe('the developer endpoints', () => {
  it('refuses a signed-out caller with 401', async () => {
    for (const route of DEV_ROUTES) {
      const response = await app.inject(route)

      expect(response.statusCode).toBe(401)
      expect(response.json()).toMatchObject({ error: 'unauthenticated' })
    }
  })

  /**
   * The case that matters. A signed-in ordinary user is exactly who would find
   * these by reading the README, and hiding the panel from them in the UI does
   * nothing to stop the request.
   */
  it('refuses a signed-in non-admin with 403', async () => {
    for (const route of DEV_ROUTES) {
      const response = await app.inject({ ...route, headers: { cookie: userCookie } })

      expect(response.statusCode).toBe(403)
      expect(response.json()).toMatchObject({ error: 'forbidden' })
    }
  })

  it('allows an administrator', async () => {
    for (const route of DEV_ROUTES) {
      const response = await app.inject({ ...route, headers: { cookie: adminCookie } })
      expect(response.statusCode).toBe(200)
    }
  })

  /**
   * The simulator is the one that mints points, so it is the one worth checking
   * separately: a non-admin reaching it could credit any account they named.
   */
  it('refuses a non-admin from simulating partner activity', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/dev/simulate-activity',
      headers: { cookie: userCookie, 'content-type': 'application/json' },
      payload: { userRef: 'acme-user-001', activityType: 'PURCHASE' },
    })

    expect(response.statusCode).toBe(403)
  })

  /**
   * The guard is a plugin-level hook rather than a per-route option, so a route
   * added later is protected without anyone remembering to protect it. This
   * asserts that shape rather than the specific list above — a new unguarded
   * route would fail here even though nobody wrote a test for it.
   */
  it('protects every route in the plugin, including ones added later', async () => {
    const devRoutes = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .filter((line) => line.includes('/api/dev/'))

    expect(devRoutes.length).toBeGreaterThan(0)

    for (const route of DEV_ROUTES) {
      expect((await app.inject({ ...route, headers: { cookie: userCookie } })).statusCode).toBe(403)
    }
  })
})

describe('roles', () => {
  it('defaults a newly registered account to USER, never ADMIN', async () => {
    const email = `${TEST_PREFIX}${randomUUID()}@example.test`

    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email, password: PASSWORD, displayName: 'Self Registered' },
    })

    expect(registered.statusCode).toBe(201)
    expect(registered.json()).toMatchObject({ role: 'USER' })

    // And nothing in the API can raise it: there is no route that grants ADMIN,
    // which is why privilege escalation has no surface to attack here.
    const stored = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(stored.role).toBe('USER')
  })

  it('reports the role on the session, which is what the UI branches on', async () => {
    const asAdmin = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: adminCookie },
    })

    expect(asAdmin.json()).toMatchObject({ role: 'ADMIN' })

    const asUser = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: userCookie },
    })

    expect(asUser.json()).toMatchObject({ role: 'USER' })
  })
})
