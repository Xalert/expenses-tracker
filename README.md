# Expenses Tracker

A multi-user, multi-currency expenses tracker. Log income, expenses and transfers across wallets held in
different currencies; totals are always grouped per currency (no conversion).

Next.js (App Router, Server Components + Server Actions) · SQLite via Drizzle ORM + better-sqlite3 · Tailwind CSS v4 ·
zod · vitest. The full build contract — data model, domain rules, service signatures, UI direction — is in
[`docs/SPEC.md`](docs/SPEC.md).

## Run it

Requires Node 20.9+ (developed on Node 24).

```bash
npm install
npm run dev          # http://localhost:3000 — the DB is created and migrated on first request
npm run db:seed      # optional: demo user + sample data (prints the demo login)
```

Demo login after seeding: `demo@example.com` / `demo-password`.

## Scripts

| script | what it does |
|---|---|
| `npm run dev` | Next.js dev server (Turbopack) |
| `npm run build` / `npm start` | production build / server (both force `NODE_ENV=production`) |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | vitest (services run against an in-memory SQLite DB) |
| `npm run db:generate` | generate a new migration into `drizzle/` after editing `src/db/schema.ts` |
| `npm run db:seed` | idempotent demo data |

## Self-hosting with Docker

The app runs from a single container: a Next.js standalone server plus a SQLite file in a volume. No hosted
platform, external database or account is needed. The image builds on `linux/amd64` and `linux/arm64`
(x86 servers, Raspberry Pi 4/5, Apple silicon).

### Quick start (Docker Compose)

```bash
git clone <this repo> expenses-tracker && cd expenses-tracker
docker compose up -d          # builds the image, creates the data volume, starts on port 3000
```

Open `http://<your-server>:3000`, create your account(s), then consider
[closing registration](#closing-registration). Settings live in the `environment:` block of
[`docker-compose.yml`](docker-compose.yml); after changing one, run `docker compose up -d` again.

### Plain `docker run`

```bash
docker build -t expenses-tracker .
docker run -d --name expenses-tracker --restart unless-stopped \
  -p 3000:3000 \
  -v expenses-data:/data \
  -e COOKIE_SECURE=auto -e ALLOW_REGISTRATION=true \
  expenses-tracker
```

Build the image on (or for) the architecture it runs on: `better-sqlite3` is a native module.
`docker buildx build --platform linux/amd64,linux/arm64 …` builds both if you publish to a registry.

### Configuration

Runtime configuration is environment-only (nothing is baked in at build time; restart to apply). For local
development see [`.env.example`](.env.example) (copy it to `.env.local`).

| variable | default (image) | default (dev) | meaning |
|---|---|---|---|
| `DATABASE_URL` | `/data/app.db` | `data/app.db` | SQLite file (path, `file:./x.db` or `:memory:`); the parent folder is created if missing |
| `COOKIE_SECURE` | `auto` | `auto` | session cookie `Secure` flag: `auto` = only when the request arrived as HTTPS (`X-Forwarded-Proto: https`); `true` = always; `false` = never |
| `ALLOW_REGISTRATION` | `true` | `true` | `false` closes sign-ups (`/register` shows "Registration is disabled", the action refuses) |
| `PORT` | `3000` | `3000` | listen port inside the container |
| `HOSTNAME` | `0.0.0.0` | — | listen address (keep `0.0.0.0` in a container) |
| `MIGRATIONS_DIR` | `/app/drizzle` | `<cwd>/drizzle` | where the SQL migrations are read from; leave as is |

`GET /api/health` returns `200 {"status":"ok"}` after a trivial DB query (`503` otherwise) and needs no auth.
The image's `HEALTHCHECK` uses it, so `docker ps` shows `healthy` / `unhealthy`.

The container runs as the unprivileged `node` user (uid/gid `1000`), not root.

### Behind a reverse proxy (HTTPS)

Put Caddy, Traefik, nginx or similar in front for HTTPS and point it at port 3000. The proxy must:

- pass the original `Host` header (or set `X-Forwarded-Host`) — Server Actions (every form in the app) reject
  requests whose `Origin` does not match the host, so a proxy that rewrites `Host` to `localhost:3000` breaks
  sign-in and every form;
- set `X-Forwarded-Proto` to `https`.

Caddy and Traefik do both by default (`reverse_proxy expenses-tracker:3000` is the whole Caddy config). For nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
}
```

How `COOKIE_SECURE` plays with this:

- `auto` (default, recommended): requests that came through the HTTPS proxy get a `Secure` session cookie; direct
  plain-HTTP requests on the LAN (`http://192.168.1.10:3000`) get a normal cookie, so both keep working.
- `true`: the cookie is always `Secure`. Only use it when *every* request goes through HTTPS. Over plain HTTP the
  browser silently drops a `Secure` cookie, so signing in "succeeds" but you land straight back on the sign-in
  page with no error message.
- `false`: never `Secure` (only useful if your proxy terminates HTTPS but cannot send `X-Forwarded-Proto`).

If the app is reachable from the internet, publish it only through the proxy (e.g. `ports: ["127.0.0.1:3000:3000"]`
in the compose file) so nobody can reach it over plain HTTP, since `X-Forwarded-Proto` could otherwise be spoofed.

