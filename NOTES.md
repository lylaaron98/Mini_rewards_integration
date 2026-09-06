# Notes

Why this is built the way it is.

## The short version

### Decisions

- **The ledger is the truth.** Append-only. A balance is a cache recomputed from it. A failed
  fulfilment writes a `REVERSAL`; nothing is ever edited or deleted.
- **One module writes it.** Only `ledger.service.ts`, so the rule above is enforceable rather
  than a convention.
- **Every write assumes it runs twice.** Earning dedupes on the partner's `event_id`,
  redemption on an `Idempotency-Key`. Two constraints, because a partner retry and a
  double-click only look alike.
- **Redemption is two-phase.** Debit in a transaction, fulfil outside it, compensate on
  failure — rather than hold a lock for however long a third party takes.
- **The webhook is untrusted.** HMAC over the raw bytes, body stored before parsing, events we
  cannot match parked with a reason instead of dropped.
- **Rules are versioned by time window,** priced against `occurredAt` — a late delivery is
  worth what it was worth when it happened.

### Trade-offs

- **Ingestion is synchronous.** Capture and process are already separate transactions, so a
  worker is a queue and a poller, not a redesign. Today a slow database becomes a
  partner-visible timeout.
- **Fulfilment is a stub** with a configurable failure rate — which is what makes the
  compensation path demonstrable.
- **No sweeper for stranded `RESERVED` redemptions.** A correct one needs the provider's real
  timeout; a number invented here would look finished and double-issue.
- **No component library, hand-rolled router.** Cost time, bought control of focus, motion and
  failure wording.
- **No earning caps.** They reintroduce the ordering problem versioned rules removed.

### With more time

1. **The `RESERVED` sweeper** — the only place a user can lose points and nothing recovers
   them.
2. **Ingestion on a worker,** which makes the `202` honest.
3. **Error states on Rewards and Activity, and an error boundary.** A failed request there
   currently reads as "nothing matches your filter".
4. **Metrics and alerting** on unmatched deliveries and reconciliation drift — a `NO_RULE` gap
   should page someone, not wait to be noticed.

Full reasoning for all of it is below.

## Points are money

The ledger, `point_transactions`, is append-only and is the only source of truth about what
a user has earned or spent. Nothing in it is ever updated or deleted — a failed fulfilment
writes a `REVERSAL` entry pointing at the debit it undoes, so the history records the part
that went wrong rather than erasing it.

`user_balances` is a **cache**, written in the same transaction as the ledger row that moves
it. It exists because reading a balance is the most frequent operation in the app and
summing an ever-growing ledger does not stay fast. What makes that defensible rather than a
second source of truth is `reconcile()`: it compares every cached balance against
`SUM(delta)` and reports any that disagree. It ships as a function, as a dev endpoint, and as
`pnpm reconcile`, which **exits non-zero** so drift fails a pipeline instead of sitting in a
log. It never repairs — silently rewriting a balance would destroy the evidence of whatever
wrote it wrongly.

Amounts are signed integers, never floats, and the sign carries the direction. A balance is
`SUM(delta)` with no CASE expression to get wrong.

## Idempotency: two constraints, not one

Both exist, and neither replaces the other:

- **`UNIQUE (partner, external_event_id)` on `webhook_deliveries`** — "we have seen this
  event". Drives the HTTP response and the `duplicate` flag. The fast, expected path.
- **`UNIQUE (source, external_event_id)` on `point_transactions`** — "this event has been
  credited at most once". A ledger invariant that holds regardless of caller.

The second is load-bearing because ingestion is not the only writer: `backfillUnmatched`
replays events, a future queue worker will, and eventually someone re-runs a delivery by
hand. Each is a path where a bookkeeping bug becomes a double credit — unless the ledger
itself refuses. In normal operation it never fires; it fires exactly when something upstream
is wrong.

Both use `INSERT … ON CONFLICT DO NOTHING RETURNING` rather than catching a unique violation.
In Postgres *any* statement error aborts the surrounding transaction, so catching a `P2002`
and then querying for the original row fails with "current transaction is aborted" — the
recovery would be broken in precisely the situation it exists for.

