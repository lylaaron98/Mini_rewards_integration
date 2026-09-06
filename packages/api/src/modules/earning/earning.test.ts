import { describe, expect, it } from 'vitest'

import { SEED_EARNING_RULES } from '../../seed-data.js'
import { findOverlappingRules, windowsOverlap } from './earning.service.js'

const window = (from: string, to: string | null, active = true) => ({
  activityType: 'PURCHASE',
  effectiveFrom: new Date(from),
  effectiveTo: to === null ? null : new Date(to),
  active,
})

describe('windowsOverlap', () => {
  /**
   * The boundary case the half-open interval exists for. With closed intervals
   * both rules would match the instant 2026-01-01T00:00:00Z, and an event
   * landing exactly there would be priced by whichever row the planner returned
   * first — wrong once a year, and never reproducible.
   */
  it('treats windows that meet at an instant as not overlapping', () => {
    const earlier = window('2025-01-01', '2026-01-01')
    const later = window('2026-01-01', null)

    expect(windowsOverlap(earlier, later)).toBe(false)
    expect(windowsOverlap(later, earlier)).toBe(false)
  })

  it('detects a genuine overlap regardless of argument order', () => {
    const earlier = window('2025-01-01', '2026-06-01')
    const later = window('2026-01-01', '2026-12-01')

    expect(windowsOverlap(earlier, later)).toBe(true)
    expect(windowsOverlap(later, earlier)).toBe(true)
  })

  it('treats a null effectiveTo as unbounded rather than as zero-length', () => {
    const openEnded = window('2025-01-01', null)
    const laterClosed = window('2030-01-01', '2030-06-01')

    expect(windowsOverlap(openEnded, laterClosed)).toBe(true)
  })

  it('detects one window fully containing another', () => {
    const outer = window('2025-01-01', '2027-01-01')
    const inner = window('2026-01-01', '2026-02-01')

    expect(windowsOverlap(outer, inner)).toBe(true)
  })
})

describe('findOverlappingRules', () => {
  /**
   * A positive control. Without it, the seed assertion below would pass just as
   * happily against a function that always returns an empty array — which is
   * the failure mode a "no overlaps found" test is most likely to have.
   */
  it('reports the specific pair that collides', () => {
    const rules = [
      { key: 'a', ...window('2025-01-01', '2026-06-01') },
      { key: 'b', ...window('2026-01-01', null) },
    ]

    const overlaps = findOverlappingRules(rules)

    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]?.first.key).toBe('a')
    expect(overlaps[0]?.second.key).toBe('b')
  })

  it('ignores rules for different activity types', () => {
    const rules = [
      { ...window('2025-01-01', null), activityType: 'PURCHASE' },
      { ...window('2025-01-01', null), activityType: 'REFERRAL' },
    ]

    expect(findOverlappingRules(rules)).toHaveLength(0)
  })

  /**
   * Superseded rules are kept forever, because ledger entries reference the rule
   * that priced them and that reference has to stay resolvable. Keeping one must
   * not block its replacement, so the check — like the database constraint it
   * mirrors — only considers active rules.
   */
  it('ignores inactive rules, which may overlap freely', () => {
    const rules = [
      window('2025-01-01', '2026-06-01', false),
      window('2026-01-01', null, true),
    ]

    expect(findOverlappingRules(rules)).toHaveLength(0)
  })

  /**
   * The requirement: the seeded rules are non-overlapping by construction.
   *
   * This asserts against the exact constants the seed script inserts, rather
   * than a copy of them written into the test, so the two cannot drift apart.
   * The database enforces the same property independently — see
   * earning.db.test.ts — and this runs without a database so it holds in CI.
   */
  it('finds no overlaps among the seeded earning rules', () => {
    const overlaps = findOverlappingRules(SEED_EARNING_RULES)

    expect(
      overlaps.map((pair) => `${pair.first.key} overlaps ${pair.second.key}`),
    ).toEqual([])
  })
})
