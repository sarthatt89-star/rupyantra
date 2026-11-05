-- tests/integrity_tests.sql  --  the database refuses wrong data by itself, whatever the application does.
\set ON_ERROR_STOP on

-- ===== accounts: no plaintext password, clean e-mail
SET ROLE ry_owner;
SELECT ry_test.raises($$INSERT INTO app.users (email, password_hash) VALUES ('p1@example.com', 'hunter2')$$, '23514', 'a plaintext password cannot be stored');
SELECT ry_test.raises($$INSERT INTO app.users (email, password_hash) VALUES ('p2@example.com', '$argon2id$short')$$, '23514', 'a truncated hash cannot be stored');
SELECT ry_test.raises($$INSERT INTO app.users (email) VALUES ('p3@example.com')$$, '23514', 'a password account must have a hash');
SELECT ry_test.raises($$INSERT INTO app.users (email, auth_provider) VALUES ('no-at-sign', 'google')$$, '23514', 'an e-mail without @ is refused');
SELECT ry_test.raises($$INSERT INTO app.users (email, auth_provider) VALUES ('a b@example.com', 'google')$$, '23514', 'an e-mail with a space is refused');
SELECT ry_test.raises($$INSERT INTO app.users (email, auth_provider) VALUES ('x@example.com', 'carrier-pigeon')$$, '23514', 'unknown sign-in provider is refused');
SELECT ry_test.raises($$INSERT INTO app.users (email, auth_provider) VALUES ('ALICE@example.com', 'google')$$, '23505', 'the same e-mail in other letter case is a duplicate');
SELECT app.register_user('  MiXed@Example.COM ', NULL, 'google');
SELECT ry_test.ok((SELECT email FROM app.users WHERE email LIKE 'mixed@%') = 'mixed@example.com', 'e-mail is stored trimmed and lower-case');
SELECT ry_test.raises($$INSERT INTO app.user_sessions (user_id, token_hash, expires_at) VALUES (ry_test.id('alice'), '\x00'::bytea, now() + interval '1 day')$$, '23514', 'a session token hash must be exactly 32 bytes');
SELECT ry_test.raises($$INSERT INTO app.user_sessions (user_id, token_hash, expires_at) VALUES (ry_test.id('alice'), decode(repeat('ab', 32), 'hex'), now() + interval '200 days')$$, '23514', 'a session cannot last longer than 91 days');
SELECT ry_test.raises($$INSERT INTO app.user_activity (user_id, activity) VALUES (ry_test.id('alice'), 'sold_my_soul')$$, '23514', 'activity names are a fixed list');
SELECT ry_test.raises($$INSERT INTO app.user_activity (user_id, activity, metadata) VALUES (ry_test.id('alice'), 'login', '{"password":"x"}')$$, '23514', 'activity metadata cannot carry a password field');

