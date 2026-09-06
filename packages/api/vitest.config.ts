import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
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
      LOG_LEVEL: 'silent',
    },
  },
})
