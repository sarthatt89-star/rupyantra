-- tests/permission_tests.sql  --  who can do what, who sees whose rows, and that text is never run as SQL.
\set ON_ERROR_STOP on

-- ===== the application role: no identity -> no data
BEGIN;
SET LOCAL ROLE ry_app;
SELECT ry_test.ok((SELECT count(*) FROM app.financial_records) = 0 AND (SELECT count(*) FROM app.transactions) = 0 AND (SELECT count(*) FROM app.chat_messages) = 0,
  'ry_app with nobody signed in sees no rows at all');
SELECT ry_test.raises($$SELECT password_hash FROM app.users$$, '42501', 'ry_app cannot read password_hash');
SELECT ry_test.raises($$SELECT * FROM app.users$$, '42501', 'SELECT * on users is refused (it would include password_hash)');
SELECT ry_test.raises($$SELECT token_hash FROM app.user_sessions$$, '42501', 'ry_app cannot read session token hashes');
SELECT ry_test.raises($$SELECT 1 FROM app.audit_logs$$, '42501', 'ry_app cannot read the audit trail');
SELECT ry_test.raises($$SELECT 1 FROM app.retention_policies$$, '42501', 'ry_app cannot read retention policies');
SELECT ry_test.raises($$SELECT 1 FROM app.schema_migrations$$, '42501', 'ry_app cannot read the migration table');
SELECT ry_test.raises($$CREATE TABLE app.sneaky (x int)$$, '42501', 'ry_app cannot create tables in app');
SELECT ry_test.raises($$CREATE TABLE public.sneaky (x int)$$, '42501', 'ry_app cannot create tables in public');
SELECT ry_test.raises($$DROP TABLE app.users CASCADE$$, '42501', 'ry_app cannot drop tables');
SELECT ry_test.raises($$ALTER TABLE app.users DISABLE ROW LEVEL SECURITY$$, '42501', 'ry_app cannot switch row-level security off');
SELECT ry_test.raises($$TRUNCATE app.financial_records$$, '42501', 'ry_app cannot truncate');
SELECT ry_test.raises($$INSERT INTO app.users (email, auth_provider) VALUES ('direct@example.com', 'google')$$, '42501', 'accounts are created only through register_user');
SELECT ry_test.raises($$UPDATE app.users SET status = 'active'$$, '42501', 'ry_app cannot edit users directly');
SELECT ry_test.raises($$DELETE FROM app.users$$, '42501', 'ry_app cannot delete users directly');
SELECT ry_test.raises($$INSERT INTO app.savings_contributions (savings_id, user_id, amount, contributed_on) VALUES (gen_random_uuid(), gen_random_uuid(), 1, '2026-01-01')$$, '42501', 'ry_app cannot insert a contribution directly');
SELECT ry_test.raises($$UPDATE app.savings_records SET saved_amount = 1$$, '42501', 'ry_app cannot write saved_amount');
SELECT ry_test.raises($$UPDATE app.calculator_history SET label = 'x'$$, '42501', 'ry_app cannot edit a saved calculation');
SELECT ry_test.raises($$UPDATE app.financial_reports SET title = 'x'$$, '42501', 'ry_app cannot edit a saved report');
SELECT ry_test.raises($$UPDATE app.engine_execution_history SET success = true$$, '42501', 'ry_app cannot edit an engine run');
SELECT ry_test.raises($$DELETE FROM app.engine_execution_history$$, '42501', 'ry_app cannot delete engine runs');
SELECT ry_test.raises($$DELETE FROM app.ai_execution_logs$$, '42501', 'ry_app cannot delete AI logs');
SELECT ry_test.raises($$UPDATE app.user_sessions SET expires_at = now() + interval '90 days'$$, '42501', 'ry_app cannot extend a session');
SELECT ry_test.raises($$SELECT app.audit_row()$$, '42501', 'ry_app cannot call internal trigger functions');
SELECT ry_test.raises($$SELECT app.run_retention()$$, '42501', 'ry_app cannot run retention');
SELECT ry_test.raises($$SELECT app.check_savings_total()$$, '42501', 'ry_app cannot call the savings check');
ROLLBACK;

