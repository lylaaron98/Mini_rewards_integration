# Mini Rewards Integration

A partner sends user activity over a webhook. Users earn points for that activity and redeem
them for rewards. A web UI shows the balance, performs redemptions, and explains what
happened.

Points are treated as money: the ledger is append-only and authoritative, balances are a
cache that can be reconciled against it, and every write path assumes it will be called
twice. The reasoning behind each decision — and the trade-offs deliberately taken — is in
[NOTES.md](./NOTES.md).

## Prerequisites

- **Node 20+** (developed on 22.22)
- **pnpm 10+** (developed on 11.1) — `npm install -g pnpm`
- **Docker, and Docker Desktop actually running.** `pnpm db:up` fails with
  "cannot find the docker API" if the daemon is not started, which looks like a broken repo
  rather than a stopped application.

## Setup

```bash
pnpm install
cp packages/api/.env.example packages/api/.env

pnpm db:up          # Postgres on host port 5433
pnpm db:migrate     # applies migrations
pnpm db:seed        # loads the development dataset
pnpm dev            # API on :3000, web on :5173
```

Open <http://localhost:5173> and sign in. The sign-in screen lists the seeded demo accounts
with a button that fills the form in for you.

> **On Windows**, the two dev servers bind different address families. This only affects
> command-line tools — browsers fall back automatically:
>
> - **API directly:** `http://127.0.0.1:3000`. Fastify binds `0.0.0.0` (IPv4 only), and
>   `localhost` resolves to the IPv6 loopback first.
> - **Web, and the API through its proxy:** `http://localhost:5173`. Vite binds `localhost`,
>   which is IPv6 `::1` here, so `127.0.0.1` is refused.
>
> Either way the symptom is "connection refused" against a perfectly healthy server.

## Start with the developer panel

Sign in as **admin@example.com** — the panel is visible to administrator accounts only.

Most of what this service does happens behind a signed webhook, and the **Developer** page —
reachable from the navigation drawer, or at `#/developer` — is how to see it without
hand-crafting an HMAC. It is five cards, one per tool: simulate activity, allocate rewards,
create a reward, inspect deliveries, reconcile the ledger. Every button signs a real payload
and posts it to the real webhook route, crediting whichever account you pick:

| Button | What it demonstrates |
| --- | --- |
| Purchase / Referral / App review | A credit lands; balance and history update |
| Survey (no rule) | Accepted **202**, credits nothing, parked `UNMATCHED / NO_RULE` |
| Replay the last event id | Answered **200** with `duplicate: true`; no points move |
| Ledger reconciliation | Every cached balance compared against the sum of its ledger |

To watch a redemption fail and refund itself, set `FULFILLMENT_FAILURE_RATE=1` in
`packages/api/.env` and redeem something. The points are taken, fulfilment refuses, a
`REVERSAL` entry is written, the stock unit is returned, and the balance comes back — all
visible in the history.

## Sending a webhook by hand

The signature is `HMAC-SHA256` over `${timestamp}.${rawBody}`, keyed with `WEBHOOK_SECRET`.

```bash
SECRET='local-development-webhook-secret'
BODY='{"event_id":"evt_manual_1","user_ref":"acme-user-001","activity_type":"PURCHASE","occurred_at":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)

curl -i -X POST http://127.0.0.1:3000/api/webhooks/acme \
  -H 'content-type: application/json' \
  -H "x-webhook-timestamp: $TS" \
  -H "x-webhook-signature: $SIG" \
  -d "$BODY"
```

**Run that exact command twice.** The first returns `202` with `"duplicate": false` and
credits 15 points. The second returns `200` with `"duplicate": true` and moves nothing —
because `event_id` is unchanged. That is the at-least-once guarantee: a partner may retry
freely and cannot be charged twice for it.

