# Expenses Tracker

A self-hosted, multi-user expenses tracker: income, expenses and transfers across wallets in different currencies,
filed under categories you manage, with totals grouped per currency (the Overview can also show all wallets
converted into one currency at the day's ECB rates). One Next.js app and one SQLite file, shipped as a prebuilt
Docker image (amd64 and arm64). To run it:

```bash
mkdir expenses-tracker && cd expenses-tracker
curl -fsSLO https://raw.githubusercontent.com/xalert/expenses-tracker/main/deploy/compose.yaml
docker compose up -d     # then open http://localhost:3000 and create your account
```

That runs the prebuilt image; nothing to clone or build. More in [Self-hosting](#self-hosting).

## Run it

Requires Node 20.9+ (developed on Node 24). Install the dependencies:

```bash
npm install
```

Try it with demo data. This seeds `data/demo.db` with a demo user, five wallets and two months of sample data (only
if it is not there yet) and starts the dev server on it at http://localhost:3000:

```bash
npm run dev:demo
```

It prints the login to use:

```text
[demo] Sign in with user ID demo / password demo-password (if unchanged)
```

Your own data lives in `data/app.db`, a separate file the demo never touches:

```bash
npm run dev
```

Both files are gitignored and are created and migrated on the first request (`DATABASE_URL` points the app at
another file). To put `data/demo.db` back to the fresh demo state, without a prompt:

```bash
npm run demo:reset
```

To reset your real database, `--demo` empties it and seeds the demo data, `--clean` leaves it empty. When it holds
data, both copy it to `data/app.db.before-reset-<timestamp>.bak` first and ask you to type `reset`:

```bash
npm run db:reset -- --clean
```

## Debugging

The dev server's log is also written to a file:

```bash
tail -f .next/dev/logs/next-development.log
```

Opening the dev server from another device works for this machine's own LAN addresses. Other hostnames (a tunnel,
`*.lan`) go in `ALLOWED_DEV_ORIGINS` (see [`.env.example`](.env.example)); under a hostname that is not allowed,
pages render but buttons and forms do nothing.

A second server on a scratch database. Keep `DATABASE_URL` on the same command line, never `export` it:

```bash
DATABASE_URL=/tmp/scratch.db PORT=3001 npm run dev
```

One test file:

```bash
npx vitest run tests/money.test.ts
```

Only the tests whose name matches:

```bash
npx vitest run tests/money.test.ts -t "JPY"
```

Type-check and lint:

```bash
npm run typecheck
```

```bash
npm run lint
```

The Statement Importer page can be tried locally: the `statement-importer-harness` entry in
`.claude/launch.json` serves `tools/statement-importer/` on http://127.0.0.1:8765.

## Scripts

| script | what it does |
|---|---|
| `npm run dev:demo` | seed `data/demo.db` if needed, then the dev server on it (port 3000) |
| `npm run demo:reset` | put `data/demo.db` back to the fresh demo state, no prompt |
| `npm run dev` | Next.js dev server (Turbopack) on port 3000, on your data in `data/app.db` |
| `npm run build` / `npm start` | production build / server (both force `NODE_ENV=production`) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest (services run against an in-memory SQLite DB) |
| `npm run db:generate` | generate a new migration into `drizzle/` after editing `src/db/schema.ts` |
| `npm run db:seed` | add the demo user and sample data to `data/app.db` (or `DATABASE_URL`) if missing (idempotent) |
| `npm run db:reset -- --demo` / `--clean` | real database: delete every row, then seed the demo data / leave it empty; asks first |

## Self-hosting

A prebuilt image for `linux/amd64` and `linux/arm64` is published to `ghcr.io/xalert/expenses-tracker`. Nothing
needs cloning or building — download one Compose file and start it on port 3000:

```bash
mkdir expenses-tracker && cd expenses-tracker
curl -fsSLO https://raw.githubusercontent.com/xalert/expenses-tracker/main/deploy/compose.yaml
docker compose up -d
```

Open `http://<your-server>:3000`, create your account(s), then consider closing registration. Settings go in a
`.env` file next to `compose.yaml` (`ALLOW_REGISTRATION=false`, `EXPENSES_TRACKER_PORT=8080`,
`EXPENSES_TRACKER_VERSION=1.2.3` to pin a release); run `docker compose up -d` again after a change. Upgrading is
`docker compose pull && docker compose up -d`.

To build from source instead, clone the repository and run `docker compose up -d` in it
([`docker-compose.yml`](docker-compose.yml) builds the image; upgrade with `git pull`, `docker compose build --pull`,
`docker compose up -d`). Both use the same data volume.

Images are built and published by GitHub Actions ([`.github/workflows/docker-image.yml`](.github/workflows/docker-image.yml))
after the tests pass: `latest` follows `main`, a `v1.2.3` tag publishes `1.2.3`, `1.2` and `1`, and `sha-<commit>`
pins one commit.

All settings (the app's environment variables and the Compose file's own) are listed in
[`docs/SELF-HOSTING.md` → Settings](docs/SELF-HOSTING.md#settings).

All data is in the `/data` volume (`app.db` with its `-wal` and `-shm` files); back it up with SQLite's backup API,
not by copying `app.db` alone while the app runs. Migrations run on start of a new version, after an automatic copy
of the database.
Reverse proxies, backup and restore, bind mounts, upgrading, publishing the image from a fork and running without
Docker are in
[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).

## Import & export

**Import & export** (`/data`) downloads a full JSON backup of your account, your transactions as CSV (also from
`/transactions`, with its filters), or your wallets and categories as JSON. Importing a backup, CSVs or a Spendee
export always adds to the signed-in account, never overwrites, skips entries that already exist, and shows a preview
before saving everything in one transaction. CSV columns (UTF-8, ISO dates, `.` decimals, a transfer is one row):
`date,type,wallet,currency,amount,category,note,to_wallet,to_currency,to_amount`. Formats, limits and the Spendee
rules are in [`docs/SPEC.md` → Import / export](docs/SPEC.md#import--export).

## Importing bank statements

Bank statements (CSV, text, PDF or a photo) are turned into this app's CSV by a companion page on claude.ai,
the [Statement Importer](https://claude.ai/artifact/1w1vJNQk41mmcG9ActCEsH): it reads them with Claude Haiku on
your own Claude account, stores nothing from them, and remembers the wallet and category you chose for each bank
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
src/db/  drizzle/          Drizzle schema + connection (auto-migrate); SQL migrations
src/lib/  src/components/  auth, config, money, dates, csv, form helpers; UI kit and app shell (top menu, account menu, Add button)
scripts/                   db:seed and db:reset
tools/statement-importer/  the claude.ai Statement Importer page
deploy/  .github/          Compose file for the prebuilt image; CI workflow that tests and publishes it
tests/  docs/              vitest suites; spec, decisions, self-hosting, statement importer
```

Next.js 16 (App Router, Server Components + Server Actions), SQLite via Drizzle + better-sqlite3, Tailwind CSS v4,
zod, vitest. The build contract is [`docs/SPEC.md`](docs/SPEC.md); the reasons and known gaps are in
[`docs/DECISIONS.md`](docs/DECISIONS.md).
