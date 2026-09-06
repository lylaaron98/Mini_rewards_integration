import { buildApp } from './app.js'
import { env } from './env.js'
import { prisma } from './lib/db.js'

const app = await buildApp()

try {
  await app.listen({ port: env.PORT, host: env.HOST })
} catch (error) {
  app.log.error({ err: error }, 'failed to start')
  process.exit(1)
}

/**
 * Graceful shutdown, and it matters more here than in a typical CRUD service.
 *
 * A redemption commits its ledger entry and then calls fulfilment outside the
 * transaction. Killing the process between those two steps strands a
 * redemption in RESERVED with the user's points already debited. `app.close()`
 * stops accepting new connections and lets in-flight requests finish, which
 * turns the common case — a deploy, a Ctrl+C — from a data problem into a
 * short wait.
 *
 * `process.once` rather than `on`: a second Ctrl+C from an impatient operator
 * should not start a second shutdown while the first is still draining.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')

    void app
      .close()
      .then(() => prisma.$disconnect())
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'error during shutdown')
        process.exit(1)
      })
  })
}