-- ===== money and dates
SELECT ry_test.raises(format($$INSERT INTO app.loan_records (user_id, label, loan_type, principal, annual_rate_percent, tenure_months, start_date) VALUES (%L,'x','home',0,8,12,'2026-01-01')$$, ry_test.id('alice')), '23514', 'a loan principal of zero is refused');
SELECT ry_test.raises(format($$INSERT INTO app.loan_records (user_id, label, loan_type, principal, annual_rate_percent, tenure_months, start_date) VALUES (%L,'x','home',100,1001,12,'2026-01-01')$$, ry_test.id('alice')), '23514', 'an interest rate over 1000 percent is refused');
SELECT ry_test.raises(format($$INSERT INTO app.loan_records (user_id, label, loan_type, principal, annual_rate_percent, tenure_months, start_date) VALUES (%L,'x','home',100,8,601,'2026-01-01')$$, ry_test.id('alice')), '23514', 'a 601-month tenure is refused');
SELECT ry_test.raises(format($$INSERT INTO app.transactions (user_id, kind, amount, occurred_on) VALUES (%L,'expense',-5,'2026-01-01')$$, ry_test.id('alice')), '23514', 'a negative amount is refused');
SELECT ry_test.raises(format($$INSERT INTO app.transactions (user_id, kind, amount, occurred_on) VALUES (%L,'expense',5,'1800-01-01')$$, ry_test.id('alice')), '23514', 'a date before 1950 is refused');
SELECT ry_test.raises(format($$INSERT INTO app.transactions (user_id, kind, amount, currency, occurred_on) VALUES (%L,'expense',5,'rupee','2026-01-01')$$, ry_test.id('alice')), '22001', 'a currency longer than 3 characters is refused');
SELECT ry_test.raises(format($$INSERT INTO app.transactions (user_id, kind, amount, occurred_on, external_ref) VALUES (%L,'expense',5,'2026-01-01','ref-1')$$, ry_test.id('alice')), '23505', 'importing the same external_ref twice is refused (re-importing a file is safe)');
SELECT ry_test.raises(format($$INSERT INTO app.investment_records (user_id, label, instrument_type, amount_invested, invested_on, current_value) VALUES (%L,'x','stock',10,'2026-01-01',12)$$, ry_test.id('alice')), '23514', 'a current value without its date is refused');
SELECT ry_test.raises(format($$INSERT INTO app.investment_records (user_id, label, instrument_type, amount_invested, invested_on, current_value, value_as_of) VALUES (%L,'x','stock',10,'2026-01-01',12,'2025-01-01')$$, ry_test.id('alice')), '23514', 'a value dated before the purchase is refused');
SELECT ry_test.raises(format($$INSERT INTO app.financial_reports (user_id, report_type, title, period_start, period_end, payload) VALUES (%L,'custom','x','2026-02-01','2026-01-01','{}')$$, ry_test.id('alice')), '23514', 'a report period that ends before it starts is refused');
SELECT ry_test.raises(format($$INSERT INTO app.financial_reports (user_id, report_type, title, period_start, period_end, payload) VALUES (%L,'custom','x','2026-01-01','2026-02-01','[]')$$, ry_test.id('alice')), '23514', 'a report payload must be a JSON object');
SELECT ry_test.raises(format($$INSERT INTO app.financial_reports (user_id, report_type, title, period_start, period_end, payload, engine_execution_id) VALUES (%L,'custom','x','2026-01-01','2026-02-01','{}', gen_random_uuid())$$, ry_test.id('alice')), '23514', 'a report cannot name an engine run without naming the engine');

-- ===== savings: the total always equals the contributions
SELECT ry_test.ok((SELECT saved_amount FROM app.savings_records WHERE user_id = ry_test.id('alice')) = 3500.35
  AND (SELECT sum(amount) FROM app.savings_contributions WHERE user_id = ry_test.id('alice')) = 3500.35, 'savings: 2500.25 + 1000.10 = 3500.35 exactly');
SELECT ry_test.raises($$UPDATE app.savings_records SET saved_amount = saved_amount + 1 WHERE user_id = ry_test.id('alice'); SET CONSTRAINTS ALL IMMEDIATE$$, '23514', 'savings: a total that disagrees with its contributions cannot be committed');
SELECT ry_test.raises($$INSERT INTO app.savings_contributions (savings_id, user_id, amount, contributed_on) SELECT id, user_id, 50, '2026-10-07' FROM app.savings_records WHERE user_id = ry_test.id('alice'); SET CONSTRAINTS ALL IMMEDIATE$$, '23514', 'savings: a contribution that is not in the total cannot be committed');
SELECT ry_test.raises($$DELETE FROM app.savings_contributions WHERE user_id = ry_test.id('alice') AND amount = 1000.10; SET CONSTRAINTS ALL IMMEDIATE$$, '23514', 'savings: removing a contribution without lowering the total cannot be committed');
SELECT ry_test.raises(format($$INSERT INTO app.savings_contributions (savings_id, user_id, amount, contributed_on) SELECT id, %L, 5, '2026-10-07' FROM app.savings_records WHERE user_id = ry_test.id('alice')$$, ry_test.id('bob')), '23503', 'savings: a contribution cannot point at another person''s goal');
SELECT ry_test.raises($$INSERT INTO app.savings_contributions (savings_id, user_id, amount, contributed_on) SELECT id, user_id, 0, '2026-10-07' FROM app.savings_records WHERE user_id = ry_test.id('alice')$$, '23514', 'savings: a contribution of zero is refused');
SELECT ry_test.raises($$UPDATE app.savings_records SET status = 'achieved' WHERE user_id = ry_test.id('alice')$$, '23514', 'savings: "achieved" needs the target to be reached');

