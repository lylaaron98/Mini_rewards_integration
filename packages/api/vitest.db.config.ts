import { defineConfig } from 'vitest/config'

/**
 * Integration tests: the ones that assert on database behaviour we cannot
 * verify any other way — constraints firing, locks serialising, transactions
 * rolling back.
 *
 * Run with `pnpm db:up && pnpm test:db`. They are kept out of the default suite
 * so `pnpm test` never depends on Docker being up; see vitest.config.ts.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.db.test.ts'],

    /**
     * These share one database, and several assert on constraint violations, so
     * running files in parallel would let one suite's rows collide with
     * another's expectations. Sequential is slower and correct.
     */
    fileParallelism: false,

    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://rewards:rewards@localhost:5433/rewards?schema=public',
      NODE_ENV: 'test',
      // Well above anything a suite sends. Rate limiting is proved by its own
      // test, which builds an app with a limit of two; throttling every other
      // suite would only make them flaky.
      RATE_LIMIT_MAX: '100000',
      WEBHOOK_RATE_LIMIT_MAX: '100000',
      WEBHOOK_PARTNER: 'acme',
      WEBHOOK_SECRET: 'test-webhook-signing-secret',
      LOG_LEVEL: 'silent',
    },
  },
})