-- ===== isolation between people
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('bob'));
DO $$
DECLARE
  t text;
  alice uuid := ry_test.id('alice');
  n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_profiles','user_preferences','user_sessions','user_activity','financial_records','transactions','loan_records','investment_records',
      'savings_records','savings_contributions','financial_reports','calculator_history','emi_history','sip_history','fd_history','tax_history','calculation_metadata',
      'chat_sessions','chat_messages','chat_feedback','engine_execution_history','ai_execution_logs'] LOOP
    n := ry_test.rows(format('SELECT 1 FROM app.%I WHERE user_id = %L', t, alice));
    IF n <> 0 THEN
      RAISE EXCEPTION 'FAILED: bob can see % row(s) of alice in %', n, t;
    END IF;
  END LOOP;
  IF ry_test.rows(format('SELECT 1 FROM app.users WHERE id = %L', alice)) <> 0 THEN
    RAISE EXCEPTION 'FAILED: bob can see alice''s account';
  END IF;
  RAISE NOTICE 'ok - bob sees none of alice''s rows in any of the 23 tables that hold personal data';
END $$;
SELECT ry_test.ok((SELECT count(*) FROM app.users) = 1 AND (SELECT count(*) FROM app.financial_records) = 1 AND (SELECT count(*) FROM app.transactions) = 1,
  'bob sees exactly his own account and his own rows');
SELECT ry_test.ok(ry_test.affected($$UPDATE app.financial_records SET label = 'hacked' WHERE user_id = ry_test.id('alice')$$) = 0, 'bob cannot update alice''s rows');
SELECT ry_test.ok(ry_test.affected($$DELETE FROM app.transactions WHERE user_id = ry_test.id('alice')$$) = 0, 'bob cannot delete alice''s rows');
SELECT ry_test.raises($$INSERT INTO app.financial_records (user_id, category, label, amount, recorded_on) VALUES (ry_test.id('alice'), 'income', 'planted', 1, '2026-10-02')$$, '42501', 'bob cannot plant a row in alice''s name');
SELECT ry_test.raises($$INSERT INTO app.ai_execution_logs (user_id, provider, model, status) VALUES (ry_test.id('alice'), 'p', 'm', 'ok')$$, '42501', 'bob cannot write a log row in alice''s name');
SELECT ry_test.ok((SELECT count(*) FROM app.v_my_savings_progress) = 0 AND (SELECT count(*) FROM app.v_my_loans) = 0 AND (SELECT count(*) FROM app.v_my_emi_comparison) = 0, 'the v_my_* views show bob none of alice''s data');
SELECT ry_test.ok((SELECT count(*) FROM app.net_position()) = 1 AND (SELECT net FROM app.net_position()) = 5000, 'net_position() reports only bob''s own records');
ROLLBACK;
-- the goal id of alice, found as the administrator, must not be usable by bob
SELECT id AS alice_goal FROM app.savings_records WHERE user_id = ry_test.id('alice') \gset
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('bob'));
SELECT ry_test.raises(format($$SELECT app.add_savings_contribution(%L, 5)$$, :'alice_goal'), 'P0002', 'bob cannot add money to alice''s savings goal');
SELECT ry_test.raises($$SELECT app.add_savings_contribution(gen_random_uuid(), 0)$$, '22023', 'a contribution of zero is refused');
SELECT ry_test.raises($$SELECT app.add_savings_contribution(gen_random_uuid(), 0.004)$$, '22023', 'a contribution that rounds to zero is refused');
ROLLBACK;
BEGIN;
SET LOCAL ROLE ry_app;
SELECT ry_test.raises(format($$SELECT app.add_savings_contribution(%L, 5)$$, :'alice_goal'), '42501', 'with nobody signed in, no contribution can be added');
ROLLBACK;

-- identity belongs to one transaction only (a pooled connection cannot carry it to the next request)
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
SELECT ry_test.ok((SELECT count(*) FROM app.financial_records) >= 3, 'inside alice''s transaction she sees her records');
COMMIT;
BEGIN;
SET LOCAL ROLE ry_app;
SELECT ry_test.ok((SELECT count(*) FROM app.financial_records) = 0 AND app.current_user_id() IS NULL, 'in the next transaction on the same connection nobody is signed in');
ROLLBACK;

