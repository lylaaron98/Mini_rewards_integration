import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { env } from '../../env.js'
import { prisma } from '../../lib/db.js'
import { requireAdmin } from '../../plugins/auth.js'
import { reconcile } from '../ledger/ledger.service.js'
import { RewardNotFoundError } from '../redemption/redemption.service.js'
import { RewardSkuTakenError, createReward } from '../reward/reward.service.js'
import { allocateReward } from './allocation.service.js'
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from '../webhook/signature.js'

/**
 * Development-only endpoints.
 *
 * Registered only when NODE_ENV is not production, so in a real deployment these
 * routes do not exist rather than existing behind a flag someone can flip.
 *
 * They are here for one reason: the most interesting behaviour in this service
 * is invisible from the UI. Ingestion, deduplication, unmatched parking and
 * reconciliation all happen behind a webhook that requires a valid HMAC, and a
 * reviewer should not have to hand-craft a signature in a terminal to see any of
 * it work.
 */

const simulateSchema = z.object({
  userRef: z.string().min(1),
  activityType: z.string().min(1),
  /** Defaults to now. Set it to price the event against an older rule version. */
  occurredAt: z.string().datetime({ offset: true }).optional(),
  /**
   * Reuse an event id to demonstrate deduplication: the second send is answered
   * 200 with `duplicate: true` and moves no points.
   */
  eventId: z.string().min(1).optional(),
})

const createRewardSchema = z.object({
  /**
   * Constrained rather than free text. A SKU is an identifier other systems
   * will key on, and one containing a space or a slash becomes a problem in a
   * URL, a CSV export and a partner integration long after it was created.
   */
  sku: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9-]+$/, 'SKU may contain letters, numbers and hyphens only'),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(200),

  /**
   * Positive, matching the CHECK constraint on the table. A zero-cost reward
   * would be free money, and a redemption of one would violate the ledger sign
   * constraint far from the mistake, which was creating it.
   */
  costPoints: z.coerce.number().int().positive().max(1_000_000),

  /** Null means unlimited, matching the column. */
  stock: z.coerce.number().int().min(0).max(1_000_000).nullable().default(null),
})

const allocateSchema = z.object({
  rewardId: z.string().uuid(),

  /**
   * At least one user, capped. An unbounded list would let one request hold the
   * same stock row across hundreds of sequential transactions, and a cap is a
   * cheaper answer than discovering that under load.
   */
  userIds: z.array(z.string().uuid()).min(1).max(100),

  /**
   * Supplied by the caller, exactly like the redemption route. A key minted
   * server-side would be new on every retry, so a double-click would allocate
   * twice — which is the failure it exists to prevent.
   */
  allocationKey: z.string().min(8).max(200),
})

