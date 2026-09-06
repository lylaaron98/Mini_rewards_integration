import { z } from 'zod'

/**
 * The activity event contract.
 *
 * Snake_case because it is the partner's wire format, not ours. Translating at
 * the boundary and using camelCase internally keeps their naming decisions from
 * leaking through the whole codebase.
 */
export const activityEventSchema = z.object({
  /**
   * REQUIRED. There is no fallback and there must never be one.
   *
   * The tempting alternative is synthesising a key from
   * (user_ref, activity_type, occurred_at) when the partner omits one. Two
   * legitimately distinct activities in the same second would hash identically,
   * collapse into a single credit, and cost the user points with no trace that
   * anything was lost. Only the partner knows whether two identical-looking
   * events are the same event; requiring them to say so is the only correct
   * answer, and a permanent 400 is how we ask.
   */
  event_id: z.string().min(1, 'event_id is required'),

  user_ref: z.string().min(1, 'user_ref is required'),
  activity_type: z.string().min(1, 'activity_type is required'),

  /** ISO 8601. Freshness is checked separately — see MAX_EVENT_AGE_MS. */
  occurred_at: z.string().datetime({ offset: true, message: 'occurred_at must be an ISO 8601 timestamp' }),

  /** Anything else the partner wants to send along, kept for provenance. */
  metadata: z.record(z.unknown()).optional(),
})

export type ActivityEvent = z.infer<typeof activityEventSchema>

/**
 * How far in the past an event may have occurred and still be credited.
 *
 * Partner clocks are untrusted input. Without a bound, a misconfigured
 * integration could replay years of history in one afternoon, and every one of
 * those events would be priced against whatever rule was in force back then —
 * correctly, which is precisely what makes it dangerous.
 *
 * Ninety days is generous enough that a genuine outage-and-catch-up succeeds,
 * and short enough that anything older is a decision a human should make rather
 * than something that happens automatically at 3am.
 */
export const MAX_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000

/**
 * How far into the future an event may claim to have occurred.
 *
 * Not zero, because clock skew between two systems is normal and rejecting a
 * partner whose clock runs eleven seconds fast would be absurd. Not unbounded,
 * because an event dated next year would be priced against rules that do not
 * exist yet, and would sit in the transaction history above everything real.
 */
export const MAX_EVENT_FUTURE_MS = 60 * 60 * 1000
