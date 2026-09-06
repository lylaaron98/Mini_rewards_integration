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

1. **The `RESERVED` sweeper**, once the provider's timeout is known — the only place a user
   can lose points and nothing recovers them.
2. **Ingestion on a worker,** which makes the `202` honest.
3. **Error states on Rewards and Activity, and an error boundary.** A failed request there
   currently reads as "nothing matches your filter".
4. **Metrics and alerting** on unmatched deliveries and reconciliation drift — a `NO_RULE` gap
   should page someone, not wait to be noticed.
5. **Per-partner secrets in a table, with rotation.** Already scoped per partner everywhere,
   so this is configuration rather than schema.
6. **Close the demo seams and finish the account lifecycle** — `/api/demo/users` and
   `/api/dev/*` deleted rather than secured; password reset, verification, lockout added.

The rest of this document is the reasoning behind those.

## Points are money

`point_transactions` is append-only and the only source of truth. A failed fulfilment writes a
`REVERSAL` pointing at the debit it undoes, so the history records what went wrong rather than
erasing it. Amounts are signed integers, never floats, and the sign carries the direction: a
balance is `SUM(delta)` with no CASE expression to get wrong.

`user_balances` is a **cache**, written in the same transaction as the ledger row that moves
it, because summing an ever-growing ledger does not stay fast. What makes that defensible is
`reconcile()`: it compares every cached balance against `SUM(delta)` and ships as a function, a
dev endpoint, and `pnpm reconcile`, which **exits non-zero** so drift fails a pipeline instead
of sitting in a log. It never repairs — silently rewriting a balance destroys the evidence of
whatever wrote it wrongly.

## Idempotency: two constraints, not one

- **`UNIQUE (partner, external_event_id)` on `webhook_deliveries`** — "we have seen this
  event". Drives the HTTP response and the `duplicate` flag.
- **`UNIQUE (source, external_event_id)` on `point_transactions`** — "this event has been
  credited at most once". A ledger invariant that holds regardless of caller.

The second is load-bearing because ingestion is not the only writer: `backfillUnmatched`
replays events, a queue worker will, and eventually someone re-runs a delivery by hand. Each
is a path where a bookkeeping bug becomes a double credit unless the ledger itself refuses.

Both use `INSERT … ON CONFLICT DO NOTHING RETURNING` rather than catching a unique violation.
In Postgres any statement error aborts the surrounding transaction, so catching a `P2002` and
querying for the original row fails with "current transaction is aborted" — the recovery
broken in precisely the situation it exists for.

**A duplicate mirrors the original outcome rather than returning 409.** On an at-least-once
channel duplicates are normal operation, and most retry libraries read any 4xx as failure, so
a 409 would trip a partner's alerting for a request that worked as designed. A replay of a
credited event is `200` with `duplicate: true`; a replay of a parked one is `202`.

`event_id` is required, with no synthesised fallback. Hashing
`(user_ref, activity_type, occurred_at)` would merge two genuinely distinct activities in the
same second into one credit, costing the user points with no trace. Only the partner knows
whether two identical-looking events are the same event.

## Concurrency

`appendEntry` takes the balance row lock before anything else: `INSERT … ON CONFLICT DO
NOTHING` to materialise the row (`FOR UPDATE` locks nothing when the row does not exist, so two
concurrent first-ever credits would both sail through), then `SELECT … FOR UPDATE`, then the
dedupe claim, the affordability check, and the write. Taking the balance first makes the lock
ordering total — balance before rewards, always — so there is no cycle to deadlock on.

Stock uses `UPDATE rewards SET stock = stock - 1 WHERE id = ? AND stock > 0` and checks
affected rows: the update *is* the concurrency check, with no window between reading a count
and decrementing it. Underneath sit constraints that make bad states unrepresentable rather
than unlikely — `CHECK (delta <> 0)`, sign-agrees-with-type, `CHECK (stock >= 0)`, and an
`EXCLUDE USING gist` making overlapping rule windows unstorable.

**Proved, not asserted.** Twenty concurrent redemptions against a balance affording exactly
one: one succeeds, nineteen are refused, one stock unit moves. Ten users race for a single
unit. Eight concurrent webhook events assert the cached balance equals the ledger sum — that
test exists because an earlier version passed everything else while destroying points.

`CHECK (balance >= 0)` was in the first migration and was **deliberately dropped**. A clawback
of a credit that should never have been granted must land even after the user has spent it,
and a row-level constraint sees a number rather than the intent behind it. A wrongly positive
balance is unrecoverable; an honest negative one is not. Overdrawn *spending* is still
prevented in `appendEntry`, under the row lock.

## Why redemption is two phases

**Phase 1, one transaction:** claim the `Idempotency-Key` by inserting the redemption row, lock
the balance, read the reward *inside* the transaction so the price charged is the price
snapshotted, conditionally decrement stock, append the negative entry.

**Phase 2, outside any transaction:** call fulfilment, record what happened.

Holding a transaction across a third party's network call holds the balance lock for the
duration of their latency, so one slow provider stalls every redemption for that user. Worse,
their timeout would roll back a debit for a voucher that may already have been issued — the
reward given away and the points kept.

On failure a compensating transaction writes a `REVERSAL`, returns the stock unit, and marks
the redemption `FAILED`, guarded by a conditional `RESERVED → FAILED` transition so a retried
handler cannot refund twice. A concurrent duplicate blocks and returns the first request's
outcome rather than a 409: the realistic case is a double-clicked button, and a 409 pushes a
retry loop onto the client for a race the server can settle.

