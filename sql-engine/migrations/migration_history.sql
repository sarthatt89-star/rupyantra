-- migrations/migration_history.sql  (runs as ry_owner)
-- Which schema versions are in this database. apply.sh adds one row per applied migration inside the SAME transaction as
-- the migration itself, so a migration is either fully applied and recorded, or not applied at all.

CREATE TABLE app.schema_migrations (
  version       text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
  name          text NOT NULL CHECK (name ~ '^[a-z0-9_]+$'),
  checksum      text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),   -- sha256 of the files that made this version
  rollback_file text NOT NULL,                                       -- the undo script that belongs to this version
  applied_at    timestamptz NOT NULL DEFAULT now(),
  applied_by    text NOT NULL DEFAULT session_user
);

COMMENT ON TABLE app.schema_migrations IS 'One row per applied migration. Rows are never edited: a rollback removes the whole schema.';
