-- tests/_fixtures.sql  --  two people with data, created the way the app creates it: as ry_app, one transaction per request.
\set ON_ERROR_STOP on
\set QUIET on
SET ROLE ry_app;
SELECT app.register_user('alice@example.com', '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA') AS alice \gset
SELECT app.register_user('bob@example.com', '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHRzb21lc2FsdA$Ym9iYm9iYm9iYm9iYm9iYm9iYm9iYm9iYm9iYg') AS bob \gset
RESET ROLE;
INSERT INTO ry_test.ids VALUES ('alice', :'alice'), ('bob', :'bob');

-- ---- alice
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'alice');
UPDATE app.user_preferences SET save_chat_history = true WHERE user_id = :'alice';
UPDATE app.user_profiles SET display_name = 'Alice', risk_comfort = 'medium' WHERE user_id = :'alice';
INSERT INTO app.financial_records (user_id, category, label, amount, recorded_on) VALUES
  (:'alice', 'income',    'Salary',    100000.00, '2026-10-01'),
  (:'alice', 'asset',     'FD',        250000.00, '2026-10-01'),
  (:'alice', 'liability', 'Card',       20000.50, '2026-10-01');
INSERT INTO app.transactions (user_id, kind, category, amount, occurred_on, external_ref)
  SELECT :'alice', CASE WHEN g % 10 = 0 THEN 'income' ELSE 'expense' END, (ARRAY['food','rent','travel'])[1 + g % 3],
         CASE WHEN g % 10 = 0 THEN 50000 ELSE 100 + g END, DATE '2026-08-01' + (g * 3), 'ref-' || g
  FROM generate_series(1, 30) g;
INSERT INTO app.loan_records (user_id, label, loan_type, principal, annual_rate_percent, tenure_months, start_date, emi_amount)
  VALUES (:'alice', 'Home loan', 'home', 5000000, 8.5, 240, '2024-04-01', 43391);
INSERT INTO app.investment_records (user_id, label, instrument_type, amount_invested, invested_on, current_value, value_as_of)
  VALUES (:'alice', 'Index fund', 'mutual_fund', 120000, '2025-01-10', 138000, '2026-10-01');
INSERT INTO app.savings_records (user_id, goal_label, target_amount) VALUES (:'alice', 'Emergency fund', 100000);
SELECT app.add_savings_contribution(id, 2500.25, '2026-10-05') FROM app.savings_records WHERE user_id = :'alice';
SELECT app.add_savings_contribution(id, 1000.10, '2026-10-06') FROM app.savings_records WHERE user_id = :'alice';
COMMIT;

-- three calculations, each in its own transaction (so saved_at differs, which the comparison views order by)
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'alice');
WITH h AS (INSERT INTO app.calculator_history (user_id, kind, label, inputs, result, calc_version, saved_by_user)
  VALUES (:'alice', 'emi', 'Car loan 8%', '{"principal":800000,"rate":8,"months":60}', '{"emi":16221.52}', 'cpp-1.0', true) RETURNING id)
INSERT INTO app.emi_history SELECT id, 'emi', :'alice', 800000, 8, 60, 16221.52, 173291.20, 973291.20 FROM h;
INSERT INTO app.calculation_metadata (calc_id, user_id, engine, engine_version, execution_id, duration_ms)
  SELECT id, :'alice', 'cpp', '1.0.0', NULL, 0.4 FROM app.calculator_history WHERE label = 'Car loan 8%';
COMMIT;
SELECT pg_sleep(0.05);
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'alice');
WITH h AS (INSERT INTO app.calculator_history (user_id, kind, label, inputs, result, calc_version, saved_by_user)
  VALUES (:'alice', 'emi', 'Car loan 9%', '{"principal":800000,"rate":9,"months":60}', '{"emi":16606.12}', 'cpp-1.0', true) RETURNING id)
INSERT INTO app.emi_history SELECT id, 'emi', :'alice', 800000, 9, 60, 16606.12, 196367.20, 996367.20 FROM h;
COMMIT;
SELECT pg_sleep(0.05);
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'alice');
WITH h AS (INSERT INTO app.calculator_history (user_id, kind, label, inputs, result, calc_version, saved_by_user)
  VALUES (:'alice', 'sip', 'SIP 5000', '{"monthly":5000,"rate":12,"years":10}', '{"fv":1161695}', 'cpp-1.0', true) RETURNING id)
INSERT INTO app.sip_history SELECT id, 'sip', :'alice', 5000, 12, 10, 0, 600000, 1161695 FROM h;
COMMIT;

BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'alice');
INSERT INTO app.chat_sessions (user_id, title) VALUES (:'alice', 'Loan question');
INSERT INTO app.chat_messages (session_id, user_id, role, content)
  SELECT id, :'alice', r, c FROM app.chat_sessions, (VALUES ('user', 'EMI kitni aayegi?'), ('assistant', 'Aapki EMI 16,221.52 hai (C++ engine).')) v(r, c);
INSERT INTO app.chat_feedback (message_id, user_id, rating)
  SELECT id, :'alice', 1 FROM app.chat_messages WHERE role = 'assistant';
INSERT INTO app.engine_execution_history (user_id, engine, function_name, executed, success, execution_id, engine_version, duration_ms) VALUES
  (:'alice', 'python', 'forecast',      true, true,  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0.1.0', 12.5),
  (:'alice', 'rust',   'rolling_stats', true, true,  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '0.1.0', 0.8);
INSERT INTO app.ai_execution_logs (user_id, provider, model, status, input_tokens, output_tokens, duration_ms, engines_claimed, engines_verified)
  VALUES (:'alice', 'example', 'model-1', 'ok', 900, 250, 2100.5, '{python}', '{python,rust}');
COMMIT;

-- ---- bob (opted out of chat history, which is the default)
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'bob');
INSERT INTO app.financial_records (user_id, category, label, amount, recorded_on) VALUES (:'bob', 'asset', 'Savings', 5000, '2026-10-02');
INSERT INTO app.transactions (user_id, kind, category, amount, occurred_on) VALUES (:'bob', 'expense', 'food', 250, '2026-10-03');
INSERT INTO app.engine_execution_history (user_id, engine, function_name, executed, success, execution_id, engine_version, duration_ms)
  VALUES (:'bob', 'python', 'describe_series', true, true, 'cccccccccccccccccccccccccccccccc', '0.1.0', 3.1);
COMMIT;
\set QUIET off
