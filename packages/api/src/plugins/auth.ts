import type { UserRole } from '@prisma/client'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { prisma } from '../lib/db.js'
import { SESSION_COOKIE, resolveSession } from '../modules/auth/auth.service.js'

/**
 * Authentication.
 *
 * This file was a stub — an `X-Demo-User` header naming whoever you claimed to
 * be — and replacing it with real sessions changed only this file plus the
 * routes that issue them. Every route still reads `request.user` and none of
 * them knows where it came from, which was the entire point of putting the seam
 * here in the first place.
 *
 * The session token arrives in an httpOnly cookie, so no script on the page can
 * read it and an XSS bug cannot exfiltrate a session. It is looked up on every
 * request rather than trusted from the cookie's contents: the cookie carries an
 * opaque random token, and the database holds only its hash, so a stolen
 * database yields nothing anyone can present back.
 */

export type AuthenticatedUser = {
  id: string
  externalRef: string
  displayName: string
  role: UserRole
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The acting user, or null when the request carried no valid session. */
    user: AuthenticatedUser | null
  }
}

/**
 * Applied to the root instance rather than registered as an encapsulated
 * plugin, so the decorator and hook reach every route without needing
 * `fastify-plugin` and its scope-escaping semantics.
 *
 * Resolving is separate from requiring. This hook only says who is asking; it
 * never rejects. The webhook has no acting user at all and must not be forced
 * to invent one, so routes that need an identity opt in with `requireUser`.
 */
export function applyAuth(app: FastifyInstance): void {
  app.decorateRequest('user', null)

  app.addHook('preHandler', async (request) => {
    const token = request.cookies[SESSION_COOKIE]

    if (!token) {
      request.user = null
      return
    }

    // Looked up every request rather than cached in the cookie, which is what
    // makes logout immediate: revoking the row ends the session on the very next
    // request rather than whenever a token would have expired.
    request.user = await resolveSession(prisma, token)
  })
}

/**
 * Route-level guard. Answers 401 when there is no acting user.
 *
 * Deliberately does not distinguish "no cookie" from "session expired or
 * revoked" — both mean the same thing to the caller, which is: log in again.
 */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.status(401).send({
      error: 'unauthenticated',
      message: 'Sign in to continue.',
    })
  }
}

/**
 * Route-level guard for administrative endpoints.
 *
 * Checked on the server, on every request, from the session — never from
 * anything the client sends. The UI hides the developer panel from ordinary
 * users, and that is presentation only: hiding a button removes the temptation,
 * not the capability, and anyone can call the endpoint directly.
 *
 * 403 rather than 404. Concealing the route's existence would be worth doing if
 * the URLs were secret, and they are not — they are in the README. What 403
 * gives instead is an honest answer to an authenticated user who took a wrong
 * turn, rather than sending them to debug a path that does exist.
 *
 * A signed-out caller still gets 401 from `requireUser`, which runs first, so
 * the two failures stay distinguishable: sign in, versus you are signed in and
 * this is not for you.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.status(401).send({
      error: 'unauthenticated',
      message: 'Sign in to continue.',
    })
    return
  }

  if (request.user.role !== 'ADMIN') {
    request.log.warn(
      { userId: request.user.id, url: request.url },
      'non-admin attempted an admin route',
    )

    await reply.status(403).send({
      error: 'forbidden',
      message: 'This area is for administrator accounts.',
    })
  }
}

/**
 * Narrows `request.user` to non-null for handlers behind `requireUser`.
 *
 * The guard already guarantees this, but a preHandler cannot express that to
 * the compiler. One helper that throws if the invariant is broken beats a
 * non-null assertion at every call site — an assertion silently becomes wrong
 * the day someone forgets to attach the guard, whereas this fails loudly.
 */
export function actingUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) {
    throw new Error('actingUser called on a route that is missing the requireUser guard.')
  }
  return request.user
}
