import { useMemo, useRef, useState } from 'react'

import type { LedgerEntry } from '../lib/api'
import { formatPoints, formatTimestamp } from '../lib/format'

/**
 * Balance over time, as the trend half of a stat tile.
 *
 * The headline number answers "how many points do I have"; this answers "and how
 * did I get here". One series, so one hue and no legend — the label above names
 * it, and a legend box for a single line is chrome doing nothing.
 *
 * A **step** line rather than a smooth one, because that is what the data is: a
 * balance does not drift between transactions, it holds flat and then jumps. An
 * interpolated curve would draw values the user never had, which on a screen
 * whose entire job is auditability is a small lie told continuously.
 */

/** Internal coordinate space. The SVG scales; the geometry does not. */
const VIEW_WIDTH = 260
const VIEW_HEIGHT = 76
const PADDING = { top: 8, right: 10, bottom: 8, left: 10 }

export type Point = {
  time: number
  balance: number
  /** What happened at this point. Absent on the opening balance. */
  entry?: LedgerEntry
}

/**
 * Reconstructs the balance after every entry, working backwards from the
 * current one.
 *
 * Derived from the history the page has already loaded rather than fetched from
 * a second endpoint. Two reasons: the chart can never disagree with the list
 * underneath it, which it could if the two were fetched separately and one was
 * stale; and it extends for free when the user presses "Load more".
 *
 * `entries` arrive newest first, so this walks forward through them subtracting
 * each delta to recover the balance *before* it, then reverses into chronological
 * order.
 */
export function buildSeries(entries: LedgerEntry[], currentBalance: number): Point[] {
  if (entries.length === 0) return []

  const points: Point[] = []
  let running = currentBalance

  for (const entry of entries) {
    points.push({ time: new Date(entry.createdAt).getTime(), balance: running, entry })
    running -= entry.delta
  }

  // The opening balance: what they held immediately before the oldest entry
  // loaded. Without it the chart would start at the value *after* the first
  // visible transaction and hide that transaction's own effect.
  const oldest = entries[entries.length - 1]
  if (oldest) {
    points.push({ time: new Date(oldest.createdAt).getTime(), balance: running })
  }

  return points.reverse()
}

