import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],

    /**
     * Tests needing a live database are named `*.db.test.ts` and run separately
     * via `pnpm test:db`.
     *
     * The split exists so that `pnpm test` is honest: it passes or fails on the
     * code, never on whether Docker happens to be running. The alternative —
     * skipping database tests when no database is reachable — turns a suite that
     * silently tested nothing into a green tick, which is worse than a red one.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.db.test.ts'],
    env: {
      /**
       * `env.ts` exits the process on a missing DATABASE_URL, and importing the
       * app pulls it in transitively, so tests need one present to import
       * anything at all.
       *
       * A syntactically valid URL is enough for tests that never issue a query:
       * Prisma connects lazily, so constructing the client opens no socket. The
       * real value is respected when it is set, which is how the integration
       * tests in later phases will point at the docker-compose database.
       */
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://rewards:rewards@localhost:5433/rewards?schema=public',
      NODE_ENV: 'test',
      // Well above anything a suite sends. Rate limiting is proved by its own
      // test, which builds an app with a limit of two; throttling every other
      // suite would only make them flaky.
      RATE_LIMIT_MAX: '100000',
      AUTH_RATE_LIMIT_MAX: '100000',
      WEBHOOK_RATE_LIMIT_MAX: '100000',
      WEBHOOK_PARTNER: 'acme',
      WEBHOOK_SECRET: 'test-webhook-signing-secret',
      LOG_LEVEL: 'silent',
    },
  },
})
