import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Component tests.
 *
 * These exist because a passing `vite build` proves the code compiles and
 * nothing more. Every interesting failure in this UI is a runtime one — a null
 * balance, a dialog that never opens, an error code with no copy written for it
 * — and none of those are visible until something renders.
 *
 * Tailwind is deliberately not loaded here: these assert behaviour and text, not
 * appearance, and pulling the CSS pipeline in would slow every run to test
 * something jsdom cannot see anyway.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.tsx'],
  },
})
