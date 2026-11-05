#!/usr/bin/env bash
# tests/run_all.sh  --  runs every database test against a THROW-AWAY database and prints one summary.
#
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=... bash sql-engine/tests/run_all.sh [--quick]
#
# The user must be a superuser of a test server (it creates and drops databases and a few login roles). NEVER point this at production.
# --quick skips the large-volume performance test (about 40 seconds).
source "$(dirname "$0")/_lib.sh"
QUICK=0; [ "${1:-}" = "--quick" ] && QUICK=1
TOTAL=0; PROBLEMS=0
LOGINS=()
cleanup() { for r in "${LOGINS[@]:-}"; do [ -n "$r" ] && psql "$(url postgres)" -X -q -c "drop role if exists $r" >/dev/null 2>&1 || true; done; drop_dbs; }
trap cleanup EXIT

section() { echo; echo "=== $1"; }
run_sql() {   # run_sql <db> <file> [psql args]  -> counts "ok" lines, fails on any error
  local db="$1" file="$2"; shift 2
  local out; out="$(mktemp)"
  if ! psql "$(url "$db")" -X -q -v ON_ERROR_STOP=1 "$@" -f "$TESTS/$file" >/dev/null 2>"$out"; then
    grep -vE '^(psql:.*)?NOTICE:  ' "$out" >&2 || true; echo "FAILED: $file" >&2; rm -f "$out"; exit 1
  fi
  local n; n="$(grep -c 'NOTICE:  ok' "$out" || true)"
  grep -E 'NOTICE:  bench' "$out" | sed 's/^.*NOTICE:  //' || true
  echo "$file: $n checks passed"; TOTAL=$((TOTAL + n)); rm -f "$out"
}
run_sh() {    # run_sh <script> -> counts "ok -" lines
  local out; out="$(mktemp)"
  if ! bash "$TESTS/$1" >"$out" 2>&1; then cat "$out" >&2; echo "FAILED: $1" >&2; rm -f "$out"; exit 1; fi
  local n; n="$(grep -c '^ok - ' "$out" || true)"; cat "$out"; TOTAL=$((TOTAL + n)); rm -f "$out"
}

DB="$(new_db)"
section "migration 0001 on a new database"
migrate "$DB"; bash "$SQL_ROOT/migrations/apply.sh" status >/dev/null 2>&1 || true
RY_ADMIN_URL="$(url "$DB")" bash "$SQL_ROOT/migrations/apply.sh" verify
qf "$DB" -f "$TESTS/_helpers.sql" >/dev/null

section "login users (real passwords, real connections)"
SUFFIX="$$"; APP="ry_login_app_$SUFFIX"; RO="ry_login_ro_$SUFFIX"; AUD="ry_login_aud_$SUFFIX"; LOGINS=("$APP" "$RO" "$AUD")
PW_APP="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"; PW_RO="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"; PW_AUD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
psql "$(url postgres)" -X -q -v ON_ERROR_STOP=1 -v a="$APP" -v r="$RO" -v u="$AUD" -v pa="$PW_APP" -v pr="$PW_RO" -v pu="$PW_AUD" >/dev/null <<'SQL'
CREATE ROLE :"a" LOGIN PASSWORD :'pa' IN ROLE ry_app;
CREATE ROLE :"r" LOGIN PASSWORD :'pr' IN ROLE ry_readonly;
CREATE ROLE :"u" LOGIN PASSWORD :'pu' IN ROLE ry_auditor;
SQL
qf "$DB" -f "$SQL_ROOT/schema/database-config.sql" >/dev/null     # gives the login users their limits (the documented re-run)
qf "$DB" -c "GRANT CONNECT ON DATABASE $DB TO ry_app, ry_readonly, ry_auditor" >/dev/null 2>&1 || true
as() { local who="$1" pw="$2"; shift 2; PGPASSWORD="$pw" psql "postgresql://${who}@${PGHOST}:${PGPORT}/${DB}" -X -q -At "$@"; }
[ "$(as "$APP" "$PW_APP" -c 'show statement_timeout')" = 10s ] || fail "the app login does not have its 10 s statement timeout"
[ "$(as "$APP" "$PW_APP" -c 'show lock_timeout')" = 5s ] || fail "the app login does not have its 5 s lock timeout"
ok "login: the app user gets statement_timeout 10s and lock_timeout 5s from the group role setup"
[ "$(as "$RO" "$PW_RO" -c 'show default_transaction_read_only')" = on ] || fail "the reporting login is not read-only by default"
ok "login: the reporting user is read-only by default"
denied() { local name="$1"; shift; if as "$@" >/dev/null 2>&1; then fail "$name was allowed"; fi; ok "login: $name is refused"; }
denied "the app user becoming the owner (SET ROLE ry_owner)" "$APP" "$PW_APP" -c 'SET ROLE ry_owner'
denied "the app user becoming the administrator (SET ROLE postgres)" "$APP" "$PW_APP" -c 'SET ROLE postgres'
denied "the app user creating a table" "$APP" "$PW_APP" -c 'CREATE TABLE app.sneaky (x int)'
denied "the app user reading password hashes" "$APP" "$PW_APP" -c 'SELECT password_hash FROM app.users'
denied "a wrong password" "$APP" "wrong-$PW_APP" -c 'SELECT 1'
denied "the reporting user running a per-person function" "$RO" "$PW_RO" -c 'SELECT app.register_user($$x@example.com$$, NULL, $$google$$)'
denied "the auditor reading accounts" "$AUD" "$PW_AUD" -c 'SELECT 1 FROM app.users'
[ "$(as "$APP" "$PW_APP" -c 'SELECT count(*) FROM app.financial_records')" = 0 ] || fail "the app login saw rows with nobody signed in"
ok "login: the app user with nobody signed in sees no rows"
[ "$(as "$RO" "$PW_RO" -c 'SELECT accounts >= 0 FROM app.v_platform_totals')" = t ] || fail "the reporting user cannot read the totals view"
ok "login: the reporting user can read the aggregate view"

section "data tests (one database, in order)"
qf "$DB" -f "$TESTS/_fixtures.sql" >/dev/null
run_sql "$DB" schema_tests.sql
run_sql "$DB" integrity_tests.sql
run_sql "$DB" permission_tests.sql
run_sql "$DB" query_tests.sql
BAD="$(psql "$(url "$DB")" -X -q -At -F'|' -f "$SQL_ROOT/backups/integrity_checks.sql" | awk -F'|' '$2 != 0')"
[ -z "$BAD" ] || { echo "$BAD" >&2; fail "backups/integrity_checks.sql found a problem after the tests"; }
ok "integrity_checks.sql: every check is 0 after all the tests"; TOTAL=$((TOTAL + 1))
if [ "$QUICK" = 0 ]; then section "performance (1,000,000 engine runs, 400,000 transactions)"; run_sql "$DB" performance_tests.sql; else echo "(performance test skipped: --quick)"; fi

section "migrations: apply, repeat, verify, tamper, roll back, fail halfway"; run_sh migration_cycle_test.sh
section "concurrent access"; run_sh concurrency_test.sh
section "backup and restore"; run_sh backup_restore_test.sh

echo; echo "ALL PASSED: $TOTAL checks"
