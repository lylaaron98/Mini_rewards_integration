import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'

import type { UserRole } from '@prisma/client'

import type { Tx } from '../../lib/db.js'

/**
 * Wrapped by hand rather than with `promisify`, whose overload resolution picks
 * the three-argument form of `scrypt` and then rejects the options object that
 * carries the cost parameters — silently losing the only part that makes this a
 * password hash rather than a fast digest.
 */
function deriveKey(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

/**
 * Accounts and sessions.
 *
 * Two bearer credentials live here — a password and a session token — and both
 * get the same treatment: never stored in a form that can be presented back.
 */

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/**
 * scrypt from the Node standard library, rather than bcrypt or argon2.
 *
 * Both of those are better-known, and both are native modules that have to
 * compile — which on Windows means a toolchain a reviewer may not have, turning
 * `pnpm install` into a support question. scrypt is memory-hard, designed for
 * exactly this, and already present, so the dependency-free option is also a
 * defensible one rather than a compromise.
 *
 * N=16384 is the widely used interactive-login cost: roughly 100ms per hash on
 * ordinary hardware, which is negligible for one login and expensive across
 * millions of guesses. That asymmetry is the entire point of a password hash.
 */
const SCRYPT_COST = 16_384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELISM = 1
const KEY_LENGTH = 64

/**
 * Stored as `scrypt$N$r$p$salt$hash`.
 *
 * The parameters travel with the hash rather than living in a constant, so
 * raising the cost later does not invalidate every existing password: an old
 * hash still verifies against the parameters it was created with, and can be
 * re-hashed on the user's next successful login.
 */
export async function hashPassword(password: string): Promise<string> {
  // A per-password salt, so two people choosing the same password get different
  // hashes and one precomputed table cannot break both.
  const salt = randomBytes(16)

  const derived = await deriveKey(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
  })

  return [
    'scrypt',
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELISM,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$')
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupt row should
 * fail the login, not the request.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, cost, blockSize, parallelism, saltHex, hashHex] = stored.split('$')

  if (scheme !== 'scrypt' || !cost || !blockSize || !parallelism || !saltHex || !hashHex) {
    return false
  }

  const expected = Buffer.from(hashHex, 'hex')

  const derived = await deriveKey(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(cost),
    r: Number(blockSize),
    p: Number(parallelism),
  })

  // Constant time. A comparison that returns early leaks how much of a guess was
  // correct, which is enough to recover a hash one byte at a time.
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'mini_rewards_session'

/**
 * Seven days, absolute rather than sliding.
 *
 * A session that renews on every request never expires for whoever is actively
 * using it — which, if the token has been stolen, is exactly the person you want
 * it to expire for.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The database stores the hash of a token, never the token.
 *
 * Same reasoning as a password: a session token is a bearer credential, so a
 * dump of the sessions table should yield nothing anyone can present. SHA-256
 * without a salt is right here and wrong for passwords — the input is 32 random
 * bytes rather than something guessable, so there is no dictionary to defend
 * against and no reason to pay scrypt's cost on every single request.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export type IssuedSession = {
  /** Goes in the cookie. Never stored. */
  token: string
  expiresAt: Date
}

export async function createSession(tx: Tx, userId: string): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)

  await tx.session.create({
    data: { id: hashToken(token), userId, expiresAt },
  })

  return { token, expiresAt }
}

export type SessionUser = {
  id: string
  externalRef: string
  displayName: string
  role: UserRole
}

/**
 * Resolves a cookie token to the user it belongs to, or null.
 *
 * An expired session is deleted on the way past rather than merely ignored. It
 * keeps the table from growing without bound in the common case, and it means a
 * session that has expired is genuinely gone rather than lingering as a row that
 * some future query forgets to filter.
 */
export async function resolveSession(tx: Tx, token: string): Promise<SessionUser | null> {
  const session = await tx.session.findUnique({
    where: { id: hashToken(token) },
    select: {
      expiresAt: true,
      user: { select: { id: true, externalRef: true, displayName: true, role: true } },
    },
  })

  if (!session) return null

  if (session.expiresAt.getTime() <= Date.now()) {
    await tx.session.deleteMany({ where: { id: hashToken(token) } })
    return null
  }

  return session.user
}

/**
 * Logging out revokes the session server-side, which is the whole reason these
 * are stored rather than self-contained. Clearing the cookie alone would leave a
 * copied token working until it expired.
 *
 * `deleteMany` rather than `delete` so logging out twice is not an error.
 */
export async function destroySession(tx: Tx, token: string): Promise<void> {
  await tx.session.deleteMany({ where: { id: hashToken(token) } })
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export class EmailAlreadyRegisteredError extends Error {
  readonly code = 'email_taken'
  constructor() {
    super('That email address is already registered.')
    this.name = 'EmailAlreadyRegisteredError'
  }
}

export type RegisterInput = {
  email: string
  password: string
  displayName: string
}

/**
 * Creates an account.
 *
 * The `externalRef` is generated with a `local:` prefix, because a
 * self-registered user has no partner identifier — nobody has told us they
 * exist. That is honest rather than a placeholder: until a partner sends an
 * event naming this reference, the account earns nothing, which is precisely the
 * UNKNOWN_USER case the ingestion path already handles. The developer panel
 * sends events under the logged-in user's reference, so a new account can still
 * earn immediately.
 *
 * Uniqueness is enforced by the database, not by a prior SELECT. Checking first
 * and inserting second is a race: two simultaneous registrations both find the
 * email free and one fails on the constraint anyway.
 */
export async function register(tx: Tx, input: RegisterInput): Promise<SessionUser> {
  const email = normaliseEmail(input.email)
  const existing = await tx.user.findUnique({ where: { email }, select: { id: true } })

  if (existing) throw new EmailAlreadyRegisteredError()

  return tx.user.create({
    data: {
      email,
      displayName: input.displayName.trim(),
      externalRef: `local:${randomUUID()}`,
      passwordHash: await hashPassword(input.password),
    },
    select: { id: true, externalRef: true, displayName: true, role: true },
  })
}

/**
 * Verifies an email and password, returning the user or null.
 *
 * Null covers all three failures — no such account, no password set, wrong
 * password — because the caller must not be able to tell them apart. A login
 * form that distinguishes "no such user" from "wrong password" is a way to
 * enumerate who has an account here.
 */
export async function authenticate(
  tx: Tx,
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const user = await tx.user.findUnique({
    where: { email: normaliseEmail(email) },
    select: { id: true, externalRef: true, displayName: true, role: true, passwordHash: true },
  })

  if (!user?.passwordHash) {
    /**
     * Hash the supplied password anyway, against nothing.
     *
     * Returning early here would make a request for a non-existent account
     * measurably faster than one for a real account with a wrong password, and
     * that timing difference is itself the account-enumeration oracle the
     * identical error message was meant to close.
     */
    await hashPassword(password)
    return null
  }

  const valid = await verifyPassword(password, user.passwordHash)
  if (!valid) return null

  return {
    id: user.id,
    externalRef: user.externalRef,
    displayName: user.displayName,
    role: user.role,
  }
}

/**
 * Lowercased and trimmed, so `Ada@Example.com ` and `ada@example.com` are one
 * account rather than two. Done in one place because doing it at some call sites
 * and not others is how duplicate accounts appear.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}
