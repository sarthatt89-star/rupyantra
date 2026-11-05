#!/usr/bin/env bash
# migrations/apply.sh  --  applies, checks or undoes the database migrations. NOTHING here runs by itself: a person runs it.
#
#   RY_ADMIN_URL=postgresql://admin@host:5432/dbname  ./migrations/apply.sh plan | up | status | verify | rollback
#
#   plan      shows what `up` would run, changes nothing
#   up        applies migration 0001 in ONE transaction (all or nothing) and records it
#   status    lists the applied migrations
#   verify    recomputes the checksum of the files and compares it with the recorded one (detects edited migrations)
#   rollback  DELETES the schema and all its data. Needs RY_CONFIRM_ROLLBACK=<exact database name>
#
# The connection string may hold a password: it is never printed. Prefer a ~/.pgpass entry or PGPASSWORD over putting it in the URL.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=0001
NAME=initial
MANIFEST="migrations/${VERSION}_${NAME}.manifest"
ROLLBACK="migrations/${VERSION}_${NAME}.rollback.sql"

: "${RY_ADMIN_URL:?set RY_ADMIN_URL to the administrator connection string (see database-config.example)}"
command -v psql >/dev/null || { echo "psql is not installed" >&2; exit 1; }
psqlq() { psql "$RY_ADMIN_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }

files() { grep -vE '^\s*(#|$)' "$MANIFEST" | awk '{print $2}'; }
checksum() { files | while read -r f; do cat "$f"; done | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1; }
db_name() { psqlq -At -c 'select current_database()'; }
has_table() { [ "$(psqlq -At -c "select to_regclass('app.schema_migrations') is not null")" = t ]; }
has_schema() { [ "$(psqlq -At -c "select exists(select 1 from pg_namespace where nspname = 'app')")" = t ]; }
recorded() { psqlq -At -c "select checksum from app.schema_migrations where version = '$VERSION'"; }

cmd="${1:-}"
case "$cmd" in
  plan)
    echo "migration $VERSION ($NAME) would run, in one transaction:"
    grep -vE '^\s*(#|$)' "$MANIFEST" | awk '{printf "  %-6s %s\n", $1, $2}'
    echo "checksum of these files: $(checksum)"
    ;;
  up)
    if [ "$(psqlq -At -c 'show server_version_num')" -lt 150000 ]; then
      echo "REFUSING: this schema needs PostgreSQL 15 or newer (security_invoker views, and a public schema that is not world-writable)." >&2
      exit 1
    fi
    if has_table; then
      if [ -n "$(recorded)" ]; then echo "migration $VERSION is already applied: nothing to do"; exit 0; fi
    elif has_schema; then
      echo "REFUSING: a schema named \"app\" already exists in this database but was not created by this migration." >&2
      echo "Nothing was changed. Inspect it, or use another database." >&2
      exit 1
    fi
    script="$(mktemp)"; trap 'rm -f "$script"' EXIT
    {
      grep -vE '^\s*(#|$)' "$MANIFEST" | awk '
        BEGIN { role = "admin" }
        { if ($1 != role) { if ($1 == "owner") print "SET LOCAL ROLE ry_owner;"; else print "RESET ROLE;"; role = $1 }
          print "\\i " $2 }'
      echo "INSERT INTO app.schema_migrations (version, name, checksum, rollback_file) VALUES (:'ver', :'name', :'sum', :'rb');"
      echo "RESET ROLE;"
    } > "$script"
    psqlq --single-transaction -v ver="$VERSION" -v name="$NAME" -v sum="$(checksum)" -v rb="$ROLLBACK" -f "$script"
    echo "migration $VERSION applied"
    ;;
  status)
    has_table || { echo "no migrations applied (app.schema_migrations does not exist)"; exit 0; }
    psqlq -c "select version, name, left(checksum, 12) as checksum, applied_at, applied_by from app.schema_migrations order by version"
    ;;
  verify)
    has_table || { echo "FAIL: nothing is applied" >&2; exit 1; }
    want="$(recorded)"; have="$(checksum)"
    if [ -z "$want" ]; then echo "FAIL: migration $VERSION is not recorded" >&2; exit 1; fi
    if [ "$want" = "$have" ]; then echo "ok: the files match what was applied"; else echo "FAIL: the files changed after they were applied" >&2; exit 1; fi
    ;;
  rollback)
    db="$(db_name)"
    if [ "${RY_CONFIRM_ROLLBACK:-}" != "$db" ]; then
      echo "REFUSING: rollback deletes every table and all data in database \"$db\"." >&2
      echo "To go ahead, set RY_CONFIRM_ROLLBACK=$db and run it again. Take a backup first (backups/backup_strategy.md)." >&2
      exit 1
    fi
    psqlq --single-transaction -f "$ROLLBACK"
    echo "migration $VERSION rolled back"
    ;;
  *)
    echo "usage: RY_ADMIN_URL=... $0 plan | up | status | verify | rollback" >&2
    exit 64
    ;;
esac
