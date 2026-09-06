/**
 * The development dataset, as data.
 *
 * Kept separate from the script that inserts it so that tests can import these
 * constants and check properties of the data itself — the rule-window overlap
 * test proves the exact rows the seed will insert, with no database running and
 * nothing restated in the test that could drift from what is seeded.
 */

export const PARTNER = 'acme'

/** Matches the `source` written on every ledger entry credited from a webhook. */
export const LEDGER_SOURCE = `partner:${PARTNER}`

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type SeedUser = {
  externalRef: string
  displayName: string
  email: string
  /** Defaults to USER. Exactly one seeded account is an administrator. */
  role?: 'USER' | 'ADMIN'
}

/**
 * The password every seeded account shares.
 *
 * Printed on the login screen and in the README, because a reviewer should not
 * have to hunt for credentials to see the app. It is seed data for a local
 * development database and nothing else — the production path never runs this
 * script, which truncates every table before it inserts.
 */
export const SEED_PASSWORD = 'demo1234'

export const SEED_USERS: SeedUser[] = [
  { externalRef: 'acme-user-001', displayName: 'Ada Lovelace', email: 'ada@example.com' },
  { externalRef: 'acme-user-002', displayName: 'Grace Hopper', email: 'grace@example.com' },

  // Deliberately left with no activity at all. An empty state is a real screen
  // that real users see on day one, and it is the one most likely to be broken
  // because nobody has any data to notice it with.
  { externalRef: 'acme-user-003', displayName: 'Alan Turing', email: 'alan@example.com' },

  /**
   * The administrator, and a separate account on purpose.
   *
   * Making Ada an admin would have been more convenient and would have hidden
   * the distinction entirely — the developer panel would simply always be
   * there. A fourth account means signing in as an ordinary user and as an
   * administrator produce visibly different applications, which is the point
   * being demonstrated.
   */
  {
    externalRef: 'local:seed-admin',
    displayName: 'Dev Admin',
    email: 'admin@example.com',
    role: 'ADMIN',
  },
]

// ---------------------------------------------------------------------------
// Earning rules
// ---------------------------------------------------------------------------

export type SeedEarningRule = {
  /** Stable handle used by the seed history below to reference a rule. */
  key: string
  activityType: string
  points: number
  effectiveFrom: Date
  effectiveTo: Date | null
  active: boolean
}

/**
 * Windows are half-open, [effectiveFrom, effectiveTo).
 *
 * PURCHASE exists in two versions whose windows meet exactly at the start of
 * 2026 — no gap, no overlap. That is the whole reason rules are versioned:
 * a purchase from last November is still worth the 10 points it was worth
 * then, even though the same activity earns 15 today, and a partner retry that
 * arrives late is priced by when it happened rather than when we saw it.
 */
export const SEED_EARNING_RULES: SeedEarningRule[] = [
  {
    key: 'purchase-v1',
    activityType: 'PURCHASE',
    points: 10,
    effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
    active: true,
  },
  {
    key: 'purchase-v2',
    activityType: 'PURCHASE',
    points: 15,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    active: true,
  },
  {
    key: 'referral',
    activityType: 'REFERRAL',
    points: 500,
    effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    effectiveTo: null,
    active: true,
  },
  {
    key: 'app-review',
    activityType: 'APP_REVIEW',
    points: 50,
    effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
    effectiveTo: null,
    active: true,
  },
]

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export type SeedReward = {
  sku: string
  name: string
  description: string
  costPoints: number
  /** Null means unlimited. */
  stock: number | null
  active: boolean
}

/**
 * Deliberately spans the range from "affordable on day one" to "something to
 * save for". A catalogue where everything is affordable never exercises the
 * insufficient-funds path, and one where nothing is never exercises redemption
 * at all.
 *
 * It also spans the stock states: unlimited, plenty, nearly gone, and — through
 * the history below — already sold out. A catalogue where everything is in stock
 * makes the sold-out card, the "Out of stock" reason and the in-stock filter all
 * dead code until someone clicks a reward down to zero by hand, which is the
 * kind of path that quietly rots.
 */
