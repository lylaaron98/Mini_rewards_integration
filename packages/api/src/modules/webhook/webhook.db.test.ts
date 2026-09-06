import { randomUUID } from 'node:crypto'

import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../../app.js'
import { prisma } from '../../lib/db.js'
import { backfillUnmatched } from './webhook.service.js'
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from './signature.js'

/**
 * End-to-end ingestion, driven through the real HTTP route.
 *
 * Signed with the real `sign()` rather than stubbing verification, so the tests
 * exercise the path production uses. A suite that waves itself past the
 * signature check is testing a code path that does not exist.
 *
 * Run with `pnpm db:up && pnpm test:db`.
 */

const SECRET = 'test-webhook-signing-secret'
const PARTNER = 'acme'
const TEST_PREFIX = 'test-webhook-'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp()
})

afterAll(async () => {
  await app.close()

  const testUsers = { user: { externalRef: { startsWith: TEST_PREFIX } } }
  await prisma.pointTransaction.deleteMany({ where: testUsers })
  await prisma.userBalance.deleteMany({ where: testUsers })
  await prisma.user.deleteMany({ where: { externalRef: { startsWith: TEST_PREFIX } } })
  await prisma.webhookDelivery.deleteMany({ where: { externalEventId: { startsWith: TEST_PREFIX } } })
  await prisma.earningRule.deleteMany({ where: { activityType: { startsWith: TEST_PREFIX } } })
  await prisma.$disconnect()
})

type EventOverrides = {
  eventId?: string
  userRef?: string
  activityType?: string
  occurredAt?: string
}

function buildEvent(overrides: EventOverrides = {}) {
  return {
    event_id: overrides.eventId ?? `${TEST_PREFIX}${randomUUID()}`,
    user_ref: overrides.userRef ?? `${TEST_PREFIX}unknown`,
    activity_type: overrides.activityType ?? 'PURCHASE',
    occurred_at: overrides.occurredAt ?? new Date().toISOString(),
  }
}

/** Posts a body with a genuine signature, as the partner would. */
async function post(body: unknown, options: { signed?: boolean; skew?: number } = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body)
  const timestamp = String(Math.floor((Date.now() + (options.skew ?? 0)) / 1000))

  const headers: Record<string, string> = { 'content-type': 'application/json' }

  if (options.signed !== false) {
    headers[TIMESTAMP_HEADER] = timestamp
    headers[SIGNATURE_HEADER] = sign(SECRET, timestamp, rawBody)
  }

  return app.inject({ method: 'POST', url: `/api/webhooks/${PARTNER}`, headers, payload: rawBody })
}

async function createUser(): Promise<string> {
  const ref = `${TEST_PREFIX}${randomUUID()}`
  await prisma.user.create({ data: { externalRef: ref, displayName: 'Webhook Test User' } })
  return ref
}

