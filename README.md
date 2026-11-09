# Expenses Tracker

A self-hosted, multi-user expenses tracker: income, expenses and transfers across wallets in different currencies,
filed under categories you manage, with totals grouped per currency (the Overview can also show all wallets
converted into one currency at the day's ECB rates). One Next.js app on PostgreSQL, shipped as a prebuilt
Docker image (amd64 and arm64). To run it:

```bash
mkdir expenses-tracker && cd expenses-tracker
curl -fsSLO https://raw.githubusercontent.com/xalert/expenses-tracker/main/deploy/compose.yaml
docker compose up -d     # then open http://localhost:3000 and create your account
```

That starts the prebuilt image and its PostgreSQL database; nothing to clone or build. More in [Self-hosting](#self-hosting).

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
`*.lan`) go in `ALLOWED_DEV_ORIGINS` (see [`.env.example`](.env.example)); under a hostname that is not allowed,
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

## Self-hosting

A prebuilt image for `linux/amd64` and `linux/arm64` is published to `ghcr.io/xalert/expenses-tracker`; the Compose
file above starts it with `postgres:17-alpine` (data in the `pg-data` volume, port not published). Open
`http://<your-server>:3000`, create your account(s), then consider closing registration. Settings go in a `.env`
file next to `compose.yaml` (`POSTGRES_PASSWORD=<a password>` before the first start, `ALLOW_REGISTRATION=false`,
`EXPENSES_TRACKER_PORT=8080`, `EXPENSES_TRACKER_VERSION=1.2.3`); run `docker compose up -d` again after a change.
Back up with `docker compose exec -T db pg_dump -U expenses -Fc expenses > expenses.dump`; take one before
upgrading (`docker compose pull && docker compose up -d`).

To build from source instead, clone the repository and run `docker compose up -d` in it
([`docker-compose.yml`](docker-compose.yml)). Images are built and published by GitHub Actions
([`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml)) after the tests pass: `latest` follows
`main`, a `v1.2.3` tag publishes `1.2.3`, `1.2` and `1`, and `sha-<commit>` pins one commit.

All settings, reverse proxies, backup and restore, upgrading (including PostgreSQL itself), publishing the image
from a fork and running without Docker are in [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md). **Instances from
before the move to PostgreSQL cannot be upgraded in place**; carry each account across with its JSON backup
([how](docs/SELF-HOSTING.md#moving-from-sqlite-older-versions)).

## Import & export

**Import & export** (`/data`) downloads a full JSON backup of your account, your transactions as CSV (also from
`/transactions`, with its filters), or your wallets and categories as JSON. Importing a backup, CSVs or a Spendee
export always adds to the signed-in account, never overwrites, skips entries that already exist, and shows a preview
before saving everything in one transaction. CSV columns (UTF-8, ISO dates, `.` decimals, a transfer is one row):
`date,type,wallet,currency,amount,category,note,to_wallet,to_currency,to_amount`. Formats, limits and the Spendee
rules are in [`docs/SPEC.md` → Import / export](docs/SPEC.md#import--export).

## Importing bank statements

Bank statements (CSV, text, PDF or a photo) are turned into this app's CSV by a companion page on claude.ai,
the [Statement Importer](https://claude.ai/artifact/1w1vJNQk41mmcG9ActCEsH): it reads ING Romania and ING Business
CSV, Wise CSV and Revolut statement PDFs directly, and anything else with Claude Haiku on your own Claude account,
stores nothing from them, and remembers the wallet and category you chose for each bank
account and merchant. Load your **Wallets & categories (JSON)** from `/data` into it, then import the CSV it gives
you at `/data` as usual. How it works, and its source, are in [`docs/STATEMENT-IMPORTER.md`](docs/STATEMENT-IMPORTER.md).

## Accounts

Each account has a user ID chosen at registration (3–32 characters: letters, digits, `.`, `_`, `-`, starting with
a letter or digit; not case-sensitive) and a password, with optional email, first name and surname; sign in with
the user ID or the email. There is no profile screen yet, so these cannot be changed after registration.

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
tests/  docs/              vitest suites; spec, decisions, self-hosting, statement importer
```

Next.js 16 (App Router, Server Components + Server Actions), PostgreSQL via Drizzle + node-postgres, Tailwind CSS v4,
zod, vitest. The build contract is [`docs/SPEC.md`](docs/SPEC.md); the reasons and known gaps are in
[`docs/DECISIONS.md`](docs/DECISIONS.md).
