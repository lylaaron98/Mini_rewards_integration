import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { prisma } from '../../lib/db.js'
import { SESSION_COOKIE, hashPassword, verifyPassword } from './auth.service.js'

/**
 * Authentication, end to end through the real routes.
 *
 * Run with `pnpm db:up && pnpm test:db`.
 */

const TEST_PREFIX = 'test-auth-'
const PASSWORD = 'test-password-1234'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
})

afterAll(async () => {
  await app.close()

  const testUsers = { user: { externalRef: { startsWith: TEST_PREFIX } } }
  await prisma.session.deleteMany({ where: testUsers })
  await prisma.user.deleteMany({ where: { externalRef: { startsWith: TEST_PREFIX } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: TEST_PREFIX } } })
  await prisma.$disconnect()
})

const testEmail = () => `${TEST_PREFIX}${randomUUID()}@example.test`

function sessionCookie(response: { cookies: Array<{ name: string; value: string }> }) {
  const token = response.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value
  return token ? `${SESSION_COOKIE}=${token}` : null
}

async function registerAccount(email: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: PASSWORD, displayName: 'Auth Test User' },
  })
}

describe('password hashing', () => {
  /**
   * Two people choosing the same password must not produce the same hash, or one
   * precomputed table breaks both accounts at once.
   */
  it('salts every hash, so identical passwords hash differently', async () => {
    const first = await hashPassword('the same password')
    const second = await hashPassword('the same password')

    expect(first).not.toBe(second)
    expect(await verifyPassword('the same password', first)).toBe(true)
    expect(await verifyPassword('the same password', second)).toBe(true)
  })

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse')
    expect(await verifyPassword('battery staple', stored)).toBe(false)
  })

  /** A corrupt row should fail the login, not the request. */
  it('returns false for a malformed hash rather than throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false)
  })

  /**
   * The stored form must never contain the password. Obvious, and exactly the
   * kind of thing worth pinning: a refactor that "simplified" the format could
   * quietly start storing it.
   */
  it('never stores the password itself', async () => {
    const stored = await hashPassword('hunter2')
    expect(stored).not.toContain('hunter2')
    expect(stored.startsWith('scrypt$')).toBe(true)
  })
})

describe('registration', () => {
  it('creates an account and signs it in', async () => {
    const response = await registerAccount(testEmail())

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ displayName: 'Auth Test User' })

    // A self-registered user has no partner identifier, so one is generated with
    // a prefix that says so.
    expect(response.json().externalRef).toMatch(/^local:/)
    expect(sessionCookie(response)).not.toBeNull()
  })

  it('refuses a duplicate email', async () => {
    const email = testEmail()
    await registerAccount(email)

    const second = await registerAccount(email)

    expect(second.statusCode).toBe(409)
    expect(second.json()).toMatchObject({ error: 'email_taken' })
  })

  it('refuses a short password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { email: testEmail(), password: 'short', displayName: 'Too Short' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('8 characters')
  })

  /** Case and surrounding whitespace must not create a second account. */
  it('normalises the email so casing cannot duplicate an account', async () => {
    const email = testEmail()
    await registerAccount(email)

    const second = await registerAccount(`  ${email.toUpperCase()}  `)

    expect(second.statusCode).toBe(409)
  })
})

