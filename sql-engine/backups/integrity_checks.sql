-- backups/integrity_checks.sql
-- Run this by hand after a restore, after a migration, and once a month:   psql "$RY_ADMIN_URL" -X -f backups/integrity_checks.sql
-- It changes nothing. Every line must show violations = 0. It needs no installation (it reads the tables and the catalog), so it also
-- works on a database that was just restored. Run it as the administrator or ry_owner (row-level security must not hide rows from it).

SELECT check_name, violations, CASE WHEN violations = 0 THEN 'ok' ELSE 'PROBLEM' END AS verdict
FROM (
  SELECT 'savings: saved_amount differs from the sum of contributions' AS check_name, count(*) AS violations
  FROM app.savings_records s
  WHERE s.saved_amount <> coalesce((SELECT sum(c.amount) FROM app.savings_contributions c WHERE c.savings_id = s.id), 0)

  UNION ALL SELECT 'savings: a contribution belongs to a different person than its goal', count(*)
  FROM app.savings_contributions c JOIN app.savings_records s ON s.id = c.savings_id WHERE s.user_id <> c.user_id

  UNION ALL SELECT 'savings: a goal marked achieved has not reached its target', count(*)
  FROM app.savings_records WHERE status = 'achieved' AND saved_amount < target_amount

  UNION ALL SELECT 'calculations: a saved calculation has no typed detail row', count(*)
  FROM app.calculator_history h
  WHERE NOT EXISTS (SELECT 1 FROM app.emi_history e WHERE e.calc_id = h.id) AND NOT EXISTS (SELECT 1 FROM app.sip_history s WHERE s.calc_id = h.id)
    AND NOT EXISTS (SELECT 1 FROM app.fd_history f WHERE f.calc_id = h.id) AND NOT EXISTS (SELECT 1 FROM app.tax_history t WHERE t.calc_id = h.id)

  UNION ALL SELECT 'calculations: a saved calculation that was not explicitly saved by the person', count(*)
  FROM app.calculator_history WHERE saved_by_user IS NOT TRUE

  UNION ALL SELECT 'engine runs: a record that contradicts itself (success without execution, failure without a code, no evidence)', count(*)
  FROM app.engine_execution_history
  WHERE (success AND NOT executed) OR (success <> (error_code IS NULL)) OR (execution_id IS NULL AND engine NOT IN ('cpp', 'julia')) OR (executed AND engine_version IS NULL)

  UNION ALL SELECT 'AI log: an engine is claimed without evidence', count(*)
  FROM app.ai_execution_logs WHERE NOT (engines_claimed <@ engines_verified)

  UNION ALL SELECT 'accounts: a password that is not a hash', count(*)
  FROM app.users WHERE password_hash IS NOT NULL AND password_hash !~ '^\$(argon2id|argon2i|2[aby]|scrypt|pbkdf2[a-z0-9-]*)\$.{20,}$'

  UNION ALL SELECT 'accounts: an e-mail that is not trimmed and lower-case', count(*)
  FROM app.users WHERE email <> lower(btrim(email))

  UNION ALL SELECT 'accounts: a person without a profile or without preferences', count(*)
  FROM app.users u WHERE NOT EXISTS (SELECT 1 FROM app.user_profiles p WHERE p.user_id = u.id) OR NOT EXISTS (SELECT 1 FROM app.user_preferences p WHERE p.user_id = u.id)

  UNION ALL SELECT 'sessions: a live session of a suspended account', count(*)
  FROM app.user_sessions s JOIN app.users u ON u.id = s.user_id WHERE u.status = 'suspended' AND s.revoked_at IS NULL AND s.expires_at > now()

  UNION ALL SELECT 'structure: a table that holds personal data has row-level security off', count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relkind = 'r' AND NOT c.relrowsecurity AND c.relname NOT IN ('audit_logs', 'retention_policies', 'schema_migrations')

  UNION ALL SELECT 'structure: something in schema app is readable by PUBLIC', count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND c.relkind IN ('r', 'v', 'm') AND has_table_privilege('public', c.oid, 'SELECT')

  UNION ALL SELECT 'structure: a SECURITY DEFINER function without a pinned search_path', count(*)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'app' AND p.prosecdef AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) x WHERE x LIKE 'search_path=%')

  UNION ALL SELECT 'structure: a constraint that is not validated', count(*)
  FROM pg_constraint WHERE connamespace = 'app'::regnamespace AND NOT convalidated

  UNION ALL SELECT 'structure: an invalid index (a failed CREATE INDEX CONCURRENTLY)', count(*)
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'app' AND NOT i.indisvalid

  UNION ALL SELECT 'structure: a trigger that is switched off', count(*)
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'app' AND NOT t.tgisinternal AND t.tgenabled <> 'O'

  UNION ALL SELECT 'migrations: no migration is recorded', CASE WHEN count(*) = 0 THEN 1 ELSE 0 END
  FROM app.schema_migrations
) checks
ORDER BY check_name;
