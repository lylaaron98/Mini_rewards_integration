import type { LedgerEntry } from '../lib/api'
import { formatPoints } from '../lib/format'
import { BalanceSparkline } from './BalanceSparkline'
import { Skeleton } from './Skeleton'

/**
 * The balance, as a stat tile: label, hero value, and a trend.
 *
 * The number is the one thing on this screen that must be unmissable, so
 * everything around it is deliberately quiet — grey text, small type, no
 * competing colour. The chart earns the one accent hue on the page because it is
 * the only element carrying data rather than chrome.
 */
export function Balance({
  balance,
  displayName,
  isLoading,
  entries,
}: {
  balance: number | undefined
  displayName: string | undefined
  isLoading: boolean
  entries: LedgerEntry[] | undefined
}) {
  return (
    <section
      aria-labelledby="balance-heading"
      aria-busy={isLoading}
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 dark:border-slate-800 dark:bg-slate-900"
    >
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2
            id="balance-heading"
            className="text-sm font-medium tracking-wide text-slate-500 uppercase dark:text-slate-400"
          >
            Your balance
          </h2>

          {isLoading ? (
            <Skeleton className="mt-3 h-14 w-48" />
          ) : (
            <p className="mt-2 flex items-baseline gap-2">
              {/*
                The number is announced with its unit so a screen reader says
                "355 points" rather than "355", and aria-live means a balance
                that changes after a redemption is spoken without the user
                hunting for it.

                Proportional figures, not tabular. Equal-width digits are for
                columns that must align vertically — the table view below uses
                them — and at display size they make a number look loose.
              */}
              <span
                aria-live="polite"
                className="text-5xl font-semibold tracking-tight text-slate-900 sm:text-6xl dark:text-slate-50"
              >
                {formatPoints(balance ?? 0)}
              </span>
              <span className="text-lg font-medium text-slate-500 dark:text-slate-400">points</span>
            </p>
          )}

          {displayName && !isLoading && (
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
              Signed in as{' '}
              <span className="font-medium text-slate-700 dark:text-slate-200">{displayName}</span>
            </p>
          )}
        </div>

        {!isLoading && (
          <BalanceSparkline entries={entries} currentBalance={balance ?? 0} />
        )}
      </div>
    </section>
  )
}
