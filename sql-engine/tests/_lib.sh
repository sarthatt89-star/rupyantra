#!/usr/bin/env bash
# tests/_lib.sh  --  shared by the shell tests. Source it; do not run it.
# Connection: the standard PostgreSQL variables PGHOST (127.0.0.1), PGPORT (5432), PGUSER (postgres) and PGPASSWORD. The user must be a superuser
# (the tests create databases and roles). Use a throw-away server or container, NEVER a production one.
set -euo pipefail
: "${PGHOST:=127.0.0.1}" "${PGPORT:=5432}" "${PGUSER:=postgres}"
export PGHOST PGPORT PGUSER
SQL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTS="$SQL_ROOT/tests"
DBS=()
ok()   { echo "ok - $1"; }
fail() { echo "FAILED: $1" >&2; exit 1; }
url()  { echo "postgresql://${PGUSER}@${PGHOST}:${PGPORT}/${1}"; }       # the password comes from PGPASSWORD or ~/.pgpass
q()    { psql "$(url "$1")" -X -q -At -v ON_ERROR_STOP=1 -c "$2"; }       # q <db> <sql>
qf()   { local db="$1"; shift; psql "$(url "$db")" -X -q -v ON_ERROR_STOP=1 "$@"; }
new_db() {
  local name="ry_t_$$_${RANDOM}"
  psql "$(url postgres)" -X -q -v ON_ERROR_STOP=1 -c "create database $name" >/dev/null
  DBS+=("$name"); echo "$name"
}
migrate() { RY_ADMIN_URL="$(url "$1")" bash "$SQL_ROOT/migrations/apply.sh" up >/dev/null; }
with_fixtures() { qf "$1" -f "$TESTS/_helpers.sql" >/dev/null; qf "$1" -f "$TESTS/_fixtures.sql" >/dev/null; }
drop_dbs() { for d in "${DBS[@]:-}"; do [ -n "$d" ] && psql "$(url postgres)" -X -q -c "drop database if exists $d with (force)" >/dev/null 2>&1 || true; done; }
trap drop_dbs EXIT