describe('login', () => {
  it('issues an httpOnly session cookie', async () => {
    const email = testEmail()
    await registerAccount(email)

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
    })

    expect(response.statusCode).toBe(200)

    const cookie = response.cookies.find((entry) => entry.name === SESSION_COOKIE)

    /**
     * httpOnly is the single most important attribute here: it is what stops any
     * script on the page from reading the session, so an XSS bug anywhere cannot
     * exfiltrate it.
     */
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite?.toLowerCase()).toBe('lax')
    expect(cookie?.path).toBe('/')
  })

  /**
   * The cookie carries a token; the database stores only its hash. A dump of the
   * sessions table must therefore yield nothing anyone could present back.
   */
  it('stores only a hash of the session token', async () => {
    const email = testEmail()
    const registered = await registerAccount(email)
    const token = registered.cookies.find((entry) => entry.name === SESSION_COOKIE)?.value

    expect(token).toBeTruthy()

    const stored = await prisma.session.findFirst({
      where: { user: { email } },
      select: { id: true },
    })

    expect(stored).not.toBeNull()
    expect(stored?.id).not.toBe(token)
    expect(stored?.id).toMatch(/^[0-9a-f]{64}$/)
  })

  /**
   * All three failures — no such account, no password set, wrong password — must
   * be indistinguishable, or the login form becomes a way to enumerate who has
   * an account here.
   */
  it('gives the same answer for a wrong password and an unknown account', async () => {
    const email = testEmail()
    await registerAccount(email)

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: 'definitely-not-it' },
    })

    const unknownAccount = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: testEmail(), password: PASSWORD },
    })

    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownAccount.statusCode).toBe(401)
    expect(wrongPassword.json()).toEqual(unknownAccount.json())
  })

  it('rejects an account that has no password set', async () => {
    const email = testEmail()
    await prisma.user.create({
      data: {
        externalRef: `${TEST_PREFIX}${randomUUID()}`,
        email,
        displayName: 'Imported, never registered',
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: 'invalid_credentials' })
  })
})

describe('the session', () => {
  it('identifies the user on subsequent requests', async () => {
    const email = testEmail()
    const registered = await registerAccount(email)
    const cookie = sessionCookie(registered)

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookie! } })

    expect(me.statusCode).toBe(200)
    expect(me.json()).toMatchObject({ displayName: 'Auth Test User', balance: 0 })
  })

  /**
   * The reason sessions are stored rather than self-contained: logging out has
   * to revoke something. A stateless token would stay valid until it expired, no
   * matter what the server thought.
   */
  it('is revoked server-side by logging out, not merely forgotten', async () => {
    const email = testEmail()
    const registered = await registerAccount(email)
    const cookie = sessionCookie(registered)!

    expect(
      (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
    ).toBe(200)

    const loggedOut = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    })
    expect(loggedOut.statusCode).toBe(204)

    // The same cookie, replayed. If logout only cleared the browser's copy, this
    // would still work — which is exactly the failure being ruled out.
    const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(after.statusCode).toBe(401)

    expect(await prisma.session.count({ where: { user: { email } } })).toBe(0)
  })

  it('treats an expired session as no session, and cleans it up', async () => {
    const email = testEmail()
    const registered = await registerAccount(email)
    const cookie = sessionCookie(registered)!

    await prisma.session.updateMany({
      where: { user: { email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const response = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })

    expect(response.statusCode).toBe(401)
    expect(await prisma.session.count({ where: { user: { email } } })).toBe(0)
  })

  /**
   * Regression, and one that only a real HTTP client exposed.
   *
   * Many clients set `Content-Type: application/json` on every POST whether or
   * not there is a body, and Fastify's default parser rejects that combination.
   * Logout carries no body, so it failed with a 400 — and the session survived,
   * which is the part that matters.
   *
   * `app.inject` with no payload sends no content-type, so the original tests
   * passed. This one sets the header explicitly to reproduce what a client does.
   */
  it('logs out even when the client declares JSON with an empty body', async () => {
    const email = testEmail()
    const registered = await registerAccount(email)
    const cookie = sessionCookie(registered)!

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '',
    })

    expect(response.statusCode).toBe(204)
    expect(await prisma.session.count({ where: { user: { email } } })).toBe(0)
  })

  it('logging out twice is not an error', async () => {
    const registered = await registerAccount(testEmail())
    const cookie = sessionCookie(registered)!

    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } }))
        .statusCode,
    ).toBe(204)
    expect(
      (await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } }))
        .statusCode,
    ).toBe(204)
  })
})
