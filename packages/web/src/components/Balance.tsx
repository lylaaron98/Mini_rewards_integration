import { formatPoints } from '../lib/format'
import { Skeleton } from './Skeleton'

/**
 * The balance. The one thing on this screen that must be unmissable.
 *
 * Everything around it is deliberately quiet — grey text, small type, no
 * competing colour — so that the single number a user opens this app to see is
 * the thing their eye lands on first.
 *
 * `tabular-nums` is not a detail. Proportional digits have different widths, so
 * a balance going from 355 to 1,355 reflows, and one ticking down during a
 * redemption visibly jitters. Tabular figures occupy identical widths, so the
 * number changes without the layout moving.
 */
export function Balance({
  balance,
  displayName,
  isLoading,
}: {
  balance: number | undefined
  displayName: string | undefined
  isLoading: boolean
}) {
  return (
    <section
      aria-labelledby="balance-heading"
      aria-busy={isLoading}
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
    >
      <h2 id="balance-heading" className="text-sm font-medium tracking-wide text-slate-500 uppercase">
        Your balance
      </h2>

      {isLoading ? (
        <Skeleton className="mt-3 h-14 w-48" />
      ) : (
        <p className="mt-2 flex items-baseline gap-2">
          {/*
            The number is announced with its unit so a screen reader says
            "355 points" rather than "355", and aria-live means a balance that
            changes after a redemption is spoken without the user hunting for it.
          */}
          <span
            aria-live="polite"
            className="text-5xl font-semibold tabular-nums tracking-tight text-slate-900 sm:text-6xl"
          >
            {formatPoints(balance ?? 0)}
          </span>
          <span className="text-lg font-medium text-slate-500">points</span>
        </p>
      )}

      {displayName && !isLoading && (
        <p className="mt-3 text-sm text-slate-500">
          Signed in as <span className="font-medium text-slate-700">{displayName}</span>
        </p>
      )}
    </section>
  )
}
