import type { LedgerEntry } from './api'

const pointsFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

/** Grouped thousands. 25000 reads as an amount; 25,000 reads as a price. */
export function formatPoints(points: number): string {
  return pointsFormatter.format(points)
}

/**
 * A signed amount, with an explicit `+` on credits.
 *
 * The sign carries the meaning in the ledger, so it should carry the meaning on
 * screen too. A bare "250" next to a "-250" makes the reader work out which is
 * which from colour alone, and colour is exactly what some readers do not have.
 */
export function formatDelta(delta: number): string {
  const sign = delta > 0 ? '+' : '−'
  return `${sign}${pointsFormatter.format(Math.abs(delta))}`
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
})

export function formatTimestamp(iso: string): string {
  const date = new Date(iso)
  return `${dateFormatter.format(date)} at ${timeFormatter.format(date)}`
}

/**
 * Where an entry came from, in words.
 *
 * `source` is a machine key — "partner:acme", "redemption", "reversal" — and
 * showing it raw would leak an internal convention onto a screen a user reads.
 * The mapping is deliberately total: an unrecognised source shows itself rather
 * than being hidden, because a new source appearing is something worth noticing
 * rather than something to swallow.
 */
export function describeSource(entry: LedgerEntry): string {
  if (entry.source.startsWith('partner:')) {
    return `Partner · ${entry.source.slice('partner:'.length)}`
  }

  if (entry.source === 'redemption') return 'Redemption'
  if (entry.source === 'reversal') return 'Refund'
  if (entry.source === 'admin') return 'Manual adjustment'

  return entry.source
}

export function describeType(type: LedgerEntry['type']): string {
  const labels: Record<LedgerEntry['type'], string> = {
    EARN: 'Earned',
    REDEEM: 'Spent',
    REVERSAL: 'Refunded',
    ADJUSTMENT: 'Adjusted',
  }
  return labels[type]
}
