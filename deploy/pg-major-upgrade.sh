#!/usr/bin/env bash
# Move the Compose `db` service to a new PostgreSQL major version (e.g. 17 -> 18) by dump and restore.
#
#   deploy/pg-major-upgrade.sh [-C <folder>] [--yes] <new-major>
#
# Run it in the folder that holds your Compose file (compose.yaml from deploy/, or a clone's docker-compose.yml),
# with the stack running. What it does, stopping at the first problem:
#
#   1. checks the running `db`, its current major and its data volume; refuses a downgrade, a bind mount, an
#      existing target volume or a hand-written override file;
#   2. stops the app, takes a fresh dump (backups/before-postgres-<new>-<time>.dump), checks it with
#      `pg_restore --list` and counts the rows of every table;
#   3. writes the Compose override file (compose.override.yaml / docker-compose.override.yml), which Compose loads
#      on its own: `db` and `backup` on postgres:<new>-alpine, `db` on a NEW volume `pg-data-<new>`;
#   4. starts the new `db` on the empty volume, restores the dump, compares the row counts, starts the app.
#
# The old volume is never modified or removed: on any failure after step 2 the override is moved aside and the old
# database is started again. Once you are happy, remove the old volume yourself (the script prints the command).
# Docs: docs/SELF-HOSTING.md#upgrading-postgresql-itself
set -euo pipefail

usage() { echo "Usage: $0 [-C <folder>] [--yes] <new-major>   (e.g. $0 18)" >&2; exit 2; }
die() { echo "pg-major-upgrade: $*" >&2; exit 1; }
say() { echo "==> $*"; }

yes=0
target=""
while [ $# -gt 0 ]; do
  case "$1" in
    -C) [ $# -ge 2 ] || usage; cd "$2"; shift 2 ;;
    --yes | -y) yes=1; shift ;;
    -h | --help) usage ;;
    -*) usage ;;
    *) [ -z "$target" ] || usage; target="$1"; shift ;;
  esac
done
[[ "$target" =~ ^[1-9][0-9]*$ ]] || usage

[ -z "${COMPOSE_FILE:-}" ] || die "COMPOSE_FILE is set; run this from the folder of your Compose file without it, so the override file is picked up."
if [ -f compose.yaml ]; then compose_file=compose.yaml; override=compose.override.yaml
elif [ -f docker-compose.yml ]; then compose_file=docker-compose.yml; override=docker-compose.override.yml
else die "no compose.yaml or docker-compose.yml in $(pwd); use -C <folder>."
fi
marker="# Written by deploy/pg-major-upgrade.sh"
if [ -f "$override" ] && ! head -n 1 "$override" | grep -qF "$marker"; then
  die "$override exists and was not written by this script; merge the change by hand (docs/SELF-HOSTING.md#upgrading-postgresql-itself)."
fi

dc() { docker compose "$@"; }
psql_db() { dc exec -T db psql -X -v ON_ERROR_STOP=1 -U expenses -d expenses -Atc "$1"; }

db_id=$(dc ps -q db)
[ -n "$db_id" ] && [ "$(docker inspect -f '{{.State.Running}}' "$db_id")" = "true" ] ||
  die "the db service is not running; start the stack (docker compose up -d) first."
project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$db_id")
current=$(( $(psql_db "show server_version_num") / 10000 ))
[ "$target" -gt "$current" ] || die "the database already runs PostgreSQL $current; $target is not newer."

mount_type=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}{{end}}{{end}}' "$db_id")
old_volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$db_id")
[ "$mount_type" = "volume" ] && [ -n "$old_volume" ] ||
  die "the database is not on a named volume (bind mount?); follow the manual steps in docs/SELF-HOSTING.md."
new_key="pg-data-$target"
new_volume="${project}_${new_key}"
if docker volume inspect "$new_volume" >/dev/null 2>&1; then
  die "volume $new_volume already exists (an earlier attempt?). Inspect it, remove it yourself if it is not needed, then rerun."
