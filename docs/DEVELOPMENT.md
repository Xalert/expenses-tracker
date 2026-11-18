# Development

Working on the app from a clone: running it locally, the demo data, debugging, every npm script and where things
live. To just run the app, use the Compose quick start in the [README](../README.md); operating an instance is in
[`SELF-HOSTING.md`](SELF-HOSTING.md).

- [Run it](#run-it)
- [Debugging](#debugging)
- [Make shortcuts](#make-shortcuts)
- [Scripts](#scripts)
- [Releasing](#releasing)
- [Layout](#layout)

## Run it

Requires Node 20.9+ (developed on Node 24) and Docker (for the development database). Install the dependencies and
start PostgreSQL 17 in Docker (`compose.dev.yaml`, on `127.0.0.1:5433`, data in a named volume):

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
DATABASE_URL=postgres://expenses:expenses@localhost:5433/scratch PORT=3001 npm run dev
```

Tests (PGlite, no Docker needed): one file, or only the tests whose name matches:

```bash
npx vitest run tests/money.test.ts -t "JPY"
```

The Statement Importer page can be tried locally: the `statement-importer-harness` entry in
`.claude/launch.json` serves `tools/statement-importer/` on http://127.0.0.1:8765.

## Make shortcuts

A `Makefile` wraps the scripts below so day-to-day work is a few keystrokes. `make` on its own lists the targets.

Start the development database, seed the demo data if missing and run the dev server on it (sign in as `demo` /
`demo-password`; also prints the LAN address for a phone):

```bash
make dev
```

Run typecheck, lint and the whole test suite:

```bash
make check
```

Run one test file, optionally only the tests whose name matches:

```bash
make test FILE=tests/users.test.ts NAME=changePassword
```

Re-run tests on every save (`FILE` and `NAME` work here too):

```bash
make watch
```

Put the demo database back to its fresh state:

```bash
make demo-reset
```

Give a user of the demo database a new random password (printed; their sessions are signed out):

```bash
make reset-password ID=demo
```

Open `psql` on the demo database (`DB=expenses` for your real data):

```bash
make psql
```

The rest: `make up` / `down` / `logs` (the development Postgres), `make dev-real` (the dev server on your **real**
data in `expenses`), `make build`, `make migration` (`db:generate`), `make docker-up` / `docker-down` / `docker-logs`
(the source-built Compose stack on :3000), `make release` (see [Releasing](#releasing)). Targets that need dependencies run `npm install` first when
`package-lock.json` is newer than `node_modules` (not `npm ci`, which deletes the folder first).

## Scripts

| script | what it does |
|---|---|
| `npm run db:up` / `db:down` | start / stop the development PostgreSQL (`compose.dev.yaml`) |
| `npm run dev:demo` | seed the `expenses_demo` database if needed, then the dev server on it (port 3000) |
| `npm run demo:reset` | put `expenses_demo` back to the fresh demo state, no prompt |
| `npm run dev` | Next.js dev server (Turbopack) on port 3000, on your data in `expenses` |
| `npm run build` / `npm start` | production build / server (both force `NODE_ENV=production` through `scripts/next-production.mjs`, so they also work in Windows `cmd`) |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm test` | vitest (services run against an in-process PGlite database) |
| `npm run db:generate` | generate a new migration into `drizzle/` after editing `src/db/schema.ts` |
| `npm run db:seed` | add the demo user and sample data to `DATABASE_URL`'s database if missing (idempotent) |
| `DATABASE_URL=<url> npm run user:reset-password -- <user ID or email> [--stdin]` | set a random (printed) or piped-in password and delete that user's sessions; needs `DATABASE_URL` on the command and refuses the real `expenses` database |
| `npm run db:reset -- --demo` / `--clean` | real database: delete every row, then seed the demo data / leave it empty; asks first |

## Releasing

A release is a `vX.Y.Z` tag on `main`; pushing it makes GitHub Actions publish the `X.Y.Z`, `X.Y` and `X` images
(signed, with SBOM and provenance). While working, add a line under "Unreleased" in
[`CHANGELOG.md`](../CHANGELOG.md) for anything a self-hoster should know about.

First a dry run: every check, and the changelog entry it would write, without changing anything:

```bash
make release VERSION=1.2.3 DRY_RUN=1
```

It refuses unless you are on `main`, the working tree is clean, `main` is exactly `origin/main` (it fetches first),
the version is `X.Y.Z` and newer than the last tag, and typecheck, lint and the tests pass. Then cut it: this sets
the version in `package.json` / `package-lock.json`, turns "Unreleased" into the `1.2.3` section (the commit
subjects since the last tag if "Unreleased" is empty), commits `Release v1.2.3` and adds the tag, all locally:

```bash
make release VERSION=1.2.3
```

It prints the push command (and how to undo it instead). To cut and push in one go:

```bash
make release VERSION=1.2.3 PUSH=1
```

Without `make` (Windows): `node scripts/release.mjs 1.2.3 [--dry-run | --push]`.

## Layout

```
src/app/(auth)/            login + register pages and their Server Actions
src/app/(app)/             signed-in pages: overview, wallets, transactions, categories, data (import/export);
                           @modal holds the dialog versions of Add, New wallet and Edit wallet
src/app/api/               health check + export downloads
src/server/                service layer: domain rules, every query scoped by userId
src/db/  drizzle/          Drizzle schema + PostgreSQL connection (auto-migrate); SQL migrations
src/lib/  src/components/  auth, config, money, dates, csv, form helpers; UI kit and app shell (top menu, account menu, Add button)
scripts/  compose.dev.yaml    db:seed, db:reset, release, the build/start wrapper; development PostgreSQL
tools/statement-importer/  the claude.ai Statement Importer page
deploy/  .github/          Compose file for the prebuilt image, Postgres major-upgrade script; CI workflow that tests and publishes it
tests/  docs/              vitest suites; spec, decisions, self-hosting, development, statement importer
```

Next.js 16 (App Router, Server Components + Server Actions), PostgreSQL via Drizzle + node-postgres, Tailwind CSS v4,
zod, vitest. The build contract is [`SPEC.md`](SPEC.md); the reasons and known gaps are in
[`DECISIONS.md`](DECISIONS.md).
