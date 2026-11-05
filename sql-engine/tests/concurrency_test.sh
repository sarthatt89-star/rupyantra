#!/usr/bin/env bash
# tests/concurrency_test.sh  --  many people at once: no lost update, no double sign-up, no deadlock.
source "$(dirname "$0")/_lib.sh"
DB="$(new_db)"; migrate "$DB"; with_fixtures "$DB"
ALICE="$(q "$DB" "select ry_test.id('alice')")"
GOAL="$(q "$DB" "select id from app.savings_records where user_id = '$ALICE'")"
START="$(q "$DB" "select saved_amount from app.savings_records where id = '$GOAL'")"
WORKERS=16; EACH=25

# 16 sessions at the same moment, each adding 25 contributions of 1.10 to the SAME goal, each in its own transaction
worker() {
  for _ in $(seq "$EACH"); do
    echo "BEGIN; SET LOCAL ROLE ry_app; SELECT app.begin_request('$ALICE'); SELECT app.add_savings_contribution('$GOAL', 1.10); COMMIT;"
  done | psql "$(url "$DB")" -X -q -At -v ON_ERROR_STOP=1 >/dev/null 2>"$1"
}
LOGS=(); PIDS=()
for i in $(seq "$WORKERS"); do f="$(mktemp)"; LOGS+=("$f"); worker "$f" & PIDS+=($!); done
for p in "${PIDS[@]}"; do wait "$p" || fail "a concurrent writer failed"; done
for f in "${LOGS[@]}"; do [ ! -s "$f" ] || { cat "$f" >&2; fail "a concurrent writer reported an error"; }; rm -f "$f"; done

WANT="$(q "$DB" "select $START + $WORKERS * $EACH * 1.10")"
GOT="$(q "$DB" "select saved_amount from app.savings_records where id = '$GOAL'")"
SUM="$(q "$DB" "select sum(amount) from app.savings_contributions where savings_id = '$GOAL'")"
N="$(q "$DB" "select count(*) from app.savings_contributions where savings_id = '$GOAL'")"
[ "$GOT" = "$WANT" ] || fail "lost update: saved_amount is $GOT, expected $WANT"
[ "$SUM" = "$GOT" ] || fail "saved_amount $GOT differs from the sum of contributions $SUM"
[ "$N" = "$((2 + WORKERS * EACH))" ] || fail "expected $((2 + WORKERS * EACH)) contributions, found $N"
ok "concurrency: $((WORKERS * EACH)) simultaneous contributions from $WORKERS sessions: saved_amount $START -> $GOT, equal to the sum, none lost"

# the same e-mail registered by 10 sessions at once: exactly one account
HASH='$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$cmFjZXJhY2VyYWNlcmFjZXJhY2VyYWNl'
RLOGS=(); PIDS=()
for i in $(seq 10); do
  f="$(mktemp)"; RLOGS+=("$f")
  ( echo "SET ROLE ry_app; SELECT app.register_user('race@example.com', '$HASH');" | psql "$(url "$DB")" -X -q -At >/dev/null 2>"$f" || true ) & PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p" || true; done
FAILED_N="$(cat "${RLOGS[@]}" | grep -c 'duplicate key' || true)"; rm -f "${RLOGS[@]}"
[ "$(q "$DB" "select count(*) from app.users where email = 'race@example.com'")" = 1 ] || fail "the same e-mail was registered more than once"
[ "$(q "$DB" "select count(*) from app.user_profiles p join app.users u on u.id = p.user_id where u.email = 'race@example.com'")" = 1 ] || fail "profile count is not exactly one"
[ "$(q "$DB" "select count(*) from app.user_preferences p join app.users u on u.id = p.user_id where u.email = 'race@example.com'")" = 1 ] || fail "preferences count is not exactly one"
[ "$FAILED_N" = 9 ] || fail "expected 9 duplicate-key refusals, saw $FAILED_N"
ok "concurrency: 10 simultaneous sign-ups with one e-mail: 1 account, 9 refused, no half-created account"

# two people erased and written to at once: no deadlock, nothing orphaned
BOB="$(q "$DB" "select ry_test.id('bob')")"
( echo "BEGIN; SET LOCAL ROLE ry_app; SELECT app.begin_request('$BOB'); SELECT app.erase_user('$BOB'); COMMIT;" | psql "$(url "$DB")" -X -q -At -v ON_ERROR_STOP=1 >/dev/null ) &
P1=$!
for _ in $(seq 20); do
  echo "BEGIN; SET LOCAL ROLE ry_app; SELECT app.begin_request('$ALICE'); INSERT INTO app.engine_execution_history (user_id, engine, function_name, executed, success, engine_version) VALUES ('$ALICE', 'cpp', 'emi', true, true, '1.0.0'); COMMIT;"
done | psql "$(url "$DB")" -X -q -At -v ON_ERROR_STOP=1 >/dev/null &
P2=$!
wait "$P1" || fail "erasing an account while others write failed"; wait "$P2" || fail "writing while an account is erased failed"
[ "$(q "$DB" "select count(*) from app.users where id = '$BOB'")" = 0 ] || fail "the erased account is still there"
ok "concurrency: erasing one account while another person writes: no deadlock, no error"

RESULT="$(psql "$(url "$DB")" -X -q -At -F'|' -f "$SQL_ROOT/backups/integrity_checks.sql" | awk -F'|' '$2 != 0')"
[ -z "$RESULT" ] || { echo "$RESULT" >&2; fail "integrity checks found a problem after the concurrent run"; }
ok "concurrency: integrity checks are all zero after the concurrent run"
