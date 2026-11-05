#!/usr/bin/env bash
# tests/migration_cycle_test.sh  --  apply, repeat, verify, tamper, refuse, fail halfway, roll back, apply again. Real databases, real apply.sh.
source "$(dirname "$0")/_lib.sh"
APPLY() { RY_ADMIN_URL="$(url "$1")" bash "$SQL_ROOT/migrations/apply.sh" "${@:2}"; }
DB="$(new_db)"; qf "$DB" -f "$TESTS/_helpers.sql" >/dev/null

APPLY "$DB" plan | grep -q "checksum of these files" || fail "plan did not show a checksum"
[ "$(q "$DB" "select to_regnamespace('app') is null")" = t ] || fail "plan created the schema"
ok "plan: shows the files and the checksum, changes nothing"
APPLY "$DB" up >/dev/null || fail "up failed"
qf "$DB" -v stage=after_apply -f "$TESTS/migration_tests.sql" 2>&1 | grep -c "NOTICE:  ok" | grep -qx 8 || fail "the migration record checks did not all pass"
ok "up: applied in one transaction; the record has version, name, checksum, rollback file, time and actor (8 checks)"
APPLY "$DB" up | grep -q "already applied" || fail "a second up did not say already applied"
[ "$(q "$DB" "select count(*) from app.schema_migrations")" = 1 ] || fail "a second up added a second record"
ok "up (again): refuses to apply twice, changes nothing"
APPLY "$DB" verify | grep -q "^ok" || fail "verify failed on untouched files"
ok "verify: the files match the recorded checksum"
QF_TAMPER="$(mktemp -d)"; cp -r "$SQL_ROOT"/. "$QF_TAMPER"/; echo "-- edited after it was applied" >> "$QF_TAMPER/users/user_profiles.sql"
if RY_ADMIN_URL="$(url "$DB")" bash "$QF_TAMPER/migrations/apply.sh" verify >/dev/null 2>&1; then fail "verify accepted an edited migration file"; fi
ok "verify: an edit to a migration file after it was applied is detected"

# rollback needs the exact database name
if APPLY "$DB" rollback >/dev/null 2>&1; then fail "rollback ran without confirmation"; fi
if RY_CONFIRM_ROLLBACK=yes APPLY "$DB" rollback >/dev/null 2>&1; then fail "rollback accepted 'yes' instead of the database name"; fi
[ "$(q "$DB" "select count(*) from pg_tables where schemaname = 'app'")" = 26 ] || fail "a refused rollback still deleted something"
ok "rollback: refused without the exact database name; nothing deleted"
RY_CONFIRM_ROLLBACK="$DB" APPLY "$DB" rollback >/dev/null || fail "confirmed rollback failed"
qf "$DB" -v stage=after_rollback -f "$TESTS/migration_tests.sql" 2>&1 | grep -c "NOTICE:  ok" | grep -qx 4 || fail "the after-rollback checks did not all pass"
ok "rollback: with the confirmation the schema and all its objects are gone (4 checks)"
APPLY "$DB" up >/dev/null || fail "re-apply after rollback failed"
ok "up: applies again cleanly after a rollback"

# a migration that fails halfway leaves nothing behind
DB2="$(new_db)"; BROKEN="$(mktemp -d)"; cp -r "$SQL_ROOT"/. "$BROKEN"/
echo "SELECT this is not valid sql;" > "$BROKEN/schema/broken.sql"; echo "owner  schema/broken.sql" >> "$BROKEN/migrations/0001_initial.manifest"
if RY_ADMIN_URL="$(url "$DB2")" bash "$BROKEN/migrations/apply.sh" up >/dev/null 2>&1; then fail "a broken migration was reported as applied"; fi
[ "$(q "$DB2" "select to_regnamespace('app') is null")" = t ] || fail "a migration that failed halfway left the schema behind"
ok "atomic: a migration whose last file fails leaves no schema, no table, no record"

# a schema called app that this migration did not create is never touched
DB3="$(new_db)"; q "$DB3" "create schema app; create table app.precious (x int); insert into app.precious values (42)" >/dev/null
if APPLY "$DB3" up >/dev/null 2>&1; then fail "up ran over an existing unknown schema"; fi
[ "$(q "$DB3" "select x from app.precious")" = 42 ] || fail "an existing schema was damaged"
ok "safety: an existing schema named app that was not made by this migration is refused and left untouched"
rm -rf "$QF_TAMPER" "$BROKEN"
