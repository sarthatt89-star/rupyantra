#!/usr/bin/env bash
# tests/backup_restore_test.sh  --  the backup procedure of backups/backup_strategy.md, run for real: dump, verify, restore elsewhere, compare.
source "$(dirname "$0")/_lib.sh"
SRC="$(new_db)"; migrate "$SRC"; with_fixtures "$SRC"
qf "$SRC" -f "$TESTS/integrity_tests.sql" >/dev/null 2>&1 || fail "could not prepare data (integrity tests)"   # more variety: audit rows, a purge, an erased account
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; drop_dbs' EXIT

# 1) the backup, exactly as written in the strategy
pg_dump "$(url "$SRC")" --format=custom --file="$WORK/backup.dump" || fail "pg_dump failed"
( cd "$WORK" && sha256sum backup.dump > backup.dump.sha256 && sha256sum -c backup.dump.sha256 >/dev/null ) || fail "checksum of the backup does not verify"
pg_restore --list "$WORK/backup.dump" >/dev/null || fail "pg_restore cannot read the backup"
ok "backup: pg_dump (custom format) written, checksum recorded and verified, table of contents readable"

# 2) restore into a new, empty database
DST="$(new_db)"
pg_restore --dbname="$(url "$DST")" --exit-on-error "$WORK/backup.dump" >"$WORK/restore.log" 2>&1 || { cat "$WORK/restore.log" >&2; fail "restore failed"; }
qf "$DST" -f "$SQL_ROOT/schema/database-config.sql" >/dev/null || fail "re-applying the database settings failed"
ok "restore: restored by the administrator into an empty database with --exit-on-error (owners kept), database settings re-applied"

# 3) content identical: row count and a hash of every row of every table
fingerprint() {
  local db="$1" sql=""
  for t in $(q "$db" "select tablename from pg_tables where schemaname = 'app' order by 1"); do
    sql+="select '$t', count(*), md5(coalesce(string_agg(x::text, '|' order by x::text), '')) from app.$t x union all "
  done
  q "$db" "${sql% union all }"
}
fingerprint "$SRC" > "$WORK/src.fp"; fingerprint "$DST" > "$WORK/dst.fp"
cmp -s "$WORK/src.fp" "$WORK/dst.fp" || { diff "$WORK/src.fp" "$WORK/dst.fp" >&2; fail "the restored data differs from the original"; }
ok "restore: $(wc -l < "$WORK/src.fp") tables have identical row counts and identical content hashes"

# 4) the protections came back too, not just the data
count() { q "$1" "select (select count(*) from pg_policies where schemaname = 'app'), (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'app' and not t.tgisinternal), (select count(*) from pg_indexes where schemaname = 'app'), (select count(*) from information_schema.role_table_grants where table_schema = 'app'), (select count(*) from information_schema.role_column_grants where table_schema = 'app'), (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app')"; }
[ "$(count "$SRC")" = "$(count "$DST")" ] || fail "policies, triggers, indexes, grants or functions differ after the restore: $(count "$SRC") vs $(count "$DST")"
ok "restore: policies, triggers, indexes, grants and functions are all back ($(count "$DST"))"
ALICE="$(q "$DST" "select ry_test.id('alice')")"
OTHERS="$(psql "$(url "$DST")" -X -q -At -c "BEGIN; SET LOCAL ROLE ry_app; SELECT set_config('app.user_id', ry_test.id('bob')::text, true); SELECT count(*) FROM app.financial_records WHERE user_id = '$ALICE'; ROLLBACK;" | tail -1)"
[ "$OTHERS" = 0 ] || fail "after the restore, bob can see alice's rows"
ok "restore: row-level security still isolates people in the restored database"
RES="$(psql "$(url "$DST")" -X -q -At -F'|' -f "$SQL_ROOT/backups/integrity_checks.sql" | awk -F'|' '$2 != 0')"
[ -z "$RES" ] || { echo "$RES" >&2; fail "integrity checks fail on the restored database"; }
ok "restore: backups/integrity_checks.sql is all zero on the restored database"
RV="$(RY_ADMIN_URL="$(url "$DST")" bash "$SQL_ROOT/migrations/apply.sh" verify)"; ok "restore: the migration record came with it ($RV)"

# 5) a damaged or altered backup is noticed
cp "$WORK/backup.dump" "$WORK/altered.dump"; printf 'X' | dd of="$WORK/altered.dump" bs=1 seek=200 conv=notrunc 2>/dev/null
sed 's/backup.dump/altered.dump/' "$WORK/backup.dump.sha256" > "$WORK/altered.sha256"
( cd "$WORK" && sha256sum -c altered.sha256 >/dev/null 2>&1 ) && fail "an altered backup passed the checksum" || ok "damage: a changed byte makes the checksum fail"
head -c 3000 "$WORK/backup.dump" > "$WORK/truncated.dump"
BAD="$(new_db)"
if pg_restore --dbname="$(url "$BAD")" --exit-on-error "$WORK/truncated.dump" >/dev/null 2>&1; then fail "a truncated backup restored without an error"; fi
ok "damage: a truncated backup is refused by pg_restore"