**A duplicate mirrors the original outcome rather than returning 409.** On an at-least-once
channel, duplicates are normal operation, not an error. Most retry libraries read any 4xx as
failure, so a 409 would trip a partner's alerting for a request that worked exactly as
designed. A replay of a credited event is `200` with `duplicate: true`; a replay of a parked
one is `202`. The code tracks the delivery's outcome, not the fact of duplication.

`event_id` is required, and there is no synthesised fallback. Hashing
`(user_ref, activity_type, occurred_at)` would merge two legitimately distinct activities in
the same second into one credit, costing the user points with no trace. Only the partner
knows whether two identical-looking events are the same event.

## Concurrency

`appendEntry` takes the balance row lock before anything else: `INSERT … ON CONFLICT DO
NOTHING` to materialise the row (`FOR UPDATE` locks nothing when the row does not exist, so
two concurrent first-ever credits would both sail through), then `SELECT … FOR UPDATE`, then
the dedupe claim, then the affordability check, then the write.

Taking the balance first makes the **lock ordering invariant** total — balance before
rewards, always — so there is no ordering to compare between flows and no cycle to deadlock
on. Stock is decremented with `UPDATE rewards SET stock = stock - 1 WHERE id = ? AND stock >
0`, checking affected rows: the update *is* the concurrency check, with no window between
reading a count and decrementing it.

Underneath sit database constraints that make bad states unrepresentable rather than merely
unlikely: `CHECK (delta <> 0)`, a check that the sign agrees with the entry type, `CHECK
(stock >= 0)`, and an `EXCLUDE USING gist` constraint making overlapping rule windows
unstorable.

**Proved, not asserted.** A test fires twenty concurrent redemptions at a balance affording
exactly one: exactly one succeeds, nineteen are refused, the balance lands on zero, and one
stock unit is taken. Another races ten users for a single unit. A third posts eight
concurrent distinct webhook events and asserts the cached balance equals the ledger sum —
that one was written because an earlier version passed every other test while destroying
points.

`CHECK (balance >= 0)` was in the first migration and was **deliberately dropped**. Clawing
back a credit that should never have been granted must land even when the user has already
spent it, and a row-level constraint sees a number rather than the intent behind it. Refusing
the clawback would leave a wrongly positive balance, which is the unrecoverable outcome; an
honest negative one is recoverable, and the user earns their way out of it. Overdrawn
*spending* is still prevented, in `appendEntry`, under the row lock.

## Why redemption is two phases

**Phase 1, one transaction:** claim the `Idempotency-Key` by inserting the redemption row,
lock the balance, read the reward *inside* the transaction so the price charged is the price
snapshotted, conditionally decrement stock, append the negative ledger entry.

**Phase 2, outside any transaction:** call fulfilment, then record what happened.

Holding a transaction across a third party's network call would hold the balance row lock for
the duration of their latency, so one slow provider stalls every redemption for that user.
Worse, their timeout would roll back a debit for a voucher that may already have been issued
— we would have given the reward away and kept the points.

On failure, a compensating transaction writes a `REVERSAL`, returns the stock unit, and marks
the redemption `FAILED`, guarded by a conditional `RESERVED → FAILED` transition so a retried
handler cannot refund twice.

A concurrent duplicate **blocks and returns the first request's outcome** rather than getting
a 409: the realistic case is a double-clicked button milliseconds apart, and a 409 pushes a
retry loop onto a client for a race the server can settle. A replay can legitimately observe
a `RESERVED` redemption, because the claim commits with phase 1 while fulfilment is still
running — each response is the truth at the moment it answered.

## Real-world edges

- **Unknown user and unknown rule are both parked, with reasons.** `UNMATCHED /
  UNKNOWN_USER` is usually a signup race that resolves itself; `UNMATCHED / NO_RULE` is our
  configuration gap. Both answer **202**, because the partner's event was valid and rejecting
  it would destroy points someone earned. Not a zero-point ledger entry: that would make the
  gap invisible while users silently earned nothing. The reason is a column because the two
  are fixed differently — one by creating the user, one by adding a rule — and
  `backfillUnmatched` replays by either, through the same `processDelivery`, priced against
  `occurredAt` so a backfill months later still credits the historical rate.
