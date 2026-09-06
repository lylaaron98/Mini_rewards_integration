import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      /**
       * The browser only ever talks to the Vite origin; Vite forwards to
       * Fastify. That means there is no cross-origin request in development,
       * so there is no CORS configuration to get subtly wrong — and no
       * preflight behaviour that works locally and fails behind a proxy.
       *
       * One rule covers the whole API because every route is mounted under
       * /api, health included.
       */
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
