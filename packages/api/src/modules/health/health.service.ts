import type { Tx } from '../../lib/db.js'

export type HealthReport = {
  status: 'ok' | 'degraded'
  database: 'up' | 'down'
  /** Present only when the database is down; stripped from production responses. */
  error?: string
}

/**
 * Confirms the database will actually answer a query.
 *
 * Takes `tx` as its first parameter like every other service function in this
 * codebase, even though it has nothing to make atomic. The convention is worth
 * more when it has no exceptions: a reader who sees a service signature without
 * a leading `tx` knows immediately that it touches no data, and a reviewer
 * never has to ask which functions opted out.
 *
 * Returns a report instead of throwing. Readiness is a question with a valid
 * negative answer — "no, not yet" is information a load balancer acts on, while
 * an exception here would be rendered as an opaque 500 by the error handler.
 */
export async function checkDatabase(tx: Tx): Promise<HealthReport> {
  try {
    // `SELECT 1` rather than a model query: it proves the connection works
    // without depending on any table existing, so this probe keeps working
    // across migrations instead of failing for an unrelated reason.
    await tx.$queryRaw`SELECT 1`
    return { status: 'ok', database: 'up' }
  } catch (error) {
    return {
      status: 'degraded',
      database: 'down',
      error: error instanceof Error ? error.message : 'unknown error',
    }
  }
}
