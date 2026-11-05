-- performance/indexes.sql  (runs as ry_owner; part of the migration)
-- How to decide whether an index earns its place, from real usage. Read these after the service has run for a few weeks:
-- an index with idx_scan = 0 costs writes and disk and gives nothing back (but check it is not a foreign-key helper first).
-- No extra index is added here: the load tests (tests/performance_tests.sql) showed the main queries already use the indexes
-- in schema/database-indexes.sql.

CREATE VIEW app.v_index_usage AS
SELECT s.relname AS table_name, s.indexrelname AS index_name, s.idx_scan AS times_used,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size, i.indisunique AS is_unique, pg_relation_size(s.indexrelid) AS size_bytes
FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.schemaname = 'app';

-- Two indexes on the same columns: one of them is dead weight.
CREATE VIEW app.v_duplicate_indexes AS
SELECT a.indrelid::regclass::text AS table_name, a.indexrelid::regclass::text AS index_a, b.indexrelid::regclass::text AS index_b
FROM pg_index a JOIN pg_index b ON a.indrelid = b.indrelid AND a.indexrelid < b.indexrelid
 AND a.indkey = b.indkey AND a.indclass = b.indclass AND coalesce(a.indpred::text, '') = coalesce(b.indpred::text, '')
WHERE a.indrelid::regclass::text LIKE 'app.%';

GRANT SELECT ON app.v_index_usage, app.v_duplicate_indexes TO ry_auditor;
