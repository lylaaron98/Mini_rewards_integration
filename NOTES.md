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
- `CHECK (balance >= 0)` as a structural backstop under the application's funds check.
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

---

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
