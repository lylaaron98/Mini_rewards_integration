import { formatPoints } from '../lib/format'

/**
 * How close this reward is.
 *
 * A meter, not a chart: one ratio against a limit. The fill and the track are the
 * same hue, the track a low-opacity step of it, so the bar reads as one thing
 * filling up rather than two colours competing.
 *
 * The bar never carries the meaning alone. The text beside it says the same
 * thing in words — "395 more needed", "Ready to redeem" — because a bar at 47%
 * is a shape, and the number of points still to earn is the thing the reader
 * actually wants.
 */
export function RewardProgress({
  balance,
  costPoints,
  name,
}: {
  balance: number
  costPoints: number
  name: string
}) {
  const shortfall = costPoints - balance
  const affordable = shortfall <= 0

  /**
   * Clamped at both ends. A negative balance — legitimate after a clawback —
   * would otherwise draw a bar extending the wrong way out of its track, and a
   * balance far above the cost would overflow it.
   */
  const ratio = Math.min(Math.max(balance / costPoints, 0), 1)
  const percent = Math.round(ratio * 100)

  return (
    <div className="mt-3">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={costPoints}
        // The value is announced in points rather than as a percentage, because
        // points are the unit the reader is counting in.
        aria-valuenow={Math.max(Math.min(balance, costPoints), 0)}
        aria-valuetext={
          affordable
            ? `${name}: you have enough points`
            : `${name}: ${formatPoints(Math.max(balance, 0))} of ${formatPoints(costPoints)} points`
        }
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: 'color-mix(in oklab, var(--viz-series) 15%, transparent)' }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
          style={{
            width: `${percent}%`,
            backgroundColor: 'var(--viz-series)',
          }}
        />
      </div>

      <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
        {affordable ? (
          <span className="font-medium text-slate-700 dark:text-slate-300">
            You have enough points
          </span>
        ) : (
          <>
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {formatPoints(shortfall)} more
            </span>{' '}
            needed · {percent}% of the way there
          </>
        )}
      </p>
    </div>
  )
}
