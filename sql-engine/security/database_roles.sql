-- security/database_roles.sql
-- Runs as the ADMIN who applies the migration (not as ry_owner).
--
-- Four group roles, none of which can log in. Real login users are created by the operator and made members
-- (see database-config.example); passwords are never written in these files.
--   ry_owner     owns every object; used only by migrations and maintenance, never by the running app
--   ry_app       what the API connects as: row-level security applies, least-privilege grants only
--   ry_readonly  reporting: aggregate views only, no table access
--   ry_auditor   reads the audit trail and the aggregate views, nothing else
--
-- Roles are CLUSTER-wide in PostgreSQL: they are shared by every database on the server.

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['ry_owner', 'ry_app', 'ry_readonly', 'ry_auditor'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
  END LOOP;
  -- the admin must be able to act as the owner (a superuser already can; this is for a non-superuser admin)
  IF NOT pg_has_role(current_user, 'ry_owner', 'MEMBER') THEN
    EXECUTE format('GRANT ry_owner TO %I', current_user);
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION ry_owner;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

-- Functions are executable by PUBLIC unless told otherwise. Make "no access unless granted" the default for
-- everything ry_owner creates from now on.
ALTER DEFAULT PRIVILEGES FOR ROLE ry_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
