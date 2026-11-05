-- performance/partitioning.sql  (NOT part of migration 0001 -- a measurement and a recipe, to be used only when the measurement says so)
--
-- DECISION (measured by tests/performance_tests.sql): NOT needed yet. 1,000,000 engine runs occupy well under a gigabyte, the main
-- queries touch them through indexes in under a millisecond, and app.run_retention() already keeps the log bounded (180 days).
-- Partitioning adds real cost (a changed primary key, a changed unique index, more moving parts), so it is justified only when:
--   * one table is above roughly 20 million rows or 10 GB, AND
--   * deleting old rows (retention) has become slow or is bloating the table, OR time-range queries scan far too much.
--
-- 1) The measurement (read-only; run it as ry_auditor or the administrator whenever you wish):
SELECT c.relname AS table_name, c.reltuples::bigint AS approx_rows, pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       (c.reltuples > 20000000 OR pg_total_relation_size(c.oid) > 10::bigint * 1024 * 1024 * 1024) AS partitioning_worth_considering
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'app' AND c.relkind = 'r' AND c.relname IN ('engine_execution_history', 'ai_execution_logs', 'audit_logs', 'transactions', 'user_activity')
ORDER BY pg_total_relation_size(c.oid) DESC;

-- 2) The recipe, for engine_execution_history, by month (practice on a COPY of the database first; it rewrites the table):
--    The table's primary key and its unique index must include the partition column, so they become (id, started_at) and
--    (engine, execution_id, started_at). That weakens "a run is recorded once" to "once per month" unless the application also
--    checks. This is the main reason not to do it early.
--
--   BEGIN;
--   ALTER TABLE app.engine_execution_history RENAME TO engine_execution_history_old;
--   CREATE TABLE app.engine_execution_history (LIKE app.engine_execution_history_old INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
--     PARTITION BY RANGE (started_at);
--   -- one partition per month, created ahead of time by a scheduled job:
--   CREATE TABLE app.engine_execution_history_2026_11 PARTITION OF app.engine_execution_history
--     FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
--   INSERT INTO app.engine_execution_history SELECT * FROM app.engine_execution_history_old;
--   -- re-create the foreign keys, the triggers (frozen), the policies, the grants and the indexes of the original table
--   COMMIT;
--
--   Retention then becomes DROP TABLE of a whole old month (instant, no bloat) instead of a large DELETE.
