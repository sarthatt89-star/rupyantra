-- security/retention_policies.sql  (runs as ry_owner)
-- How long operational data is kept. Nothing runs by itself: an operator (or a scheduled job on the host) calls
--   SELECT * FROM app.run_retention();        -- dry run: only counts
--   SELECT * FROM app.run_retention(false);   -- deletes
-- as ry_owner. A person's own saved data (records, calculations) is NOT in this list: it stays until they delete it.

CREATE TABLE app.retention_policies (
  table_name text PRIMARY KEY CHECK (table_name IN
    ('audit_logs', 'ai_execution_logs', 'engine_execution_history', 'user_activity', 'user_sessions', 'chat_sessions')),
  keep_for   interval NOT NULL CHECK (keep_for >= interval '7 days'),
  measured_from text NOT NULL
);
INSERT INTO app.retention_policies (table_name, keep_for, measured_from) VALUES
  ('audit_logs',               interval '400 days', 'occurred_at'),
  ('ai_execution_logs',        interval '90 days',  'created_at'),
  ('engine_execution_history', interval '180 days', 'started_at'),
  ('user_activity',            interval '365 days', 'occurred_at'),
  ('user_sessions',            interval '30 days',  'expires_at, or revoked_at if earlier'),
  ('chat_sessions',            interval '365 days', 'last_message_at');

CREATE FUNCTION app.run_retention(p_dry_run boolean DEFAULT true) RETURNS TABLE (table_name text, rows_affected bigint)
LANGUAGE plpgsql SET search_path = app, pg_catalog
AS $$
DECLARE
  p record;
  v_cut timestamptz;
  v_n bigint;
BEGIN
  FOR p IN SELECT * FROM retention_policies ORDER BY retention_policies.table_name LOOP
    v_cut := now() - p.keep_for;
    -- one fixed statement per table: no table or column name is ever built from data
    IF p.table_name = 'audit_logs' THEN
      IF p_dry_run THEN
        SELECT count(*) INTO v_n FROM audit_logs WHERE occurred_at < v_cut;
      ELSE
        PERFORM set_config('app.retention_purge', 'on', true);
        DELETE FROM audit_logs WHERE occurred_at < v_cut;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        PERFORM set_config('app.retention_purge', 'off', true);
      END IF;
    ELSIF p.table_name = 'ai_execution_logs' THEN
      IF p_dry_run THEN SELECT count(*) INTO v_n FROM ai_execution_logs WHERE created_at < v_cut;
      ELSE DELETE FROM ai_execution_logs WHERE created_at < v_cut; GET DIAGNOSTICS v_n = ROW_COUNT; END IF;
    ELSIF p.table_name = 'engine_execution_history' THEN
      IF p_dry_run THEN SELECT count(*) INTO v_n FROM engine_execution_history WHERE started_at < v_cut;
      ELSE DELETE FROM engine_execution_history WHERE started_at < v_cut; GET DIAGNOSTICS v_n = ROW_COUNT; END IF;
    ELSIF p.table_name = 'user_activity' THEN
      IF p_dry_run THEN SELECT count(*) INTO v_n FROM user_activity WHERE occurred_at < v_cut;
      ELSE DELETE FROM user_activity WHERE occurred_at < v_cut; GET DIAGNOSTICS v_n = ROW_COUNT; END IF;
    ELSIF p.table_name = 'user_sessions' THEN
      IF p_dry_run THEN SELECT count(*) INTO v_n FROM user_sessions WHERE least(expires_at, coalesce(revoked_at, expires_at)) < v_cut;
      ELSE DELETE FROM user_sessions WHERE least(expires_at, coalesce(revoked_at, expires_at)) < v_cut; GET DIAGNOSTICS v_n = ROW_COUNT; END IF;
    ELSE
      IF p_dry_run THEN SELECT count(*) INTO v_n FROM chat_sessions WHERE last_message_at < v_cut;
      ELSE DELETE FROM chat_sessions WHERE last_message_at < v_cut; GET DIAGNOSTICS v_n = ROW_COUNT; END IF;
    END IF;
    table_name := p.table_name;
    rows_affected := v_n;
    RETURN NEXT;
  END LOOP;
END
$$;
