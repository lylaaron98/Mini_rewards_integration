import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import rawBody from 'fastify-raw-body'

import { env } from './env.js'
import { devRoutes } from './modules/dev/dev.routes.js'
import { healthRoutes } from './modules/health/health.routes.js'
import { redemptionRoutes } from './modules/redemption/redemption.routes.js'
import { rewardRoutes } from './modules/reward/reward.routes.js'
import { demoRoutes, userRoutes } from './modules/user/user.routes.js'
import { webhookRoutes } from './modules/webhook/webhook.routes.js'
import { applyAuth } from './plugins/auth.js'

/**
 * Builds the server without starting it.
 *
 * Kept separate from `index.ts` so tests can `app.inject()` requests straight
 * into a real instance — same plugins, same routes, same error handling — with
 * no port to bind and no cleanup race between test files.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },

    // Fastify generates a request id per request; trusting a partner-supplied
    // one would let them collide our log lines with each other.
    requestIdHeader: false,
  })

  /**
   * Registered here, before any route, because it works by installing a
   * content-type parser — and a parser can only be installed before the routes
   * that use it are added.
   *
   * The partner signs `${timestamp}.${rawBody}`, so verification needs the
   * exact bytes that were signed. Re-serialising the parsed JSON does not
   * reproduce them: key order and whitespace are not preserved, so the HMAC
   * would fail on payloads that are perfectly valid. By the time a normal
   * handler runs, the raw copy is gone.
   *
   * `global: false` means only routes that opt in with `config: { rawBody: true }`
   * pay the cost of retaining the buffer — in practice, the webhook alone.
   */
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    encoding: 'utf8',
    runFirst: true,
  })

  // Applied to the root instance so every route can read request.user. It only
  // resolves an identity and never rejects; routes that require one opt in with
  // requireUser, so the webhook is not forced to invent an acting user it does
  // not have.
  applyAuth(app)

  // Every route lives under /api, health included, so the Vite dev proxy needs
  // exactly one rule and there is no second origin for a browser to refuse.
  await app.register(healthRoutes, { prefix: '/api/health' })
  await app.register(webhookRoutes, { prefix: '/api/webhooks' })
  await app.register(userRoutes, { prefix: '/api' })
  await app.register(demoRoutes, { prefix: '/api/demo' })
  await app.register(rewardRoutes, { prefix: '/api/rewards' })
  await app.register(redemptionRoutes, { prefix: '/api/redemptions' })

  /**
   * Registered only outside production, so these routes do not exist in a real
   * deployment rather than existing behind a flag someone can flip. The
   * simulator signs genuine payloads, so it weakens nothing — but an endpoint
   * that lists every delivery and every balance discrepancy is a development
   * tool, and the safest way to keep it one is for it not to be there.
   */
  if (env.NODE_ENV !== 'production') {
    await app.register(devRoutes, { prefix: '/api/dev' })
  }

  /**
   * Fastify's built-in 404 does not pass through `setErrorHandler`, so without
   * this the API would speak two different error dialects: `{ error, message }`
   * everywhere, and `{ statusCode, error, message }` with a human-readable
   * string in `error` for unknown routes. The web client reads `error` as a
   * machine code, so one envelope for every failure is what keeps that honest.
   */
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: 'not_found',
      message: `Route ${request.method}:${request.url} not found.`,
    }),
  )

  /**
   * A single error shape for anything that escapes a handler.
   *
   * Internal errors are logged in full and answered with a generic message: an
   * endpoint that moves points should not narrate its stack trace, constraint
   * names or table structure to an untrusted caller. Client errors (4xx) carry
   * their message through, because those are the ones the caller can act on.
   */
  app.setErrorHandler((error: unknown, request, reply) => {
    // Fastify types this as `unknown` because JavaScript permits throwing any
    // value, not just an Error. Reading `.statusCode` off it directly would be
    // a lie that happens to work until something throws a string.
    const details = error as { statusCode?: number; code?: string; message?: string }
    const status = typeof details.statusCode === 'number' ? details.statusCode : 500

    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error')
      return reply.status(status).send({
        error: 'internal_error',
        message: 'The request could not be completed.',
      })
    }

    request.log.warn({ err: error }, 'request rejected')
    return reply.status(status).send({
      error: details.code ?? 'bad_request',
      message: details.message ?? 'The request was rejected.',
    })
  })

  return app
}