describe('webhook authentication', () => {
  it('rejects an unsigned request with 401 and stores nothing', async () => {
    const event = buildEvent()
    const response = await post(event, { signed: false })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: 'invalid_signature' })

    // Unauthenticated requests must not be persisted: we cannot attribute them
    // to anyone, so storing them would let an anonymous caller write rows.
    const stored = await prisma.webhookDelivery.findFirst({
      where: { externalEventId: event.event_id },
    })
    expect(stored).toBeNull()
  })

  it('rejects a correctly signed request with a stale timestamp', async () => {
    const response = await post(buildEvent(), { skew: -10 * 60 * 1000 })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ reason: 'timestamp_outside_window' })
  })

  it('rejects a request whose body was altered after signing', async () => {
    const rawBody = JSON.stringify(buildEvent())
    const timestamp = String(Math.floor(Date.now() / 1000))

    const response = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${PARTNER}`,
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(SECRET, timestamp, rawBody),
      },
      payload: rawBody.replace('PURCHASE', 'REFERRAL'),
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ reason: 'signature_mismatch' })
  })

  it('rejects an unknown partner without revealing whether it exists', async () => {
    const rawBody = JSON.stringify(buildEvent())
    const timestamp = String(Math.floor(Date.now() / 1000))

    const response = await app.inject({
      method: 'POST',
      url: '/api/webhooks/not-a-partner',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: sign(SECRET, timestamp, rawBody),
      },
      payload: rawBody,
    })

    expect(response.statusCode).toBe(401)
  })
})

describe('webhook validation', () => {
  it('rejects a payload with no event_id as permanently invalid', async () => {
    const response = await post({
      user_ref: 'someone',
      activity_type: 'PURCHASE',
      occurred_at: new Date().toISOString(),
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ status: 'REJECTED' })
    expect(response.json().message).toContain('event_id')
  })

  /**
   * A body Fastify's default JSON parser would have rejected with its own 400
   * before any handler ran. The route installs a pass-through parser precisely
   * so these reach us and get recorded — a payload we could not read is the
   * evidence in the conversation that starts "we definitely sent that".
   */
  it('stores a malformed body rather than dropping it', async () => {
    const response = await post('{"event_id":"broken",')

    expect(response.statusCode).toBe(400)

    const stored = await prisma.webhookDelivery.findUnique({
      where: { id: response.json().deliveryId },
    })
    expect(stored?.status).toBe('REJECTED')
    expect(stored?.rawPayload).toBe('{"event_id":"broken",')
    // Keyed by a content hash, since there is no readable event id. Bounded
    // storage: a partner retrying one broken request writes one row, not many.
    expect(stored?.externalEventId).toMatch(/^unparsed:[0-9a-f]{64}$/)

    await prisma.webhookDelivery.delete({ where: { id: response.json().deliveryId } })
  })

  it('rejects an event dated more than 90 days in the past', async () => {
    const userRef = await createUser()
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()

    const response = await post(buildEvent({ userRef, occurredAt: old }))

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('90 days')
  })

  it('rejects an event dated more than an hour in the future', async () => {
    const userRef = await createUser()
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

    const response = await post(buildEvent({ userRef, occurredAt: future }))

    expect(response.statusCode).toBe(400)
    expect(response.json().message).toContain('future')
  })
})

describe('webhook crediting', () => {
  it('credits a valid event once and reports the new balance', async () => {
    const userRef = await createUser()
    const response = await post(buildEvent({ userRef, activityType: 'PURCHASE' }))

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ status: 'PROCESSED', duplicate: false, points: 15 })

    const user = await prisma.user.findUniqueOrThrow({ where: { externalRef: userRef } })
    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
    expect(balance?.balance).toBe(15)
  })

  /**
   * The required replay test, and the one that matters most: on an
   * at-least-once channel this is normal operation, not an edge case.
   */
  it('credits a replayed event exactly once and answers 200, never 409', async () => {
    const userRef = await createUser()
    const event = buildEvent({ userRef, activityType: 'PURCHASE' })

    const first = await post(event)
    const second = await post(event)
    const third = await post(event)

    expect(first.statusCode).toBe(202)
    expect(first.json().duplicate).toBe(false)

    // 200, not 202: the partner can tell "you have this now" from "you had this
    // already". And emphatically not 409 — a duplicate is success on this
    // channel, and a 4xx would trip their alerting for something that worked.
    expect(second.statusCode).toBe(200)
    expect(second.json()).toMatchObject({ status: 'PROCESSED', duplicate: true })
    expect(third.statusCode).toBe(200)

    const user = await prisma.user.findUniqueOrThrow({ where: { externalRef: userRef } })
    expect(await prisma.pointTransaction.count({ where: { userId: user.id } })).toBe(1)
    expect((await prisma.userBalance.findUnique({ where: { userId: user.id } }))?.balance).toBe(15)

    // One delivery seen three times, not three deliveries.
    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { partner_externalEventId: { partner: PARTNER, externalEventId: event.event_id } },
    })
    expect(delivery.attempts).toBe(3)
  })

  /**
   * Pricing resolves against occurred_at, not against now — so a delivery that
   * arrives late is worth what it was worth on the day it happened.
   *
   * Uses a rule boundary inside the 90-day freshness window, because an event
   * old enough to cross a seeded rule boundary would be rejected on age before
   * pricing ever ran. Two versions of one activity type, superseded 20 days ago:
   * an event from 40 days ago must take the old rate.
   */
  it('prices a late event at the rate in force when it occurred, not the current one', async () => {
    const userRef = await createUser()
    const activityType = `${TEST_PREFIX}LATE`
    const supersededAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    const occurredAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)

    await prisma.earningRule.create({
      data: {
        activityType,
        points: 80,
        effectiveFrom: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        effectiveTo: supersededAt,
      },
    })
    await prisma.earningRule.create({
      data: { activityType, points: 5, effectiveFrom: supersededAt, effectiveTo: null },
    })

    const response = await post(
      buildEvent({ userRef, activityType, occurredAt: occurredAt.toISOString() }),
    )

    expect(response.statusCode).toBe(202)
    // 80, the historical rate. Pricing against receipt time would credit 5, and
    // replaying history in a different order would then produce a different
    // balance.
    expect(response.json()).toMatchObject({ status: 'PROCESSED', points: 80 })
  })

  /**
   * The boundary the half-open window exists for. An event at the exact instant
   * a rule was superseded belongs to the successor, not to both.
   */
  it('prices an event at a rule boundary using the successor rule', async () => {
    const userRef = await createUser()
    const activityType = `${TEST_PREFIX}BOUNDARY`
    const boundary = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)

    await prisma.earningRule.create({
      data: {
        activityType,
        points: 11,
        effectiveFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        effectiveTo: boundary,
      },
    })
    await prisma.earningRule.create({
      data: { activityType, points: 22, effectiveFrom: boundary, effectiveTo: null },
    })

    const response = await post(
      buildEvent({ userRef, activityType, occurredAt: boundary.toISOString() }),
    )

    expect(response.json()).toMatchObject({ status: 'PROCESSED', points: 22 })
  })
})

describe('unmatched deliveries and backfill', () => {
  it('parks an event for an unknown user as 202, not a rejection', async () => {
    const event = buildEvent({ userRef: `${TEST_PREFIX}ghost-${randomUUID()}` })
    const response = await post(event)

    // 202 because rejecting would destroy points someone genuinely earned, for
    // a signup/activity race that resolves itself minutes later.
    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ status: 'UNMATCHED', reason: 'UNKNOWN_USER' })
  })

  it('parks an event with no matching rule as 202, and credits nothing', async () => {
    const userRef = await createUser()
    const activityType = `${TEST_PREFIX}SURVEY`
    const response = await post(buildEvent({ userRef, activityType }))

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({ status: 'UNMATCHED', reason: 'NO_RULE' })

    // Not a zero-point entry. That would make the gap invisible while users
    // silently earned nothing for real activity.
    const user = await prisma.user.findUniqueOrThrow({ where: { externalRef: userRef } })
    expect(await prisma.pointTransaction.count({ where: { userId: user.id } })).toBe(0)
  })

  /**
   * The required backfill test: add the missing rule, replay, and confirm the
   * event is credited at the HISTORICAL rate rather than at whatever is current.
   */
  it('credits a parked event at the historical rate once the rule is added', async () => {
    const userRef = await createUser()
    const activityType = `${TEST_PREFIX}WEBINAR`
    const occurredAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    const parked = await post(buildEvent({ userRef, activityType, occurredAt: occurredAt.toISOString() }))
    expect(parked.json()).toMatchObject({ status: 'UNMATCHED', reason: 'NO_RULE' })

    // The rule that should have existed: worth 70 points back then, superseded
    // by a 5-point rule a week ago. A backfill priced against "now" would credit
    // 5. Priced against occurred_at, it credits 70.
    const supersededAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    await prisma.earningRule.create({
      data: {
        activityType,
        points: 70,
        effectiveFrom: new Date(occurredAt.getTime() - 24 * 60 * 60 * 1000),
        effectiveTo: supersededAt,
      },
    })
    await prisma.earningRule.create({
      data: { activityType, points: 5, effectiveFrom: supersededAt, effectiveTo: null },
    })

    const result = await prisma.$transaction((tx) => backfillUnmatched(tx, { activityType }))

    expect(result).toMatchObject({ examined: 1, processed: 1, stillUnmatched: 0 })

    const user = await prisma.user.findUniqueOrThrow({ where: { externalRef: userRef } })
    const balance = await prisma.userBalance.findUnique({ where: { userId: user.id } })
    expect(balance?.balance).toBe(70)
  })

  /**
   * The required concurrency test. Two backfills racing must credit once.
   *
   * Two independent transactions, started together: the conditional status
   * transition means the loser finds a status that is no longer UNMATCHED and
   * skips. The ledger's unique constraint sits underneath as a second,
   * independent guarantee — a double credit would need both to fail.
   */
  it('credits once when two backfills run concurrently', async () => {
    const userRef = await createUser()
    const activityType = `${TEST_PREFIX}CONCURRENT`

    const parked = await post(buildEvent({ userRef, activityType }))
    expect(parked.json()).toMatchObject({ status: 'UNMATCHED', reason: 'NO_RULE' })

    await prisma.earningRule.create({
      data: {
        activityType,
        points: 42,
        effectiveFrom: new Date(Date.now() - 60 * 60 * 1000),
        effectiveTo: null,
      },
    })

    const [first, second] = await Promise.all([
      prisma.$transaction((tx) => backfillUnmatched(tx, { activityType })),
      prisma.$transaction((tx) => backfillUnmatched(tx, { activityType })),
    ])

    // Exactly one of them did the work. Which one is a race and does not matter.
    expect(first.processed + second.processed).toBe(1)

    const user = await prisma.user.findUniqueOrThrow({ where: { externalRef: userRef } })
    expect(await prisma.pointTransaction.count({ where: { userId: user.id } })).toBe(1)
    expect((await prisma.userBalance.findUnique({ where: { userId: user.id } }))?.balance).toBe(42)
  })

  it('refuses an unfiltered backfill', async () => {
    await expect(prisma.$transaction((tx) => backfillUnmatched(tx, {}))).rejects.toThrow(
      /requires at least one of/,
    )
  })
})
