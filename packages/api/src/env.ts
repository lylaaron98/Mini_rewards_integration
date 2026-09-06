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