export const SEED_REWARDS: SeedReward[] = [
  {
    sku: 'WALLPAPER-PACK',
    name: 'Digital Wallpaper Pack',
    description: 'A set of twelve desktop and phone wallpapers.',
    costPoints: 50,
    stock: null, // Digital goods do not run out — this exercises the unlimited path.
    active: true,
  },
  {
    sku: 'COFFEE-VOUCHER',
    name: 'Coffee Voucher',
    description: 'One free coffee at any participating café.',
    costPoints: 250,
    stock: 50,
    active: true,
  },
  {
    sku: 'ENAMEL-PIN',
    name: 'Limited Edition Enamel Pin',
    description: 'One of a numbered run made for the partner launch.',
    costPoints: 500,
    // Exactly one, and Grace takes it in the history below — so a freshly
    // seeded database already has a sold-out reward on the shelf rather than
    // needing one to be manufactured by clicking.
    stock: 1,
    active: true,
  },
  {
    sku: 'TOTE-BAG',
    name: 'Canvas Tote Bag',
    description: 'Heavyweight cotton tote with the partner logo.',
    costPoints: 750,
    stock: 20,
    active: true,
  },
  {
    sku: 'HEADPHONES',
    name: 'Wireless Headphones',
    description: 'Over-ear noise-cancelling headphones.',
    costPoints: 5_000,
    // Low on purpose: three units is few enough that the out-of-stock path is
    // reachable by hand while clicking around.
    stock: 3,
    active: true,
  },
  {
    sku: 'WEEKEND-GETAWAY',
    name: 'Weekend Getaway',
    description: 'Two nights for two people at a partner hotel.',
    costPoints: 25_000,
    stock: 1,
    active: true,
  },
]

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type SeedEarn = {
  kind: 'earn'
  userRef: string
  eventId: string
  ruleKey: string
  occurredAt: Date
  description: string
}

export type SeedRedeem = {
  kind: 'redeem'
  userRef: string
  sku: string
  idempotencyKey: string
  occurredAt: Date
  /**
   * `fulfilled` is the happy path. `failed-and-reversed` walks the full
   * two-phase story: points debited, fulfilment failed, compensating reversal
   * written, stock returned — so the UI has a real example of the case that is
   * hardest to get right and easiest to never look at.
   */
  outcome: 'fulfilled' | 'failed-and-reversed'
  failureReason?: string
}

export type SeedHistoryEntry = SeedEarn | SeedRedeem

/**
 * Applied in order. The running balance is never negative at any point, which
 * matters because CHECK (balance >= 0) is enforced on every intermediate write,
 * not just the final state.
 *
 * Ada ends on 355 points after earning 605 and spending 250. Grace ends on 15,
 * having spent 500 of her 515 on the last enamel pin.
 */
export const SEED_HISTORY: SeedHistoryEntry[] = [
  // Priced by purchase-v1 at 10 points. Sits in the history right next to
  // purchases worth 15, which is what rule versioning looks like from the
  // user's side.
  {
    kind: 'earn',
    userRef: 'acme-user-001',
    eventId: 'evt_20251115_0001',
    ruleKey: 'purchase-v1',
    occurredAt: new Date('2025-11-15T10:24:00.000Z'),
    description: 'Purchase at Corner Store',
  },
  {
    kind: 'earn',
    userRef: 'acme-user-001',
    eventId: 'evt_20260712_0002',
    ruleKey: 'purchase-v2',
    occurredAt: new Date('2026-07-12T09:10:00.000Z'),
    description: 'Purchase at Corner Store',
  },
  {
    kind: 'earn',
    userRef: 'acme-user-001',
    eventId: 'evt_20260728_0003',
    ruleKey: 'app-review',
    occurredAt: new Date('2026-07-28T18:45:00.000Z'),
    description: 'Left an app store review',
  },
  {
    kind: 'earn',
    userRef: 'acme-user-001',
    eventId: 'evt_20260805_0004',
    ruleKey: 'purchase-v2',
    occurredAt: new Date('2026-08-05T12:02:00.000Z'),
    description: 'Purchase at Riverside Market',
  },
  {
    kind: 'earn',
    userRef: 'acme-user-001',
    eventId: 'evt_20260819_0005',
    ruleKey: 'referral',
    occurredAt: new Date('2026-08-19T15:30:00.000Z'),
    description: 'Referred a friend who signed up',
  },
  {
    kind: 'earn',
    userRef: 'acme-user-001',
    eventId: 'evt_20260830_0006',
    ruleKey: 'purchase-v2',
    occurredAt: new Date('2026-08-30T08:55:00.000Z'),
    description: 'Purchase at Corner Store',
  },
  {
    kind: 'redeem',
    userRef: 'acme-user-001',
    sku: 'COFFEE-VOUCHER',
    idempotencyKey: 'seed-redemption-ada-1',
    occurredAt: new Date('2026-09-01T11:00:00.000Z'),
    outcome: 'fulfilled',
  },
  {
    kind: 'redeem',
    userRef: 'acme-user-001',
    sku: 'COFFEE-VOUCHER',
    idempotencyKey: 'seed-redemption-ada-2',
    occurredAt: new Date('2026-09-03T16:20:00.000Z'),
    outcome: 'failed-and-reversed',
    failureReason: 'Fulfilment provider returned 503 after 3 attempts',
  },

  // A second user with a little activity, so switching users shows genuinely
  // different data rather than the same screen twice.
  {
    kind: 'earn',
    userRef: 'acme-user-002',
    eventId: 'evt_20260820_0007',
    ruleKey: 'referral',
    occurredAt: new Date('2026-08-20T14:00:00.000Z'),
    description: 'Referred a friend who signed up',
  },
  {
    kind: 'earn',
    userRef: 'acme-user-002',
    eventId: 'evt_20260902_0008',
    ruleKey: 'purchase-v2',
    occurredAt: new Date('2026-09-02T10:15:00.000Z'),
    description: 'Purchase at Riverside Market',
  },

  /**
   * Grace takes the only enamel pin, which is what leaves the catalogue with a
   * sold-out reward from the first page load.
   *
   * Written as a redemption by another user rather than as `stock: 0` on the
   * reward itself, because stock reaching zero is a consequence of something
   * happening — and doing it this way means the seeded database is one the
   * application could actually have produced, rather than a state only the seed
   * knows how to reach.
   */
  {
    kind: 'redeem',
    userRef: 'acme-user-002',
    sku: 'ENAMEL-PIN',
    idempotencyKey: 'seed-redemption-grace-1',
    occurredAt: new Date('2026-09-04T09:30:00.000Z'),
    outcome: 'fulfilled',
  },
]

