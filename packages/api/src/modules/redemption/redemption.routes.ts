import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { prisma } from '../../lib/db.js'
import { actingUser, requireUser } from '../../plugins/auth.js'
import { InsufficientPointsError } from '../ledger/ledger.service.js'
import { RewardNotFoundError, RewardUnavailableError, redeem } from './redemption.service.js'

const IDEMPOTENCY_HEADER = 'idempotency-key'

const redeemBodySchema = z.object({
  rewardId: z.string().uuid('rewardId must be a reward id'),
})

export async function redemptionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', { preHandler: requireUser }, async (request, reply) => {
    const user = actingUser(request)

    /**
     * The idempotency key is REQUIRED, not optional with a generated fallback.
     *
     * A server-generated key would make every request unique, which is the same
     * as having no idempotency at all — and it would look like it worked. Only
     * the client knows whether this submission is the same submission as the one
     * that just timed out on them. Making them say so is the entire mechanism.
     */
    const header = request.headers[IDEMPOTENCY_HEADER]
    const idempotencyKey = typeof header === 'string' ? header.trim() : ''

    if (!idempotencyKey) {
      return reply.status(400).send({
        error: 'idempotency_key_required',
        message: 'Send an Idempotency-Key header. It makes a retried redemption safe.',
      })
    }

    const body = redeemBodySchema.safeParse(request.body)
    if (!body.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: body.error.issues.map((issue) => issue.message).join('; '),
      })
    }

    try {
      const outcome = await redeem(prisma, {
        userId: user.id,
        rewardId: body.data.rewardId,
        idempotencyKey,
      })

      /**
       * 201 for a redemption this request created, 200 for a replay of one that
       * already existed — with an identical body either way.
       *
       * Identical because a client that retried after a timeout must be able to
       * treat both answers the same. If a replay returned less than the original
       * did, the retry would look like a partial success and the client would
       * have to special-case it, which is exactly the burden idempotency exists
       * to remove.
       */
      return reply.status(outcome.replay ? 200 : 201).send(outcome)
    } catch (error) {
      /**
       * Both refusals are 409 — the request was well-formed and the conflict is
       * with current state, not with the request itself — but they carry
       * distinct codes, because they mean opposite things to a user. "Earn more
       * points" is something they can act on; "this is out of stock" is not, and
       * showing the wrong one is worse than showing nothing.
       */
      if (error instanceof InsufficientPointsError) {
        return reply.status(409).send({
          error: error.code,
          message: 'Not enough points for this reward.',
          balance: error.balance,
          required: error.requested,
        })
      }

      if (error instanceof RewardUnavailableError) {
        return reply.status(409).send({ error: error.code, message: error.message })
      }

      if (error instanceof RewardNotFoundError) {
        return reply.status(404).send({ error: error.code, message: 'No such reward.' })
      }

      // Anything else is ours. The error handler logs it and answers 500 without
      // narrating internals to the caller.
      throw error
    }
  })
}