### Closing registration

Anyone who can reach `/register` can create an account. Once your household's accounts exist, set
`ALLOW_REGISTRATION: "false"` in `docker-compose.yml` (or `-e ALLOW_REGISTRATION=false`) and run
`docker compose up -d`. `/register` then shows "Registration is disabled", the sign-in page hides the sign-up
link, and existing users are unaffected. Flip it back to `true` temporarily to add someone.

### Where the data lives

Everything is in the `/data` volume: `app.db` plus SQLite's `app.db-wal` and `app.db-shm` (the database runs in
WAL mode — the three files belong together). With Compose the volume is named `<folder>_expenses-data`
(e.g. `expenses-tracker_expenses-data`; see `docker volume ls`), on Linux stored under
`/var/lib/docker/volumes/<name>/_data`. `docker compose down` keeps it; `docker compose down -v` **deletes it**.

### Bind mount instead of a named volume

If you would rather keep the data in a host folder (e.g. `- ./data:/data`), that folder must be writable by
uid `1000`, the user the container runs as. On a Linux host, a folder owned by root — including the one Docker
creates automatically when `./data` does not exist yet — or by another uid makes the app fail with
`SqliteError: unable to open database file`; `/api/health` returns 503 and the container stays `unhealthy`.
Fix it with either:

```bash
mkdir -p data && sudo chown 1000:1000 data       # give the folder to the container's user
```

or run the container as the folder's owner instead (the app files are world-readable, so any uid works):

```yaml
    user: "1001:1001"     # your `id -u`:`id -g`; with docker run: --user "$(id -u):$(id -g)"
    volumes:
      - ./data:/data
```

(Docker Desktop on macOS maps ownership of bind mounts loosely, so the problem does not show up there.)
Named volumes need none of this: Docker initialises them with the image's `/data`, already owned by uid 1000.

### Backup

Do not copy `app.db` on its own while the app is running: recent writes may still be in `app.db-wal`. Take a
consistent online backup with SQLite's backup API (the image has no `sqlite3` CLI; this uses the app's own
driver) and copy it out:

```bash
docker compose exec expenses-tracker node -e "const D=require('better-sqlite3'); new D('/data/app.db').backup('/tmp/app-backup.db').then(() => new D('/tmp/app-backup.db').pragma('journal_mode=DELETE'))"
docker compose cp expenses-tracker:/tmp/app-backup.db ./app-backup-$(date +%F).db
```

The result is a single self-contained SQLite file (switched out of WAL mode), safe to store anywhere and
readable with any `sqlite3`. Alternatively stop the container (`docker compose stop`) and copy all three files
of the volume together.

### Restore

```bash
docker compose stop
docker compose run --rm --no-deps -v "$PWD/app-backup-2026-01-31.db:/restore.db:ro" --entrypoint node \
  expenses-tracker -e "new (require('better-sqlite3'))('/restore.db',{readonly:true}).backup('/data/app.db').then(() => console.log('restored'))"
docker compose start
```

This writes the backup into `/data/app.db` through SQLite, so the leftover `-wal`/`-shm` files are handled
correctly (simply copying a file over `app.db` while an old `app.db-wal` sits next to it can corrupt the
database). Use the exact path of an existing file: if it does not exist, Docker mounts an empty directory instead.
It works on an empty volume too (e.g. moving to a new server).

### Upgrading

```bash
git pull
docker compose build --pull     # rebuild on the latest node:24-bookworm-slim
docker compose up -d            # recreates the container; the data volume is kept
```

Pending database migrations are applied automatically when the new version starts (on first DB access, which
the health check triggers within seconds). Take a backup first; migrations only move forward.

## Running without Docker (standalone build)

`next build` produces a self-contained server in `.next/standalone` (`output: "standalone"`; the `drizzle/`
migrations are traced into it). To run it directly with Node 20.9+:

```bash
npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cd .next/standalone && DATABASE_URL=/srv/expenses/app.db PORT=3000 node server.js
```

The reverse-proxy and backup notes above apply unchanged.

## Database

- SQLite file at `data/app.db` (gitignored) in development, `/data/app.db` in the container. Override with
  `DATABASE_URL` — a path, `file:./other.db`, or `:memory:`.
- Migrations live in `drizzle/` and are applied automatically the first time the app touches the DB.
- To reset local data, stop the server and delete the `data/` folder. For backups see [Backup](#backup)
  (locally, `sqlite3 data/app.db ".backup backup.db"` also works while the server runs).

## Layout

```
src/app/(auth)/        login + register pages and their Server Actions
src/app/(app)/         signed-in area: layout (shell + nav), dashboard, wallets, transactions
src/components/ui/     Button, Input, Select, Field, Card, Badge, Amount, EmptyState, FormError…
src/components/        transaction-list.tsx, app shell pieces
src/db/                Drizzle schema + connection (auto-migrate)
src/lib/               auth, config (env), money, currencies, dates, errors, form-state helpers
src/app/api/health/    health check route
src/server/            service layer: every query is scoped by userId
tests/                 vitest suites
scripts/seed.ts        demo data
```