## Real-world edges

- **Unknown user and unknown rule are both parked, with reasons.** Both answer **202** — the
  partner's event was valid, and rejecting it would destroy points someone earned. Not a
  zero-point ledger entry, which would make the gap invisible while users silently earned
  nothing. The reason is a column because the two are fixed differently: one by creating the
  user, one by adding a rule. `backfillUnmatched` replays by either, through the same
  `processDelivery`, priced against `occurredAt`.
- **Raw payloads are persisted verbatim, before parsing,** as text rather than JSON. A
  malformed body cannot be stored as `json` at all, and those are the ones worth keeping; the
  HMAC also covers bytes that do not survive a parse and re-serialise.
- **Five-minute replay window,** with the timestamp *inside* the signed string so it cannot be
  moved forward without breaking the signature. Authenticity is verified before freshness.
- **Timestamps are clamped** to 90 days past, 1 hour future. Without a bound, a misconfigured
  integration could replay years of history in an afternoon, correctly priced against old
  rules — which is what makes it dangerous. The future bound is not zero because clock skew is
  normal.
- **Permanent and transient failures are signalled differently.** 400 means stop and fix the
  payload; 401 means nothing was stored; 429 and 500 mean retry. Backwards in either direction
  is expensive: a 4xx on something transient loses points permanently, a 5xx on something
  permanent produces a retry loop that never succeeds.
- **Secrets never reach the logs.** Headers are logged deliberately — debugging a partner
  integration comes down to what they actually sent — with signature and credentials redacted,
  asserted by a test that reads the log output rather than the configuration.
- **Rate limits and a 32 KB body cap.** The webhook is keyed by partner rather than IP: a
  partner behind a proxy arrives from changing addresses, and two sharing an egress IP would
  consume each other's budget. Its allowance is an order of magnitude larger than the
  browser-facing API, because a partner catching up after an outage bursts legitimately.
- **Graceful shutdown drains in-flight requests** with a 20-second cap, so a deploy cannot kill
  a redemption between its commit and its fulfilment call. Waiting forever is a hang that ends
  in SIGKILL, so losing the race is logged as the incident it is.
- **History is cursor-paginated, never offset.** `OFFSET` means an entry landing between two
  requests pushes everything down: the next page repeats a row and skips another. On the one
  screen whose purpose is auditing a balance, a list that quietly lies is worse than no
  pagination. The cursor compares `(createdAt, id)` as a pair, because a redemption and its
  reversal routinely share a millisecond, and ordering flips the comparison as well as the
  sort — flipping only the sort returns the rows *before* the cursor.

## Deliberate cuts

- **The `RESERVED` sweeper.** Phase 2 runs outside a transaction, so a crash between the
  phase-1 commit and the fulfilment call leaves a redemption `RESERVED` with points debited and
  nothing issued. The fix is a periodic job over `reservedAt` running each through the
  compensation path a fulfilment failure already uses — a scheduler around existing idempotent
  code, not new logic. It is unbuilt because a correct one needs a number this exercise cannot
  supply: how long to wait before assuming fulfilment did not happen. Too short and it refunds
  a user whose voucher is about to arrive, leaving them with both.
- **Account recovery.** Authentication is real: scrypt-hashed passwords, opaque session tokens
  stored only as hashes, an httpOnly cookie, rate-limited login and register, and no response
  that lets an attacker enumerate accounts. Missing is the lifecycle — reset, verification,
  lockout — each needing a mail path and a policy number that belongs to a product. The seam is
  worth recording: this began as an `X-Demo-User` header, and replacing it with real sessions
  changed `plugins/auth.ts` and the routes that issue them, because every other route reads
  `request.user` and none knows where it came from.
- **An asynchronous queue.** Moving to a worker means the route stops calling
  `processDelivery` and a worker polls `RECEIVED` instead. Neither function changes: the split
  is the migration, and building the queue too would add operational surface without changing
  the design.
- **A component library.** Twelve components with Tailwind is less code than configuring and
  overriding someone else's, and it kept control of what matters here — focus styling, reduced
  motion, and the wording of a failed redemption.
- **Earning caps and campaign windows.** Genuinely order-dependent: a daily cap makes an
  event's value depend on every other event that day, reintroducing the ordering problem
  versioned rules just removed. The design accommodates them later without a schema change,
  which is the right place to stop.

## Scaling the data layer

The schema lives entirely in **versioned Prisma migrations**, including the CHECK and EXCLUDE
constraints Prisma's schema language cannot express — appended to the migration that creates
the tables they guard, because a side-car script is a step someone forgets and forgetting it
removes a backstop silently. Going to production is a `DATABASE_URL` change and nothing else:
no local-only extension beyond `btree_gist`, which every managed provider offers.

The demo seed is **not** part of that path. It is a script, destructive by design, and must
never run against production. What *would* move into migrations is the reference data the
application depends on — the reward catalogue and the earning rules. Those are configuration
rather than sample data, and an earning rule with the wrong window silently misprices every
event in it.

At volume the first pressure point is the ledger, which only grows.
`(user_id, created_at DESC, id DESC)` already serves the paginated history, and the natural
next step is partitioning by month with old partitions detached to cheap storage — practical
precisely because nothing ever updates a ledger row.
