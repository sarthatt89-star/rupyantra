-- tests/query_tests.sql  --  the reporting queries, views and functions give the RIGHT numbers (checked against hand-worked answers).
\set ON_ERROR_STOP on

-- ===== alice's fixtures: income 100000.00, asset 250000.00, liability 20000.50 (+ the rows added by earlier tests are not counted: filter by label)
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));

SELECT ry_test.ok((SELECT net FROM app.net_position() WHERE currency = 'INR') = 250000.00 - 20000.50,
  'net_position: assets 250000.00 minus liabilities 20000.50 = 229999.50 exactly');
SELECT ry_test.ok((SELECT total_amount FROM app.v_my_financial_summary WHERE category = 'asset' AND currency = 'INR') = 250000.00, 'v_my_financial_summary: asset total');

-- 30 fixture transactions: g = 1..30, every 10th is income 50000, the others are expenses of 100 + g
SELECT ry_test.ok((SELECT sum(total) FROM app.monthly_cashflow('2026-01-01', '2027-01-01') WHERE kind = 'income') = 150000.00
  AND (SELECT sum(entries) FROM app.monthly_cashflow('2026-01-01', '2027-01-01') WHERE kind = 'income') = 3,
  'monthly_cashflow: three income rows of 50000 add to 150000.00');
SELECT ry_test.ok((SELECT sum(total) FROM app.monthly_cashflow('2026-01-01', '2027-01-01') WHERE kind = 'expense')
  = (SELECT sum(100 + g) FROM generate_series(1, 30) g WHERE g % 10 <> 0), 'monthly_cashflow: the expenses add up to the hand-computed sum');
SELECT ry_test.ok((SELECT count(DISTINCT month) FROM app.monthly_cashflow('2026-01-01', '2027-01-01')) >= 3, 'monthly_cashflow: grouped by month');
SELECT ry_test.ok((SELECT count(*) FROM app.monthly_cashflow('2030-01-01', '2031-01-01')) = 0, 'monthly_cashflow: an empty period returns no rows');
SELECT ry_test.ok((SELECT sum(entries) FROM app.monthly_cashflow('2026-08-01', '2026-08-02')) IS NULL, 'monthly_cashflow: the end date is exclusive');

SELECT ry_test.ok((SELECT saved_amount FROM app.v_my_savings_progress WHERE goal_label = 'Emergency fund') = 3500.35
  AND (SELECT percent_of_target FROM app.v_my_savings_progress WHERE goal_label = 'Emergency fund') = 3.50, 'v_my_savings_progress: 3500.35 of 100000 is 3.50 percent');
SELECT ry_test.ok((SELECT emi_amount FROM app.v_my_loans WHERE label = 'Home loan') = 43391.00
  AND (SELECT months_elapsed FROM app.v_my_loans WHERE label = 'Home loan') BETWEEN 0 AND 240, 'v_my_loans: the loan terms and a sensible months_elapsed');

-- the comparison views: each saved result against the one before it
SELECT ry_test.ok((SELECT count(*) FROM app.v_my_emi_comparison) = 2
  AND (SELECT emi_change_vs_previous FROM app.v_my_emi_comparison WHERE label = 'Car loan 8%') IS NULL
  AND (SELECT emi_change_vs_previous FROM app.v_my_emi_comparison WHERE label = 'Car loan 9%') = 16606.12 - 16221.52
  AND (SELECT interest_change_vs_previous FROM app.v_my_emi_comparison WHERE label = 'Car loan 9%') = 196367.20 - 173291.20,
  'v_my_emi_comparison: the second EMI is compared with the first (+384.60 EMI), the first has nothing to compare with');
SELECT ry_test.ok((SELECT count(*) FROM app.v_my_sip_comparison) = 1 AND (SELECT future_value_change_vs_previous FROM app.v_my_sip_comparison) IS NULL, 'v_my_sip_comparison: a single SIP has no previous result');

-- the history screen
SELECT ry_test.ok((SELECT count(*) FROM app.recent_calculations('emi')) = 2 AND (SELECT label FROM app.recent_calculations('emi') LIMIT 1) = 'Car loan 9%',
  'recent_calculations: newest first, only the requested kind');
SELECT ry_test.ok((SELECT count(*) FROM app.recent_calculations('emi', 1)) = 1 AND (SELECT count(*) FROM app.recent_calculations('emi', 0)) = 1, 'recent_calculations: the limit is applied and never below 1');
SELECT ry_test.ok((SELECT result ->> 'emi' FROM app.recent_calculations('emi', 1)) = '16606.12', 'recent_calculations: the saved result comes back exactly as it was stored');
ROLLBACK;

-- ===== operator views (as the administrator; the data is the fixtures)
SELECT ry_test.ok((SELECT sum(runs) FROM app.v_engine_usage WHERE engine = 'python') >= 2, 'v_engine_usage: counts runs per engine');
SELECT ry_test.ok((SELECT sum(executed_runs) FROM app.v_engine_usage) <= (SELECT sum(runs) FROM app.v_engine_usage), 'v_engine_usage: executed runs never exceed runs');
SELECT ry_test.ok((SELECT sum(requests) FROM app.v_ai_usage WHERE provider = 'example') = 1 AND (SELECT sum(input_tokens) FROM app.v_ai_usage WHERE provider = 'example') = 900, 'v_ai_usage: tokens add up');
SELECT ry_test.ok((SELECT count(*) FROM app.v_calculator_usage) = 0, 'v_calculator_usage: a group of fewer than 5 saved calculations is not shown');
SELECT ry_test.ok((SELECT accounts FROM app.v_platform_totals) = (SELECT count(*) FROM app.users), 'v_platform_totals: accounts equals the number of users');

-- ===== the plans use the indexes (a real table size: 20000 rows for one person among 20000 others)
SET ROLE ry_owner;
SELECT app.register_user('bulk' || g || '@example.com', NULL, 'google') FROM generate_series(1, 200) g;
INSERT INTO app.transactions (user_id, kind, category, amount, occurred_on)
  SELECT u.id, 'expense', 'food', 10 + (g % 90), DATE '2025-01-01' + (g % 600)
  FROM (SELECT id FROM app.users WHERE email LIKE 'bulk%') u, generate_series(1, 200) g;
ANALYZE app.transactions;
RESET ROLE;
BEGIN;
SET LOCAL ROLE ry_app;
SELECT app.begin_request(ry_test.id('alice'));
SELECT ry_test.ok((SELECT plan FROM ry_test.timed($$SELECT * FROM app.transactions WHERE user_id = app.current_user_id() ORDER BY occurred_on DESC LIMIT 20$$)) LIKE '%transactions_user_date%',
  'plan: the "latest transactions" screen uses the (user_id, occurred_on) index, not a table scan');
ROLLBACK;
