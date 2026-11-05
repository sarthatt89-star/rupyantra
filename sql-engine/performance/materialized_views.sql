-- performance/materialized_views.sql  (NOT part of migration 0001 -- apply by hand as ry_owner only when the numbers say so)
--
-- DECISION (measured by tests/performance_tests.sql): NOT needed yet. app.v_engine_usage reads 1,000,000 engine runs in about 1.2 seconds
-- on a 2-CPU test machine, and it is an operator report read now and then, not a page every visitor opens. A stored copy would
-- be faster to read but can be out of date, so it earns its place only when ONE of these is true:
--   * app.v_engine_usage takes more than 5 seconds on the real server (measure: EXPLAIN ANALYZE SELECT * FROM app.v_engine_usage;)
--   * it is read more than about once a minute (for example a public status page)
--
-- When that day comes, run this file as ry_owner, then refresh it on a schedule (cron on the database host, or the host's job runner):
--     REFRESH MATERIALIZED VIEW CONCURRENTLY app.mv_engine_usage_daily;
-- The data is "as of the last refresh": show the refreshed_at column wherever the numbers are shown.

CREATE MATERIALIZED VIEW app.mv_engine_usage_daily AS
SELECT engine, coalesce(function_name, '') AS function_name, started_at::date AS day,
       count(*) AS runs, count(*) FILTER (WHERE executed) AS executed_runs, count(*) FILTER (WHERE success) AS successful_runs,
       round(avg(duration_ms) FILTER (WHERE executed), 3) AS avg_duration_ms, now() AS refreshed_at
FROM app.engine_execution_history
GROUP BY engine, coalesce(function_name, ''), started_at::date
WITH DATA;

-- REFRESH ... CONCURRENTLY (readers are not blocked) needs a unique index over plain columns
CREATE UNIQUE INDEX mv_engine_usage_daily_key ON app.mv_engine_usage_daily (engine, function_name, day);
GRANT SELECT ON app.mv_engine_usage_daily TO ry_readonly, ry_auditor;
