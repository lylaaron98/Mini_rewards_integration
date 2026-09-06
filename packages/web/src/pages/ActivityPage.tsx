import { useInfiniteQuery } from '@tanstack/react-query'

import { History } from '../components/History'
import { fetchTransactions } from '../lib/api'

/**
 * The full ledger, paginated.
 *
 * Shares its query key with the overview, so the pages the user has already
 * loaded there are already here — moving between the two costs no request and
 * shows no loading state.
 */
export function ActivityPage() {
  const transactions = useInfiniteQuery({
    queryKey: ['transactions'],
    queryFn: ({ pageParam }) => fetchTransactions(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })

  const entries = transactions.data?.pages.flatMap((page) => page.items)

  return (
    <section aria-labelledby="activity-heading">
      <h2 id="activity-heading" className="text-2xl font-semibold tracking-tight">
        Activity
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Every entry, newest first. Nothing is aggregated — a failed redemption
        appears as a debit and a refund, exactly as it happened.
      </p>

      <div className="mt-5">
        <History
          entries={entries}
          isLoading={transactions.isPending}
          isFetchingMore={transactions.isFetchingNextPage}
          hasMore={transactions.hasNextPage}
          onLoadMore={() => void transactions.fetchNextPage()}
          heading={null}
        />
      </div>
    </section>
  )
}