Change `event_id` and it credits again. Corrupt the signature by one character and it is
`401`, unstored.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the API and the web app together |
| `pnpm test` | Unit and component tests. **No database needed** |
| `pnpm test:db` | Integration tests. Requires a running database |
| `pnpm typecheck` | Typechecks every package |
| `pnpm build` | Compiles the API and builds the web bundle |
| `pnpm reconcile` | Checks every cached balance against the ledger. **Exits non-zero on drift** |
| `pnpm db:up` / `db:down` | Starts / stops Postgres |
| `pnpm db:migrate` | Applies Prisma migrations |
| `pnpm db:reset` | Drops, re-migrates and re-seeds |
| `pnpm db:seed` | Reloads the development dataset (clears tables first) |
| `pnpm db:studio` | Prisma Studio against the local database |

`pnpm reconcile` is the one to wire into CI or cron. It prints every user whose cached
balance disagrees with the sum of their ledger and exits `1`, so a drift fails a pipeline
rather than sitting in a log nobody reads. It never repairs: the ledger is authoritative, and
silently rewriting a balance would destroy the evidence of whatever wrote it wrongly.

## Seeded data

| Account | Balance | What they exercise |
| --- | --- | --- |
| Ada Lovelace | 355 | Purchases priced by two rule versions, a fulfilled redemption, and one that failed and was reversed |
| Grace Hopper | 15 | A smaller history, and the redemption that took the last enamel pin |
| Alan Turing | 0 | The empty state — a real screen, and the one most likely to be broken by nobody looking at it |
| Dev Admin | 0 | The only account that can see the developer panel |

Sign in as `ada@example.com`, `grace@example.com`, `alan@example.com` or
`admin@example.com`, all with the password `demo1234`. The sign-in screen lists them with a
**Use** button that fills the form in, so there is nothing to copy by hand. You can also
create your own account — it starts at zero points, and the administrator can credit it from
the developer panel.

The developer panel is visible **only to `admin@example.com`**, and that is enforced on the
server: every `/api/dev/*` route requires an `ADMIN` session and answers `403` otherwise. So
hiding the panel in the UI removes the temptation rather than the capability. Because an
administrator has no history of their own, the panel lets them choose which account the
simulated activity is credited to.