fi
docker image inspect "postgres:$target-alpine" >/dev/null 2>&1 || docker pull "postgres:$target-alpine" >/dev/null ||
  die "cannot pull postgres:$target-alpine."

cat <<EOF
PostgreSQL $current -> $target for Compose project '$project' ($compose_file)
  old volume (kept, not modified): $old_volume
  new volume:                      $new_volume
  override file:                   $override
The app is stopped from the dump until the restore has been checked.
EOF
if [ "$yes" -ne 1 ]; then
  [ -t 0 ] || die "not a terminal; pass --yes to confirm."
  read -r -p "Continue? Type 'upgrade': " answer
  [ "$answer" = "upgrade" ] || die "cancelled."
fi

counts_sql="select string_agg(table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text, ' ' order by table_name) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"

# ---- 2. stop the app, fresh dump ----------------------------------------------------------------------------
say "Stopping the app"
dc stop expenses-tracker
restart_old() {
  echo "pg-major-upgrade: FAILED - restoring the previous setup (old volume $old_volume untouched)" >&2
  if [ -f "$override" ] && head -n 1 "$override" | grep -qF "$marker" && grep -qF "$new_key" "$override"; then
    mv "$override" "$override.failed-$(date -u +%Y%m%d-%H%M%S)"
  fi
  [ -n "${previous_override:-}" ] && [ -f "$previous_override" ] && mv "$previous_override" "$override"
  dc up -d >&2 || true
  echo "pg-major-upgrade: the old database is running again. The new volume $new_volume (if created) was left for inspection." >&2
}
trap restart_old ERR

mkdir -p backups
dump="backups/before-postgres-$target-$(date -u +%Y%m%d-%H%M%S).dump"
say "Dumping the database to $dump"
(umask 077; dc exec -T db pg_dump -U expenses -Fc expenses > "$dump.partial")
mv "$dump.partial" "$dump"
[ -s "$dump" ] || { echo "the dump is empty" >&2; false; }
dc exec -T db pg_restore --list < "$dump" > /dev/null
before=$(psql_db "$counts_sql")
say "Dump checked; rows: $before"

# ---- 3. override: new image, new volume ---------------------------------------------------------------------
if [ -f "$override" ]; then
  previous_override="$override.before-postgres-$target"
  cp "$override" "$previous_override"
fi
cat > "$override" <<EOF
$marker for PostgreSQL $target ($(date -u +%Y-%m-%d)).
# Compose merges this file into $compose_file. To go back to PostgreSQL $current on the old volume
# ($old_volume): docker compose down, delete this file${previous_override:+ (or restore $previous_override)}, docker compose up -d.
services:
  db:
    image: postgres:$target-alpine
    environment:
      # Keep the data directory where the volume is mounted (postgres:18+ images default to another path).
      PGDATA: /var/lib/postgresql/data
    volumes:
      - $new_key:/var/lib/postgresql/data
  backup:
    image: postgres:$target-alpine
volumes:
  $new_key:
EOF

# ---- 4. new server, restore, check --------------------------------------------------------------------------
say "Starting PostgreSQL $target on the new volume"
dc up -d --wait db
say "Restoring $dump"
dc exec -T db pg_restore -U expenses -d expenses --exit-on-error < "$dump"
after=$(psql_db "$counts_sql")
if [ "$before" != "$after" ]; then
  echo "row counts differ after the restore:" >&2
  echo "  before: $before" >&2
  echo "  after:  $after" >&2
  false
fi
now=$(( $(psql_db "show server_version_num") / 10000 ))
[ "$now" -eq "$target" ] || { echo "the new server reports PostgreSQL $now" >&2; false; }
say "Row counts match"

say "Starting the app"
dc up -d
trap - ERR
[ -n "${previous_override:-}" ] && rm -f "$previous_override"

cat <<EOF

Done: PostgreSQL $target on volume $new_volume, the app is starting (docker compose ps shows it healthy).
Kept: the dump $dump and the old volume $old_volume.
Back to $current (loses what was written since): docker compose down && rm $override && docker compose up -d
Once you are satisfied, free the space of the old volume:  docker volume rm $old_volume
EOF
