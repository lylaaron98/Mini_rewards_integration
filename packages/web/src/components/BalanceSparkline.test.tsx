import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BalanceSparkline, buildSeries } from './BalanceSparkline'
import type { LedgerEntry } from '../lib/api'

/**
 * The chart's arithmetic and its geometry.
 *
 * The maths is the part most likely to be wrong: the series is reconstructed by
 * walking *backwards* from the current balance, subtracting each delta, and an
 * off-by-one there draws a plausible line that is quietly wrong — which on a
 * screen about auditability is the worst kind of bug.
 *
 * The geometry is checked numerically because there is no browser here to look
 * at. A path containing `NaN` renders as nothing at all, and a coordinate
 * outside the viewBox silently clips.
 */

const entry = (id: string, delta: number, createdAt: string): LedgerEntry => ({
  id,
  delta,
  type: delta > 0 ? 'EARN' : 'REDEEM',
  description: `Entry ${id}`,
  source: 'partner:test',
  createdAt,
})

describe('buildSeries', () => {
  /**
   * Newest first in, chronological out — with the balance *after* each entry,
   * reconstructed from the current one.
   */
  it('reconstructs the balance after every entry', () => {
    const entries = [
      entry('c', -250, '2026-09-03T00:00:00.000Z'),
      entry('b', 500, '2026-09-02T00:00:00.000Z'),
      entry('a', 100, '2026-09-01T00:00:00.000Z'),
    ]

    const series = buildSeries(entries, 350)

    // Opening 0 → +100 → +500 → −250, ending on the 350 we were told.
    expect(series.map((point) => point.balance)).toEqual([0, 100, 600, 350])
  })

  /**
   * The opening balance is a point in its own right. Without it the chart starts
   * at the value *after* the oldest visible transaction, hiding that
   * transaction's own effect — the line would begin at 100 and the +100 that got
   * it there would be invisible.
   */
  it('includes the balance before the oldest entry', () => {
    const series = buildSeries([entry('a', 100, '2026-09-01T00:00:00.000Z')], 100)

    expect(series).toHaveLength(2)
    expect(series[0]?.balance).toBe(0)
    expect(series[0]?.entry).toBeUndefined()
    expect(series[1]?.balance).toBe(100)
  })

  /**
   * Negative balances are legitimate — a clawback of a credit the user already
   * spent puts them there — so the series has to carry them rather than clamping
   * at zero and drawing a floor the data never had.
   */
  it('handles a history that goes negative after a clawback', () => {
    const entries = [
      entry('reversal', -500, '2026-09-02T00:00:00.000Z'),
      entry('earn', 100, '2026-09-01T00:00:00.000Z'),
    ]

    const series = buildSeries(entries, -400)

    // Opened at 0, earned 100, then a 500 clawback took them to −400.
    expect(series.map((point) => point.balance)).toEqual([0, 100, -400])
  })

  it('returns nothing for a user with no history', () => {
    expect(buildSeries([], 0)).toEqual([])
  })
})

describe('BalanceSparkline geometry', () => {
  const entries = [
    entry('c', -250, '2026-09-03T00:00:00.000Z'),
    entry('b', 500, '2026-09-02T00:00:00.000Z'),
    entry('a', 100, '2026-09-01T00:00:00.000Z'),
  ]

  function pathData(): string[] {
    const { container } = render(<BalanceSparkline entries={entries} currentBalance={350} />)
    return Array.from(container.querySelectorAll('path')).map(
      (path) => path.getAttribute('d') ?? '',
    )
  }

  /** A path with NaN in it renders as nothing, silently. */
  it('produces paths with no NaN coordinates', () => {
    for (const d of pathData()) {
      expect(d).not.toContain('NaN')
      expect(d.length).toBeGreaterThan(0)
    }
  })

  /** A coordinate outside the viewBox clips without any error. */
  it('keeps every coordinate inside the viewBox', () => {
    const numbers = pathData()
      .join(' ')
      .split(/[^0-9.-]+/)
      .filter((token) => token !== '' && token !== '-')
      .map(Number)

    for (const value of numbers) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(260)
    }
  })

  /**
   * Two entries at the same instant — a redemption and its reversal share a
   * millisecond routinely — collapse the time span to zero. Dividing by it would
   * put every x at NaN and render nothing.
   *
   * (The matching zero-*balance*-range guard is deliberately not tested: with
   * `CHECK (delta <> 0)` on the ledger, no two points can share a balance across
   * a whole series, so that branch is defensive rather than reachable.)
   */
  it('survives two entries sharing a timestamp', () => {
    const sameInstant = [
      entry('reversal', 250, '2026-09-02T00:00:00.000Z'),
      entry('spend', -250, '2026-09-02T00:00:00.000Z'),
    ]

    const { container } = render(
      <BalanceSparkline entries={sameInstant} currentBalance={100} />,
    )

    const paths = Array.from(container.querySelectorAll('path'))
    expect(paths.length).toBeGreaterThan(0)

    for (const path of paths) {
      expect(path.getAttribute('d')).not.toContain('NaN')
    }
  })

  it('falls back to a message rather than plotting a single point', () => {
    render(<BalanceSparkline entries={[]} currentBalance={0} />)

    expect(screen.getByText(/at least two transactions/i)).toBeInTheDocument()
  })
})
