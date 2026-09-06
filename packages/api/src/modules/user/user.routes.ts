import { TransactionType } from '@prisma/client'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { prisma } from '../../lib/db.js'
import { actingUser, requireUser } from '../../plugins/auth.js'
import { listTransactions } from '../ledger/ledger.service.js'
import { getMe, listUsers } from './user.service.js'

const transactionQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  /**
   * Capped at 100. An uncapped limit lets any client turn one request into a
   * full table scan, and nothing in this UI needs more than a screenful.
   */
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.nativeEnum(TransactionType).optional(),
})

export async function userRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The acting user and their balance.
   *
   * `prisma` is passed straight in as the `tx`: this only reads, so it satisfies
   * the tx-first convention without opening a transaction it does not need.
   */
  app.get('/me', { preHandler: requireUser }, async (request, reply) => {
    const me = await getMe(prisma, actingUser(request).id)

    if (!me) {
      // The auth hook resolved this user moments ago, so reaching here means
      // they were deleted mid-request. Vanishingly rare, and still not a 500.
      return reply.status(404).send({ error: 'user_not_found', message: 'No such user.' })
    }

    return reply.send(me)
  })

  /**
   * The acting user's ledger, newest first, cursor-paginated.
   *
   * Every entry is returned as it was written — no aggregation, no rolling up
   * of a redemption and its reversal into a net figure. The screen this feeds
   * exists so a person can audit what happened, and a smoothed history is not
   * an audit trail. A failed redemption showing as a debit followed by a refund
   * is the truth; showing nothing at all, because they cancel out, hides the
   * event that most needs explaining.
   */
  app.get('/me/transactions', { preHandler: requireUser }, async (request, reply) => {
    const query = transactionQuerySchema.safeParse(request.query)

    if (!query.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: query.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      })
    }

    const page = await listTransactions(prisma, {
      userId: actingUser(request).id,
      cursor: query.data.cursor,
      limit: query.data.limit,
      type: query.data.type,
    })

    return reply.send(page)
  })
}

/**
 * The seeded demo accounts.
 *
 * Deliberately unauthenticated, because the sign-in screen lists them before
 * anyone has a session — that is its only reason to exist. It returns display
 * names and partner references, never email addresses or roles beyond what the
 * screen shows, and it is seed data for a local database.
 *
 * A real deployment deletes this endpoint rather than securing it: an endpoint
 * that enumerates accounts has no place in one.
 */
export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', async () => listUsers(prisma))
}
