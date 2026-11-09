# Self-hosting

The app runs from a single container: a Next.js standalone server plus a SQLite file in a volume. No hosted
platform, external database or account is needed. The image builds on `linux/amd64` and `linux/arm64` (x86
servers, Raspberry Pi 4/5, Apple silicon).

The [README](../README.md#self-hosting) has the Compose quick start. This page has the [settings](#settings) and
everything else: running without Compose, HTTPS behind a reverse proxy, closing registration, where the
data lives, backup and restore, upgrading, and running without Docker.

- [Settings](#settings)
- [Prebuilt image](#prebuilt-image) (tags, pinning a version, publishing it from a fork)
- [Plain `docker run`](#plain-docker-run)
- [Health check and container user](#health-check-and-container-user)
- [Behind a reverse proxy (HTTPS)](#behind-a-reverse-proxy-https)
- [Closing registration](#closing-registration)
- [Where the data lives](#where-the-data-lives)
- [Bind mount instead of a named volume](#bind-mount-instead-of-a-named-volume)
- [Backup](#backup) · [Restore](#restore)
- [Upgrading](#upgrading) (automatic pre-migration copy, rolling back, the user-ID migration)
- [Running without Docker (standalone build)](#running-without-docker-standalone-build)
- [Database notes](#database-notes)

## Settings

All runtime configuration is environment variables; nothing is baked into the image, and a restart applies a
change. With [`deploy/compose.yaml`](../deploy/compose.yaml), put them in a `.env` file next to it; with the source
[`docker-compose.yml`](../docker-compose.yml), edit its `environment:` block. Then run `docker compose up -d` again.

| variable | default (image) | default (dev) | meaning |
|---|---|---|---|
| `DATABASE_URL` | `/data/app.db` | `data/app.db` | SQLite file (path, `file:./x.db` or `:memory:`); the parent folder is created if missing |
| `COOKIE_SECURE` | `auto` | `auto` | session cookie `Secure` flag: `auto` = only when the request arrived as HTTPS (`X-Forwarded-Proto: https`); `true` = always; `false` = never |
| `ALLOW_REGISTRATION` | `true` | `true` | `false` closes sign-ups (`/register` shows "Registration is disabled", the action refuses) |
| `EXCHANGE_RATES` | `true` | `true` | `false` stops the requests to `api.frankfurter.dev` for the Overview's converted "All in" view |
| `PORT` | `3000` | `3000` | listen port inside the container |
| `HOSTNAME` | `0.0.0.0` | — | listen address (keep `0.0.0.0` in a container) |
| `MIGRATIONS_DIR` | `/app/drizzle` | `<cwd>/drizzle` | where the SQL migrations are read from; leave as is |
| `ALLOWED_DEV_ORIGINS` | — | — | `npm run dev` only: extra hostnames allowed to open the dev server |

`deploy/compose.yaml` also reads these (they configure Compose, not the app):

| variable | default | meaning |
|---|---|---|
| `EXPENSES_TRACKER_VERSION` | `latest` | image tag; pin a release (`1.2.3`, or `1.2` for its fixes) or `sha-<commit>` |
| `EXPENSES_TRACKER_PORT` | `3000` | host port |
| `EXPENSES_TRACKER_IMAGE` | `ghcr.io/xalert/expenses-tracker` | image repository, for a fork or a mirror |

## Prebuilt image

The GitHub Actions workflow [`.github/workflows/docker-image.yml`](../.github/workflows/docker-image.yml) runs
typecheck, lint and the tests, then builds the image for `linux/amd64` and `linux/arm64` and pushes it to
`ghcr.io/xalert/expenses-tracker`:

| tag | follows |
|---|---|
| `latest`, `main` | the newest commit on `main` |
| `1.2.3`, `1.2`, `1` | the release tag `v1.2.3` (and the newest release in that minor / major line) |
| `sha-<commit>` | one exact commit on `main` |

[`deploy/compose.yaml`](../deploy/compose.yaml) runs it; everything in it can be set from a `.env` file next to
it, so the file itself never needs editing and can simply be downloaded again:

Its variables are in [Settings](#settings).

The file sets the Compose project name to `expenses-tracker`, the same as a clone of the repository, so both
use the volume `expenses-tracker_expenses-data`: switching between the prebuilt image and a source build keeps
the data. (Running a second instance on the same machine needs `-p <other-name>`.)

**Publishing from a fork.** Push the repository to GitHub; the workflow publishes `ghcr.io/<owner>/<repo>`
(lowercased) on every push to `main` and every `v*.*.*` tag. The first push creates the package as **private**:
open it under your profile's *Packages*, *Package settings* → *Change visibility* → *Public*, or every pull needs
a `docker login ghcr.io`. Then set `EXPENSES_TRACKER_IMAGE` (or edit the image line). A release is `git tag v1.2.3
&& git push --tags`. Pull requests run the tests and build the image but push nothing.

## Plain `docker run`

```bash
docker run -d --name expenses-tracker --restart unless-stopped \
  -p 3000:3000 \
  -v expenses-data:/data \
  -e COOKIE_SECURE=auto -e ALLOW_REGISTRATION=true \
  ghcr.io/xalert/expenses-tracker:latest
```

To build it yourself, `docker build -t expenses-tracker .` and use `expenses-tracker` as the image.

Build the image on (or for) the architecture it runs on: `better-sqlite3` is a native module.
`docker buildx build --platform linux/amd64,linux/arm64 …` builds both if you publish to a registry.

With Compose, settings live in the `environment:` block of [`docker-compose.yml`](../docker-compose.yml); after
changing one, run `docker compose up -d` again. Runtime configuration is environment-only: nothing is baked in at
build time, and a restart applies a change.

## Health check and container user

`GET /api/health` returns `200 {"status":"ok"}` after a trivial DB query (`503` otherwise) and needs no auth.
The image's `HEALTHCHECK` uses it, so `docker ps` shows `healthy` / `unhealthy`.

The container runs as the unprivileged `node` user (uid/gid `1000`), not root.

## Behind a reverse proxy (HTTPS)

Put Caddy, Traefik, nginx or similar in front for HTTPS and point it at port 3000. The proxy must:

- pass the original `Host` header (or set `X-Forwarded-Host`). Server Actions (every form in the app) reject
  requests whose `Origin` does not match the host, so a proxy that rewrites `Host` to `localhost:3000` breaks
  sign-in and every form;
- set `X-Forwarded-Proto` to `https`;
- accept uploads of 6 MB. Imports on `/data` take up to 5 MB of files; nginx's `client_max_body_size` defaults to
  **1 MB**, and without raising it large imports fail with `413 Request Entity Too Large`.

Caddy and Traefik do the first two by default (`reverse_proxy expenses-tracker:3000` is the whole Caddy config).
For nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    client_max_body_size 6m;          # imports on /data accept files up to 5 MB (nginx default: 1 MB)
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

## Closing registration

Anyone who can reach `/register` can create an account. Once your household's accounts exist, set
`ALLOW_REGISTRATION: "false"` in `docker-compose.yml` (or `-e ALLOW_REGISTRATION=false`) and run
`docker compose up -d`. `/register` then shows "Registration is disabled", the register action refuses, the
sign-in page hides the sign-up link, and existing users are unaffected. Flip it back to `true` temporarily to add
someone.

## Where the data lives

Everything is in the `/data` volume: `app.db` plus SQLite's `app.db-wal` and `app.db-shm` (the database runs in
WAL mode — the three files belong together). With Compose the volume is named `<folder>_expenses-data`
(e.g. `expenses-tracker_expenses-data`; see `docker volume ls`), on Linux stored under
`/var/lib/docker/volumes/<name>/_data`. `docker compose down` keeps it; `docker compose down -v` **deletes it**.

There is no reset command for a deployed instance (`npm run db:reset` is a development tool and refuses to run
with `NODE_ENV=production`). To start over, take a [backup](#backup), then `docker compose down -v` and
`docker compose up -d`: the app creates and migrates a new, empty database on first start.

## Bind mount instead of a named volume

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

Docker Desktop on macOS maps ownership of bind mounts loosely, so the problem does not show up there. Named
volumes need none of this: Docker initialises them with the image's `/data`, already owned by uid 1000.

## Backup

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

Each user can also download a **Full backup (JSON)** of their own account at `/data`; it restores into any
instance by importing it, but it covers one account, not the whole database.

## Restore

```bash
docker compose stop
docker compose run --rm --no-deps -v "$PWD/app-backup-2026-01-31.db:/restore.db:ro" --entrypoint node \
  expenses-tracker -e "new (require('better-sqlite3'))('/restore.db',{readonly:true}).backup('/data/app.db').then(() => console.log('restored'))"
docker compose start
```

This writes the backup into `/data/app.db` through SQLite, so the leftover `-wal`/`-shm` files are handled
correctly (simply copying a file over `app.db` while an old `app.db-wal` sits next to it can corrupt the
database). Use the exact path of an existing file: if it does not exist, Docker mounts an empty directory
instead. It works on an empty volume too (e.g. moving to a new server).

## Upgrading

With the prebuilt image ([`deploy/compose.yaml`](../deploy/compose.yaml)):

```bash
docker compose pull             # the newest image for your EXPENSES_TRACKER_VERSION
docker compose up -d            # recreates the container; the data volume is kept
```

Built from source:

```bash
git pull
docker compose build --pull     # rebuild on the latest node:24-bookworm-slim
docker compose up -d            # recreates the container; the data volume is kept
```

Pending database migrations are applied automatically when the new version starts (on first DB access, which
the health check triggers within seconds). Take a backup first; migrations only move forward.

### Automatic pre-migration copy

Before applying pending migrations to a database that already has data, the app writes a consistent copy of it
next to the database file, named after the first pending migration — in the container
`/data/app.db.before-migration-0001_user_ids.bak`. An existing copy is never overwritten; a later one gets a
timestamp in its name. It is a self-contained SQLite file. The app logs
`[db] Pending migrations …: copied the database to …` when it writes one. Delete it once you are happy with the
upgrade; it is not cleaned up for you.

After applying migrations the app checks that no row points at something that no longer exists, and refuses to
start (the error names the copy) if one does.

### Rolling back

To go back to the state before the upgrade, run the **previous** version of the image (with the prebuilt image:
set `EXPENSES_TRACKER_VERSION` to the release or `sha-<commit>` you ran before) and restore the copy into
`/data/app.db` (the same procedure as [Restore](#restore), reading the file that is already in the volume):

```bash
docker compose stop
docker compose run --rm --no-deps --entrypoint node expenses-tracker -e \
  "new (require('better-sqlite3'))('/data/app.db.before-migration-0001_user_ids.bak',{readonly:true}).backup('/data/app.db').then(() => console.log('restored'))"
```

Starting the new version on the restored file simply migrates it again.

### Upgrading to user IDs (migration `0001_user_ids`)

Accounts created before user IDs existed keep signing in with their email and their password, and also get a
user ID:

- The user ID is the part of the email before `@`, lowercased, with every character other than `a–z 0–9 . _ -`
  replaced by `-`, leading `.`/`_`/`-` dropped and cut to 32 characters — `Jane.Doe+bills@example.com` becomes
  `jane.doe-bills`. If that leaves fewer than 3 characters it is `user<number>` (e.g. `user7`). If another,
  older account already has the same user ID, `-<number>` is appended (`jane.doe-bills-12`). The number is the
  account's internal id.
- The name is split at its first space into first name and surname (`Ana Maria Pop` → `Ana` / `Maria Pop`).
- Nothing else changes: emails, passwords, wallets, categories, transactions, transfers and sessions are kept
  exactly as they were, and signed-in browsers stay signed in.

The account menu (the initials at the top right) shows each account's user ID under its name. To list them all on a server:

```bash
docker compose exec expenses-tracker node -e "console.table(new (require('better-sqlite3'))('/data/app.db',{readonly:true}).prepare('select username, email from users').all())"
```

## Running without Docker (standalone build)

`next build` produces a self-contained server in `.next/standalone` (`output: "standalone"`; the `drizzle/`
migrations are traced into it). To run it directly with Node 20.9+:

```bash
npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cd .next/standalone && DATABASE_URL=/srv/expenses/app.db PORT=3000 node server.js
```

The reverse-proxy, backup and upgrade notes above apply unchanged (with the file at your `DATABASE_URL` instead
of `/data/app.db`).

## Database notes

- SQLite file at `data/app.db` (gitignored) in development, `/data/app.db` in the container. Override with
  `DATABASE_URL` — a path, `file:./other.db`, or `:memory:`; the parent folder is created if missing.
- Migrations live in `drizzle/` and are applied automatically the first time the app touches the DB, with
  foreign keys switched off around them (SQLite rebuilds a table to change a column, and dropping the old table
  with foreign keys on would cascade-delete everything that references it), followed by a foreign-key check. A
  database that already has data is copied to `<file>.before-migration-<tag>.bak` first (see
  [Upgrading](#automatic-pre-migration-copy)). Generated migrations that rebuild a table must be checked by hand
  before they ship.
- Locally, `sqlite3 data/app.db ".backup backup.db"` takes a consistent backup while the dev server runs. To
  reset local data, use `npm run db:reset` (see the README); it keeps a copy of the old database.
