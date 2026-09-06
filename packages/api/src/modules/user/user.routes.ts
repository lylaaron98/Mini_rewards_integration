import type { FastifyInstance } from 'fastify'

import { prisma } from '../../lib/db.js'
import { actingUser, requireUser } from '../../plugins/auth.js'
import { getMe, listUsers } from './user.service.js'

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
}

/**
 * The demo user switcher.
 *
 * Registered separately and without `requireUser`, because the UI needs it
 * before anyone has been selected — the list is what lets you pick. It exists
 * only because authentication is stubbed, and real sessions delete it rather
 * than securing it.
 */
export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/users', async () => listUsers(prisma))
}