// ---------------------------------------------------------------------------
// Deliveries that produced no ledger entry
// ---------------------------------------------------------------------------

export type SeedOrphanDelivery = {
  eventId: string
  status: 'UNMATCHED' | 'REJECTED'
  unmatchedReason: 'UNKNOWN_USER' | 'NO_RULE' | null
  userRef: string | null
  activityType: string | null
  rawPayload: string
  error: string | null
  receivedAt: Date
}

/**
 * The cases the deliveries view exists for.
 *
 * Without these the view is a list of successes, which is the one thing it does
 * not need to be good at. Both UNMATCHED reasons are represented because they
 * are fixed differently: NO_RULE is resolved by adding a rule and replaying by
 * activity type, UNKNOWN_USER by creating the user and replaying by user
 * reference. That distinction is the whole reason the column exists.
 */
export const SEED_ORPHAN_DELIVERIES: SeedOrphanDelivery[] = [
  {
    eventId: 'evt_20260904_0101',
    status: 'UNMATCHED',
    unmatchedReason: 'NO_RULE',
    userRef: 'acme-user-001',
    activityType: 'SURVEY_COMPLETED',
    rawPayload: JSON.stringify({
      event_id: 'evt_20260904_0101',
      user_ref: 'acme-user-001',
      activity_type: 'SURVEY_COMPLETED',
      occurred_at: '2026-09-04T09:30:00.000Z',
    }),
    error: null,
    receivedAt: new Date('2026-09-04T09:30:12.000Z'),
  },
  {
    eventId: 'evt_20260905_0102',
    status: 'UNMATCHED',
    unmatchedReason: 'UNKNOWN_USER',
    userRef: 'acme-user-999',
    activityType: 'PURCHASE',
    rawPayload: JSON.stringify({
      event_id: 'evt_20260905_0102',
      user_ref: 'acme-user-999',
      activity_type: 'PURCHASE',
      occurred_at: '2026-09-05T13:05:00.000Z',
    }),
    error: null,
    receivedAt: new Date('2026-09-05T13:05:04.000Z'),
  },
  {
    // Stored as the exact bytes received, which is why raw_payload is text
    // rather than json: this one is not valid JSON, and it is precisely the
    // kind of payload worth keeping.
    eventId: 'evt_20260905_0103',
    status: 'REJECTED',
    unmatchedReason: null,
    userRef: null,
    activityType: null,
    rawPayload: '{"event_id":"evt_20260905_0103","user_ref":"acme-user-002",',
    error: 'Malformed JSON body: unexpected end of input',
    receivedAt: new Date('2026-09-05T13:44:51.000Z'),
  },
]
