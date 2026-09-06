import { createHash } from 'node:crypto'

import { TransactionType } from '@prisma/client'
import type { DeliveryStatus, Prisma, UnmatchedReason } from '@prisma/client'

import type { Tx } from '../../lib/db.js'
import { resolveRule } from '../earning/rule.service.js'
import { appendEntry } from '../ledger/ledger.service.js'
import {
  MAX_EVENT_AGE_MS,
  MAX_EVENT_FUTURE_MS,
  activityEventSchema,
} from './webhook.schema.js'

/**
 * Webhook ingestion, split into two functions on purpose.
 *
 * `captureDelivery` records that something arrived. `processDelivery` decides
 * what it means. Today the route calls them in sequence, which is the simplest
 * thing to debug: one request, one path, top to bottom, and a failure is
 * wherever the stack trace says it is.
 *
 * When volume outgrows synchronous processing, the route stops calling
 * `processDelivery` and a worker polls for deliveries left in RECEIVED and calls
 * it instead. **Neither function changes.** The split is the whole migration —
 * it is not preparation for a queue, it is the part of a queue that has to exist
 * either way, written now while it is cheap.
 *
 * That is also why capture and process run in *separate* transactions at the
 * route. If they shared one, a crash during processing would roll back the
 * record that anything arrived, and there would be nothing for a retry or a
 * worker to find.
 */

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export type CaptureResult = {
  deliveryId: string
  /** True when this (partner, eventId) had already been received. */
  duplicate: boolean
  /** The delivery's status — for a duplicate, the ORIGINAL delivery's status. */
  status: DeliveryStatus
}

/**
 * The dedupe key for a raw body.
 *
 * Normally the partner's `event_id`, read with a deliberately minimal parse:
 * enough to find the key, and nothing more. Full validation belongs in
 * `processDelivery`, after the body is safely stored.
 *
 * When the body cannot be parsed at all, or carries no usable `event_id`, the
 * key falls back to a hash of the raw bytes. This is NOT the synthesised
 * dedupe key the contract rules out — that one would merge two legitimately
 * distinct *activities* and silently cost a user points. This key is only ever
 * attached to a delivery that is about to be permanently rejected and can never
 * be credited. Its job is to bound storage: without it, a partner retrying one
 * broken request would write an unbounded number of identical rows, turning
 * their bug into our disk-space problem. The prefix makes it impossible to
 * collide with a real event id.
 */
export function resolveDeliveryKey(rawPayload: string): string {
  try {
    const parsed: unknown = JSON.parse(rawPayload)
    if (parsed !== null && typeof parsed === 'object') {
      const eventId = (parsed as { event_id?: unknown }).event_id
      if (typeof eventId === 'string' && eventId.length > 0) {
        return eventId
      }
    }
  } catch {
    // Falls through to the hash. A body we cannot parse is exactly the kind
    // worth keeping — it is the evidence in the conversation that starts "we
    // definitely sent that".
  }

  return `unparsed:${createHash('sha256').update(rawPayload).digest('hex')}`
}

/**
 * Persists the raw body verbatim, before anything interprets it.
 *
 * Stored as the exact bytes received. Parsing and re-serialising would lose key
 * order and whitespace, and with them the only form in which the signature can
 * ever be re-checked — which matters the day a partner insists they sent
 * something we say they did not.
 *
 * Deduplication uses INSERT ... ON CONFLICT DO NOTHING RETURNING, the same
 * pattern as the ledger, so both dedupe paths in this codebase read identically.
 * Catching a unique violation instead would abort the surrounding transaction,
 * and the recovery query would fail with "current transaction is aborted" — in
 * exactly the situation the recovery exists for.
 */
export async function captureDelivery(
  tx: Tx,
  partner: string,
  rawPayload: string,
): Promise<CaptureResult> {
  const externalEventId = resolveDeliveryKey(rawPayload)

  const claimed = await tx.$queryRaw<Array<{ id: string; status: DeliveryStatus }>>`
    INSERT INTO webhook_deliveries (id, partner, external_event_id, status, raw_payload, received_at)
    VALUES (gen_random_uuid()::text, ${partner}, ${externalEventId}, 'RECEIVED', ${rawPayload}, now())
    ON CONFLICT (partner, external_event_id) DO NOTHING
    RETURNING id, status
  `

  const inserted = claimed[0]
  if (inserted) {
    return { deliveryId: inserted.id, duplicate: false, status: inserted.status }
  }

  /**
   * Already seen. Count the retry against the existing row rather than writing
   * a new one: a partner retrying forty times is one delivery seen forty times,
   * not forty deliveries, and the difference is the whole readability of the
   * deliveries view.
   *
   * Safe against a concurrent first writer: ON CONFLICT DO NOTHING waits for an
   * in-progress conflicting insert to commit rather than skipping past it, and
   * under READ COMMITTED this statement then sees the committed row.
   */
  const existing = await tx.webhookDelivery.update({
    where: { partner_externalEventId: { partner, externalEventId } },
    data: { attempts: { increment: 1 } },
    select: { id: true, status: true },
  })

  return { deliveryId: existing.id, duplicate: true, status: existing.status }
}