export async function devRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every route in this plugin requires an ADMIN session.
   *
   * Applied once as a hook rather than per route, so a route added later is
   * protected by default. Opting each one in individually means the guard is
   * only ever as good as the memory of whoever adds the next endpoint.
   *
   * This is the real control. The UI hides the developer panel from ordinary
   * users, which removes the temptation and not the capability — these URLs are
   * documented in the README and anyone can call them directly.
   */
  app.addHook('preHandler', requireAdmin)

  /**
   * Signs a payload and posts it to the real webhook route.
   *
   * `app.inject` rather than a fetch to our own port: it goes through the actual
   * route, the actual content-type parser and the actual signature verification,
   * so what a reviewer sees is the production path and not a shortcut around it.
   * A simulator that called `processDelivery` directly would prove nothing about
   * the part most likely to be wrong.
   *
   * The signature is genuine — computed with the same `sign()` the partner would
   * use. There is no bypass, which is why this endpoint can exist without
   * weakening the webhook.
   */
  app.post('/simulate-activity', async (request, reply) => {
    const body = simulateSchema.safeParse(request.body)

    if (!body.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: body.error.issues.map((issue) => issue.message).join('; '),
      })
    }

    const payload = {
      event_id: body.data.eventId ?? `sim_${randomUUID()}`,
      user_ref: body.data.userRef,
      activity_type: body.data.activityType,
      occurred_at: body.data.occurredAt ?? new Date().toISOString(),
    }

    const rawBody = JSON.stringify(payload)
    const timestamp = String(Math.floor(Date.now() / 1000))

    const response = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${env.WEBHOOK_PARTNER}`,
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(env.WEBHOOK_SECRET, timestamp, rawBody),
      },
      payload: rawBody,
    })

    // The webhook's own status code and body are passed straight through, so the
    // panel shows exactly what the partner would have received — 202 for a new
    // credit, 200 for a duplicate, 400 for a rejection.
    return reply.status(response.statusCode).send({
      sentEventId: payload.event_id,
      webhookStatus: response.statusCode,
      webhookResponse: response.json(),
    })
  })

  /**
   * Adds a reward to the catalogue.
   *
   * Administrative rather than developer-only in spirit — a real deployment
   * would have a catalogue screen behind the same role — but it lives here
   * because that screen does not exist and this is where the admin tools are.
   */
  app.post('/rewards', async (request, reply) => {
    const body = createRewardSchema.safeParse(request.body)

    if (!body.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: body.error.issues.map((issue) => issue.message).join('; '),
      })
    }

    try {
      const reward = await prisma.$transaction((tx) => createReward(tx, body.data))
      return reply.status(201).send(reward)
    } catch (error) {
      if (error instanceof RewardSkuTakenError) {
        return reply.status(409).send({ error: error.code, message: error.message })
      }
      throw error
    }
  })

  /**
   * Allocates one reward to one or many users.
   *
   * Each user gets an independent outcome: one person being unreachable — out of
   * stock, or too far in debt for the credit to cover the cost — must not
   * abandon the rest, and the operator needs to know exactly who missed out.
   * So this answers 200 with a per-user result rather than a single status that
   * would have to lie about a partial success.
   */
  app.post('/allocate', async (request, reply) => {
    const body = allocateSchema.safeParse(request.body)

    if (!body.success) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: body.error.issues.map((issue) => issue.message).join('; '),
      })
    }

    try {
      const outcomes = await allocateReward(prisma, body.data)

      return reply.send({
        allocated: outcomes.filter((outcome) => outcome.status === 'ALLOCATED').length,
        failed: outcomes.filter((outcome) => outcome.status === 'FAILED').length,
        outcomes,
      })
    } catch (error) {
      if (error instanceof RewardNotFoundError) {
        return reply.status(404).send({ error: error.code, message: 'No such reward.' })
      }
      throw error
    }
  })

  /**
   * Does every cached balance still equal the sum of its ledger?
   *
   * An empty list is the healthy answer. Exposed because "balances are a cache"
   * is a claim, and a claim a reviewer can check in one click is worth more than
   * a paragraph asserting it.
   */
  app.get('/reconcile', async () => {
    const discrepancies = await reconcile(prisma)
    return { healthy: discrepancies.length === 0, discrepancies }
  })

  /**
   * Recent webhook deliveries, including the ones that produced no ledger entry.
   *
   * This is where UNMATCHED stops being theoretical. An event parked for
   * NO_RULE looks identical to a successful one from the partner's side — both
   * are 202 — and without somewhere to see it, a configuration gap is invisible
   * until someone notices users earning nothing.
   */
  app.get('/deliveries', async () => {
    const deliveries = await prisma.webhookDelivery.findMany({
      orderBy: { receivedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        partner: true,
        externalEventId: true,
        status: true,
        unmatchedReason: true,
        userRef: true,
        activityType: true,
        error: true,
        attempts: true,
        receivedAt: true,
        processedAt: true,
      },
    })

    const unmatched = deliveries.filter((delivery) => delivery.status === 'UNMATCHED')

    return {
      deliveries,
      summary: {
        total: deliveries.length,
        unmatched: unmatched.length,
        noRule: unmatched.filter((d) => d.unmatchedReason === 'NO_RULE').length,
        unknownUser: unmatched.filter((d) => d.unmatchedReason === 'UNKNOWN_USER').length,
      },
    }
  })
}