-- ===== saved calculations
SELECT ry_test.raises(format($$INSERT INTO app.calculator_history (user_id, kind, inputs, result, calc_version, saved_by_user) VALUES (%L,'emi','{}','{}','v1',false)$$, ry_test.id('alice')), '23514', 'a calculation the person did not choose to save is refused');
SELECT ry_test.raises(format($$INSERT INTO app.calculator_history (user_id, kind, inputs, result, calc_version) VALUES (%L,'emi','{}','{}','v1')$$, ry_test.id('alice')), '23502', 'saved_by_user has no default: leaving it out is refused');
SELECT ry_test.raises(format($$INSERT INTO app.calculator_history (user_id, kind, inputs, result, calc_version, saved_by_user) VALUES (%L,'emi','[]','{}','v1',true)$$, ry_test.id('alice')), '23514', 'calculation inputs must be a JSON object');
SELECT ry_test.raises(format($$INSERT INTO app.calculator_history (user_id, kind, inputs, result, calc_version, saved_by_user) VALUES (%L,'mortgage','{}','{}','v1',true)$$, ry_test.id('alice')), '23514', 'only the four calculator kinds exist');
SELECT ry_test.raises(format($$INSERT INTO app.tax_history (calc_id, user_id, financial_year, regime, gross_income, taxable_income, tax_payable) SELECT id, user_id, '2026-27', 'new', 100, 100, 0 FROM app.calculator_history WHERE label = 'Car loan 8%%' AND user_id = %L$$, ry_test.id('alice')), '23503', 'a tax detail row cannot hang on an EMI calculation');
SELECT ry_test.raises(format($$WITH h AS (INSERT INTO app.calculator_history (user_id, kind, inputs, result, calc_version, saved_by_user) VALUES (%L,'emi','{}','{}','v1',true) RETURNING id) INSERT INTO app.emi_history SELECT id, 'emi', %L, 1000, 8, 12, 87, 44, 1044 FROM h$$, ry_test.id('alice'), ry_test.id('bob')), '23503', 'an EMI detail row cannot belong to another person than its calculation');
SELECT ry_test.raises($$INSERT INTO app.tax_history (calc_id, user_id, financial_year, regime, gross_income, taxable_income, tax_payable) SELECT id, user_id, '2026-27', 'new', 100, 100, 0 FROM app.calculator_history WHERE label = 'SIP 5000'$$, '23503', 'the tax row for a SIP calculation is refused (wrong kind)');
SELECT ry_test.raises($$INSERT INTO app.calculation_metadata (calc_id, user_id, engine, engine_version) SELECT id, user_id, 'java', '1' FROM app.calculator_history WHERE label = 'SIP 5000'$$, '23514', 'only the four engines can be named');