// ---------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------

export type ProcessOutcome =
  | {
      status: 'PROCESSED'
      transactionId: string
      points: number
      balanceAfter: number
      /** True when the ledger had already credited this event. */
      alreadyCredited: boolean
    }
  | { status: 'UNMATCHED'; reason: UnmatchedReason; detail: string }
  | { status: 'REJECTED'; error: string }

/**
 * Interprets a captured delivery and credits it, in the caller's transaction.
 *
 * The delivery's terminal status is set in that same transaction as the ledger
 * entry, so "credited" and "marked as credited" cannot come apart. A crash
 * between them would otherwise leave a delivery that looks unprocessed and a
 * user who has already been paid — and the obvious fix, reprocessing it, would
 * pay them twice were it not for the ledger's own dedupe constraint.
 */
export async function processDelivery(tx: Tx, deliveryId: string): Promise<ProcessOutcome> {
  const delivery = await tx.webhookDelivery.findUnique({
    where: { id: deliveryId },
    select: { id: true, partner: true, externalEventId: true, status: true, rawPayload: true },
  })

  if (!delivery) {
    throw new Error(`Delivery ${deliveryId} does not exist.`)
  }

  // --- Parse ---------------------------------------------------------------

  let payload: unknown
  try {
    payload = JSON.parse(delivery.rawPayload)
  } catch {
    return reject(tx, deliveryId, 'Malformed JSON body.')
  }

  const parsed = activityEventSchema.safeParse(payload)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ')
    return reject(tx, deliveryId, `Schema validation failed — ${detail}`)
  }

  const event = parsed.data
  const occurredAt = new Date(event.occurred_at)

  // Denormalised now that they are known, so the deliveries view and the
  // backfill sweep can filter without reading JSON out of a text column.
  await tx.webhookDelivery.update({
    where: { id: deliveryId },
    data: { userRef: event.user_ref, activityType: event.activity_type },
  })

  // --- Freshness -----------------------------------------------------------

  const ageMs = Date.now() - occurredAt.getTime()

  if (ageMs > MAX_EVENT_AGE_MS) {
    return reject(
      tx,
      deliveryId,
      `occurred_at is more than ${Math.floor(MAX_EVENT_AGE_MS / 86_400_000)} days in the past.`,
    )
  }

  if (-ageMs > MAX_EVENT_FUTURE_MS) {
    return reject(tx, deliveryId, 'occurred_at is more than 1 hour in the future.')
  }

  // --- Resolve -------------------------------------------------------------

  const user = await tx.user.findUnique({
    where: { externalRef: event.user_ref },
    select: { id: true },
  })

  if (!user) {
    /**
     * Parked, not rejected. The usual cause is a race between a partner
     * creating a user and that user immediately doing something — and rejecting
     * would destroy points the person genuinely earned, for a reason that
     * resolves itself minutes later. `backfillUnmatched` replays these by user
     * reference once the user exists.
     */
    return park(tx, deliveryId, 'UNKNOWN_USER', `No user with external ref ${event.user_ref}.`)
  }

  const rule = await resolveRule(tx, event.activity_type, occurredAt)

  if (!rule) {
    /**
     * Also parked, for a different reason and fixed a different way: this one
     * needs a rule adding, then a replay by activity type.
     *
     * Emphatically NOT a zero-point ledger entry. That would make the gap
     * invisible — every response would say success while users silently earned
     * nothing for real activity, and nobody would notice for weeks. And
     * emphatically not a 400: the partner sent a well-formed event, and the
     * missing configuration is ours.
     */
    return park(
      tx,
      deliveryId,
      'NO_RULE',
      `No active earning rule for ${event.activity_type} at ${occurredAt.toISOString()}.`,
    )
  }

  // --- Credit --------------------------------------------------------------

  const entry = await appendEntry(tx, {
    userId: user.id,
    delta: rule.points,
    type: TransactionType.EARN,
    source: `partner:${delivery.partner}`,
    // The partner's key, which is what makes crediting idempotent no matter
    // which path reaches here — this one, a backfill, or a manual replay.
    externalEventId: event.event_id,
    ruleId: rule.ruleId,
    description: describeActivity(event.activity_type),
    metadata: {
      occurredAt: occurredAt.toISOString(),
      partner: delivery.partner,
      // Cast because Zod validates this as Record<string, unknown> while Prisma
      // wants its own JSON type. The value came out of JSON.parse, so it is
      // JSON by construction — this is the one place that fact is known and
      // cannot be expressed in the types.
      ...(event.metadata === undefined
        ? {}
        : { partnerMetadata: event.metadata as Prisma.InputJsonObject }),
    },
  })

  await tx.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'PROCESSED', unmatchedReason: null, error: null, processedAt: new Date() },
  })

  return {
    status: 'PROCESSED',
    transactionId: entry.transactionId,
    points: rule.points,
    balanceAfter: entry.balanceAfter,
    alreadyCredited: entry.duplicate,
  }
}

