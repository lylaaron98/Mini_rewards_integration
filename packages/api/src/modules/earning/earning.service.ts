/**
 * Earning rules: the window arithmetic that decides which rule prices an event.
 *
 * Phase 1 defines only the overlap logic, because that is what the schema's
 * EXCLUDE constraint encodes and what the seed data has to satisfy. Pricing
 * against `occurredAt` builds on the same predicate.
 *
 * These functions are pure and take no `tx`. The tx-first convention applies to
 * functions that touch the database; date arithmetic does not, and pretending
 * otherwise would make it untestable without a database for no benefit.
 */

export type RuleWindow = {
  activityType: string
  /** Inclusive lower bound. */
  effectiveFrom: Date
  /** Exclusive upper bound. Null means the rule is still current. */
  effectiveTo: Date | null
  active: boolean
}

export type OverlappingPair<TRule extends RuleWindow> = {
  first: TRule
  second: TRule
}

/**
 * Windows are half-open: [effectiveFrom, effectiveTo).
 *
 * That choice is what lets one version end at the exact instant the next begins
 * without either a gap or an overlap. With closed intervals, a rule ending on
 * 2026-01-01 and one starting on 2026-01-01 would both match that instant, and
 * an event landing precisely there would be priced by whichever row came back
 * first — a bug that appears once a year and is never reproducible.
 *
 * A null `effectiveTo` is treated as positive infinity rather than as "no
 * bound", so open-ended and closed rules compare with the same expression.
 */
export function windowsOverlap(first: RuleWindow, second: RuleWindow): boolean {
  const firstEnd = first.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY
  const secondEnd = second.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY

  return first.effectiveFrom.getTime() < secondEnd && second.effectiveFrom.getTime() < firstEnd
}

/**
 * Every pair of active rules for the same activity type whose windows overlap.
 *
 * Returns the offending pairs rather than a boolean so a failure says *which*
 * rules collide. "Rules overlap" sends someone reading four rows by hand;
 * "purchase-v1 overlaps purchase-v2" does not.
 *
 * Inactive rules are excluded because they are excluded by the database
 * constraint too — a superseded rule is kept forever so that ledger entries
 * referencing it stay resolvable, and keeping it must not block its successor.
 *
 * The comparison is a plain nested loop. Rule counts are measured in dozens, and
 * a sweep-line would trade readability for a speedup nothing here can observe.
 */
export function findOverlappingRules<TRule extends RuleWindow>(
  rules: readonly TRule[],
): Array<OverlappingPair<TRule>> {
  const active = rules.filter((rule) => rule.active)
  const overlaps: Array<OverlappingPair<TRule>> = []

  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const first = active[i]
      const second = active[j]

      // noUncheckedIndexedAccess makes these possibly-undefined. The loop bounds
      // rule that out, but the compiler cannot see it and a non-null assertion
      // here would be the one place this file lies about what it knows.
      if (!first || !second) continue
      if (first.activityType !== second.activityType) continue

      if (windowsOverlap(first, second)) {
        overlaps.push({ first, second })
      }
    }
  }

  return overlaps
}
