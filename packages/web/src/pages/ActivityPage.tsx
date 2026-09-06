import { useInfiniteQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { History } from '../components/History'
import { fetchTransactions } from '../lib/api'
import type { TransactionOrder, TransactionType } from '../lib/api'

/**
 * The full ledger, filtered and ordered.
 *
 * Both controls are server-side rather than applied to whatever happens to be
 * loaded. Filtering a page of fifteen in the browser would show "3 results" from
 * the most recent fifteen entries while silently ignoring the other four hundred
 * — an answer that looks precise and is wrong, on the one screen whose job is
 * that a person can audit their own balance.
 */

type TypeFilter = TransactionType | 'ALL'

const TYPE_FILTERS: Array<{ id: TypeFilter; label: string; hint: string }> = [
  { id: 'ALL', label: 'Everything', hint: 'Every entry in the ledger' },
  { id: 'EARN', label: 'Earned', hint: 'Credits from partner activity' },
  { id: 'REDEEM', label: 'Spent', hint: 'Points spent on rewards' },
  { id: 'REVERSAL', label: 'Refunded', hint: 'Reversals of an earlier entry' },
  { id: 'ADJUSTMENT', label: 'Adjusted', hint: 'Manual corrections and admin allocations' },
]

const ORDERS: Array<{ id: TransactionOrder; label: string }> = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
]

export function ActivityPage() {
  const [type, setType] = useState<TypeFilter>('ALL')
  const [order, setOrder] = useState<TransactionOrder>('newest')

  const filters = { type: type === 'ALL' ? undefined : type, order }

  const transactions = useInfiniteQuery({
    /**
     * The filters are part of the key, which is what makes changing one correct
     * rather than merely convenient: a cursor is only meaningful for the query
     * that issued it, so a new filter starts a new list instead of resuming an
     * old one with a cursor that no longer means what it did.
     */
    queryKey: ['transactions', { type: filters.type ?? null, order }],
    queryFn: ({ pageParam }) => fetchTransactions(pageParam, filters),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  })

  const entries = transactions.data?.pages.flatMap((page) => page.items)
  const loaded = entries?.length ?? 0

  return (
    <section aria-labelledby="activity-heading">
      <h2 id="activity-heading" className="text-2xl font-semibold tracking-tight">
        Activity
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Every entry, exactly as it happened. Nothing is aggregated — a failed
        redemption appears as a debit and a refund rather than cancelling out.
      </p>

      {/* Controls in one row above the list, so they and what they control are
          never separated by scrolling. */}
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by type">
          {TYPE_FILTERS.map((filter) => {
            const active = type === filter.id

            return (
              <button
                key={filter.id}
                type="button"
                title={filter.hint}
                // A toggle's state has to be announced, not just coloured.
                aria-pressed={active}
                onClick={() => setType(filter.id)}
                className={`rounded-full border px-3 py-1.5 text-sm transition ${
                  active
                    ? 'border-slate-900 bg-slate-900 font-medium text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900'
                    : 'border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
              >
                {filter.label}
              </button>
            )
          })}
        </div>

        <div className="shrink-0">
          <label
            htmlFor="activity-order"
            className="block text-sm font-medium text-slate-700 dark:text-slate-300"
          >
            Order
          </label>
          {/* A native select: keyboard-accessible, screen-reader correct and
              native on mobile without a line of code, none of which is true of
              a div-based dropdown by default. */}
          <select
            id="activity-order"
            value={order}
            onChange={(event) => setOrder(event.target.value as TransactionOrder)}
            className="mt-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
          >
            {ORDERS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/*
        Announced politely, because pressing a filter gives no other feedback
        until the list below redraws — and says "so far" rather than a total,
        since a paginated list genuinely does not know how many more there are.
      */}
      {!transactions.isPending && (
        <p aria-live="polite" className="mt-3 text-sm text-slate-500 dark:text-slate-400">
          {loaded} {loaded === 1 ? 'entry' : 'entries'} loaded
          {transactions.hasNextPage ? ' so far' : ''}
          {type === 'ALL' ? '' : ` · ${TYPE_FILTERS.find((f) => f.id === type)?.label.toLowerCase()}`}
        </p>
      )}

      <div className="mt-3">
        <History
          entries={entries}
          isLoading={transactions.isPending}
          isFetchingMore={transactions.isFetchingNextPage}
          hasMore={transactions.hasNextPage}
          onLoadMore={() => void transactions.fetchNextPage()}
          heading={null}
          emptyDetail={
            type === 'ALL'
              ? 'Points appear when the partner sends activity.'
              : 'No entries of that kind yet. Try “Everything”.'
          }
        />
      </div>
    </section>
  )
}
