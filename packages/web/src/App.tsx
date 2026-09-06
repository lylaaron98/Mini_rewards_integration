import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { fetchHealth } from './lib/api'

/**
 * Phase 0 shell. Its job is to prove the whole path works end to end —
 * browser, Vite proxy, Fastify, Prisma, Postgres — so that when the balance and
 * redemption views arrive in later phases, any failure is in the new code
 * rather than in the plumbing underneath it.
 */
export function App() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    // A readiness probe is the one thing worth polling: it is the signal that
    // tells a developer their database container has finished starting.
    refetchInterval: 5_000,
  })

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <header>
          <h1 className="text-3xl font-semibold tracking-tight">Mini Rewards</h1>
          <p className="mt-2 text-slate-600">
            Points earned from partner activity, redeemable for rewards.
          </p>
        </header>

        <section className="mt-10 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            System status
          </h2>

          <div className="mt-4 flex items-center gap-3">
            <StatusDot
              state={
                health.isPending
                  ? 'pending'
                  : health.data?.database === 'up'
                    ? 'up'
                    : 'down'
              }
            />
            <span className="font-medium">
              {health.isPending
                ? 'Checking API…'
                : health.data?.database === 'up'
                  ? 'API and database reachable'
                  : 'API or database unreachable'}
            </span>
          </div>

          {health.isError && (
            <p className="mt-3 text-sm text-slate-600">
              {health.error instanceof Error ? health.error.message : 'Request failed'}
            </p>
          )}

          {health.data?.error && (
            <pre className="mt-3 overflow-x-auto rounded bg-slate-100 p-3 text-xs text-slate-700">
              {health.data.error}
            </pre>
          )}

          <p className="mt-6 border-t border-slate-100 pt-4 text-sm text-slate-500">
            Is the database unreachable? Run <Code>pnpm db:up</Code>, then{' '}
            <Code>pnpm db:migrate</Code>.
          </p>
        </section>
      </div>
    </div>
  )
}

function StatusDot({ state }: { state: 'pending' | 'up' | 'down' }) {
  const color =
    state === 'up' ? 'bg-emerald-500' : state === 'down' ? 'bg-red-500' : 'bg-slate-300'

  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} aria-hidden />
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">{children}</code>
}
