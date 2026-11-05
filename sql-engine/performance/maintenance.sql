-- performance/maintenance.sql  (runs as ry_owner; part of the migration)
-- Routine care. PostgreSQL's autovacuum does the everyday work; this gives the operator the numbers to check it is keeping up.
--
-- Routine (run by the operator or a scheduled job on the database host, not from the web app):
--   weekly   : SELECT * FROM app.v_table_health;                    -- dead rows, last vacuum/analyze
--   weekly   : SELECT * FROM app.run_retention();                   -- dry run, then run_retention(false)
--   after a large import or purge : VACUUM (ANALYZE) app.<table>;   -- cannot run inside a function, so it is not automated here
--   monthly  : psql -f backups/integrity_checks.sql                 -- every line must show 0
--   monthly  : a restore drill (tests/backup_restore_test.sh is the same procedure)

CREATE VIEW app.v_table_health AS
SELECT relname AS table_name, n_live_tup AS live_rows, n_dead_tup AS dead_rows,
       round(100.0 * n_dead_tup / greatest(n_live_tup + n_dead_tup, 1), 1) AS dead_percent,
       greatest(last_vacuum, last_autovacuum) AS last_vacuum, greatest(last_analyze, last_autoanalyze) AS last_analyze,
       pg_size_pretty(pg_total_relation_size(relid)) AS total_size, pg_total_relation_size(relid) AS total_bytes
FROM pg_stat_user_tables WHERE schemaname = 'app';

-- Sessions are purged by app.run_retention (30 days after expiry). This one is for the person who wants every dead session
-- of their own gone right now.
CREATE FUNCTION app.delete_my_dead_sessions() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
DECLARE
  v_user uuid := app.current_user_id();
  v_n bigint;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no signed-in user in this request' USING ERRCODE = '42501';
  END IF;
  DELETE FROM user_sessions WHERE user_id = v_user AND (revoked_at IS NOT NULL OR expires_at <= now());
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;

GRANT SELECT ON app.v_table_health TO ry_auditor;
GRANT EXECUTE ON FUNCTION app.delete_my_dead_sessions() TO ry_app;
