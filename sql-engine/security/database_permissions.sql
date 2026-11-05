-- security/database_permissions.sql  (runs as ry_owner)
-- Least privilege. Nothing is granted to PUBLIC. ry_app gets exactly the commands (and, where it matters, the columns) the
-- product needs. Things ry_app can NOT do, by design:
--   read password_hash or a session token hash        (column grants; only find_login / resolve_session touch them)
--   insert a savings contribution or change saved_amount   (only app.add_savings_contribution)
--   edit a saved calculation, report, engine run or log    (history is never edited)
--   read or write audit_logs, or run retention
--   create, alter or drop anything

REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO ry_app, ry_readonly, ry_auditor;

-- ---- ry_app: accounts
GRANT SELECT (id, email, email_verified_at, auth_provider, status, created_at, updated_at) ON app.users TO ry_app;
GRANT SELECT, UPDATE (display_name, preferred_language, country, timezone, risk_comfort) ON app.user_profiles TO ry_app;
GRANT SELECT, UPDATE (default_currency, number_format, save_chat_history, marketing_opt_in) ON app.user_preferences TO ry_app;
GRANT SELECT (id, user_id, device_label, created_at, last_seen_at, expires_at, revoked_at) ON app.user_sessions TO ry_app;
GRANT INSERT (user_id, token_hash, device_label, expires_at) ON app.user_sessions TO ry_app;
GRANT UPDATE (revoked_at) ON app.user_sessions TO ry_app;
GRANT SELECT, INSERT (user_id, activity, metadata) ON app.user_activity TO ry_app;

-- ---- ry_app: the person's own financial data
GRANT SELECT, DELETE ON app.financial_records, app.transactions, app.loan_records, app.investment_records TO ry_app;
GRANT INSERT (user_id, category, label, amount, currency, recorded_on, note) ON app.financial_records TO ry_app;
GRANT UPDATE (category, label, amount, currency, recorded_on, note) ON app.financial_records TO ry_app;
GRANT INSERT (user_id, kind, category, amount, currency, occurred_on, note, source, external_ref) ON app.transactions TO ry_app;
GRANT UPDATE (kind, category, amount, currency, occurred_on, note) ON app.transactions TO ry_app;
GRANT INSERT (user_id, label, loan_type, lender_label, principal, annual_rate_percent, tenure_months, start_date, emi_amount) ON app.loan_records TO ry_app;
GRANT UPDATE (label, lender_label, principal, annual_rate_percent, tenure_months, start_date, emi_amount, status) ON app.loan_records TO ry_app;
GRANT INSERT (user_id, label, instrument_type, amount_invested, units, invested_on, current_value, value_as_of) ON app.investment_records TO ry_app;
GRANT UPDATE (label, instrument_type, amount_invested, units, invested_on, current_value, value_as_of) ON app.investment_records TO ry_app;
GRANT SELECT, DELETE ON app.savings_records TO ry_app;
GRANT INSERT (user_id, goal_label, target_amount, target_date) ON app.savings_records TO ry_app;
GRANT UPDATE (goal_label, target_amount, target_date, status) ON app.savings_records TO ry_app;
GRANT SELECT ON app.savings_contributions TO ry_app;
GRANT SELECT, DELETE ON app.financial_reports TO ry_app;
GRANT INSERT (user_id, report_type, title, period_start, period_end, payload, source_engine, engine_execution_id) ON app.financial_reports TO ry_app;

-- ---- ry_app: saved calculations (written only after the person pressed "save"; never edited)
GRANT SELECT, DELETE ON app.calculator_history, app.emi_history, app.sip_history, app.fd_history, app.tax_history, app.calculation_metadata TO ry_app;
GRANT INSERT (user_id, kind, label, inputs, result, calc_version, saved_by_user) ON app.calculator_history TO ry_app;
GRANT INSERT ON app.emi_history, app.sip_history, app.fd_history, app.tax_history, app.calculation_metadata TO ry_app;

-- ---- ry_app: AI chat
GRANT SELECT, DELETE ON app.chat_sessions, app.chat_messages, app.chat_feedback TO ry_app;
GRANT INSERT (user_id, title) ON app.chat_sessions TO ry_app;
GRANT INSERT (session_id, user_id, role, content) ON app.chat_messages TO ry_app;
GRANT INSERT (message_id, user_id, rating, reason, comment) ON app.chat_feedback TO ry_app;
GRANT UPDATE (rating, reason, comment) ON app.chat_feedback TO ry_app;
GRANT SELECT, INSERT ON app.engine_execution_history, app.ai_execution_logs TO ry_app;

-- ---- ry_app: the only functions it may call
GRANT EXECUTE ON FUNCTION app.current_user_id(), app.begin_request(uuid), app.register_user(text, text, text), app.find_login(text),
  app.resolve_session(bytea), app.erase_user(uuid), app.change_password(text), app.change_email(text),
  app.add_savings_contribution(uuid, numeric, date) TO ry_app;

-- ---- ry_auditor: the trail only
GRANT SELECT ON app.audit_logs TO ry_auditor;
