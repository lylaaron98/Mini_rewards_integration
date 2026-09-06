import type { FastifyInstance } from 'fastify'

import { env } from '../../env.js'
import { prisma } from '../../lib/db.js'
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from './signature.js'
import { captureDelivery, processDelivery } from './webhook.service.js'
import type { CaptureResult, ProcessOutcome } from './webhook.service.js'

/**
 * Partner activity ingestion.
 *
 * The status code is not decoration here — it is a control signal telling the
 * partner whether to retry. Getting it wrong is expensive in both directions: a
 * 4xx on something transient loses points permanently, and a 5xx on something
 * permanent produces a retry loop that never succeeds. The mapping is set out
 * in `statusCodeFor` below and in NOTES.md.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Take the body as an unparsed string.
   *
   * Fastify's default JSON parser rejects a malformed body with its own 400
   * before any handler runs, which would mean the payloads most worth keeping —
   * the broken ones — are never stored and never explainable. Parsing is this
   * module's job, after the bytes are safely recorded.
   *
   * Registered inside this plugin, so it is scoped to the webhook routes and
   * every other endpoint keeps ordinary JSON parsing.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    done(null, body)
  })

  app.post<{ Params: { partner: string } }>(
    '/:partner',
    { config: { rawBody: true } },
    async (request, reply) => {
      const { partner } = request.params

      /**
       * One configured partner, checked against the route parameter.
       *
       * A real deployment looks up a per-partner signing secret from a table;
       * `source` and the delivery key are already scoped per partner so that
       * change touches configuration rather than schema. Answering 401 rather
       * than 404 for an unknown partner avoids turning this endpoint into a way
       * to enumerate who our partners are.
       */
      if (partner !== env.WEBHOOK_PARTNER) {
        return reply.status(401).send({
          error: 'invalid_signature',
          message: 'Request could not be authenticated.',
        })
      }

      const rawBody = request.rawBody

      if (typeof rawBody !== 'string') {
        // The plugin is registered and the route opts in, so this cannot happen
        // — but signing whatever is left would be worse than failing loudly.
        throw new Error('Raw body was not captured for a webhook request.')
      }

      const verification = verifySignature({
        secret: env.WEBHOOK_SECRET,
        rawBody,
        signature: readHeader(request.headers[SIGNATURE_HEADER]),
        timestamp: readHeader(request.headers[TIMESTAMP_HEADER]),
      })

      if (!verification.valid) {
        /**
         * Unauthenticated requests are NOT persisted.
         *
         * Every other failure mode is recorded, because the evidence is worth
         * keeping. This one is different: we cannot attribute the request to
         * anyone, so storing it would let an unauthenticated caller write rows
         * into our database at will. The reason is echoed back because it helps
         * a partner debug their integration and tells an attacker nothing they
         * could not learn by trying.
         */
        request.log.warn({ partner, reason: verification.reason }, 'webhook signature rejected')

        return reply.status(401).send({
          error: 'invalid_signature',
          message: 'Request could not be authenticated.',
          reason: verification.reason,
        })
      }

      // Capture and process are separate transactions. If they shared one, an
      // error during processing would roll back the record that anything ever
      // arrived, leaving nothing for a retry or a worker to pick up.
      const capture = await prisma.$transaction((tx) => captureDelivery(tx, partner, rawBody))

      /**
       * A duplicate of a delivery that already reached a terminal state is
       * answered from that state without reprocessing.
       *
       * RECEIVED and FAILED are deliberately not terminal. RECEIVED means an
       * earlier attempt was captured but never processed — a crash, or a worker
       * that has not run yet. FAILED means processing hit something transient.
       * In both cases the partner's retry is the second chance the design
       * intends, so it falls through and processes now.
       */
      if (capture.duplicate && isTerminal(capture.status)) {
        return reply.status(statusCodeFor(capture.status, true)).send({
          deliveryId: capture.deliveryId,
          status: capture.status,
          duplicate: true,
        })
      }

      const outcome = await processDelivery(prisma, capture.deliveryId).catch(
        async (error: unknown) => {
          /**
           * Recorded in its own transaction, because the one that just threw is
           * rolled back and cannot write anything. FAILED rather than REJECTED:
           * this is our fault and probably transient, so the 500 that follows
           * invites a retry rather than closing the door on the event.
           */
          await prisma.webhookDelivery.update({
            where: { id: capture.deliveryId },
            data: {
              status: 'FAILED',
              error: error instanceof Error ? error.message : 'Unknown processing error',
            },
          })
          throw error
        },
      )

      return reply
        .status(statusCodeFor(outcome.status, false))
        .send(buildResponseBody(capture, outcome))
    },
  )
}

/** A header can arrive as an array when sent more than once. Take neither. */
function readHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * A type predicate rather than a plain boolean, so the compiler knows that past
 * this check the status is one the response mapping can actually represent.
 * Returning `boolean` would leave RECEIVED and FAILED in the type and force a
 * cast at the call site — a cast that would still be there the day someone adds
 * a fourth terminal state and forgets to handle it.
 */
function isTerminal(status: CaptureResult['status']): status is ProcessOutcome['status'] {
  return status === 'PROCESSED' || status === 'UNMATCHED' || status === 'REJECTED'
}

/**
 * The status code contract.
 *
 * - **202** — accepted. Either credited just now, or parked as UNMATCHED for us
 *   to resolve. Both are "we have it, stop retrying".
 * - **200** — already fully processed on an earlier delivery. Distinguished from
 *   202 so a partner can tell "you have this now" from "you had this already",
 *   which is the only difference a retry cares about.
 * - **400** — permanently invalid. Retrying cannot help and the partner should
 *   stop and look at their payload.
 *
 * Never 409 for a duplicate. On an at-least-once channel duplicates are normal
 * operation, and most retry libraries read any 4xx as failure — so a 409 would
 * trip a partner's alerting for something that worked exactly as designed.
 */
function statusCodeFor(status: ProcessOutcome['status'], mirroredFromEarlier: boolean): number {
  if (status === 'REJECTED') return 400
  if (status === 'UNMATCHED') return 202
  return mirroredFromEarlier ? 200 : 202
}

function buildResponseBody(capture: CaptureResult, outcome: ProcessOutcome) {
  const base = {
    deliveryId: capture.deliveryId,
    status: outcome.status,
    /**
     * True when this event had been seen before — either the delivery was a
     * repeat, or the ledger had already credited the event id through some
     * other path such as a backfill. Both mean "no points moved just now".
     */
    duplicate: capture.duplicate || (outcome.status === 'PROCESSED' && outcome.alreadyCredited),
  }

  if (outcome.status === 'PROCESSED') {
    return { ...base, points: outcome.points, balanceAfter: outcome.balanceAfter }
  }

  if (outcome.status === 'UNMATCHED') {
    // The reason is returned so a partner can see the difference between "we do
    // not know this user yet" and "we have no rule for this activity" — the
    // first often resolves itself, the second needs someone here to act.
    return { ...base, reason: outcome.reason, message: outcome.detail }
  }

  return { ...base, error: 'invalid_payload', message: outcome.error }
}