-- ===== engine records can not lie
INSERT INTO app.engine_execution_history (engine, function_name, executed, success, execution_id, engine_version) VALUES ('rust', 'csv_profile', true, true, repeat('dd',16), '0.1.0');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, executed, success, execution_id, engine_version) VALUES ('rust', false, true, repeat('e1',16), '0.1.0')$$, '23514', 'success without execution is refused (e.g. an engine that was never run cannot be recorded as succeeding)');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, executed, success, execution_id, engine_version) VALUES ('rust', false, true, repeat('e1',16), '0.1.0')$$, '23514', 'a result that says "success" but "not executed" is refused');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, executed, success, execution_id, engine_version) VALUES ('rust', true, false, repeat('e2',16), '0.1.0')$$, '23514', 'a failure without an error code is refused');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, executed, success, execution_id, engine_version, error_code) VALUES ('rust', true, true, repeat('e3',16), '0.1.0', 'TIMEOUT')$$, '23514', 'a success that also carries an error code is refused');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, executed, success, engine_version) VALUES ('python', true, true, '0.1.0')$$, '23514', 'a Python run without its execution_id is refused');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, executed, success, engine_version) VALUES ('rust', true, true, '0.1.0')$$, '23514', 'a Rust run without its execution_id is refused');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, executed, success, execution_id) VALUES ('rust', true, true, repeat('e4',16))$$, '23514', 'an executed run without a version is refused');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, function_name, executed, success, execution_id, engine_version) VALUES ('rust', 'csv_profile', true, true, repeat('dd',16), '0.1.0')$$, '23505', 'the same engine run cannot be recorded twice');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, function_name, executed, success, execution_id, engine_version) VALUES ('rust', 'x''; DROP TABLE app.users; --', true, true, repeat('e5',16), '0.1.0')$$, '23514', 'a function name with SQL punctuation is refused');
SELECT ry_test.raises($$INSERT INTO app.engine_execution_history (engine, executed, success, execution_id, engine_version, error_code) VALUES ('rust', true, false, repeat('e6',16), '0.1.0', 'oops')$$, '23514', 'an error code must be in CAPITAL_LETTERS');
INSERT INTO app.engine_execution_history (engine, function_name, executed, success, engine_version, duration_ms) VALUES ('cpp', 'emi', true, true, '1.0.0', 0.2), ('julia', 'sip_monte_carlo', true, true, '0.1.0', 40);
SELECT ry_test.ok(true, 'C++ and Julia runs may omit the execution id (they do not report one)');
INSERT INTO app.engine_execution_history (engine, function_name, executed, success, execution_id, error_code) VALUES ('rust', 'run_shell', false, false, repeat('f1',16), 'NOT_APPROVED');
SELECT ry_test.ok(true, 'a refused request is stored honestly: executed = false, no version needed');
SELECT ry_test.raises($$INSERT INTO app.ai_execution_logs (provider, model, status, engines_claimed, engines_verified) VALUES ('p', 'm', 'ok', '{rust}', '{python}')$$, '23514', 'an AI answer cannot be logged as claiming an engine that has no evidence');
SELECT ry_test.raises($$INSERT INTO app.ai_execution_logs (provider, model, status, engines_claimed, engines_verified) VALUES ('p', 'm', 'ok', '{java}', '{java}')$$, '23514', 'an unknown engine name is refused in the AI log');
SELECT ry_test.raises($$INSERT INTO app.ai_execution_logs (provider, model, status) VALUES ('p', 'm', 'error')$$, '23514', 'a failed AI request must say what kind of failure');
SELECT ry_test.raises($$INSERT INTO app.ai_execution_logs (provider, model, status, input_tokens) VALUES ('p', 'm', 'ok', -1)$$, '23514', 'negative token counts are refused');
INSERT INTO app.ai_execution_logs (provider, model, status, engines_claimed, engines_verified) VALUES ('p', 'm', 'ok', '{python}', '{python,julia}');
SELECT ry_test.ok(true, 'claiming a subset of the verified engines is accepted');

-- ===== history is never edited
SELECT ry_test.raises($$UPDATE app.calculator_history SET label = 'edited'$$, '42501', 'a saved calculation cannot be edited');
SELECT ry_test.raises($$UPDATE app.engine_execution_history SET success = false, error_code = 'X1'$$, '42501', 'an engine run record cannot be edited');
SELECT ry_test.raises($$UPDATE app.ai_execution_logs SET status = 'refused'$$, '42501', 'an AI log row cannot be edited');
SELECT ry_test.raises($$UPDATE app.user_activity SET activity = 'logout'$$, '42501', 'account activity cannot be edited');
SELECT ry_test.raises($$UPDATE app.calculation_metadata SET engine = 'rust'$$, '42501', 'calculation metadata cannot be edited');
RESET ROLE;