-- ===== sessions and login
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
INSERT INTO app.user_sessions (user_id, token_hash, device_label, expires_at) VALUES (ry_test.id('alice'), decode(repeat('11', 32), 'hex'), 'Chrome on Android', now() + interval '30 days');
COMMIT;
BEGIN;
SET LOCAL ROLE ry_app;
SELECT ry_test.ok(app.resolve_session(decode(repeat('11', 32), 'hex')) = ry_test.id('alice'), 'a valid session token hash resolves to its user');
SELECT ry_test.ok(app.resolve_session(decode(repeat('22', 32), 'hex')) IS NULL, 'an unknown token hash resolves to nobody');
ROLLBACK;
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
UPDATE app.user_sessions SET revoked_at = now() WHERE device_label = 'Chrome on Android';
COMMIT;
SELECT ry_test.ok(app.resolve_session(decode(repeat('11', 32), 'hex')) IS NULL, 'a revoked session resolves to nobody');
INSERT INTO app.user_sessions (user_id, token_hash, created_at, expires_at) VALUES (ry_test.id('bob'), decode(repeat('33', 32), 'hex'), now() - interval '2 days', now() - interval '1 day');
SELECT ry_test.ok(app.resolve_session(decode(repeat('33', 32), 'hex')) IS NULL, 'an expired session resolves to nobody');
INSERT INTO app.user_sessions (user_id, token_hash, expires_at) VALUES (ry_test.id('bob'), decode(repeat('44', 32), 'hex'), now() + interval '1 day');
SELECT ry_test.ok(app.resolve_session(decode(repeat('44', 32), 'hex')) = ry_test.id('bob'), 'bob''s live session resolves to bob');
UPDATE app.users SET status = 'suspended' WHERE id = ry_test.id('bob');
SELECT ry_test.ok(app.resolve_session(decode(repeat('44', 32), 'hex')) IS NULL, 'a suspended account''s session resolves to nobody');
UPDATE app.users SET status = 'active' WHERE id = ry_test.id('bob');
BEGIN;
SET LOCAL ROLE ry_app;
SELECT ry_test.ok((SELECT count(*) FROM app.find_login('  ALICE@Example.com ')) = 1 AND (SELECT password_hash FROM app.find_login('alice@example.com')) LIKE '$argon2id$%',
  'find_login finds an account by e-mail and returns its hash for verification');
