import { z } from 'zod'

/**
 * Environment is validated once, at import time, and the process dies if it is
 * wrong.
 *
 * The alternative — reading `process.env.FOO` at the point of use — defers the
 * failure to whenever that line first runs. For a service that moves points,
 * that could be the middle of a redemption: half-configured is strictly worse
 * than not started, because a process that boots looks healthy to everything
 * upstream of it.
 */
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Checked for the Postgres scheme specifically rather than "is a URL". The
  // failure this prevents is a MySQL or SQLite URL reaching Prisma, where the
  // error surfaces much further from the cause.
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgresql:// connection string'),

  /**
   * The partner whose deliveries this instance accepts, and the secret their
   * signatures are verified against.
   *
   * One partner, because that is what the exercise needs. A real deployment
   * looks these up per partner from a table — `source`, the delivery dedupe key
   * and the route parameter are already scoped per partner, so that change is
   * configuration rather than schema.
   *
   * The secret has a minimum length rather than just being required. A
   * one-character HMAC key passes "is it set?" and provides no security at all,
   * and the failure is completely silent.
   */
  WEBHOOK_PARTNER: z.string().min(1).default('acme'),
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET must be at least 16 characters'),

  /**
   * Probability that the stubbed fulfilment provider fails, 0 to 1.
   *
   * Defaults to 0 so tests and demos are deterministic unless someone asks for
   * chaos. Set it to something like 0.3 to watch the compensating reversal path
   * actually run — a failure branch nobody exercises is a failure branch that
   * does not work.
   */
  FULFILLMENT_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  /**
   * Requests per minute, per caller.
   *
   * Two limits because the two callers fail differently. The user-facing API is
   * reached from a browser and has no reason to send hundreds of requests a
   * minute, so a low ceiling costs nothing. A partner catching up after an
   * outage bursts legitimately, and throttling them there would turn our
   * protection into their lost events — so the webhook allowance is an order of
   * magnitude larger, and its refusal (429) is a transient signal telling them
   * to retry rather than to give up.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(1200),
})

const parsed = environmentSchema.safeParse(process.env)

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')

  // Deliberately console.error rather than the Fastify logger: this runs before
  // the logger exists, and a stack trace here would bury the one line that
  // tells the reader which variable to set.
  console.error(
    `Invalid environment configuration:\n${problems}\n\nDid you copy packages/api/.env.example to packages/api/.env?`,
  )
  process.exit(1)
}

export const env = parsed.data