export function BalanceSparkline({
  entries,
  currentBalance,
}: {
  entries: LedgerEntry[] | undefined
  currentBalance: number
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const points = useMemo(
    () => buildSeries(entries ?? [], currentBalance),
    [entries, currentBalance],
  )

  const geometry = useMemo(() => {
    if (points.length < 2) return null

    const times = points.map((point) => point.time)
    const balances = points.map((point) => point.balance)

    const minTime = Math.min(...times)
    const maxTime = Math.max(...times)
    const minBalance = Math.min(...balances)
    const maxBalance = Math.max(...balances)

    const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right
    const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom

    // A flat history has no range to scale against; dividing by it would put
    // every point at NaN and render nothing. Centre the line instead.
    const timeSpan = maxTime - minTime || 1
    const balanceSpan = maxBalance - minBalance || 1
    const flat = maxBalance === minBalance

    const x = (time: number) => PADDING.left + ((time - minTime) / timeSpan) * plotWidth
    const y = (balance: number) =>
      flat
        ? PADDING.top + plotHeight / 2
        : PADDING.top + plotHeight - ((balance - minBalance) / balanceSpan) * plotHeight

    const coords = points.map((point) => ({ x: x(point.time), y: y(point.balance) }))

    // Step-after: hold the previous value across to the new x, then jump. This
    // is the shape of a balance rather than a guess about what it did in between.
    let line = `M ${coords[0]?.x ?? 0} ${coords[0]?.y ?? 0}`
    for (let index = 1; index < coords.length; index += 1) {
      const previous = coords[index - 1]
      const current = coords[index]
      if (!previous || !current) continue
      line += ` L ${current.x} ${previous.y} L ${current.x} ${current.y}`
    }

    const baseline = VIEW_HEIGHT - PADDING.bottom
    const first = coords[0]
    const last = coords[coords.length - 1]
    const area =
      first && last ? `${line} L ${last.x} ${baseline} L ${first.x} ${baseline} Z` : line

    return { coords, line, area, minBalance, maxBalance }
  }, [points])

  if (!geometry) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        A trend appears here once there are at least two transactions.
      </p>
    )
  }

  const { coords, line, area } = geometry
  const active = activeIndex === null ? null : points[activeIndex]
  const activeCoord = activeIndex === null ? null : coords[activeIndex]
  const last = coords[coords.length - 1]

  const firstPoint = points[0]
  const lastPoint = points[points.length - 1]
  const change =
    firstPoint && lastPoint ? lastPoint.balance - firstPoint.balance : 0

  /** Maps a pointer position to the nearest point's index. */
  const nearestIndex = (clientX: number): number => {
    const svg = svgRef.current
    if (!svg) return 0

    const rect = svg.getBoundingClientRect()
    const viewX = ((clientX - rect.left) / rect.width) * VIEW_WIDTH

    let closest = 0
    let bestDistance = Infinity

    coords.forEach((coord, index) => {
      const distance = Math.abs(coord.x - viewX)
      if (distance < bestDistance) {
        bestDistance = distance
        closest = index
      }
    })

    return closest
  }

  return (
    <figure className="m-0 w-full max-w-xs">
      <figcaption className="flex items-baseline justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span>Balance over time</span>
        <span>
          {change === 0 ? 'no change' : `${change > 0 ? '+' : '−'}${formatPoints(Math.abs(change))}`}
          {firstPoint && ` since ${new Date(firstPoint.time).toLocaleDateString()}`}
        </span>
      </figcaption>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        width="100%"
        height={VIEW_HEIGHT}
        className="mt-1 touch-none overflow-visible"
        role="img"
        aria-label={`Balance over time, from ${formatPoints(firstPoint?.balance ?? 0)} to ${formatPoints(lastPoint?.balance ?? 0)} points across ${points.length} points in time. The full figures are in the table below.`}
        tabIndex={0}
        onPointerMove={(event) => setActiveIndex(nearestIndex(event.clientX))}
        onPointerLeave={() => setActiveIndex(null)}
        /*
          Keyboard gets what the pointer gets. A tooltip reachable only by mouse
          would make the hover layer a gate rather than an enhancement — which is
          why focus opens it and the arrow keys walk it.
        */
        onFocus={() => setActiveIndex(points.length - 1)}
        onBlur={() => setActiveIndex(null)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()

          setActiveIndex((current) => {
            const from = current ?? points.length - 1
            const next = event.key === 'ArrowLeft' ? from - 1 : from + 1
            return Math.min(Math.max(next, 0), points.length - 1)
          })
        }}
      >
        {/* A wash, not a saturated block. The line carries the data; the fill
            only gives it a body so the shape reads at this size. */}
        <path d={area} fill="var(--viz-series)" fillOpacity="0.1" />

        <path
          d={line}
          fill="none"
          stroke="var(--viz-series)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          /* Keeps the 2px stroke at 2px however wide the card gets, rather than
             thickening with the viewBox scale. */
          vectorEffect="non-scaling-stroke"
        />

        {/* The current value, direct-marked. One marker rather than a dot on
            every point, which at this density would be noise. */}
        {last && (
          <circle
            cx={last.x}
            cy={last.y}
            r="3.5"
            fill="var(--viz-series)"
            stroke="var(--viz-surface)"
            strokeWidth="2"
          />
        )}

        {/* The crosshair finds the X, so the reader aims at a moment in time
            rather than at a two-pixel line. */}
        {activeCoord && (
          <g>
            <line
              x1={activeCoord.x}
              y1={PADDING.top}
              x2={activeCoord.x}
              y2={VIEW_HEIGHT - PADDING.bottom}
              stroke="var(--viz-axis)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={activeCoord.x}
              cy={activeCoord.y}
              r="4"
              fill="var(--viz-series)"
              stroke="var(--viz-surface)"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>

      {/*
        The readout. Value first and high-contrast, context second — the reader
        already knows which series they are looking at and wants the number.

        Given a reserved height so the card does not jump as the pointer moves
        in and out of the plot.
      */}
      <p className="mt-1 min-h-[2.5rem] text-xs">
        {active ? (
          <>
            <span className="font-semibold text-slate-900 tabular-nums dark:text-slate-100">
              {formatPoints(active.balance)} points
            </span>
            <span className="block text-slate-500 dark:text-slate-400">
              {active.entry
                ? `${active.entry.description} · ${formatTimestamp(active.entry.createdAt)}`
                : 'Opening balance for this period'}
            </span>
          </>
        ) : (
          <span className="block text-slate-400 dark:text-slate-500">
            Hover or focus the chart for a reading.
          </span>
        )}
      </p>

      {/*
        The table view. A tooltip enhances; it must never be the only way to read
        a value — someone using a screen reader, or printing the page, gets the
        same figures from here.
      */}
      <details className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer">Table view</summary>
        <table className="mt-2 w-full">
          <caption className="sr-only">Balance after each transaction</caption>
          <thead>
            <tr className="text-left">
              <th scope="col" className="font-medium">
                When
              </th>
              <th scope="col" className="text-right font-medium">
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point, index) => (
              <tr key={`${point.time}-${index}`}>
                <td className="pr-2">{new Date(point.time).toLocaleString()}</td>
                {/* tabular-nums here and not on the hero: these align in a
                    column, which is exactly what equal-width digits are for. */}
                <td className="text-right tabular-nums">{formatPoints(point.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}
