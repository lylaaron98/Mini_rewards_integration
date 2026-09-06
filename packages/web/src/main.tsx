import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * Short and deliberately not zero. A points balance changes when a
       * webhook lands, which this app has no way to be notified about, so
       * showing a value cached for minutes would mean a user sees a stale
       * balance right after earning. Ten seconds keeps refetches cheap while
       * staying close enough to the truth to be honest.
       */
      staleTime: 10_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
    mutations: {
      /**
       * No automatic retries on mutations, ever. A redemption is a spend: a
       * transparent retry is precisely the double-submit the Idempotency-Key
       * exists to defend against, and a retry the user did not ask for is a
       * retry nobody can reason about. Failures surface to the user, who
       * decides whether to try again.
       */
      retry: 0,
    },
  },
})

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element #root is missing from index.html')
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
