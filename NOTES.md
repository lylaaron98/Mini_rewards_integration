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
