import type { LedgerEntry } from '../lib/api'
import { describeSource, describeType, formatDelta, formatTimestamp } from '../lib/format'
import { EmptyState } from './EmptyState'
import { SkeletonRows } from './Skeleton'

/**
 * The ledger, one row per entry.
 *
 * Deliberately not summarised. A failed redemption appears as a debit followed
 * by a refund, two rows, exactly as it happened — not netted to nothing, and not
 * collapsed into a single "cancelled" line. The whole purpose of this screen is
 * that a user can reconstruct their balance from it, and any aggregation makes
 * that impossible while looking tidier.
 *
 * Rendered as a list of rows rather than a `<table>` because there is no
 * meaningful column relationship between entries; each row is a self-contained
 * record, and a list collapses onto a narrow screen without horizontal scroll.
 */
export function History({
  entries,
  isLoading,
  isFetchingMore,
  hasMore,
  onLoadMore,
}: {
  entries: LedgerEntry[] | undefined
  isLoading: boolean
  isFetchingMore: boolean
  hasMore: boolean
  onLoadMore: () => void
}) {
  return (
    <section aria-labelledby="history-heading" aria-busy={isLoading}>
      <h2 id="history-heading" className="text-lg font-semibold text-slate-900">
        Activity
      </h2>

      {isLoading && (
        <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white px-4">
          <SkeletonRows rows={5} />
        </div>
      )}

      {!isLoading && entries?.length === 0 && (
        <EmptyState
          title="Nothing here yet"
          detail="Points appear when the partner sends activity. Use the developer panel below to simulate some."
        />
      )}

      {!isLoading && entries && entries.length > 0 && (
        <>
          <ol className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {entries.map((entry) => (
              <Row key={entry.id} entry={entry} />
            ))}
          </ol>

          {hasMore && (
            <button
              type="button"
              onClick={onLoadMore}
              disabled={isFetchingMore}
              className="mt-3 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
            >
              {isFetchingMore ? 'Loading…' : 'Load more'}
            </button>
          )}

          {!hasMore && entries.length > 15 && (
            <p className="mt-3 text-center text-sm text-slate-500">That is the whole history.</p>
          )}
        </>
      )}
    </section>
  )
}

function Row({ entry }: { entry: LedgerEntry }) {
  const isCredit = entry.delta > 0

  return (
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="font-medium text-slate-900">{entry.description}</p>
        <p className="mt-0.5 text-sm text-slate-500">
          <span>{describeType(entry.type)}</span>
          <span aria-hidden="true"> · </span>
          <span>{describeSource(entry)}</span>
        </p>
        {/*
          The full timestamp, not "3 days ago". Relative time is friendlier and
          useless for reconciliation — the question this screen answers is "what
          happened and exactly when", and a user comparing against a partner's
          records needs the actual moment.
        */}
        <p className="mt-0.5 text-xs text-slate-400">
          <time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt)}</time>
        </p>
      </div>

      {/*
        Colour AND sign. Green versus red alone is invisible to a red-green
        colour-blind reader, so the leading + or − carries the same information
        independently.
      */}
      <p
        className={`shrink-0 text-sm font-semibold tabular-nums ${
          isCredit ? 'text-emerald-700' : 'text-slate-700'
        }`}
      >
        {formatDelta(entry.delta)}
      </p>
    </li>
  )
}
