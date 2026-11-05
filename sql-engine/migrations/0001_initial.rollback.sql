-- migrations/0001_initial.rollback.sql  (runs as the ADMIN)
-- Undoes migration 0001 completely: DELETES EVERY TABLE AND ALL DATA in schema "app". There is no partial undo for a first
-- migration. apply.sh refuses to run this unless RY_CONFIRM_ROLLBACK is set to the exact name of the database.
-- Roles (ry_owner, ry_app, ry_readonly, ry_auditor) are shared by the whole server and are NOT dropped here; drop them by hand
-- only when no other database uses them:  DROP OWNED BY ry_app; DROP ROLE ry_app;  (and the same for the others).

DROP SCHEMA IF EXISTS app CASCADE;

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I RESET timezone', current_database());
  EXECUTE format('ALTER DATABASE %I RESET idle_in_transaction_session_timeout', current_database());
END
$$;
