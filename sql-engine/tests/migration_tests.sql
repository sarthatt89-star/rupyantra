-- tests/migration_tests.sql  --  what the migration record must look like. tests/migration_cycle_test.sh runs this at each stage:
--   psql -v stage=after_apply -f migration_tests.sql     /     psql -v stage=after_rollback -f migration_tests.sql
\set ON_ERROR_STOP on
SELECT :'stage' = 'after_apply' AS applied \gset
\if :applied
  SELECT ry_test.ok((SELECT count(*) FROM app.schema_migrations) = 1, 'exactly one migration is recorded');
  SELECT ry_test.ok((SELECT version || '/' || name FROM app.schema_migrations) = '0001/initial', 'it is version 0001, named initial');
  SELECT ry_test.ok((SELECT checksum FROM app.schema_migrations) ~ '^[0-9a-f]{64}$', 'its checksum is a sha256');
  SELECT ry_test.ok((SELECT rollback_file FROM app.schema_migrations) = 'migrations/0001_initial.rollback.sql', 'it names its rollback script');
  SELECT ry_test.ok((SELECT applied_at FROM app.schema_migrations) <= now() AND (SELECT applied_by FROM app.schema_migrations) <> '', 'it records when and by whom');
  SELECT ry_test.ok((SELECT count(*) FROM pg_tables WHERE schemaname = 'app') = 26, 'the migration created exactly 26 tables');
  SELECT ry_test.ok((SELECT count(*) FROM app.retention_policies) = 6, 'retention policies were seeded (6)');
  SELECT ry_test.ok(current_setting('server_version_num')::int >= 150000, 'the server is PostgreSQL 15 or newer');
\else
  SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'app'), 'after rollback the schema app is gone, with every table, view and function in it');
  SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app'), 'after rollback no object is left behind');
  SELECT ry_test.ok(NOT EXISTS (SELECT 1 FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = current_database() AND s.setconfig::text ~ 'timezone|idle_in_transaction'), 'after rollback the database settings are back to default');
  SELECT ry_test.ok(EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ry_app'), 'the shared roles are intentionally kept (they belong to the whole server)');
\endif
