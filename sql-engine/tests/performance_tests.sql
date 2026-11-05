-- tests/performance_tests.sql  --  load the database with realistic volume, MEASURE the main queries, and decide from the numbers whether
-- partitioning or a materialized view is justified. Lines starting "bench" are the measurements (they differ per machine); the
-- limits below are deliberately generous (about ten times what a small server needs) so the test catches a lost index, not noise.
-- Volume: 2,000 people, 400,000 transactions, 1,000,000 engine runs.
\set ON_ERROR_STOP on
\timing off

SET ROLE ry_owner;
SELECT app.register_user('bench' || g || '@example.com', NULL, 'google') FROM generate_series(1, 2000) g;
INSERT INTO app.transactions (user_id, kind, category, amount, occurred_on)
  SELECT u.id, CASE WHEN g % 12 = 0 THEN 'income' ELSE 'expense' END, (ARRAY['food','rent','travel','fuel','bills'])[1 + g % 5],
         10 + (g * 37 % 5000), DATE '2024-01-01' + (g * 7 % 900)
  FROM (SELECT id FROM app.users WHERE email LIKE 'bench%@example.com') u, generate_series(1, 200) g;
INSERT INTO app.engine_execution_history (engine, function_name, executed, success, execution_id, engine_version, duration_ms, error_code, started_at, user_id)
  SELECT (ARRAY['python', 'rust', 'cpp', 'julia'])[1 + g % 4], (ARRAY['forecast', 'rolling_stats', 'emi', 'sip_monte_carlo'])[1 + g % 4], true, g % 20 <> 0,
         CASE WHEN g % 4 IN (0, 1) THEN md5(g::text) END, '0.1.0', (g % 500) / 10.0, CASE WHEN g % 20 = 0 THEN 'TIMEOUT' END,
         now() - interval '120 days' * (1 - g / 1000000.0),
         CASE WHEN g % 1000 = 0 THEN (SELECT id FROM app.users WHERE email = 'bench1@example.com') END
  FROM generate_series(1, 1000000) g;
INSERT INTO app.ai_execution_logs (provider, model, status, input_tokens, output_tokens, duration_ms, created_at)
  SELECT 'example', 'model-' || (g % 3), 'ok', 500 + g % 900, 100 + g % 300, 800 + g % 3000, now() - interval '100 days' * (1 - g / 200000.0) FROM generate_series(1, 200000) g;
ANALYZE app.transactions; ANALYZE app.engine_execution_history; ANALYZE app.ai_execution_logs; ANALYZE app.users;
RESET ROLE;
SELECT id AS bench FROM app.users WHERE email = 'bench1@example.com' \gset
SELECT ry_test.ok((SELECT count(*) FROM app.engine_execution_history) >= 1000000 AND (SELECT count(*) FROM app.transactions) >= 400000, 'load: 1,000,000 engine runs and 400,000 transactions are in place');

CREATE OR REPLACE FUNCTION ry_test.bench(p_name text, p_sql text, p_limit_ms numeric, p_index text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r record;
  best numeric := 1e12;
  p text;
BEGIN
  FOR i IN 1..3 LOOP                      -- best of 3: the first run warms the cache
    SELECT * INTO r FROM ry_test.timed(p_sql);
    best := least(best, r.ms);
    p := r.plan;
  END LOOP;
  RAISE NOTICE 'bench - % : % ms', p_name, best;
  IF best > p_limit_ms THEN
    RAISE EXCEPTION 'FAILED: % took % ms (limit % ms)', p_name, best, p_limit_ms;
  END IF;
  IF p_index IS NOT NULL AND p NOT LIKE '%' || p_index || '%' THEN
    RAISE EXCEPTION 'FAILED: % did not use index %', p_name, p_index;
  END IF;
  RAISE NOTICE 'ok - % (limit % ms%)', p_name, p_limit_ms, CASE WHEN p_index IS NULL THEN '' ELSE ', uses ' || p_index END;
END $$;

-- ===== one person's screens, as the application role, among 400,000 transactions
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'bench');
SELECT ry_test.bench('latest 20 transactions of one person', 'SELECT * FROM app.transactions WHERE user_id = app.current_user_id() ORDER BY occurred_on DESC LIMIT 20', 50, 'transactions_user_date');
SELECT ry_test.bench('monthly_cashflow for 3 years (200 rows)', $$SELECT * FROM app.monthly_cashflow('2024-01-01', '2027-01-01')$$, 100);
SELECT ry_test.bench('net_position', 'SELECT * FROM app.net_position()', 50);
SELECT ry_test.bench('one person''s own engine runs (partial index)', 'SELECT * FROM app.engine_execution_history WHERE user_id = app.current_user_id() ORDER BY started_at DESC LIMIT 20', 50, 'engine_runs_user_time');
SELECT ry_test.bench('count of this person''s transactions', 'SELECT count(*) FROM app.transactions', 100);
ROLLBACK;