-- ===== audit trail: names of changed columns, never values; cannot be edited
SET ROLE ry_owner;
SELECT ry_test.raises($$UPDATE app.audit_logs SET table_name = 'x'$$, '42501', 'audit rows cannot be edited');
SELECT ry_test.raises($$DELETE FROM app.audit_logs$$, '42501', 'audit rows cannot be deleted by hand');
SELECT ry_test.raises($$TRUNCATE app.audit_logs$$, '42501', 'the audit table cannot be truncated');
RESET ROLE;
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
UPDATE app.loan_records SET annual_rate_percent = 7.75 WHERE user_id = ry_test.id('alice');
SELECT app.change_password('$argon2id$v=19$m=65536,t=3,p=4$bmV3c2FsdG5ld3NhbHQ$bmV3aGFzaG5ld2hhc2huZXdoYXNobmV3aGFzaA');
COMMIT;
SELECT ry_test.ok(EXISTS (SELECT 1 FROM app.audit_logs WHERE table_name = 'loan_records' AND operation = 'UPDATE' AND changed_columns = '{annual_rate_percent}' AND app_user_id = ry_test.id('alice')),
  'audit: the loan change is recorded with the changed column name and the signed-in user');
SELECT ry_test.ok(EXISTS (SELECT 1 FROM app.audit_logs WHERE table_name = 'users' AND operation = 'UPDATE' AND changed_columns @> '{password_hash}' AND app_user_id = ry_test.id('alice')),
  'audit: a password change is recorded by column name');
SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM app.audit_logs a WHERE (to_jsonb(a) - 'occurred_at' - 'id')::text ~ '(7\.75|8\.5|argon2|newhash|hunter2|@example\.com)'),
  'audit: no value, hash or e-mail address appears anywhere in the audit trail');
SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM app.audit_logs WHERE table_name = 'transactions'), 'audit: bulk transactions are deliberately not audited');
SELECT ry_test.ok((SELECT count(*) FROM app.user_sessions WHERE user_id = ry_test.id('alice') AND revoked_at IS NULL) = 0 AND
  EXISTS (SELECT 1 FROM app.user_activity WHERE user_id = ry_test.id('alice') AND activity = 'password_changed'), 'a password change signs out every session and is logged');

-- ===== transactions: all or nothing
SELECT count(*) AS before_n FROM app.users \gset
SELECT ry_test.raises($$SELECT app.register_user('atomic@example.com', NULL, 'carrier-pigeon')$$, '23514', 'sign-up with an invalid provider is refused');
SELECT ry_test.ok((SELECT count(*) FROM app.users) = :before_n AND NOT EXISTS (SELECT 1 FROM app.users WHERE email = 'atomic@example.com')
  AND NOT EXISTS (SELECT 1 FROM app.user_profiles p WHERE NOT EXISTS (SELECT 1 FROM app.users u WHERE u.id = p.user_id)), 'a failed sign-up leaves nothing behind');
SELECT count(*) AS recs_before FROM app.financial_records \gset
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
INSERT INTO app.financial_records (user_id, category, label, amount, recorded_on) VALUES (ry_test.id('alice'), 'income', 'Temp', 1, '2026-10-02');
ROLLBACK;
SELECT ry_test.ok((SELECT count(*) FROM app.financial_records) = :recs_before, 'ROLLBACK removes what the transaction wrote');
SELECT ry_test.raises(format($$INSERT INTO app.financial_records (user_id, category, label, amount, recorded_on) VALUES (%L,'income','Half',1,'2026-10-02'); SELECT 1/0$$, ry_test.id('alice')), '22012', 'an error halfway through a statement batch is raised');
SELECT ry_test.ok((SELECT count(*) FROM app.financial_records) = :recs_before, 'and the first half of that batch is not kept');
SELECT ry_test.raises($$INSERT INTO app.financial_records (user_id, category, label, amount, recorded_on) VALUES (ry_test.id('alice'), 'income', 'Bad', 10, '2026-10-02'), (ry_test.id('alice'), 'income', 'Bad', -10, '2026-10-02')$$, '23514', 'one bad row in a multi-row insert refuses the whole insert');
SELECT ry_test.ok((SELECT count(*) FROM app.financial_records) = :recs_before, 'and none of its rows are kept');

