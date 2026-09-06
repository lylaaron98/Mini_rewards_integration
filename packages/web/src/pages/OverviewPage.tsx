import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import { Balance } from '../components/Balance'
import { History } from '../components/History'
import { fetchMe, fetchTransactions } from '../lib/api'
import type { Route } from '../lib/use-route'

/**
 * The landing page: how many points, and how they got here.
 *
 * Shows only the most recent entries and hands off to the Activity page for the
 * rest. A dashboard that tries to be the full ledger as well is neither — the
 * job here is the answer at a glance, and "see everything" is a different job on
 * a different page.
 */
export function OverviewPage({ onNavigate }: { onNavigate: (next: Route) => void }) {
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe })

  const transactions = useInfiniteQuery({
    // Same key as the Activity page's default view, so moving between the two
    // costs no request and shows no loading state.
    queryKey: ['transactions', { type: null, order: 'newest' }],
    queryFn: ({ pageParam }) => fetchTransactions(pageParam, { order: 'newest' }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })

  const entries = transactions.data?.pages.flatMap((page) => page.items)

  return (
    <div className="space-y-6">
      <Balance
        balance={me.data?.balance}
        displayName={me.data?.displayName}
        isLoading={me.isPending}
        entries={entries}
      />

      {me.isError && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
          Could not load your balance. Is the API running?
        </p>
      )}

      <div>
        <History
          entries={entries?.slice(0, 5)}
          isLoading={transactions.isPending}
          isFetchingMore={false}
          // The overview never paginates. "Load more" here would slowly turn this
          // page into the Activity page and leave neither doing its job.
          hasMore={false}
          onLoadMore={() => undefined}
          heading="Recent activity"
        />

        {(entries?.length ?? 0) > 5 && (
          <a
            href="#/activity"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey) return
              event.preventDefault()
              onNavigate('activity')
            }}
            className="mt-3 inline-block text-sm font-medium text-slate-700 underline underline-offset-2 dark:text-slate-300"
          >
            See all activity
          </a>
        )}
      </div>
    </div>
  )
}
