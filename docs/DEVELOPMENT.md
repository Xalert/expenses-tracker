# Development

Working on the app from a clone: running it locally, the demo data, debugging, every npm script and where things
live. To just run the app, use the Compose quick start in the [README](../README.md); operating an instance is in
[`SELF-HOSTING.md`](SELF-HOSTING.md).

- [Run it](#run-it)
- [Debugging](#debugging)
- [Scripts](#scripts)
- [Layout](#layout)

## Run it

Requires Node 20.9+ (developed on Node 24) and Docker (for the development database). Install the dependencies and
start PostgreSQL 17 in Docker (`compose.dev.yaml`, on `127.0.0.1:5432`, data in a named volume):

```bash
npm install
```

```bash
npm run db:up
```

Try it with demo data. This seeds the `expenses_demo` database with a demo user, five wallets and two months of
sample data (only if it is not there yet) and starts the dev server on it at http://localhost:3000:

```bash
npm run dev:demo
```

It prints the login to use:

```text
[demo] Sign in with user ID demo / password demo-password (if unchanged)
```

Your own data lives in the `expenses` database, which the demo never touches (it is created and migrated on the
first request; `DATABASE_URL` points the app at another):

```bash
npm run dev
```

To put `expenses_demo` back to the fresh demo state, without a prompt:

```bash
npm run demo:reset
```

To reset your real database, `--demo` empties it and seeds the demo data, `--clean` leaves it empty. When it holds
data, both ask you to type `reset`; there is no copy, so take a backup first (the app's JSON export or `pg_dump`):

```bash
npm run db:reset -- --clean
```

`npm run db:down` stops the database container (the data stays in its volume).

## Debugging

The dev server's log is also written to a file:

```bash
tail -f .next/dev/logs/next-development.log
```

Opening the dev server from another device works for this machine's own LAN addresses. Other hostnames (a tunnel,
`*.lan`) go in `ALLOWED_DEV_ORIGINS` (see [`.env.example`](../.env.example)); under a hostname that is not allowed,
pages render but buttons and forms do nothing.

A second server on a scratch database. Keep `DATABASE_URL` on the same command line, never `export` it (the
database must exist; `docker compose -f compose.dev.yaml exec db createdb -U expenses scratch`):

```bash
DATABASE_URL=postgres://expenses:expenses@localhost:5432/scratch PORT=3001 npm run dev
```

Tests (PGlite, no Docker needed): one file, or only the tests whose name matches:

```bash
npx vitest run tests/money.test.ts -t "JPY"
```

The Statement Importer page can be tried locally: the `statement-importer-harness` entry in
`.claude/launch.json` serves `tools/statement-importer/` on http://127.0.0.1:8765.

## Scripts

| script | what it does |
|---|---|
| `npm run db:up` / `db:down` | start / stop the development PostgreSQL (`compose.dev.yaml`) |
| `npm run dev:demo` | seed the `expenses_demo` database if needed, then the dev server on it (port 3000) |
| `npm run demo:reset` | put `expenses_demo` back to the fresh demo state, no prompt |
| `npm run dev` | Next.js dev server (Turbopack) on port 3000, on your data in `expenses` |
| `npm run build` / `npm start` | production build / server (both force `NODE_ENV=production`) |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | vitest (services run against an in-process PGlite database) |
| `npm run db:generate` | generate a new migration into `drizzle/` after editing `src/db/schema.ts` |
| `npm run db:seed` | add the demo user and sample data to `DATABASE_URL`'s database if missing (idempotent) |
| `npm run db:reset -- --demo` / `--clean` | real database: delete every row, then seed the demo data / leave it empty; asks first |

## Layout

```
src/app/(auth)/            login + register pages and their Server Actions
src/app/(app)/             signed-in pages: overview, wallets, transactions, categories, data (import/export);
                           @modal holds the dialog versions of Add, New wallet and Edit wallet
src/app/api/               health check + export downloads
src/server/                service layer: domain rules, every query scoped by userId
src/db/  drizzle/          Drizzle schema + PostgreSQL connection (auto-migrate); SQL migrations
src/lib/  src/components/  auth, config, money, dates, csv, form helpers; UI kit and app shell (top menu, account menu, Add button)
scripts/  compose.dev.yaml    db:seed and db:reset; development PostgreSQL
tools/statement-importer/  the claude.ai Statement Importer page
deploy/  .github/          Compose file for the prebuilt image; CI workflow that tests and publishes it
tests/  docs/              vitest suites; spec, decisions, self-hosting, development, statement importer
```

Next.js 16 (App Router, Server Components + Server Actions), PostgreSQL via Drizzle + node-postgres, Tailwind CSS v4,
zod, vitest. The build contract is [`SPEC.md`](SPEC.md); the reasons and known gaps are in
[`DECISIONS.md`](DECISIONS.md).
