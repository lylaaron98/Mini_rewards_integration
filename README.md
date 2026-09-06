# Mini Rewards Integration

A partner sends user activity over a webhook. Users earn points for that activity and
redeem them for rewards. A small web UI shows the balance, performs redemptions, and
explains what happened.

The reasoning behind the design — and the trade-offs deliberately taken — is in
[NOTES.md](./NOTES.md).

## Requirements

- Node 20+ (developed on 22.22)
- pnpm 10+ (developed on 11.1)
- Docker, for the Postgres container

## Running it

```bash
pnpm install
cp packages/api/.env.example packages/api/.env

pnpm db:up          # starts Postgres on host port 5433
pnpm db:migrate     # applies migrations
pnpm db:seed        # loads the development dataset
pnpm dev            # API on :3000, web on :5173
```

Then open <http://localhost:5173>. The status panel turns green once the API and database
are both reachable, which is also the quickest way to tell whether the container has
finished starting.

> On Windows, the two dev servers bind different address families, which matters only for
> command-line tools — browsers fall back automatically:
>
> - **API directly:** use `http://127.0.0.1:3000`. Fastify binds `0.0.0.0` (IPv4 only), and
>   `localhost` resolves to the IPv6 loopback first.
> - **Web, and the API through its proxy:** use `http://localhost:5173`. Vite binds
>   `localhost`, which here is IPv6 `::1`, so `127.0.0.1` is refused.
>
> Either way the symptom is "connection refused" against a perfectly healthy server.

## Commands

| Command           | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `pnpm dev`        | Runs the API and the web app together                  |
| `pnpm test`       | Runs the Vitest suites (no database needed)             |
| `pnpm test:db`    | Integration tests that need a running database          |
| `pnpm typecheck`  | Typechecks every package                               |
| `pnpm build`      | Compiles the API and builds the web bundle             |
| `pnpm db:up`      | Starts Postgres via docker compose                     |
| `pnpm db:down`    | Stops it                                               |
| `pnpm db:migrate` | Applies Prisma migrations                              |
| `pnpm db:reset`   | Drops and rebuilds the database                         |
| `pnpm db:seed`    | Reloads the development dataset (clears tables first)   |
| `pnpm db:studio`  | Opens Prisma Studio against the local database          |
| `pnpm reconcile`  | Checks every cached balance against the ledger           |

## Seeded data

`pnpm db:seed` loads a dataset shaped around the states that are otherwise awkward to
reach by clicking:

| User | Balance | What they exercise |
| --- | --- | --- |
| Ada Lovelace | 355 | Full history: purchases priced by two different rule versions, a fulfilled redemption, and one that failed and was reversed |
| Grace Hopper | 515 | A second, smaller history, so switching users shows different data |
| Alan Turing | 0 | The empty state, which is a real screen and the one most likely to be broken by nobody looking at it |

There are also three deliveries that produced no ledger entry — one `UNMATCHED` for each
reason (`NO_RULE`, `UNKNOWN_USER`) and one `REJECTED` with a genuinely malformed payload —
and rewards from 50 to 25,000 points, so both a successful redemption and an
insufficient-funds refusal are reachable without editing the database.

The seed is destructive: it clears every table first, so re-running it always produces the
same state rather than a different one depending on how many times it has run.

## Layout

```
packages/
  api/                     Fastify + Prisma
    prisma/
      schema.prisma        Models, relations, indexes
      migrations/          Including the CHECK and EXCLUDE constraints
    src/
      app.ts               Plugin and route registration; builds without listening
      index.ts             Boot and graceful shutdown
      env.ts               Environment validated once, at startup
      seed-data.ts         The development dataset, as importable constants
      seed.ts              Loads it, in one transaction
      reconcile.ts         Checks balances against the ledger; exits non-zero on drift
      lib/db.ts            The Prisma client and the `Tx` transaction contract
      modules/
        health/            One directory per domain concept: routes + service
        earning/           Rule-window resolution
        ledger/            The only writer of point_transactions and user_balances
  web/                     React + Vite + TanStack Query + Tailwind
    src/
      lib/api.ts           The single API client
      App.tsx
```

Each module owns one domain concept and exposes it through its service. Routes parse the
request, call one service function, and choose a status code — anything worth testing lives
in the service, where no HTTP layer is in the way.

## Endpoints

| Method | Path                 | Purpose                                             |
| ------ | -------------------- | --------------------------------------------------- |
| GET    | `/api/health/live`   | Liveness. Touches nothing external.                  |
| GET    | `/api/health/ready`  | Readiness. 200 if the database answers, else 503.    |

Everything is mounted under `/api`, health included, so the Vite dev proxy needs exactly one
rule and the browser never makes a cross-origin request.