async function reject(tx: Tx, deliveryId: string, error: string): Promise<ProcessOutcome> {
  await tx.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'REJECTED', error, processedAt: new Date() },
  })
  return { status: 'REJECTED', error }
}

async function park(
  tx: Tx,
  deliveryId: string,
  reason: UnmatchedReason,
  detail: string,
): Promise<ProcessOutcome> {
  await tx.webhookDelivery.update({
    where: { id: deliveryId },
    data: { status: 'UNMATCHED', unmatchedReason: reason, error: detail },
  })
  return { status: 'UNMATCHED', reason, detail }
}

/**
 * Turns an activity type into the line a support agent reads.
 *
 * Written onto the ledger entry once, never derived at display time — changing
 * this function must not change what a two-year-old transaction appears to say.
 */
function describeActivity(activityType: string): string {
  const known: Record<string, string> = {
    PURCHASE: 'Purchase',
    REFERRAL: 'Referred a friend',
    APP_REVIEW: 'Left an app store review',
  }

  return known[activityType] ?? `Activity: ${activityType}`
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export type BackfillFilter = {
  /** Replay everything parked for this user — the UNKNOWN_USER fix. */
  userRef?: string
  /** Replay everything parked for this activity type — the NO_RULE fix. */
  activityType?: string
}

export type BackfillResult = {
  examined: number
  processed: number
  stillUnmatched: number
  rejected: number
  /** Deliveries another backfill claimed first. Not an error. */
  skipped: number
}

/**
 * Replays parked deliveries once the missing user or rule exists.
 *
 * Runs them back through `processDelivery` unchanged. A second, subtly
 * different ingestion path is how a backfill ends up crediting a different
 * number of points than the original would have — and because pricing resolves
 * against `occurredAt`, replaying months later still credits the HISTORICAL
 * rate rather than today's.
 *
 * Each delivery is claimed with a conditional status transition before anything
 * is credited, and the affected-row count is checked — the same shape as the
 * conditional stock decrement. Two backfills running at once cannot both claim
 * the same row: the second blocks on the row lock, then sees a status that is no
 * longer UNMATCHED and skips. The ledger's unique constraint sits underneath
 * that as an independent guarantee, so a double credit needs both to fail.
 *
 * Note this runs entirely in the caller's transaction, so a large backfill is
 * one long transaction and all-or-nothing. That is the right trade at this scale
 * — a partial backfill is harder to reason about than a failed one — but at real
 * volume it would need chunking, with each chunk its own transaction.
 */
export async function backfillUnmatched(
  tx: Tx,
  filter: BackfillFilter,
): Promise<BackfillResult> {
  if (filter.userRef === undefined && filter.activityType === undefined) {
    // Refused rather than defaulted to "everything". A backfill is a bulk
    // credit; making the unfiltered case require an explicit decision is worth
    // the inconvenience.
    throw new Error('backfillUnmatched requires at least one of userRef or activityType.')
  }

  const candidates = await tx.webhookDelivery.findMany({
    where: {
      status: 'UNMATCHED',
      ...(filter.userRef === undefined ? {} : { userRef: filter.userRef }),
      ...(filter.activityType === undefined ? {} : { activityType: filter.activityType }),
    },
    // Oldest first, so a replayed history reads in the order it happened.
    orderBy: { receivedAt: 'asc' },
    select: { id: true },
  })

  const result: BackfillResult = {
    examined: candidates.length,
    processed: 0,
    stillUnmatched: 0,
    rejected: 0,
    skipped: 0,
  }

  for (const candidate of candidates) {
    /**
     * Claim it. Moving UNMATCHED back to RECEIVED both marks it as taken and
     * puts it in the state `processDelivery` expects, so the replay is the
     * ordinary path rather than a special case.
     */
    const claimed = await tx.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'RECEIVED', unmatched_reason = NULL, error = NULL
      WHERE id = ${candidate.id} AND status = 'UNMATCHED'
    `

    if (claimed === 0) {
      result.skipped += 1
      continue
    }

    const outcome = await processDelivery(tx, candidate.id)

    if (outcome.status === 'PROCESSED') result.processed += 1
    else if (outcome.status === 'UNMATCHED') result.stillUnmatched += 1
    else result.rejected += 1
  }

  return result
}
