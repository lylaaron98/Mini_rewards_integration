import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import { env } from '../../env.js'
import { prisma } from '../../lib/db.js'
import { reconcile } from '../ledger/ledger.service.js'
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

export async function devRoutes(app: FastifyInstance): Promise<void> {
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
