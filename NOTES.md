# Notes

Why this is built the way it is. Roughly in the order the decisions had to be made.

## The premise everything else follows from

**Points are money.** That single framing decides most of what follows: the ledger is
append-only and is the source of truth, balances are a cache rather than a value, and every
write path is designed around the assumption that it will be called twice.

The webhook is an untrusted, at-least-once channel. Partners retry, duplicate, reorder and
send malformed payloads — not occasionally, but as normal operation. A design that only
works when each event arrives exactly once is a design that silently mints or destroys
points in production.

---

## 1. The caller owns the transaction boundary

Every service function that touches the database takes a Prisma transaction client as its
first parameter. No service ever opens its own `prisma.$transaction`.

This exists to resolve a genuine conflict between two goals:

1. A redemption must debit the balance, append the ledger row and decrement reward stock
   atomically.
2. Modules are self-contained — redemption may not touch the ledger's tables, only call an
   exported ledger function.

If each service opened its own transaction, the second goal would hold and the first would
quietly break: three separate commit points, and a crash between them leaves points debited
for a reward never reserved. Letting the caller own the boundary satisfies both — redemption
opens one transaction and threads it through `ledger.appendEntry(tx, …)`.

`Tx` is defined in [`lib/db.ts`](packages/api/src/lib/db.ts) as `PrismaClient` minus
Prisma's `ITXClientDenyList` — `$transaction`, `$connect` and friends. Omitting them makes
the rule enforceable by the compiler rather than by discipline: inside a service,
`tx.$transaction(...)` does not typecheck, so a second boundary cannot be nested by
accident.

A useful consequence: `PrismaClient` is structurally assignable to `Tx`, so a read-only path
passes `prisma` directly and honours the convention without paying for a transaction it does
not need. The health readiness probe does exactly this.

**`ledger.service.ts` is the only file permitted to write `point_transactions` or
`user_balances`.** Redemption does not reach for those tables; it calls `appendEntry`. That
is what keeps module isolation intact while staying atomic.

## 2. The dedupe key is the partner's, and it is required

`event_id` is required by the contract. A payload without one fails validation and gets a
permanent 400.

The tempting alternative — synthesising a key by hashing `(user_ref, activity_type,
occurred_at)` when the partner omits one — is a trap. Two legitimately distinct activities in
the same second would hash identically, collapse into one, and cost the user points with no
trace that anything was lost. Only the partner knows whether two identical-looking events
are the same event. Requiring them to say so is the only correct answer.

Uniqueness is scoped per partner — `UNIQUE (source, external_event_id)` with
`source = "partner:{id}"` — so two partners both using `evt_1` do not collide.

**A duplicate is a success, not an error.** It returns HTTP 200 with the original outcome and
`duplicate: true`. Answering 409 would be technically defensible and operationally awful: the
partner's retry logic reads a 4xx as "this failed", and retries it forever.

### Two dedupe constraints, not one

Both of these exist, and neither replaces the other:

- **`deliveries`** enforces *"we have seen this event"*. It drives the HTTP response and the
  `duplicate` flag. This is the fast, expected path.
- **`point_transactions`** enforces *"this event has been credited at most once"*. This is a
  ledger invariant, and it holds regardless of which caller reached `appendEntry`.

The second is the load-bearing one. Ingestion is not the only writer: `backfillUnmatched`
replays events, a future queue worker will replay them, and sooner or later someone re-runs a
delivery by hand. Every one of those is a path where a bug in status bookkeeping becomes a
double credit — unless the ledger itself refuses. In the normal flow the ledger constraint
never fires. It fires exactly when something upstream got its bookkeeping wrong, which is
precisely when you want it. Same reasoning as `CHECK (balance >= 0)` sitting underneath the
application's own funds check: defence in depth, where the inner layer makes a mistake
impossible rather than merely unlikely.

Both use `INSERT … ON CONFLICT DO NOTHING RETURNING` rather than catching a unique-violation
error. This is not a style preference. In Postgres, *any* statement error aborts the
surrounding transaction, so catching a `P2002` inside an interactive transaction and then
querying for the original row fails with "current transaction is aborted". `ON CONFLICT`
raises nothing, the transaction stays healthy, and the original outcome can be read with a
plain `SELECT` in the same transaction. Both dedupe paths then read identically.

## 3. Webhook authenticity

The raw request body is captured before parsing, on the webhook route only
(`fastify-raw-body`, registered ahead of all routes because it works by installing a
content-type parser).

The signature covers `${timestamp}.${rawBody}` and is compared in constant time, with a
five-minute replay window. Re-serialising parsed JSON does not reproduce the signed bytes —
key order and whitespace are not preserved — so verifying against anything but the original
buffer fails on payloads that are perfectly valid.

The replay window and the dedupe key defend different things and are both needed: the window
limits how long a captured request stays usable, while dedupe ensures a *legitimate* retry
inside that window is harmless.

## 4. Balances, locks and stock

- `SELECT … FOR UPDATE` on the balance row inside `appendEntry`, so concurrent credits and
  debits for one user serialise instead of losing an update. Read Committed — Postgres's
  default — does not prevent this on its own.