- **Raw payloads are persisted verbatim, before parsing,** as text rather than JSON. A
  malformed body cannot be stored as `json` at all, and those are the ones worth keeping; the
  HMAC also covers bytes that do not survive a parse and re-serialise. A pass-through
  content-type parser exists so Fastify does not reject them with its own 400 first.
- **Replay window of five minutes**, with the timestamp *inside* the signed string so it
  cannot be moved forward without breaking the signature. Authenticity is verified before
  freshness, because the timestamp is only worth reading once signed.
- **Timestamps are clamped** to 90 days past and 1 hour future. Partner clocks are untrusted:
  without a bound a misconfigured integration could replay years of history in an afternoon,
  correctly priced against old rules, which is what makes it dangerous. The future bound is
  not zero because clock skew is normal.
- **Permanent and transient failures are signalled differently.** 400 means stop and fix the
  payload; 401 means not authenticated and nothing was stored; 429 and 500 mean retry, and
  the delivery is left recoverable. Getting this backwards is expensive in both directions: a
  4xx on something transient loses points permanently, a 5xx on something permanent produces
  a retry loop that never succeeds.
- **Secrets never reach the logs.** Headers are logged deliberately — debugging a partner
  integration comes down to what they actually sent — with the signature and credentials
  redacted, asserted by a test that reads the log output rather than the configuration.
  Request ids are generated by us, never taken from the caller, and webhook lines carry the
  partner's `event_id` so their support question can be traced to our records.
- **Rate limits and a 32 KB body cap.** The webhook is keyed by partner rather than IP — a
  partner behind a proxy arrives from changing addresses, and two partners sharing an egress
  IP would consume each other's budget — with an allowance an order of magnitude larger than
  the browser-facing API, because a partner catching up after an outage bursts legitimately.
- **Graceful shutdown drains in-flight requests** with a 20-second cap, so a deploy cannot
  kill a redemption between its commit and its fulfilment call. Waiting forever is not
  graceful, it is a hang that ends in SIGKILL, so losing the race is logged as the incident it
  is.
- **History is cursor-paginated, never offset.** A ledger is a feed being appended to, and
  `OFFSET` means an entry landing between two requests pushes everything down: the next page
  repeats a row and silently skips another. On the one screen whose purpose is auditing a
  balance, a list that quietly lies is worse than no pagination. The cursor compares
  `(createdAt, id)` as a pair, because a redemption and its reversal routinely share a
  millisecond. Ordering flips the *comparison* as well as the sort — flipping only the sort
  returns the rows before the cursor, so page two repeats page one — which is why the filter
  and the ordering are part of the client's query key: changing either starts a new list
  rather than resuming with a cursor that no longer means what it did.

## Deliberate cuts

- **Account recovery.** Authentication itself is real — scrypt-hashed passwords, opaque
  session tokens stored only as hashes, an httpOnly cookie, rate-limited login and register,
  and no response that lets an attacker enumerate who has an account. What is missing is the
  lifecycle around it: password reset, email verification, and lockout after repeated
  failures. Each needs a mail path and a policy number — how many failures, how long a lock —
  that belongs to a product rather than to this exercise, and none of them changes the shape
  of what is here. The seam this was originally cut at is worth recording: authentication
  began as an `X-Demo-User` header, and replacing it with real sessions changed
  `plugins/auth.ts` plus the routes that issue them, because every other route reads
  `request.user` and none of them knows where it came from.
- **An asynchronous queue.** Ingestion is already split into `captureDelivery` and
  `processDelivery` across separate transactions, so moving to a worker means the route stops
  calling the second one and a worker polls `RECEIVED` instead. Neither function changes. The
  split is the migration; building the queue too would add operational surface without
  changing the design.
- **A component library.** Twelve components with Tailwind is less code than configuring and
  overriding someone else's, and it kept full control over the parts that actually matter
  here — focus styling, reduced motion, and the wording of a failed redemption.
