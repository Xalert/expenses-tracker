# Self-hosting

The app runs from two containers started by one Compose file: a Next.js standalone server and a PostgreSQL 17
database with its data in a volume. No hosted platform or account is needed. The image is pure JavaScript and is
published for `linux/amd64` and `linux/arm64` (x86 servers, Raspberry Pi 4/5, Apple silicon).

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
- [Upgrading](#upgrading) (rolling back, [PostgreSQL itself](#upgrading-postgresql-itself), [moving from SQLite](#moving-from-sqlite-older-versions))
- [Running without Docker (standalone build)](#running-without-docker-standalone-build)
- [Database notes](#database-notes)

## Settings

All runtime configuration is environment variables; nothing is baked into the image, and a restart applies a
change. With [`deploy/compose.yaml`](../deploy/compose.yaml), put them in a `.env` file next to it; with the source
[`docker-compose.yml`](../docker-compose.yml), edit its `environment:` block. Then run `docker compose up -d` again.

| variable | default (image) | default (dev) | meaning |
|---|---|---|---|
| `DATABASE_URL` | — (required; the Compose files set it) | `postgres://expenses:expenses@localhost:5432/expenses` | PostgreSQL connection URL (`postgres://user:password@host:5432/dbname`); the app migrates it on first use. Unset in production: the app refuses to start using the database |
| `COOKIE_SECURE` | `auto` | `auto` | session cookie `Secure` flag: `auto` = only when the request arrived as HTTPS (`X-Forwarded-Proto: https`); `true` = always; `false` = never |
| `ALLOW_REGISTRATION` | `true` | `true` | `false` closes sign-ups (`/register` shows "Registration is disabled", the action refuses) |
| `EXCHANGE_RATES` | `true` | `true` | `false` stops the requests to `api.frankfurter.dev` for the Overview's converted "All in" view |
| `PORT` | `3000` | `3000` | listen port inside the container |
| `HOSTNAME` | `0.0.0.0` | — | listen address (keep `0.0.0.0` in a container) |
| `MIGRATIONS_DIR` | `/app/drizzle` | `<cwd>/drizzle` | folder the SQL migrations are read from; leave as is |
| `ALLOWED_DEV_ORIGINS` | — | — | `npm run dev` only: extra hostnames allowed to open the dev server |

`deploy/compose.yaml` also reads these (they configure Compose, not the app):

| variable | default | meaning |
|---|---|---|
| `EXPENSES_TRACKER_VERSION` | `latest` | image tag; pin a release (`1.2.3`, or `1.2` for its fixes) or `sha-<commit>` |
| `EXPENSES_TRACKER_PORT` | `3000` | host port |
| `EXPENSES_TRACKER_IMAGE` | `ghcr.io/xalert/expenses-tracker` | image repository, for a fork or a mirror |
| `POSTGRES_PASSWORD` | `expenses` | password of the `db` service's `expenses` user, also put into `DATABASE_URL`; use URL-safe characters (or URL-encode). Set it in `.env` before the first start; the port is not published, which is why the default is tolerable |

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
use the volume `expenses-tracker_pg-data`: switching between the prebuilt image and a source build keeps
the data. (Running a second instance on the same machine needs `-p <other-name>`.)

**Publishing from a fork.** Push the repository to GitHub; the workflow publishes `ghcr.io/<owner>/<repo>`
(lowercased) on every push to `main` and every `v*.*.*` tag. The first push creates the package as **private**:
open it under your profile's *Packages*, *Package settings* → *Change visibility* → *Public*, or every pull needs
a `docker login ghcr.io`. Then set `EXPENSES_TRACKER_IMAGE` (or edit the image line). A release is `git tag v1.2.3
&& git push --tags`. Pull requests run the tests and build the image but push nothing.

## Plain `docker run`

The app needs a PostgreSQL database; without Compose, start one and point `DATABASE_URL` at it:

```bash
docker network create expenses
docker run -d --name expenses-db --network expenses --restart unless-stopped \
  -e POSTGRES_USER=expenses -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=expenses \
  -v expenses-pg:/var/lib/postgresql/data postgres:17-alpine
docker run -d --name expenses-tracker --network expenses --restart unless-stopped \
  -p 3000:3000 \
  -e DATABASE_URL=postgres://expenses:change-me@expenses-db:5432/expenses \
  -e COOKIE_SECURE=auto -e ALLOW_REGISTRATION=true \
  ghcr.io/xalert/expenses-tracker:latest
```

To build it yourself, `docker build -t expenses-tracker .` and use `expenses-tracker` as the image.

The image has no native modules, so it is not tied to the architecture it was built on;
`docker buildx build --platform linux/amd64,linux/arm64 …` builds both if you publish to a registry.

With Compose, settings live in the `environment:` block of [`docker-compose.yml`](../docker-compose.yml); after
changing one, run `docker compose up -d` again. Runtime configuration is environment-only: nothing is baked in at
build time, and a restart applies a change.

## Health check and container user

`GET /api/health` returns `200 {"status":"ok"}` after a trivial DB query (`503` otherwise) and needs no auth.
The image's `HEALTHCHECK` uses it, so `docker ps` shows `healthy` / `unhealthy`.

The app container runs as the unprivileged `node` user (uid/gid `1000`), not root.

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

Everything is in PostgreSQL, in the `db` service's volume `pg-data`, mounted at `/var/lib/postgresql/data`. With
Compose the volume is named `<folder>_pg-data` (e.g. `expenses-tracker_pg-data`; see `docker volume ls`), on Linux
stored under `/var/lib/docker/volumes/<name>/_data`. The app container keeps nothing. `docker compose down` keeps
the volume; `docker compose down -v` **deletes it**, and with it every account.

The database port is not published, so only the Compose network reaches it. The default password (`expenses`) is
acceptable for that reason alone; put `POSTGRES_PASSWORD=<URL-safe password>` in `.env` before the first start
(or URL-encode special characters, since the password is part of `DATABASE_URL`). Changing it afterwards does not
change the password stored in an existing database (`docker compose exec db psql -U expenses -c "ALTER USER expenses
PASSWORD '…'"` does, then update `.env` and run `docker compose up -d`). To reach the database from the host (a GUI,
`psql`), publish it on loopback only by adding `ports: ["127.0.0.1:5432:5432"]` to the `db` service.

There is no reset command for a deployed instance (`npm run db:reset` is a development tool and refuses to run
with `NODE_ENV=production`). To start over, take a [backup](#backup), then `docker compose down -v` and
`docker compose up -d`: the app creates and migrates a new, empty database on first start.

## Bind mount instead of a named volume

The `postgres` image initialises its data directory itself, so a named volume (the default) needs no preparation.
If you prefer a host folder (`- ./pg-data:/var/lib/postgresql/data` on the `db` service), it must be empty or hold
a Postgres 17 data directory and be writable by the image's `postgres` user; a permission error in the `db`
container's log means it is not. Avoid network shares (NFS/SMB) for it. The app container has no data directory,
so the old requirement that a bind mount be writable by uid 1000 is gone.

## Backup

Take a dump of the database with `pg_dump` (custom format) from the running `db` container; the app can stay up:

```bash
docker compose exec -T db pg_dump -U expenses -Fc expenses > expenses-$(date +%F).dump
```

The result is one compressed file with the whole database (every account). Copy it somewhere else. Do not back
up by copying the volume's files while Postgres runs. A dump taken with `pg_dump` from the same major version
(17) restores anywhere.

Each user can also download a **Full backup (JSON)** of their own account at `/data`; it imports into any instance,
but it covers one account (wallets, wallet groups, categories, transactions and transfers), not the whole
database, and not the account itself or its password.

## Restore

Stop the app so nothing writes during the restore, then load the dump into the running `db` container:

```bash
docker compose stop expenses-tracker
docker compose exec -T db pg_restore -U expenses -d expenses --clean --if-exists < expenses-2026-01-31.dump
docker compose start expenses-tracker
```

`--clean --if-exists` drops and recreates the objects in the dump, so the target can be the live database or an
empty one. On a new server: start only the database (`docker compose up -d db`), run the `pg_restore` line, then
`docker compose up -d`. Restore into the same Postgres major version (17), and use the image version that wrote
the dump or a newer one: a newer app applies its pending migrations on start; an older app cannot read a newer
schema.

## Upgrading

With the prebuilt image ([`deploy/compose.yaml`](../deploy/compose.yaml)):

```bash
docker compose exec -T db pg_dump -U expenses -Fc expenses > before-upgrade.dump   # first: see Backup
docker compose pull             # the newest image for your EXPENSES_TRACKER_VERSION
docker compose up -d            # recreates the app container; the database volume is kept
```

Built from source:

```bash
git pull
docker compose build --pull     # rebuild on the latest node:24-bookworm-slim
docker compose up -d            # recreates the container; the database volume is kept
```

Pending database migrations are applied automatically when the new version starts (on first DB access, which the
health check triggers within seconds), all in one transaction: if one fails, nothing changes and the app logs the
error and does not become healthy. **The app no longer makes a copy of the database before migrating**; the
`pg_dump` above is your way back. To roll back, run the previous image (set `EXPENSES_TRACKER_VERSION`) and, if the
new version already migrated, [restore](#restore) the dump taken before the upgrade. Migrations only move forward.

### Upgrading PostgreSQL itself

The Compose files pin `postgres:17-alpine`, so `docker compose pull` never changes the major version. Moving to a
new major (18, …) is a dump and restore: take a [backup](#backup), `docker compose down`, remove the database
volume (`docker volume rm expenses-tracker_pg-data`), change the image tag in the `db` service, `docker compose up
-d db`, then run the [restore](#restore) step and `docker compose up -d`. Minor releases (17.x) are picked up by the
same tag with no extra steps.

### Moving from SQLite (older versions)

Versions of this app before the move to PostgreSQL (2026-11-09) stored data in a SQLite file in a `/data` volume.
**Those instances cannot be upgraded in place, and the owner decided not to write a migration.** Starting the new
image against an old volume does nothing with the old file; the `/data` volume is ignored and can be deleted once
you no longer need it. To bring data across, use each account's JSON backup:

1. On the **old** version, each user signs in, opens `/data` and downloads **Full backup (JSON)**.
2. Start the new version (empty PostgreSQL database) and register the account again (any user ID; it does not have
   to be the old one).
3. Signed in to the new instance, import the backup on `/data`: preview, then confirm.

The import recreates wallets (name, currency, initial balance, archived flag, wallet group), categories,
transactions and transfers, all under the signed-in account. It does **not** carry over the account itself (user ID,
email, names), the password or sessions: the backup never contains them. Wallets and categories that the account already has are matched by name
(and currency or kind), not duplicated. Do this once per account.

## Running without Docker (standalone build)

You need a PostgreSQL server (17 recommended) with an empty database and a user that owns it, and Node 20.9+.
`next build` produces a self-contained server in `.next/standalone` (`output: "standalone"`; the `drizzle/`
migrations are traced into it, and the app applies them on start):

```bash
npm run build
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public
cd .next/standalone && DATABASE_URL=postgres://expenses:secret@localhost:5432/expenses PORT=3000 node server.js
```

`DATABASE_URL` is required in production. The reverse-proxy, backup and upgrade notes above apply unchanged (run
`pg_dump` / `pg_restore` against your own server instead of through `docker compose exec`).

## Database notes

- PostgreSQL 17, through `pg` and Drizzle. `DATABASE_URL` is a `postgres://` or `postgresql://` URL and is required in
  production; in development it defaults to `postgres://expenses:expenses@localhost:5432/expenses`, the database
  that `npm run db:up` starts (see [`compose.dev.yaml`](../compose.dev.yaml)).
- Migrations live in `drizzle/` and are applied automatically the first time the app touches the database
  (once per process, in a transaction; foreign keys are always enforced).
- The database `expenses_demo` (created by the development container's init script) holds the demo data; `npm run
  dev:demo` and `npm run demo:reset` use it and never touch `expenses`. `npm run dev` is on `expenses`, the real
  data. To reset local data, use `npm run db:reset` (see the README); it asks first and does not keep a copy, so
  take a backup with the app's JSON export or `pg_dump` before confirming.
- A scratch database: put `DATABASE_URL=postgres://expenses:expenses@localhost:5432/<scratch>` on the same command line
  (never `export` it).