SELECT ry_test.ok((SELECT count(*) FROM app.find_login($q$' OR '1'='1$q$)) = 0 AND (SELECT count(*) FROM app.find_login($q$x'; DROP TABLE app.users; --$q$)) = 0, 'find_login treats an injection string as an e-mail that does not exist');
ROLLBACK;

-- ===== reporting roles
BEGIN;
SET LOCAL ROLE ry_readonly;
SELECT ry_test.raises($$SELECT 1 FROM app.users$$, '42501', 'ry_readonly cannot read users');
SELECT ry_test.raises($$SELECT 1 FROM app.financial_records$$, '42501', 'ry_readonly cannot read financial records');
SELECT ry_test.raises($$SELECT 1 FROM app.audit_logs$$, '42501', 'ry_readonly cannot read the audit trail');
SELECT ry_test.raises($$SELECT 1 FROM app.engine_execution_history$$, '42501', 'ry_readonly cannot read engine runs row by row');
SELECT ry_test.raises($$SELECT * FROM app.net_position()$$, '42501', 'ry_readonly cannot call the per-user functions');
SELECT ry_test.raises($$SELECT 1 FROM app.v_my_loans$$, '42501', 'ry_readonly cannot use the per-user views');
SELECT ry_test.raises($$INSERT INTO app.ai_execution_logs (provider, model, status) VALUES ('p', 'm', 'ok')$$, '42501', 'ry_readonly cannot write');
SELECT ry_test.ok((SELECT accounts FROM app.v_platform_totals) >= 2, 'ry_readonly can read the aggregate view of platform totals');
SELECT ry_test.ok((SELECT count(*) FROM app.v_engine_usage) >= 1, 'ry_readonly can read engine usage');
ROLLBACK;
SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'app'
  AND table_name IN ('v_engine_usage', 'v_engine_errors', 'v_ai_usage', 'v_calculator_usage', 'v_platform_totals', 'v_table_health', 'v_index_usage', 'v_duplicate_indexes')
  AND (column_name ILIKE '%user%' OR column_name ILIKE '%email%' OR column_name ILIKE '%label%' OR column_name ILIKE '%title%' OR column_name ILIKE '%content%' OR column_name ILIKE '%note%')),
  'no operator view has a column that could hold a person, an e-mail or text a person wrote');
BEGIN;
SET LOCAL ROLE ry_auditor;
SELECT ry_test.ok((SELECT count(*) FROM app.audit_logs) >= 1, 'ry_auditor can read the audit trail');
SELECT ry_test.ok((SELECT count(*) FROM app.v_table_health) >= 20 AND (SELECT count(*) FROM app.v_index_usage) >= 20, 'ry_auditor can read table health and index usage');
SELECT ry_test.raises($$SELECT 1 FROM app.users$$, '42501', 'ry_auditor cannot read users');
SELECT ry_test.raises($$SELECT 1 FROM app.transactions$$, '42501', 'ry_auditor cannot read transactions');
SELECT ry_test.raises($$DELETE FROM app.audit_logs$$, '42501', 'ry_auditor cannot delete audit rows');
ROLLBACK;
CREATE ROLE ry_stranger NOLOGIN;
BEGIN;
SET LOCAL ROLE ry_stranger;
SELECT ry_test.raises($$SELECT 1 FROM app.users$$, '42501', 'a role with no grants cannot read users');
SELECT ry_test.raises($$SELECT * FROM app.v_platform_totals$$, '42501', 'a role with no grants cannot even see the aggregate views (no schema access)');
SELECT ry_test.raises($$SELECT app.current_user_id()$$, '42501', 'a role with no grants cannot call functions');
ROLLBACK;
DROP ROLE ry_stranger;

-- ===== SQL injection: text is data, never code
SELECT count(*) AS users_before FROM app.users \gset
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
PREPARE add_record(text) AS
  INSERT INTO app.financial_records (user_id, category, label, amount, recorded_on) VALUES (app.current_user_id(), 'income', $1, 1, '2026-10-02');
EXECUTE add_record($q$x'); DROP TABLE app.users CASCADE; --$q$);
EXECUTE add_record($q$Robert'); DELETE FROM app.financial_records; --$q$);
COMMIT;
SELECT ry_test.ok((SELECT count(*) FROM app.users) = :users_before, 'injection through a prepared parameter: the users table is intact');
SELECT ry_test.ok(EXISTS (SELECT 1 FROM app.financial_records WHERE label = $q$x'); DROP TABLE app.users CASCADE; --$q$)
  AND EXISTS (SELECT 1 FROM app.financial_records WHERE label = $q$Robert'); DELETE FROM app.financial_records; --$q$), 'injection through a prepared parameter: the text was stored exactly as typed');
SELECT :VERSION_NUM >= 160000 AS can_bind \gset
\if :can_bind
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
INSERT INTO app.financial_records (user_id, category, label, amount, recorded_on) VALUES (app.current_user_id(), 'income', $1, 1, '2026-10-02') \bind '1; DROP SCHEMA app CASCADE; --' \g
COMMIT;
SELECT ry_test.ok(EXISTS (SELECT 1 FROM app.financial_records WHERE label = '1; DROP SCHEMA app CASCADE; --') AND (SELECT count(*) FROM app.users) = :users_before,
  'injection through the real extended protocol (the way a driver sends parameters): stored as text, schema intact');
\else
SELECT ry_test.ok(true, 'extended-protocol check skipped: this psql is older than 16');
\endif
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
SELECT ry_test.raises($q$SELECT * FROM app.monthly_cashflow('2026-01-01''; DROP TABLE app.users; --', '2026-12-01')$q$, '22007', 'a typed date parameter cannot carry SQL: it is a syntax error for a date');
SELECT ry_test.ok(ry_test.rows($q$SELECT * FROM app.recent_calculations($z$emi' OR '1'='1$z$)$q$) = 0, 'recent_calculations: an injection string is just a kind that does not exist');
SELECT ry_test.ok(ry_test.rows($q$SELECT * FROM app.recent_calculations('emi', 1000000)$q$) <= 100, 'recent_calculations: the row limit is capped at 100');
ROLLBACK;
SELECT ry_test.ok((SELECT count(*) FROM app.users) = :users_before AND to_regclass('app.financial_records') IS NOT NULL, 'after every injection attempt the schema and the users are intact');
