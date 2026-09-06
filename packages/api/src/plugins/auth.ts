import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { prisma } from '../lib/db.js'

/**
 * Authentication, stubbed on purpose.
 *
 * An `X-Demo-User` header naming a user's external reference selects who is
 * acting. There are no passwords, no sessions, no tokens, and anyone who can
 * reach the API can act as anyone. That is a conscious cut, not an oversight:
 * building real authentication would have consumed the time that went into the
 * ledger and the redemption path, and it would have demonstrated nothing about
 * the problem this exercise is actually about.
 *
 * What matters is that it is a SINGLE SEAM. Every route reads `request.user` and
 * no route knows where that came from. Replacing this with real sessions means
 * changing the `resolveUser` hook below and nothing else — the routes, the
 * services and the tests are all already written against the seam rather than
 * against the header.
 *
 * The demo switcher in the UI is the visible consequence: it sets this header,
 * which is why switching users is instant and why it must never ship.
 */

export const DEMO_USER_HEADER = 'x-demo-user'

export type AuthenticatedUser = {
  id: string
  externalRef: string
  displayName: string
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The acting user, or null when the request carried no valid identity. */
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
    const header = request.headers[DEMO_USER_HEADER]
    const externalRef = typeof header === 'string' ? header : undefined

    if (!externalRef) {
      request.user = null
      return
    }

    // Looked up every request rather than trusted from the header, so a header
    // naming a deleted or non-existent user resolves to nobody instead of to a
    // half-populated object that fails later, further from the cause.
    const user = await prisma.user.findUnique({
      where: { externalRef },
      select: { id: true, externalRef: true, displayName: true },
    })

    request.user = user
  })
}

/**
 * Route-level guard. Answers 401 when there is no acting user.
 *
 * Deliberately does not distinguish "no header" from "header names someone we
 * do not have" — both mean the same thing to the caller, and telling them apart
 * would let anyone probe which user references exist.
 */
export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.status(401).send({
      error: 'unauthenticated',
      message: `Send a valid ${DEMO_USER_HEADER} header identifying the acting user.`,
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
