import type { FastifyInstance } from 'fastify'

import { env } from '../../env.js'
import { prisma } from '../../lib/db.js'
import { checkDatabase } from './health.service.js'

/**
 * Routes stay thin: parse the request, call one service function, choose a
 * status code. Any logic worth testing belongs in the service, where it can be
 * tested without an HTTP layer in the way.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Liveness: is this process running.
   *
   * Touches nothing external, on purpose. If liveness depended on the database,
   * a brief database outage would make every API container look dead, get them
   * all restarted, and turn a recoverable blip into an outage of our own
   * making. Liveness answers "restart me?"; readiness answers "route to me?".
   */
  app.get('/live', async () => ({ status: 'ok' as const }))

  /**
   * Readiness: can this process serve real traffic.
   *
   * `prisma` is passed directly as the `tx` argument. It satisfies `Tx`
   * structurally, so a read-only path honours the tx-first convention without
   * opening a transaction it has no use for. See lib/db.ts.
   */
  app.get('/ready', async (request, reply) => {
    const report = await checkDatabase(prisma)

    if (report.database === 'down') {
      request.log.warn({ err: report.error }, 'readiness probe failed')

      // The underlying error can name the host, port and credentials source.
      // Useful on a laptop, an information leak on a public endpoint.
      const body = env.NODE_ENV === 'production' ? { ...report, error: undefined } : report
      return reply.status(503).send(body)
    }

    return reply.status(200).send(report)
  })
}
