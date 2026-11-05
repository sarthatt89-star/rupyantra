-- tests/schema_tests.sql  --  the structure is what it should be. Runs as the administrator.
\set ON_ERROR_STOP on

SELECT ry_test.ok(
  (SELECT array_agg(t ORDER BY t COLLATE "C") FROM unnest(ARRAY[
    'users','user_profiles','user_preferences','user_sessions','user_activity',
    'financial_records','transactions','loan_records','investment_records','savings_records','savings_contributions','financial_reports',
    'calculator_history','emi_history','sip_history','fd_history','tax_history','calculation_metadata',
    'chat_sessions','chat_messages','chat_feedback','ai_execution_logs','engine_execution_history',
    'audit_logs','retention_policies','schema_migrations']) t)
  = (SELECT array_agg(tablename::text ORDER BY tablename::text COLLATE "C") FROM pg_tables WHERE schemaname = 'app'),
  'exactly the expected 26 tables exist in schema app');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'app'
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = (quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))::regclass AND c.contype = 'p')),
  'every table has a primary key');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = 'app' AND c.contype = 'f' AND NOT EXISTS (
    SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indkey[0] = c.conkey[1])),
  'every foreign key has an index that starts with its first column');

SELECT ry_test.ok((SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'app' AND c.contype = 'f') = 24,
  'exactly 24 foreign keys exist');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'app' AND data_type IN ('real', 'double precision', 'money')),
  'no money or number is stored as a floating-point (or locale "money") column');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'app' AND (column_name ILIKE '%password%' OR column_name ILIKE '%pan%' OR column_name ILIKE '%aadhaar%' OR column_name ILIKE '%card_number%' OR column_name ILIKE '%account_number%')
    AND column_name NOT IN ('password_hash')),
  'no column is meant to hold a PAN, Aadhaar, card or account number or a plain password');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relkind = 'r' AND NOT c.relrowsecurity
    AND c.relname NOT IN ('audit_logs', 'retention_policies', 'schema_migrations')),
  'row-level security is on for every table except the three that the app can never reach');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app' AND p.prosecdef AND NOT (coalesce(p.proconfig, '{}') && ARRAY[(SELECT 'search_path=' || 'app, pg_catalog')])),
  'every SECURITY DEFINER function pins its search_path (no search-path hijack)');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app' AND has_function_privilege('public', p.oid, 'EXECUTE')),
  'no function in schema app can be run by PUBLIC');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relkind IN ('r', 'v', 'm') AND has_table_privilege('public', c.oid, 'SELECT')),
  'nothing in schema app can be read by PUBLIC');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('ry_owner', 'ry_app', 'ry_readonly', 'ry_auditor')
  AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)),
  'the four group roles cannot log in and have no special powers');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relkind IN ('r', 'v', 'S', 'm') AND pg_get_userbyid(c.relowner) <> 'ry_owner'),
  'ry_owner owns every table, view and sequence');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relkind = 'v' AND c.relname LIKE 'v\_my\_%' AND NOT (coalesce(c.reloptions, '{}') && ARRAY['security_invoker=true'])),
  'every v_my_* view runs with the caller''s rights, so row-level security applies');

SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND NOT i.indisvalid), 'no invalid index');
SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM app.v_duplicate_indexes), 'no duplicate index');
SELECT ry_test.ok((SELECT count(*) FROM pg_constraint WHERE connamespace = 'app'::regnamespace AND NOT convalidated) = 0, 'every constraint is validated');

-- the value rules are written once, as domains
SELECT ry_test.ok((SELECT count(*) FROM pg_type t WHERE t.typnamespace = 'app'::regnamespace AND t.typtype = 'd') = 7, 'seven value domains (money, signed_money, percent, currency, short_text, note_text, hex32)');
SELECT ry_test.raises($$SELECT (-1)::app.money$$, '23514', 'money cannot be negative');
SELECT ry_test.raises($$SELECT 1e16::app.money$$, '22003', 'money cannot reach 1e16 (the column type overflows)');
SELECT ry_test.raises($$SELECT 'inr'::app.currency$$, '23514', 'currency must be 3 capital letters');
SELECT ry_test.raises($$SELECT ''::app.short_text$$, '23514', 'a short text cannot be empty');
SELECT ry_test.raises($$SELECT 'XYZ'::app.hex32$$, '23514', 'hex32 must be 32 hex digits');
SELECT ry_test.ok((0.1::numeric + 0.2::numeric)::app.money = 0.30, 'decimal money adds exactly: 0.1 + 0.2 = 0.30');
SELECT ry_test.ok(current_setting('TimeZone') = 'UTC' OR (SELECT setconfig FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setrole = 0)::text LIKE '%timezone=UTC%', 'the database default time zone is UTC');
