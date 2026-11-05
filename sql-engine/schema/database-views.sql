-- schema/database-views.sql  (runs as ry_owner)
-- Two kinds of view.
--  v_my_*   security_invoker: they run with the CALLER's rights, so row-level security applies and each person sees only their
--           own numbers. Granted to ry_app.
--  v_*      aggregate views for operators (ry_readonly, ry_auditor). They contain no user id, no e-mail and no text a person wrote;
--           groups smaller than 5 people's worth of rows are left out where a small group could identify someone.
-- A view never calculates finance. Outstanding loan balance, interest and returns are the engines' job.

CREATE VIEW app.v_my_financial_summary WITH (security_invoker = true) AS
SELECT category, currency, count(*) AS records, sum(amount) AS total_amount, max(recorded_on) AS latest_record_on
FROM app.financial_records GROUP BY category, currency;

CREATE VIEW app.v_my_loans WITH (security_invoker = true) AS
SELECT id, label, loan_type, principal, annual_rate_percent, tenure_months, emi_amount, start_date, status,
       least(tenure_months, greatest(0, (extract(year FROM age(current_date, start_date)) * 12 + extract(month FROM age(current_date, start_date)))::int)) AS months_elapsed
FROM app.loan_records;

CREATE VIEW app.v_my_savings_progress WITH (security_invoker = true) AS
SELECT id, goal_label, target_amount, saved_amount, round(100 * saved_amount / target_amount, 2) AS percent_of_target, target_date, status
FROM app.savings_records;

-- Each saved EMI result next to the one saved before it: "what changed between my two calculations"
CREATE VIEW app.v_my_emi_comparison WITH (security_invoker = true) AS
SELECT h.id AS calc_id, h.saved_at, h.label, e.principal, e.annual_rate_percent, e.tenure_months, e.emi_amount,
       e.emi_amount - lag(e.emi_amount) OVER w AS emi_change_vs_previous,
       e.total_interest - lag(e.total_interest) OVER w AS interest_change_vs_previous,
       h.calc_version
FROM app.calculator_history h JOIN app.emi_history e ON e.calc_id = h.id
WINDOW w AS (PARTITION BY h.user_id ORDER BY h.saved_at, h.id);

CREATE VIEW app.v_my_sip_comparison WITH (security_invoker = true) AS
SELECT h.id AS calc_id, h.saved_at, h.label, s.monthly_amount, s.expected_return_percent, s.years, s.step_up_percent, s.invested_total, s.future_value,
       s.future_value - lag(s.future_value) OVER w AS future_value_change_vs_previous, h.calc_version
FROM app.calculator_history h JOIN app.sip_history s ON s.calc_id = h.id
WINDOW w AS (PARTITION BY h.user_id ORDER BY h.saved_at, h.id);

-- ---- operator views
CREATE VIEW app.v_engine_usage AS
SELECT engine, function_name, started_at::date AS day, count(*) AS runs,
       count(*) FILTER (WHERE executed) AS executed_runs, count(*) FILTER (WHERE success) AS successful_runs,
       round(avg(duration_ms) FILTER (WHERE executed), 3) AS avg_duration_ms,
       round((percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE executed))::numeric, 3) AS p95_duration_ms
FROM app.engine_execution_history WHERE started_at >= now() - interval '90 days'
GROUP BY engine, function_name, started_at::date;

CREATE VIEW app.v_engine_errors AS
SELECT engine, error_code, started_at::date AS day, count(*) AS runs, count(*) FILTER (WHERE executed) AS executed_runs
FROM app.engine_execution_history WHERE NOT success AND started_at >= now() - interval '90 days'
GROUP BY engine, error_code, started_at::date;

CREATE VIEW app.v_ai_usage AS
SELECT created_at::date AS day, provider, model, status, count(*) AS requests,
       sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, round(avg(duration_ms), 3) AS avg_duration_ms
FROM app.ai_execution_logs WHERE created_at >= now() - interval '90 days'
GROUP BY created_at::date, provider, model, status;

CREATE VIEW app.v_calculator_usage AS
SELECT date_trunc('month', saved_at)::date AS month, kind, count(*) AS saved_calculations
FROM app.calculator_history GROUP BY 1, 2 HAVING count(*) >= 5;

CREATE VIEW app.v_platform_totals AS
SELECT (SELECT count(*) FROM app.users) AS accounts,
       (SELECT count(*) FROM app.users WHERE status = 'active') AS active_accounts,
       (SELECT count(*) FROM app.calculator_history) AS saved_calculations,
       (SELECT count(*) FROM app.chat_sessions) AS saved_chats;

GRANT SELECT ON app.v_my_financial_summary, app.v_my_loans, app.v_my_savings_progress, app.v_my_emi_comparison, app.v_my_sip_comparison TO ry_app;
GRANT SELECT ON app.v_engine_usage, app.v_engine_errors, app.v_ai_usage, app.v_calculator_usage, app.v_platform_totals TO ry_readonly, ry_auditor;
