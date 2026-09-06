import type { Tx } from '../../lib/db.js'

/**
 * Resolving what an activity was worth.
 *
 * Separate from `earning.service.ts`, which owns the window arithmetic and its
 * overlap checking. This file answers the one question ingestion asks.
 */

export type ResolvedRule = {
  ruleId: string
  activityType: string
  points: number
}

/**
 * What this activity was worth AT THE TIME IT HAPPENED.
 *
 * Priced against `occurredAt`, never against now. That single choice is what
 * makes replay order-independent: a partner retry that arrives three weeks late,
 * a backfill run months after the fact, and the original delivery all resolve to
 * the same rule and therefore the same number of points. Pricing against receipt
 * time would mean the value of an event depended on how quickly we happened to
 * process it, and replaying history in a different order would produce a
 * different balance.
 *
 * Returns null when nothing matches, which is not an error. It means we have no
 * rule for this activity — a gap in our configuration, not a bad request from
 * the partner — and the caller parks the delivery as UNMATCHED/NO_RULE so it can
 * be credited correctly once the rule exists.
 *
 * At most one rule can match. Windows are half-open, [effectiveFrom,
 * effectiveTo), and the EXCLUDE constraint on `earning_rules` makes overlapping
 * windows for one activity type unstorable — so this is not "the first match
 * wins", it is "the only match". `take: 1` is a statement about the shape of the
 * result, not a tiebreak.
 */
export async function resolveRule(
  tx: Tx,
  activityType: string,
  occurredAt: Date,
): Promise<ResolvedRule | null> {
  const rule = await tx.earningRule.findFirst({
    where: {
      activityType,
      active: true,
      effectiveFrom: { lte: occurredAt },
      // Half-open at the upper end: a rule ending at midnight does not price an
      // event that happened exactly at midnight — its successor does. Closed
      // intervals would make both match, and the winner would depend on row
      // order once a year.
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: occurredAt } }],
    },
    select: { id: true, activityType: true, points: true },
  })

  if (!rule) return null

  return { ruleId: rule.id, activityType: rule.activityType, points: rule.points }
}