Plus three deliveries that produced no ledger entry (one `UNMATCHED` per reason, one
`REJECTED` with a malformed payload) and six rewards from 50 to 25,000 points, so a
successful redemption, an insufficient-funds refusal and a sold-out reward are all reachable
without editing the database. The last of those is the Limited Edition Enamel Pin: stocked at
one, and Grace takes it in the seeded history, so the catalogue has a genuinely sold-out card
from the first page load rather than a `stock: 0` row that nothing in the app could have
produced. It is also what separates the **In stock** filter from **Everything** on the rewards
page — without it the two show the same list. The seed is destructive by design: it clears
every table first, so re-running it always produces the same state.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/webhooks/:partner` | Partner activity. HMAC-signed; see above |
| POST | `/api/auth/register` | Create an account. Signs in on success |
| POST | `/api/auth/login` | Sign in. Sets an httpOnly session cookie |
| POST | `/api/auth/logout` | Revokes the session server-side |
| GET | `/api/auth/me` | The signed-in account and its role |
| GET | `/api/me` | Balance and profile. Requires a session |
| GET | `/api/me/transactions` | Ledger history, cursor-paginated. `?cursor=&limit=&type=&order=` |
| GET | `/api/rewards` | Catalogue, cheapest first, with `inStock` |
| POST | `/api/redemptions` | Redeem. Requires a session and `Idempotency-Key` |
| GET | `/api/demo/users` | Seeded accounts for the sign-in screen. Demo only |
| GET | `/api/health/live` | Liveness. Touches nothing external |
| GET | `/api/health/ready` | Readiness. 200 if the database answers, else 503 |
| POST | `/api/dev/simulate-activity` | Signs a real payload and posts it to the webhook. **Admin** |
| GET | `/api/dev/deliveries` | Recent deliveries, including parked ones. **Admin** |
| GET | `/api/dev/reconcile` | Balances vs. ledger. Empty is healthy. **Admin** |

`/api/dev/*` is guarded twice over: the routes are registered only when
`NODE_ENV !== 'production'`, so they do not exist in a real deployment, and every one of them
requires an `ADMIN` session — `401` when signed out, `403` when signed in as an ordinary
user. The guard is a plugin-level hook rather than a per-route option, so a route added later
is protected without anyone having to remember.

Sessions are an httpOnly cookie carrying a random token; the database stores only its
SHA-256. JavaScript cannot read the cookie, so an XSS bug cannot exfiltrate a session, and a
stolen database yields nothing that can be presented back. Logging out deletes the row, so a
copied cookie stops working immediately rather than at expiry. Passwords are hashed with
scrypt from Node's standard library — memory-hard, and no native module for a reviewer to
compile.

Errors share one envelope, `{ error, message }`, where `error` is a machine-readable code.

### Webhook status codes

The status code is a control signal telling the partner whether to retry.

| Situation | Code | Retry? | Why |
| --- | --- | --- | --- |
| New valid event, credited | 202 | No | Accepted. 202 so processing can become asynchronous without the contract changing |
| Duplicate of a credited event | 200 | No | "You had this already" — the only difference a retry cares about |
| Unknown user | 202 | No | Parked `UNMATCHED / UNKNOWN_USER`. Usually a signup race that resolves itself |
| No matching rule | 202 | No | Parked `UNMATCHED / NO_RULE`. Our configuration gap, not their bad request |
| Bad or stale signature | 401 | No | Not authenticated, and not stored |
| Fails schema, or no `event_id` | 400 | No | Permanently invalid. Retrying cannot help |
| `occurred_at` outside 90 days past / 1 hour future | 400 | No | Permanently invalid, same reason |
| Rate limited | 429 | Yes | With `retry-after`. Transient |
| Internal fault | 500 | Yes | Ours, probably transient. Marked `FAILED`; a retry reprocesses |

**A duplicate is never 409.** On an at-least-once channel duplicates are normal operation,
and most retry libraries read any 4xx as failure — a 409 would trip a partner's alerting for
something that worked exactly as designed.

### Redemption status codes

`201` for a redemption this request created, `200` for a replay of one that already existed,
with an **identical body** either way so a client that retried after a timeout can treat both
the same. `409` for both refusals — `insufficient_points` and `out_of_stock` — with distinct
codes, because they mean opposite things to a person.

## Layout

```
packages/
  api/                     Fastify + Prisma
    prisma/
      schema.prisma        Models, relations, indexes
      migrations/          Including the CHECK and EXCLUDE constraints
    src/
      app.ts               Plugins, routes, rate limits, one error envelope
      index.ts             Boot and graceful shutdown with a drain timeout
      env.ts               Environment validated once, at startup
      seed.ts              Loads the dev dataset, in one transaction
      reconcile.ts         Balances vs. ledger; exits non-zero on drift
      lib/db.ts            The Prisma client and the `Tx` transaction contract
      plugins/auth.ts      The stubbed authentication seam
      modules/
        ledger/            The ONLY writer of point_transactions and user_balances
        webhook/           Signature, capture, process, backfill
        earning/           Rule windows and pricing against occurredAt
        redemption/        Two-phase redemption and the fulfilment stub
        reward/            The catalogue
        user/              Balance reads and transaction history
        health/            Liveness and readiness
        dev/               Simulator and inspection. Not registered in production
  web/                     React + Vite + TanStack Query + Tailwind
    src/
      App.tsx              The shell: session, drawer, header, current page
      pages/               Overview, Rewards, Activity — each owns its own data
      components/          Sidebar (the drawer), Card, Balance, History,
                           RedeemDialog, RewardAdmin, DevPanel
      lib/
        api.ts             The single API client
        use-route.ts       Hash routing: the URL is the source of truth
        use-nav-drawer.ts  Drawer state, remembered across reloads
        use-theme.ts       Light/dark, seeded from the system preference
        redemption-copy.ts Per-error-code copy, including the refund wording
        toast.tsx          Minimal toast provider
```

Each module owns one domain concept and exposes it through its service. Routes parse the
request, call one service function, and choose a status code — anything worth testing lives
in the service, where no HTTP layer is in the way.
