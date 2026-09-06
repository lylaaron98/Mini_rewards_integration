import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'

import { env } from '../../env.js'
import { prisma } from '../../lib/db.js'
import { actingUser, requireUser } from '../../plugins/auth.js'
import {
  EmailAlreadyRegisteredError,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  authenticate,
  createSession,
  destroySession,
  register,
} from './auth.service.js'

/**
 * Login, registration and logout.
 *
 * The session lives in an httpOnly cookie, which is the part that matters: no
 * script on the page can read it, so an XSS bug anywhere in the app cannot
 * exfiltrate a session. A token in `localStorage` would be readable by any
 * script that ran, which for an application whose whole premise is that points
 * are money is not a trade worth making.
 */

const credentialsSchema = z.object({
  /**
   * Trimmed before validation, not after.
   *
   * Validating first rejects "ada@example.com " as malformed, which is a
   * baffling error for someone whose paste picked up a trailing space — and
   * the service lowercases and trims anyway, so the only effect of checking
   * first was to refuse input it was about to accept.
   */
  email: z.string().trim().email('A valid email address is required'),
  /**
   * Eight characters, checked server-side.
   *
   * A client-side rule is a hint; this is the rule. Length is the only
   * requirement — composition rules ("one uppercase, one symbol") push people
   * toward `Password1!` and are weaker in practice than simply requiring more
   * characters.
   */
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

const registerSchema = credentialsSchema.extend({
  displayName: z.string().min(1, 'A display name is required').max(80),
})

/**
 * A much tighter allowance than the rest of the API.
 *
 * Login is where an attacker guesses, and the global limit of 120 a minute is
 * generous enough to be useful to them. Ten attempts a minute is invisible to
 * someone typing their own password and ruinous to a dictionary.
 */
const AUTH_RATE_LIMIT = { max: env.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' }

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Accepts an empty body on a JSON request.
   *
   * Fastify's default parser rejects `Content-Type: application/json` with no
   * body as `FST_ERR_CTP_EMPTY_JSON_BODY`, which is reasonable for a request
   * that should carry data and wrong for logout, which carries none. Plenty of
   * HTTP clients set that header on every POST regardless — PowerShell's
   * `Invoke-WebRequest` does — so without this, logging out fails with a
   * baffling 400 and, worse, the session stays alive.
   *
   * Browsers happen to avoid it, because `fetch` with no body sends no
   * content-type at all. That is exactly why this was not caught by the tests:
   * `app.inject` behaves the same way, so the failure only appeared against a
   * real client.
   *
   * Scoped to this plugin, so the webhook's own parser and ordinary JSON
   * handling elsewhere are untouched.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body === '') {
        done(null, {})
        return
      }

      try {
        done(null, JSON.parse(body))
      } catch (error) {
        done(error as Error, undefined)
      }
    },
  )

  app.post('/register', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const body = registerSchema.safeParse(request.body)

    if (!body.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: body.error.issues.map((issue) => issue.message).join('; '),
      })
    }

    try {
      const user = await prisma.$transaction(async (tx) => {
        const created = await register(tx, body.data)
        const session = await createSession(tx, created.id)
        setSessionCookie(reply, session.token)
        return created
      })

      // Includes the role, like every other place a session user is returned.
      // A response whose shape differs from /api/auth/me would make the client
      // type a lie the moment anything branched on it.
      return reply.status(201).send(user)
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        /**
         * The one place account existence is deliberately disclosed.
         *
         * A registration form cannot avoid it: refusing to say the address is
         * taken while also refusing to create the account leaves the person
         * stuck with no way forward. The login form, which has no such excuse,
         * gives nothing away.
         */
        return reply.status(409).send({ error: error.code, message: error.message })
      }
      throw error
    }
  })

  app.post('/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const body = credentialsSchema.safeParse(request.body)

    if (!body.success) {
      // Deliberately not itemised. "Password must be at least 8 characters" on a
      // login form tells an attacker the minimum length without helping anyone
      // who already knows their own password.
      return reply.status(401).send({
        error: 'invalid_credentials',
        message: 'Email or password is incorrect.',
      })
    }

    const user = await prisma.$transaction(async (tx) => {
      const authenticated = await authenticate(tx, body.data.email, body.data.password)
      if (!authenticated) return null

      const session = await createSession(tx, authenticated.id)
      setSessionCookie(reply, session.token)
      return authenticated
    })

    if (!user) {
      request.log.warn({ email: body.data.email }, 'failed login')
      return reply.status(401).send({
        error: 'invalid_credentials',
        message: 'Email or password is incorrect.',
      })
    }

    return reply.send(user)
  })

  /**
   * Revokes the session server-side, not just in the browser.
   *
   * Clearing the cookie alone would leave a copied token valid until it expired,
   * which is the failure a stateless token cannot avoid and this design exists
   * to prevent.
   *
   * Answers 204 whether or not there was a session: logging out when already
   * logged out is not an error, and a client cleaning up should not have to
   * branch on it.
   */
  app.post('/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]

    if (token) {
      await prisma.$transaction((tx) => destroySession(tx, token))
    }

    clearSessionCookie(reply)
    return reply.status(204).send()
  })

  /** Who am I, for the client to restore state on load. */
  app.get('/me', { preHandler: requireUser }, async (request) => actingUser(request))
}

function cookieOptions() {
  return {
    /** Unreadable to JavaScript. The single most important flag here. */
    httpOnly: true,

    /**
     * `lax` rather than `strict`: it still refuses to send the cookie on a
     * cross-site POST, which is the CSRF vector that matters for an API whose
     * state changes are all POSTs, while not breaking an ordinary top-level
     * navigation into the app from an email or a bookmark.
     */
    sameSite: 'lax' as const,

    /**
     * HTTPS only in production. Not in development, where the dev server is
     * plain HTTP and a `secure` cookie would simply never be stored — which
     * presents as "login does nothing" and takes an hour to diagnose.
     */
    secure: env.NODE_ENV === 'production',

    path: '/',
  }
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    ...cookieOptions(),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  })
}

function clearSessionCookie(reply: FastifyReply): void {
  // Cleared with the same attributes it was set with. A cookie cleared with a
  // different path or sameSite is not the same cookie, and the browser keeps
  // the original.
  reply.clearCookie(SESSION_COOKIE, cookieOptions())
}
