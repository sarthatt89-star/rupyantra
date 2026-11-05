-- users/user_sessions.sql  (runs as ry_owner)
-- Login sessions. The session token itself is NEVER stored: only its SHA-256 hash (32 bytes). A stolen copy of this table
-- therefore cannot be used to sign in. No IP address is stored.

CREATE TABLE app.user_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  device_label text CHECK (char_length(device_label) <= 80),     -- coarse, for example "Chrome on Android"
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  CONSTRAINT user_sessions_lifetime CHECK (expires_at > created_at AND expires_at <= created_at + interval '91 days')
);

-- Turns a token hash into a user id, or NULL when the session is unknown, revoked, expired, or the user is suspended.
-- last_seen_at is refreshed at most every 5 minutes so that reading a session does not write on every request.
CREATE FUNCTION app.resolve_session(p_token_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
DECLARE
  v_id uuid;
  v_user uuid;
  v_seen timestamptz;
BEGIN
  SELECT s.id, s.user_id, s.last_seen_at INTO v_id, v_user, v_seen
  FROM user_sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_seen < now() - interval '5 minutes' THEN
    UPDATE user_sessions SET last_seen_at = now() WHERE id = v_id;
  END IF;
  RETURN v_user;
END
$$;
