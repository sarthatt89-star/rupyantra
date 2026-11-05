-- schema/database-config.sql
-- Runs as the ADMIN. Safe to run again: re-run it after creating login users so they get their limits.

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
  -- a transaction left open by a crashed client must not hold locks forever
  EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout TO %L', current_database(), '60s');
END
$$;

-- ALTER ROLE ... SET is NOT inherited through group membership, so the limits are applied to each login user that is a
-- member of a group role.
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN
    SELECT member.rolname AS login_role, grp.rolname AS group_role
    FROM pg_auth_members am
    JOIN pg_roles grp ON grp.oid = am.roleid
    JOIN pg_roles member ON member.oid = am.member
    WHERE grp.rolname IN ('ry_app', 'ry_readonly', 'ry_auditor') AND member.rolcanlogin
  LOOP
    IF m.group_role = 'ry_app' THEN
      EXECUTE format('ALTER ROLE %I SET statement_timeout TO %L', m.login_role, '10s');
      EXECUTE format('ALTER ROLE %I SET lock_timeout TO %L', m.login_role, '5s');
      EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout TO %L', m.login_role, '15s');
    ELSE
      EXECUTE format('ALTER ROLE %I SET statement_timeout TO %L', m.login_role, '60s');
      EXECUTE format('ALTER ROLE %I SET default_transaction_read_only TO on', m.login_role);
    END IF;
  END LOOP;
END
$$;
