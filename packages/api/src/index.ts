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
 * How long to let in-flight requests finish before giving up on them.
 *
 * Longer than the redemption transaction's own 15-second bound, so a redemption
 * that is already running gets to reach a commit or a rollback rather than
 * being cut off partway. Shorter than the grace period an orchestrator
 * typically allows before sending SIGKILL, so the process gets to exit on its
 * own terms instead of being killed mid-write.
 */
const SHUTDOWN_GRACE_MS = 20_000

/**
 * Graceful shutdown, and it matters more here than in a typical CRUD service.
 *
 * A redemption commits its ledger entry and then calls fulfilment outside the
 * transaction. Killing the process between those two steps strands a redemption
 * in RESERVED with the user's points already debited — the exact state the
 * sweeper described in NOTES.md would have to clean up. `app.close()` stops
 * accepting new connections and lets in-flight requests finish, which turns the
 * common case — a deploy, a Ctrl+C — from a data problem into a short wait.
 *
 * The timeout is the honest part. Waiting forever for a wedged request is not
 * graceful, it is a hang that an orchestrator eventually resolves with SIGKILL,
 * which is strictly worse than exiting deliberately. So the drain races a clock,
 * and losing that race is logged as the incident it is rather than passed over
 * in silence.
 *
 * `process.once` rather than `on`: a second Ctrl+C from an impatient operator
 * should not start a second shutdown while the first is still draining.
 */
async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal, graceMs: SHUTDOWN_GRACE_MS }, 'shutting down, draining requests')

  let drained = false

  const drain = app.close().then(() => {
    drained = true
  })

  const grace = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS)
    // Do not hold the event loop open on account of the timer itself; if the
    // drain finishes first, the process should be free to exit immediately.
    timer.unref()
  })

  await Promise.race([drain, grace])

  if (!drained) {
    app.log.error(
      { signal, graceMs: SHUTDOWN_GRACE_MS },
      'requests still in flight at the end of the grace period; exiting anyway',
    )
  }

  await prisma.$disconnect()
  process.exit(drained ? 0 : 1)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      app.log.error({ err: error }, 'error during shutdown')
      process.exit(1)
    })
  })
}