- **Earning caps and campaign windows.** These are genuinely order-dependent: a daily cap
  makes an event's value depend on every other event that day, reintroducing exactly the
  ordering problem versioned rules just removed. The versioned-rule design accommodates them
  later without a schema change, which is the right place to stop.
- **A sweeper for stranded `RESERVED` redemptions.** See below.

## The RESERVED sweeper

Phase 2 runs outside a transaction, so a crash between the phase-1 commit and the fulfilment
call leaves a redemption `RESERVED` with the user's points debited and nothing issued. Nothing
currently recovers those.

It would be a periodic job selecting redemptions `RESERVED` for longer than a threshold —
`reservedAt` exists for exactly this query — and running each through the same compensation
path a fulfilment failure uses: conditional `RESERVED → FAILED`, a `REVERSAL` entry, the stock
unit returned. All three steps are already written and already idempotent, so the sweeper is
a scheduler around existing code rather than new logic.

It is not built because a correct one needs a decision this exercise cannot make: how long to
wait before assuming a fulfilment did not happen. Too short and it refunds a user whose
voucher is about to be issued, leaving them with both. That threshold comes from the
provider's actual timeout behaviour, and inventing a number would have produced something
that looks finished and is wrong in a way nobody notices until it double-issues. The column,
the compensation path and this note are the honest boundary.

## Scaling the data layer

The schema lives entirely in **versioned Prisma migrations**, including the CHECK and EXCLUDE
constraints that Prisma's schema language cannot express — appended to the same migration as
the tables they guard rather than a side-car script, because a separate script is a step
someone forgets and forgetting it removes a backstop silently. Any environment is reproducible
by replaying them in order, and `pnpm db:reset` does exactly that from empty.

Going to production is a `DATABASE_URL` change and nothing else. Pointing it at managed
Postgres — RDS, Cloud SQL, Neon — requires no code change: there is no local-only extension
beyond `btree_gist`, which every managed provider offers, and connection pooling is a URL
parameter.

The demo seed is **not** part of that path. It is a script, not a migration, and it is
destructive by design — it truncates before inserting — so it must never run against
production. What *would* move into migrations is the reference data the application depends
on: the reward catalogue and the earning rules. Those are configuration, not sample data, and
they need the same versioning and review as a schema change, because an earning rule with the
wrong window silently misprices every event in it.

At volume the first pressure point is the ledger, which only grows. `(user_id, created_at
DESC, id DESC)` already serves the paginated history, and the natural next step is
partitioning by month with old partitions detached to cheap storage — practical precisely
because nothing ever updates a ledger row.

## What I would do next, in priority order

1. **The RESERVED sweeper**, once the fulfilment provider's timeout is known. It is the only
   gap where a user can currently lose points and nothing recovers them, which makes it
   categorically more urgent than anything below.
2. **Move ingestion to a worker.** Synchronous processing means a slow database turns into
   webhook timeouts and partner retries. The split already exists; this is a queue and a
   poller, and it makes the 202 contract honest rather than aspirational.
3. **Close the demo seams and finish the account lifecycle.** `/api/demo/users` lists seeded
   accounts for the sign-in screen and `/api/dev/*` is registered only outside production;
   both are review affordances rather than features, and they get deleted rather than
   secured. With them go password reset, email verification and lockout — the difference
   between authentication that works and authentication that can be operated.
4. **Per-partner secrets in a table, with rotation.** `source`, the delivery key and the
   route are already scoped per partner, so this is configuration rather than schema. It
   matters the moment there is a second partner, and rotation matters the first time a secret
   leaks.
5. **Earning caps and campaign windows**, built on the versioned rules, with the ordering
   problem solved explicitly — most likely by evaluating caps against the ledger inside the
   crediting transaction rather than against a counter that can drift.
6. **Observability beyond logs.** Metrics on unmatched deliveries and reconciliation drift,
   alerting on both. A `NO_RULE` gap is currently visible only to someone who opens the
   deliveries view; it should page someone.