- The balance row is materialised with `INSERT … ON CONFLICT DO NOTHING` *before* it is
  locked. `FOR UPDATE` locks nothing when the row does not exist yet, so without this a
  user's first two concurrent events would both sail through.
- The non-negative guarantee lives in `appendEntry`, under that lock. It started as a
  `CHECK (balance >= 0)` backstop as well; that constraint was dropped once it turned out to
  block legitimate clawbacks. See §9.
- Stock uses the conditional form — `UPDATE rewards SET stock = stock - 1 WHERE id = ? AND
  stock > 0` — and checks affected rows, so overselling is impossible without a read-modify-
  write race to lose.
- **Lock ordering invariant: balance first, then rewards.** Any future flow touching both
  must take them in that order, or two flows in opposite orders will deadlock under load.
- `reconcile()` asserts `balance == SUM(delta)` per user and ships three ways: `pnpm
  reconcile`, a dev-only endpoint, and a test. A cache that cannot be checked against its
  source of truth is just a second source of truth.

## 5. Redemption is two-phase

**Phase 1, one transaction:** claim the client-supplied `Idempotency-Key` first — before
touching anything valuable — then lock the balance, read the reward inside the transaction,
conditionally decrement stock, write the `Redemption` row as `RESERVED`, and append the
negative ledger entry.

**Phase 2, outside the transaction:** call fulfilment. Success marks it `FULFILLED`. Failure
writes a compensating `REVERSAL` entry, returns the stock unit, and marks it `FAILED` with a
reason.

A database transaction is never held open across a third-party network call. Doing so means a
slow partner holds row locks on live balances, and one timeout cascades into a pile-up on
every user in the queue.

The `Idempotency-Key` header is required; absent, the request is rejected with 400.

**Concurrent requests with the same key block and wait rather than getting a 409.** The
realistic case is a double-click where the second request is milliseconds behind the first,
so the wait is short and resolves cleanly. The claim uses `INSERT … ON CONFLICT DO NOTHING
RETURNING`; when no row comes back, a `SELECT … FOR UPDATE` on the existing row blocks until
the first transaction commits, and then returns its outcome. A 409 would push a retry loop
onto the client for something the server can settle itself.

Two consequences worth knowing:

- If the first transaction *rolled back*, its claim row never existed in committed state, so
  the waiter unblocks and finds nothing. It re-attempts the claim once — bounded, not a loop.
- A waiter can legitimately unblock on a `RESERVED` redemption, because the claim commits
  with phase 1 while fulfilment is still running. The replay returns the redemption's current
  state. Two identical requests returning different bodies is correct here, not a race.

`statement_timeout` is set to 10s (`SET LOCAL`, scoped to the transaction) so a genuinely
stuck first request surfaces as an error instead of hanging every retry behind it.

A crash between the phase-1 commit and phase-2 completion strands a redemption in `RESERVED`
with points already debited. A `reservedAt` timestamp is recorded so stale reservations are
identifiable; sweeping them is listed under known gaps below.

## 6. Ordering: the cheap half, deliberately

**Taken.** Earning rules are versioned by validity window (`effectiveFrom` / `effectiveTo`)
and pricing resolves against the event's `occurred_at`, never receipt time. Replay then
produces the same balance regardless of arrival order, which is most of the value for very
little complexity.

**Taken.** Partner timestamps are untrusted, so events dated more than 90 days in the past or
more than one hour in the future are rejected as a permanent 400. Clock skew is real and an
unbounded accepted range means an event can be priced against rules from any era.

**Deferred:** daily caps, campaign windows, and per-user earning rate limits. These are
genuinely order-dependent and racy — a cap makes the value of an event depend on every other
event that day, which reintroduces exactly the ordering problem the versioned rules just
removed. The payoff does not justify the complexity in a timeboxed exercise. They fit the
existing design without a schema change: a cap is another dimension on a versioned rule, and
the ledger already records everything needed to evaluate one.

## 7. Unmatched events are parked, not silently zeroed

An event that matches no earning rule — or names a user we do not know — is stored as
`UNMATCHED` and answered with **202**.

Crediting zero points instead would be the quiet failure: users earn nothing for real
activity, everything looks successful, and nobody notices for weeks. `UNMATCHED` keeps the
event, makes the gap visible in the deliveries view, and lets `backfillUnmatched()` credit it
correctly once the rule is added — replayable by `activity_type` as well as by `user_ref`,
and priced against `occurred_at`, so a backfill months later is still correct.

202 rather than 400 because the gap is ours, not the partner's. Rejecting their well-formed
event for our missing configuration would be blaming the wrong party, and would make them
retry something that cannot succeed.

