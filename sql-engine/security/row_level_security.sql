-- security/row_level_security.sql  (runs as ry_owner)
-- Data isolation. Every table that holds a person's data is filtered to the signed-in user of the current transaction
-- (app.begin_request). The policies are the SECOND gate: database_permissions.sql decides which commands exist at all.
-- (SELECT app.current_user_id()) is written as a sub-select so PostgreSQL evaluates it once per statement, not once per row.
-- What this protects against: an application bug (a forgotten WHERE user_id = ...). What it cannot protect against: a stolen
-- ry_app password, because the app role itself chooses the user id. Keep that password secret and rotate it.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'user_profiles', 'user_preferences', 'user_sessions', 'user_activity',
    'financial_records', 'transactions', 'loan_records', 'investment_records', 'savings_records', 'savings_contributions', 'financial_reports',
    'calculator_history', 'emi_history', 'sip_history', 'fd_history', 'tax_history', 'calculation_metadata',
    'chat_sessions', 'chat_messages', 'chat_feedback'] LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY own_rows ON app.%I TO ry_app USING (user_id = (SELECT app.current_user_id())) WITH CHECK (user_id = (SELECT app.current_user_id()))', t);
  END LOOP;
END
$$;

-- users: one row, your own, read only (changes go through the functions in users/users.sql)
ALTER TABLE app.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_row ON app.users FOR SELECT TO ry_app USING (id = (SELECT app.current_user_id()));

-- operational logs: rows of the signed-in user, or anonymous rows (user_id NULL) that nobody can read back through the app
ALTER TABLE app.engine_execution_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_own ON app.engine_execution_history FOR SELECT TO ry_app USING (user_id = (SELECT app.current_user_id()));
CREATE POLICY write_own_or_anonymous ON app.engine_execution_history FOR INSERT TO ry_app
  WITH CHECK (user_id IS NULL OR user_id = (SELECT app.current_user_id()));
ALTER TABLE app.ai_execution_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_own ON app.ai_execution_logs FOR SELECT TO ry_app USING (user_id = (SELECT app.current_user_id()));
CREATE POLICY write_own_or_anonymous ON app.ai_execution_logs FOR INSERT TO ry_app
  WITH CHECK (user_id IS NULL OR user_id = (SELECT app.current_user_id()));