-- ===== chat history only with the person's consent; no secrets in text
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('bob'));
SELECT ry_test.raises(format($$INSERT INTO app.chat_sessions (user_id, title) VALUES (%L, 'hello')$$, ry_test.id('bob')), '42501', 'chat: a session cannot be stored for a person who has not switched history on');
ROLLBACK;
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
SELECT ry_test.raises(format($$INSERT INTO app.chat_messages (session_id, user_id, role, content) SELECT id, user_id, 'user', 'my key is sk-abcdefghijklmnopqrstuvwxyz0123' FROM app.chat_sessions WHERE user_id = %L$$, ry_test.id('alice')), '23514', 'chat: text that looks like an API key is refused');
SELECT ry_test.raises(format($$INSERT INTO app.chat_messages (session_id, user_id, role, content) SELECT id, user_id, 'user', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' FROM app.chat_sessions WHERE user_id = %L$$, ry_test.id('alice')), '23514', 'chat: a bearer token is refused');
SELECT ry_test.raises(format($$INSERT INTO app.chat_messages (session_id, user_id, role, content) SELECT id, user_id, 'user', '' FROM app.chat_sessions WHERE user_id = %L$$, ry_test.id('alice')), '23514', 'chat: an empty message is refused');
SELECT ry_test.raises(format($$INSERT INTO app.chat_feedback (message_id, user_id, rating) SELECT id, user_id, -1 FROM app.chat_messages WHERE user_id = %L AND role = 'user'$$, ry_test.id('alice')), '23514', 'chat: feedback on your own words is refused');
SELECT ry_test.raises(format($$INSERT INTO app.chat_feedback (message_id, user_id, rating) SELECT id, user_id, 1 FROM app.chat_messages WHERE user_id = %L AND role = 'assistant'$$, ry_test.id('alice')), '23505', 'chat: one feedback per answer');
SELECT ry_test.ok((SELECT last_message_at FROM app.chat_sessions) >= (SELECT created_at FROM app.chat_sessions), 'chat: the session''s last_message_at follows its messages');
ROLLBACK;

-- ===== right to erasure: the account and its data go; operational rows stay, unlinked
SET ROLE ry_app;
SELECT app.register_user('carol@example.com', '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$Y2Fyb2xjYXJvbGNhcm9sY2Fyb2xjYXJvbA') AS carol \gset
RESET ROLE;
INSERT INTO ry_test.ids VALUES ('carol', :'carol');
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'carol');
INSERT INTO app.financial_records (user_id, category, label, amount, recorded_on) VALUES (:'carol', 'asset', 'Cash', 100, '2026-10-02');
INSERT INTO app.engine_execution_history (user_id, engine, function_name, executed, success, execution_id, engine_version) VALUES (:'carol', 'python', 'forecast', true, true, repeat('99',16), '0.1.0');
INSERT INTO app.ai_execution_logs (user_id, provider, model, status) VALUES (:'carol', 'p', 'm', 'ok');
COMMIT;
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('bob'));
SELECT ry_test.raises(format($$SELECT app.erase_user(%L)$$, :'carol'), '42501', 'erase: one person cannot erase another person''s account');
ROLLBACK;
SELECT ry_test.raises(format($$SELECT app.erase_user(%L)$$, :'carol'), '42501', 'erase: a request with nobody signed in cannot erase an account');
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'carol');
SELECT app.erase_user(:'carol') AS erased \gset
COMMIT;
SELECT ry_test.ok(:'erased' = 't' AND NOT EXISTS (SELECT 1 FROM app.users WHERE id = :'carol') AND NOT EXISTS (SELECT 1 FROM app.financial_records WHERE user_id = :'carol')
  AND NOT EXISTS (SELECT 1 FROM app.user_profiles WHERE user_id = :'carol') AND NOT EXISTS (SELECT 1 FROM app.user_activity WHERE user_id = :'carol'), 'erase: the account and all of its personal data are gone');