-- row-level security costs next to nothing: the same query as the owner (no policy) and as the app (policy)
SELECT ms AS owner_ms FROM ry_test.timed(format($$SELECT * FROM app.transactions WHERE user_id = %L ORDER BY occurred_on DESC LIMIT 20$$, :'bench')) \gset
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'bench');
SELECT ms AS app_ms FROM ry_test.timed($$SELECT * FROM app.transactions WHERE user_id = app.current_user_id() ORDER BY occurred_on DESC LIMIT 20$$) \gset
ROLLBACK;
SELECT ry_test.ok(:app_ms < 20 + :owner_ms * 10, format('row-level security overhead is small (owner %s ms, app %s ms)', :'owner_ms', :'app_ms'));

-- ===== operator reports over 1,000,000 engine runs
SELECT ry_test.bench('v_engine_usage over 1,000,000 runs', 'SELECT * FROM app.v_engine_usage', 8000);
SELECT ry_test.bench('v_engine_errors over 1,000,000 runs', 'SELECT * FROM app.v_engine_errors', 8000);
SELECT ry_test.bench('v_ai_usage over 200,000 requests', 'SELECT * FROM app.v_ai_usage', 3000);
SELECT ry_test.bench('last day of engine runs (BRIN index on time)', $$SELECT count(*) FROM app.engine_execution_history WHERE started_at >= now() - interval '1 day'$$, 500, 'engine_runs_time_brin');
SELECT ry_test.bench('one engine and function, one week', $$SELECT count(*) FROM app.engine_execution_history WHERE engine = 'python' AND function_name = 'forecast' AND started_at >= now() - interval '7 days'$$, 500);
SELECT ry_test.bench('retention dry run over everything', 'SELECT * FROM app.run_retention()', 5000);

-- ===== writing
CREATE TEMP TABLE t0 AS SELECT clock_timestamp() AS t;
SET ROLE ry_app;
INSERT INTO app.ai_execution_logs (provider, model, status, input_tokens) SELECT 'w', 'm', 'ok', g FROM generate_series(1, 20000) g;
RESET ROLE;
SELECT round((extract(epoch FROM clock_timestamp() - t) * 1000)::numeric) AS write_ms FROM t0 \gset
SELECT ry_test.ok(:write_ms < 5000, format('bench - inserting 20,000 AI log rows as the app role: %s ms (limit 5000)', :'write_ms'));

-- deleting an account cascades through every table via the foreign-key indexes
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(:'bench');
CREATE TEMP TABLE t1 AS SELECT clock_timestamp() AS t;
SELECT app.erase_user(:'bench');
SELECT round((extract(epoch FROM clock_timestamp() - t) * 1000)::numeric) AS erase_ms FROM t1 \gset
ROLLBACK;
SELECT ry_test.ok(:erase_ms < 1000, format('bench - erasing an account with 200 transactions and 1000 engine runs: %s ms (limit 1000)', :'erase_ms'));

-- ===== are partitioning and a materialized view justified? Decided from the numbers above, written down here.
SELECT pg_total_relation_size('app.engine_execution_history') AS engine_bytes, pg_total_relation_size('app.transactions') AS tx_bytes \gset
SELECT ry_test.ok(:engine_bytes < 5::bigint * 1024 * 1024 * 1024 AND :tx_bytes < 5::bigint * 1024 * 1024 * 1024,
  format('partitioning is NOT justified: 1,000,000 engine runs take %s MB and retention keeps the log bounded (see performance/partitioning.sql)', round(:engine_bytes / 1048576.0)));
