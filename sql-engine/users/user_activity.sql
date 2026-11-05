-- users/user_activity.sql  (runs as ry_owner)
-- A short, append-only account history ("you changed your password on ..."). Fixed event names only: there is no free
-- text, so a request body or a secret cannot end up here by accident. Failed logins for unknown e-mails are not stored.

CREATE TABLE app.user_activity (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  activity    text NOT NULL CHECK (activity IN (
    'account_created', 'login', 'logout', 'login_failed', 'password_changed', 'email_changed',
    'profile_updated', 'preferences_updated', 'data_exported')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT user_activity_metadata_small CHECK (jsonb_typeof(metadata) = 'object' AND pg_column_size(metadata) <= 1000),
  CONSTRAINT user_activity_no_secrets CHECK (NOT (metadata ?| ARRAY['password', 'password_hash', 'token', 'api_key', 'secret', 'authorization']))
);