SELECT ry_test.ok(EXISTS (SELECT 1 FROM app.engine_execution_history WHERE execution_id = repeat('99',16) AND user_id IS NULL)
  AND EXISTS (SELECT 1 FROM app.ai_execution_logs l WHERE user_id IS NULL AND provider = 'p' AND model = 'm'), 'erase: operational logs stay, no longer linked to anyone');
SELECT ry_test.ok(EXISTS (SELECT 1 FROM app.audit_logs WHERE table_name = 'users' AND operation = 'DELETE' AND row_id = :'carol'), 'erase: the audit trail records that the account was deleted');

-- ===== retention
SET ROLE ry_owner;
SELECT ry_test.raises($$UPDATE app.retention_policies SET keep_for = interval '1 day' WHERE table_name = 'audit_logs'$$, '23514', 'retention: nothing may be kept for less than 7 days');
INSERT INTO app.engine_execution_history (engine, function_name, executed, success, execution_id, engine_version, started_at) VALUES ('rust', 'old_run', true, true, repeat('ab',16), '0.1.0', now() - interval '400 days');
INSERT INTO app.ai_execution_logs (provider, model, status, created_at) VALUES ('old', 'old', 'ok', now() - interval '100 days');
INSERT INTO app.user_activity (user_id, activity, occurred_at) VALUES (ry_test.id('bob'), 'login', now() - interval '400 days');
INSERT INTO app.user_sessions (user_id, token_hash, created_at, expires_at) VALUES (ry_test.id('bob'), decode(repeat('cd', 32), 'hex'), now() - interval '100 days', now() - interval '45 days');
INSERT INTO app.audit_logs (occurred_at, table_name, operation) VALUES (now() - interval '500 days', 'old_table', 'INSERT');
CREATE TEMP TABLE keep AS SELECT (SELECT count(*) FROM app.engine_execution_history) AS runs, (SELECT count(*) FROM app.audit_logs) AS audits;
SELECT ry_test.ok((SELECT bool_and(rows_affected >= 1) FROM app.run_retention() WHERE table_name IN ('engine_execution_history', 'ai_execution_logs', 'user_activity', 'user_sessions', 'audit_logs')), 'retention: a dry run counts what is due');
SELECT ry_test.ok((SELECT count(*) FROM app.engine_execution_history WHERE function_name = 'old_run') = 1, 'retention: a dry run deletes nothing');
SELECT ry_test.ok((SELECT sum(rows_affected) FROM app.run_retention(false)) >= 5, 'retention: the real run deletes the due rows');
SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM app.engine_execution_history WHERE function_name = 'old_run') AND NOT EXISTS (SELECT 1 FROM app.ai_execution_logs WHERE provider = 'old')
  AND NOT EXISTS (SELECT 1 FROM app.audit_logs WHERE table_name = 'old_table'), 'retention: old rows are gone, including old audit rows');
SELECT ry_test.ok((SELECT count(*) FROM app.engine_execution_history) = (SELECT runs - 1 FROM keep) AND (SELECT count(*) FROM app.audit_logs) = (SELECT audits - 1 FROM keep), 'retention: recent rows were not touched');
SELECT ry_test.ok((SELECT sum(rows_affected) FROM app.run_retention()) = 0, 'retention: a second run finds nothing due');
RESET ROLE;
SET ROLE ry_app;
SELECT ry_test.raises($$SELECT * FROM app.run_retention(false)$$, '42501', 'retention: the application cannot run it');
RESET ROLE;