Backfill's safety guard is the conditional status transition — `UPDATE … WHERE status =
'UNMATCHED'`, checking affected rows — so two concurrent backfills cannot double-credit. The
ledger constraint from §2 sits underneath that as the real guarantee.

Note that a retry of an `UNMATCHED` event replays as **202** with `duplicate: true`, not 200:
the status code reflects the delivery's outcome, and that outcome has not changed.

## 8. The shape of the data

Seven tables. The organising split is that **`point_transactions` is the only
place a fact about points lives**, and everything else is either input to it,
derived from it, or context for reading it.

### Append-only means corrections are new rows

Nothing in the ledger is ever updated or deleted. A failed fulfilment does not
edit the debit that preceded it — it writes a `REVERSAL` entry pointing at it
through `reversesId`. That column is unique, so a given entry can be reversed at
most once; without it a retried failure handler could write two compensating
entries and hand back twice what was spent.

The cost is that the ledger grows and a balance is a sum over it. That is what
`user_balances` is for, and why it is written in the same transaction as the
entry that moves it. The cache can be rebuilt from the ledger at any time. The
ledger can never be rebuilt from the cache — which is the whole reason the
direction of derivation matters.

### The sign carries the meaning

`delta` is a signed integer and the type must agree with its sign: `EARN`
positive, `REDEEM` negative, `REVERSAL` and `ADJUSTMENT` either way. A balance is
then `SUM(delta)` with no CASE expression to get wrong, and "positive amount with
negative meaning" is not representable. `CHECK (delta <> 0)` rejects entries that
record that something happened while asserting nothing did.

Integer points throughout, never floats. Points are money and money is not
binary-fractional.

### Snapshots, because a receipt is not a join

`costPointsSnapshot` and `rewardNameSnapshot` are copied onto the redemption at
the moment it happens rather than read back through the reward relation. Prices
change and products get renamed; a user looking at last year's redemption must
see the 250 points they actually paid for the thing that was actually called
that. Re-reading today's values would silently rewrite history every time the
catalogue is edited. The relation is kept for provenance — the snapshot is what
gets displayed.

`ruleId` on the ledger is the same argument for earning. It records *which
version of which rule* priced an entry, so "why is this worth 15" is answerable
by looking up a row rather than by re-running today's pricing against a
year-old event and hoping the answer has not moved.

`description` is written once for the same reason. Deriving display text at read
time means today's copy changes what an old transaction appears to say.

### Raw payloads are text, not JSON

`webhook_deliveries.rawPayload` is a text column holding the exact bytes
received. Two reasons, both of which rule out `json`:

- A malformed body cannot be stored in a `json` column at all — and malformed
  bodies are exactly the ones worth keeping, because they are the evidence in
  the conversation that starts "we definitely sent that".
- The HMAC is computed over the raw bytes. Parsing and re-serialising does not
  preserve key order or whitespace, so a stored `json` value cannot be used to
  re-verify a signature afterwards.

`userRef` and `activityType` are denormalised out of the payload once it parses,
so the deliveries view and the backfill sweep can filter without digging through
text.

### `unmatchedReason` is load-bearing

`UNKNOWN_USER` and `NO_RULE` are fixed differently — one by creating a user and
replaying by user reference, the other by adding a rule and replaying by activity
type. `backfillUnmatched` cannot target either without being able to tell them
apart, so the distinction is a column rather than something inferred by
re-parsing the payload later.

### Timestamps are `timestamptz`

Every date column is `@db.Timestamptz(3)`, not Prisma's default `timestamp(3)`.
Pricing resolves an event's `occurredAt` against rule windows, and comparing
instants that do not carry a zone is a bug that only appears once the server, the
database and the partner stop agreeing about what time it is. This is one of the
few decisions here that is nearly free to make correctly up front and genuinely
painful to migrate later.

### Constraints live in the migration

Everything Prisma's schema language cannot express is appended to the same
migration as the tables it guards, not kept in a side-car `.sql` script. A
separate script is a step someone forgets, and forgetting it does not fail — it
removes a backstop and leaves a database that looks right until the day it
matters.

| Constraint | Guards against |
| --- | --- |
| `point_transactions_delta_non_zero` | Entries that record nothing |
| `point_transactions_delta_sign_matches_type` | An `EARN` that drains a balance |
| `earning_rules_no_overlapping_windows` | Ambiguous pricing (EXCLUDE, GiST) |
| `earning_rules_window_ordered` | A window ending before it starts |
| `rewards_stock_non_negative` | Overselling by any route |
| `rewards_cost_points_positive` | Free money |

Each sits underneath an application check that already prevents the same thing.
That is deliberate: the application check produces the good error message, and
the constraint makes the bad state unreachable when a bug, a replay or a psql
session bypasses it.

The overlap constraint is the one worth singling out. `EXCLUDE USING gist` with
`tstzrange(effective_from, COALESCE(effective_to, 'infinity'), '[)')` is what
makes "rules never overlap" a property of the database rather than a convention
the seed script happens to follow. It is partial, on `active`, because a
superseded rule is kept forever so the entries it priced stay explicable, and
keeping it must not block its replacement.

### Indexes

Three that exist for a named query, rather than by reflex:

- `(user_id, created_at DESC, id DESC)` on the ledger — cursor pagination for
  transaction history. `id` breaks ties so two entries written in the same
  millisecond cannot make a page boundary skip or repeat a row.
- `(status, unmatched_reason, received_at)` on deliveries — the backfill sweep:
  everything parked for one reason, oldest first.
- `(received_at DESC)` on deliveries — the deliveries view.

### Seed data

Three users, four rules, five rewards, and a history for two of them. Shaped
around the states that are otherwise hard to reach by clicking:

- Purchases priced at both 10 and 15 points, because the rule changed at the
  start of 2026. Rule versioning is visible in the history rather than merely
  implemented.
- A fulfilled redemption and a failed-and-reversed one, so the compensating path
  has a worked example.
- Deliveries in both `UNMATCHED` states and one `REJECTED` with a genuinely
  malformed payload.
- One user with no activity at all, because the empty state is a real screen and
  it is the one most likely to be broken by nobody ever seeing it.
- Rewards from 50 to 25,000 points, so both "affordable immediately" and
  "insufficient funds" are reachable without editing the database.

The seed runs in one transaction and verifies `balance == SUM(delta)` before
committing — the same property `reconcile()` will check in production, applied
to the data it just wrote.

---

## 9. The ledger service

`ledger.service.ts` is the only file permitted to write `point_transactions` or
`user_balances`. Redemption, the webhook and the seed all reach points through
`appendEntry`. The seed included — a seed script writing those tables directly would make
the rule *mostly* true, which is the same as not true, because the whole value of the rule
is being able to rely on it. The useful side effect is that seeding exercises the real
path: the same lock, the same dedupe claim, the same arithmetic.

### Order of operations: lock, claim, check, move

`appendEntry` takes the balance row lock before it does anything else, for two reasons that
are easy to miss.

**It makes the lock ordering invariant total rather than partial.** The balance is the first
lock *any* flow acquires, so there is no ordering to compare between flows and no cycle to
deadlock on. Claiming the ledger row first would mean `appendEntry` takes a unique-index
lock before the balance while redemption takes the balance before rewards — and mixed
orderings across resources are exactly where deadlocks come from.

**The affordability check must come after the duplicate check, not before.** A retried
redemption proves it: the user spent 250 from a balance of 300, so the retry arrives when
only 50 remain. Checking affordability first would reject that retry with
`InsufficientPointsError` when the correct answer is `duplicate: true` and no movement at
all — a false failure reported for a request that had already succeeded. There is a test
pinning this exact sequence.

Holding the lock across both also means the duplicate path can report the balance it is
already holding, rather than re-reading a value that could have moved.

### Reversal is idempotent through the ordinary mechanism

`reverseEntry` does not get a special idempotency scheme. The reversal is written with
`(source, externalEventId) = ('reversal', originalId)`, so the ledger's own unique
constraint makes a second call a no-op. A retried failure handler cannot refund twice. The
unique index on `reverses_id` is a second, independent guard on the same property.

Reversals are new rows, never edits. A failed fulfilment is something that happened, and
editing the original debit away would leave a balance nobody can explain from the rows.

### The non-negative balance constraint was dropped, deliberately

`CHECK (balance >= 0)` was in the first migration, justified as defence in depth under the
application's funds check. It had to go, and finding out why was the most useful thing to
come out of this phase.

`reverseEntry` passes `enforceNonNegative: false` so that clawing back a credit that should
never have been granted lands even when the user has already spent it. The constraint made
that flag unreachable in the exact scenario it exists for — the test failed with a 23514 on
a `-400` balance.

The constraint encoded the claim "a balance is never negative", and the clawback rule
establishes that claim is false. So the constraint was wrong, not the requirement. A
row-level CHECK sees a number and not the intent behind it, so it cannot distinguish an
overdrawn spend from a correction. Refusing the clawback would leave a wrongly positive
balance, and that is the worse outcome by a wide margin: a negative balance is honest and
recoverable, because the user earns their way out of it and the ledger says exactly why. A
wrongly positive one is indistinguishable from points that were legitimately earned, so
nobody can ever tell it apart afterwards.

What still prevents an overdrawn spend is the check in `appendEntry`, which runs while the
caller holds the balance row lock — so a concurrent debit cannot slip between the check and
the write. What is genuinely given up is a backstop against a bug inside `ledger.service.ts`
itself, or against someone editing `user_balances` from a psql prompt. That is narrower than
it sounds, since that file is by rule the only writer, but it is a real reduction rather
than a free win.

A trigger enforcing the floor unless a transaction opted out with a session variable would
have kept a database-level backstop against every writer while still letting clawbacks
through. It was rejected because a trigger is control flow that appears nowhere in the
service you are reading, and following these flows top to bottom is worth more here than the
backstop it would preserve.

### `appendEntry` must run inside a transaction

`Tx` is structurally satisfied by `PrismaClient`, so nothing stops a caller passing `prisma`
directly. That is deliberate and useful for read-only paths, and wrong here: between the
ledger insert and the balance update `appendEntry` is briefly inconsistent, and only the
caller's transaction hides it. The integration tests call it inside `prisma.$transaction`
for exactly that reason, so they would also catch a change that broke the assumption.

### `reconcile` ships three ways

As a function, as `pnpm reconcile` (non-zero exit on drift, so it works as a cron job or a
deploy gate), and as a test. The test has a positive control that corrupts a balance and
asserts the drift is detected, because a "no problems found" check that always returns
nothing passes every test you would think to write for it.

`reconcile` never repairs. The ledger is authoritative, so the fix is always to rewrite the
cache from it — but doing that automatically would destroy the evidence of whatever wrote a
balance it should not have.

## 10. Ingestion

### Capture and process are two functions

`captureDelivery` records that something arrived. `processDelivery` decides what it means.
Today the route calls them in sequence, which is the simplest thing to debug — one request,
one path, top to bottom, and a failure is wherever the stack trace says it is.

When volume outgrows synchronous processing, the route stops calling `processDelivery` and a
worker polls for deliveries left in `RECEIVED` and calls it instead. **Neither function
changes.** The split *is* the migration. It is not preparation for a queue — it is the part
of a queue that has to exist either way, written now while it costs nothing.

They also run in **separate transactions**. If they shared one, an error during processing
would roll back the record that anything ever arrived, and there would be nothing for a
retry or a worker to find. Capture commits on its own; processing is a second, independent
step whose failure leaves a durable row behind.

### The status code is a control signal

It decides whether the partner retries, which makes it as load-bearing as the response body.
Wrong in one direction loses points permanently; wrong in the other produces a retry loop
that can never succeed.

| Situation | Code | Retry? | Why |
| --- | --- | --- | --- |
| New valid event, credited | 202 | No | Accepted. 202 rather than 200 because processing is allowed to become asynchronous without the contract changing. |
| Duplicate of a credited event | 200 | No | "You had this already", distinguished from "you have it now" — the only difference a retry cares about. |
| Unknown user | 202 | No | Parked as `UNMATCHED`/`UNKNOWN_USER`. Usually a signup/activity race that resolves itself. |
| No matching rule | 202 | No | Parked as `UNMATCHED`/`NO_RULE`. Our configuration gap, not their bad request. |
| Bad or stale signature | 401 | No | Not authenticated, and not stored. |
| Fails schema, or no `event_id` | 400 | No | Permanently invalid. Retrying cannot help. |
| `occurred_at` outside the accepted window | 400 | No | Permanently invalid for the same reason. |
| Internal fault | 500 | Yes | Ours, probably transient. The delivery is marked `FAILED` and a retry reprocesses it. |

**Never 409 for a duplicate.** On an at-least-once channel duplicates are normal operation,
not an error, and most retry libraries read any 4xx as failure — so a 409 would trip a
partner's alerting for something that worked exactly as designed.

`RECEIVED` and `FAILED` are deliberately not terminal. A duplicate landing on either of
those states falls through and processes now, because in both cases the partner's retry is
the second chance the design intends: `RECEIVED` means an earlier attempt was captured but
never processed, and `FAILED` means processing hit something transient.

### Signature verification

The signed string is `${timestamp}.${rawBody}`, with the timestamp *inside* the signature
rather than beside it. That is what makes the five-minute freshness window meaningful: an
attacker replaying a captured request cannot move its timestamp forward without invalidating
the signature. Signing the body alone would leave the timestamp as an unauthenticated field
anyone could rewrite.

For the same reason, authenticity is checked **before** freshness. The timestamp is only
worth reading once the signature over it has been verified.

`sign()` is exported so the dev simulator produces genuine signatures. A simulator that
bypassed verification would exercise a code path that does not exist in production, and the
signature check is precisely the part where a mistake stays invisible until someone forges a
request.

**Unauthenticated requests are the one failure mode that is not persisted.** Everything else
is recorded because the evidence is worth keeping; this one cannot be attributed to anybody,
so storing it would let an anonymous caller write rows into our database at will.

### Malformed bodies are stored, which took a custom parser

Fastify's default JSON parser rejects a malformed body with its own 400 before any handler
runs — so the payloads most worth keeping would never be seen, let alone stored. The webhook
routes register a pass-through content-type parser, scoped to that plugin, that hands the
body over as an unparsed string. Parsing is then this module's job, after the bytes are
safely recorded.

A body that cannot be parsed has no readable `event_id` to key on, so the delivery key falls
back to a hash of the raw bytes, prefixed `unparsed:`. **This is not the synthesised dedupe
key the contract rules out.** That one would merge two legitimately distinct activities and
silently cost a user points. This key is only ever attached to a delivery that is about to be
permanently rejected and can never be credited, and its job is to bound storage: without it,
a partner retrying one broken request would write an unbounded number of identical rows,
turning their bug into our disk-space problem.

### Freshness bounds on `occurred_at`

Ninety days in the past, one hour in the future. Partner clocks are untrusted input.

Without a lower bound, a misconfigured integration could replay years of history in an
afternoon, and every event would be priced against whatever rule was in force back then —
correctly, which is exactly what makes it dangerous. Ninety days is long enough that a
genuine outage-and-catch-up succeeds and short enough that anything older should be a human
decision rather than something that happens automatically at 3am.

The future bound is not zero because clock skew between two systems is normal, and rejecting
a partner whose clock runs eleven seconds fast would be absurd.

### Backfill replays the ordinary path

`backfillUnmatched` runs parked deliveries back through `processDelivery` unchanged. A
second, subtly different ingestion path is how a backfill ends up crediting a different
number of points than the original would have.

Each delivery is claimed with a conditional status transition — `UPDATE … WHERE id = ? AND
status = 'UNMATCHED'`, checking affected rows — before anything is credited. Same shape as
the conditional stock decrement. Two backfills running at once cannot both claim the same
row: the second blocks on the row lock, then sees a status that is no longer `UNMATCHED` and
skips. The ledger's unique constraint sits underneath as an independent guarantee, so a
double credit would need both to fail. There is a test that runs two backfills concurrently
and asserts exactly one credit.

Because pricing resolves against `occurredAt`, a replay months later still credits the
**historical** rate. A test covers this specifically: an event is parked with no rule, two
rule versions are then created — 70 points at the time it happened, superseded by 5 — and the
backfill credits 70.

An unfiltered backfill is refused rather than defaulting to "everything". A backfill is a
bulk credit, and making the unfiltered case an explicit decision is worth the inconvenience.

The whole backfill runs in the caller's transaction, so it is all-or-nothing. That is the
right trade at this scale — a partially applied backfill is harder to reason about than a
failed one — but at real volume it would need chunking, each chunk its own transaction.

## 11. Reads, and the authentication seam

Authentication is stubbed. An `X-Demo-User` header names the acting user, there are no
passwords or sessions, and anyone who can reach the API can act as anyone.

That is a conscious cut. Building real authentication would have consumed the time that went
into the ledger and the redemption path and demonstrated nothing about the problem this
exercise is actually about. What makes it defensible is that it is a **single seam**: every
route reads `request.user` and no route knows where that came from, so real sessions mean
changing one hook in [`plugins/auth.ts`](packages/api/src/plugins/auth.ts) and nothing else.

Resolving an identity is separate from requiring one. The hook only says who is asking and
never rejects; routes that need an identity opt in with `requireUser`. The webhook has no
acting user at all and must not be forced to invent one.

A header naming somebody we do not have is treated exactly like no header — both are 401.
Distinguishing them would turn the endpoint into a way to enumerate which user references
exist.

`GET /api/me` reads the balance from `user_balances`, not from `SUM(delta)`. This is the most
frequent read in the application and the ledger only grows; one indexed row lookup does not
get slower. That is the payoff for writing the cache in the same transaction as the ledger
row, and `reconcile()` is what makes relying on it defensible rather than hopeful.

`GET /api/rewards` returns `inStock` rather than a stock count. The client never learns that
`stock === null` means unlimited — a rule that, reimplemented client-side, eventually gets
inverted and shows an unlimited reward as sold out. It also keeps inventory levels out of a
public response. The flag is advisory: between reading it and redeeming, the last unit can
go, which is why redemption decrements with a conditional UPDATE rather than trusting it.

## 12. Redemption

The only operation that destroys value. It has to survive being called twice, called
concurrently, and called again by a client that timed out and genuinely cannot tell whether
the first attempt worked.

### Phase 1, one transaction

1. **Read the reward inside the transaction.** A price read outside could be stale by the
   time the debit runs, and the user would be charged an amount that matched neither what
   they were shown nor what the receipt records.
2. **Claim the Idempotency-Key**, by inserting the redemption row `ON CONFLICT DO NOTHING
   RETURNING`. The claim *is* the redemption row, because the unique constraint that enforces
   idempotency lives on it — which is why the reward read has to come first: the row cannot
   be written without its snapshots. A read touches nothing valuable, so nothing is at risk
   in that ordering.
3. **`lockBalance`**, before the stock decrement. This call looks redundant — `appendEntry`
   takes the same lock a few lines later — and it is not. Without it the locks would be taken
   as (reward, then balance) while every other flow takes the balance first, and two
   orderings across two resources is exactly the shape that deadlocks under load.
4. **Conditional stock decrement.** `UPDATE rewards SET stock = stock - 1 WHERE id = ? AND
   stock > 0`, checking affected rows. The update *is* the concurrency check: there is no
   window between reading the count and decrementing it, because there is no read.
5. **`appendEntry`** with a negative delta. If the balance will not cover it, the whole
   transaction rolls back — including the stock unit, so a refused redemption never quietly
   consumes inventory.

### The blocking replay

A second request with the same key does not get a 409. It blocks.

`SELECT … FOR UPDATE` on the claimed row waits until the holder's transaction ends, then
returns its outcome. The realistic cause is a double-clicked button where the second request
is milliseconds behind the first, so the wait is short and resolves cleanly. A 409 would push
a retry loop onto the client for a race the server can settle — and the client cannot tell
that race apart from a genuine failure.

Two consequences that would otherwise be baffling in production:

- **If the blocked read returns zero rows, the holder rolled back.** Their row only ever
  existed inside a transaction that aborted, so in committed state it never existed at all.
  The claim is re-attempted exactly once — bounded, never a loop, because if one retry does
  not settle it then retrying is not what is wrong. Unhandled, this is an undefined
  dereferenced under load: a mysterious null that no test reproduces.
- **A replay can legitimately unblock on a `RESERVED` redemption**, because the claim commits
  with phase 1 while fulfilment is still running. Two identical requests can therefore return
  different bodies — the first eventually says `FULFILLED`, the second may say `RESERVED` —
  and that is correct rather than a race. Each reports the truth at the moment it answered.
  Reporting a guessed final state would be the actual bug.

`SET LOCAL statement_timeout = '10s'` scopes the cap to the transaction rather than changing
behaviour for every other query in the pool. It exists because of that blocking path: if the
holder is genuinely wedged, this turns an indefinite hang into one loud error instead of
every retry queueing forever behind it.

### Phase 2, outside any transaction

Fulfilment is called with no transaction open. Holding one across a third party's network
call would hold the balance row lock for the duration of their latency, so one slow provider
stalls every other redemption for that user. Worse, their timeout would roll back a debit for
a voucher that may already have been issued — we would have given the reward away and kept
the points.

On failure the compensation writes a `REVERSAL` entry, returns the stock unit, and marks the
redemption `FAILED` with a reason. It is guarded by a conditional status transition
(`RESERVED → FAILED`, checking affected rows), the same shape as the stock decrement and the
backfill claim, so a retried failure handler cannot refund twice or return two units for one
reservation. Inside that transaction the order is balance before rewards, per the invariant.

`FULFILLMENT_FAILURE_RATE` exists so this path is genuinely reachable. A compensating reversal
that has never run is a compensating reversal that does not work, and this is the branch
nobody exercises by clicking around.

The cost of the split is a real state a crash can strand: `RESERVED`, with points debited and
nothing issued. `reservedAt` is recorded so those are findable, and the sweeper is in the
known gaps rather than pretended away.

### One deliberate exception to the tx-first convention

`redeem()` takes a `PrismaClient`, not a `Tx`. It is the only service function that does.

Every other service accepts an open transaction because the caller owns the boundary — but a
two-phase operation has no single boundary to hand it. There are two, with a third party's
network call in between, and only this function is positioned to know where each one ends.
The convention still holds underneath: `reserve` and `compensate` both take `tx` and neither
opens a transaction, and `redeem` does nothing with the database except own the boundaries.

### Status codes

`201` for a redemption this request created, `200` for a replay — with an **identical body**
either way, so a client that retried after a timeout can treat both the same. If a replay
returned less than the original, the retry would look like a partial success and the client
would have to special-case it, which is the burden idempotency exists to remove.

Both refusals are `409`, because the request was well-formed and the conflict is with current
state, but they carry distinct codes. "Earn more points" is something a user can act on;
"this is out of stock" is not, and showing the wrong one is worse than showing nothing.

## Smaller choices

- **Every route under `/api`, health included.** The Vite dev proxy then needs one rule, the
  browser makes no cross-origin request, and there is no CORS configuration to get subtly
  wrong or to work locally and fail behind a proxy.
- **One error envelope, `{ error, message }`,** with `error` a machine-readable code. Fastify's
  default 404 does not use that shape, so it is overridden; a test pins it, because the web
  client branches on `error`.
- **5xx bodies are generic.** An endpoint that moves points should not narrate constraint
  names or table structure to an untrusted caller. 4xx messages pass through, because those
  are the ones the caller can act on.
- **Environment is validated once at boot and the process exits if it is wrong.** Reading
  `process.env` at the point of use defers the failure to the middle of a request, and a
  half-configured process looks healthy to everything upstream of it.
- **Liveness does not touch the database.** If it did, a brief database outage would make
  every container look dead and get them all restarted, turning a blip into a self-inflicted
  outage. Liveness answers "restart me?"; readiness answers "route traffic to me?".
- **Mutations never auto-retry in the client.** A transparent retry on a redemption is
  precisely the double-submit the idempotency key defends against.
- **Postgres on host port 5433.** Whoever reviews this probably already has something on
  5432.

## Surprises worth recording

Four things that cost time while setting the project up. Each would have been a silent
failure rather than a loud one, which is why they are written down.

- **Fastify's default 404 does not pass through `setErrorHandler`.** It answers with
  `{ statusCode, error, message }` where `error` is a human-readable string — a different
  envelope from every other failure, which returns `{ error, message }` with a machine code.
  The web client branches on `error`, so a 404 would have quietly matched nothing and fallen
  through to the generic path. Overridden with `setNotFoundHandler`, and pinned by a test so
  it stays that way.
- **`setErrorHandler` types its error parameter as `unknown` in Fastify 5.** Initially read
  as an inconvenience, it is correct: JavaScript permits throwing any value, so reading
  `.statusCode` straight off it is an assumption that holds right up until something throws
  a string. Narrowed explicitly instead.
- **The two dev servers bind different address families on Windows.** Fastify binds
  `0.0.0.0`, so it is reachable on `127.0.0.1` but not on the IPv6 loopback that `localhost`
  resolves to first. Vite binds `localhost`, which resolves to IPv6 `::1`, so it is the exact
  opposite. Both failures present identically as "connection refused" against a healthy
  server, which reads as a startup problem rather than an address mismatch. Browsers fall
  back and are unaffected, so this only bites command-line testing — but it bit twice while
  verifying setup, in both directions. Documented in the README.
- **PostgreSQL checks CHECK constraints on an upsert's *proposed insert* before it detects
  the conflict.** Writing a balance move as a single upsert carrying the delta —
  `create: { balance: delta }, update: { increment: delta }` — is rejected by
  `CHECK (balance >= 0)` on the first debit against an *existing* row, because the
  tuple the INSERT proposes is validated before the unique-key conflict diverts it
  to the update path. The error names a row that was never going to be written.
  The fix is the pattern the ledger needed anyway: materialise the row at zero,
  then move it. That form is also required because `FOR UPDATE` locks nothing when
  the row does not yet exist.
- **pnpm 11 renamed `onlyBuiltDependencies` to `allowBuilds`.** With the old key, install
  reports success but skips Prisma's postinstall, so the client is never generated and the
  first `tsc` fails with import errors that point nowhere near the cause.

## Bugs found by adversarial review, after the tests were green

All of Phase 4's tests passed — including twenty concurrent redemptions against a balance
affording exactly one. Then five independent reviewers were pointed at the value-moving code
with instructions to find sequences producing a wrong outcome, and every finding was checked
by two more reviewers told to refute it and to default to "refuted" when uncertain.

Four survived. They are recorded here because each one was invisible to a passing suite, and
because the shape of the mistakes is more useful than the fixes.

### 1. Webhook crediting ran outside a transaction

`webhook.routes.ts` called `processDelivery(prisma, …)` — the bare client, not a transaction.
Four of the five reviewers found it independently.

`appendEntry` reads the balance under `SELECT … FOR UPDATE` and then writes an absolute
value. With no surrounding transaction every statement autocommits, so the row lock was
released the instant the SELECT finished and nothing spanned the read-modify-write. It was
precisely the lost update that lock exists to prevent, in the one path that did not have the
transaction its own docstring assumed.

It compiled silently because `Tx` is `Omit<PrismaClient, ITXClientDenyList>`, which
`PrismaClient` structurally satisfies — deliberate, so read-only paths can pass `prisma`
directly, and exactly what let a write path do the same. NOTES §9 had already written down
"`appendEntry` must run inside a transaction"; the rule was documented and then broken two
phases later.

No test caught it because the webhook suite only ever replayed the *same* event id, where
the ledger's `(source, external_event_id)` unique constraint masks the problem entirely. The
regression test posts eight concurrent **distinct** events and asserts the cached balance
equals the ledger sum. Against the old code it credited 400 and cached 100.

The lesson worth keeping: a type that is deliberately permissive in one direction will
eventually be used in the other, and a convention documented in prose is not enforced.

### 2. `appendEntry` refused every credit into a negative balance

The guard was `if (enforceNonNegative && balanceAfter < 0)` — it tested the *result*, not
whether the entry was a debit. Once a clawback put a balance below zero, every subsequent
credit was rejected too, so the webhook answered 500 forever and the user could never earn
their way out.

That is the exact opposite of the reasoning used to justify dropping
`CHECK (balance >= 0)` in the first place: negative balances are acceptable *because* they
are recoverable. The guard made them permanent. Now `input.delta < 0 &&  balanceAfter < 0` —
a credit can only ever move a balance toward zero and is never a reason to refuse.

### 3. A replay was unreachable once the catalogue changed

`reserve` validated the reward — not found, or inactive — *before* claiming the idempotency
key. So a client retrying a redemption that had already succeeded got a 409 if the reward had
since been deactivated, having already been charged. And the client that retries is by
definition the one whose first attempt timed out, so it had no way to discover the truth.

The fix is a read-only lookup for an existing redemption before the reward is read at all. A
replay now wins over any catalogue change. The authoritative claim is still the
`INSERT … ON CONFLICT`, which is what settles a genuine race; this is only the fast path for
work that is already done.

### 4. A NUL character wedged a delivery in a retry loop

PostgreSQL cannot store a NUL in `text` or `jsonb` at all. A payload carrying one failed on
INSERT rather than in validation, so it answered 500 — which tells the partner to retry, and
the retry failed identically, forever.

Both forms are now rejected as permanently invalid: the literal byte before capture, since
that one cannot be stored even as evidence, and the backslash-u-0000 JSON escape after parsing. The
first attempt at the second check was `JSON.stringify(value).includes(NUL)`, which never
matches anything — `stringify` re-escapes a NUL back into its six-character form. It looked
correct and tested nothing, which is why `containsNul` walks the decoded values instead.

### Also fixed: a documented timeout that could never fire

`SET LOCAL statement_timeout = '10s'` was described as the bound on the blocking replay path.
Prisma's default interactive-transaction timeout is **5 seconds** — shorter — so a blocked
replay was always killed first by Prisma with an opaque `P2028`, and the statement timeout
never ran. The `$transaction` call now passes an explicit 15-second timeout so the inner
bound is the one that fires.

### And two test-quality problems

The webhook suite used fixed activity-type names, so a run that failed before its cleanup
poisoned the next one through the no-overlapping-windows constraint. Names are now unique per
run.

One test was named "prices a late event at the historical rate" and actually asserted a 400,
because the seeded rule boundary is older than the 90-day freshness window so the event never
reached pricing. A test whose name does not match what it checks is worse than no test: it
reports coverage that does not exist. It was replaced with two that genuinely exercise
historical pricing.

## Known gaps

Things I would do next, and why they are not here.

- **Sweeping stale `RESERVED` redemptions.** `reservedAt` is recorded but nothing reaps it. A
  process crash between phase 1 and phase 2 leaves points debited and no reward. Needs a
  periodic job that reverses reservations older than a threshold — straightforward, but it
  needs a scheduler and a story about running exactly one of them.
- **Caps, campaign windows and earning rate limits.** Discussed in §6.
- **Webhook delivery retries from our side.** An event we reject with a 5xx relies entirely
  on the partner retrying. A durable queue in front of processing would make that ours.
- **Multi-partner key management.** `source` is already scoped per partner, but signing
  secrets are configured as one value rather than per-partner records.
- **AuthN/AuthZ on the user-facing API.** The UI acts as a fixed demo user. Real deployment
  needs sessions, and every balance and redemption query scoped to the authenticated user.
