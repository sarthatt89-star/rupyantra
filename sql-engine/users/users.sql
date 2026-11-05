-- users/users.sql  (runs as ry_owner)
-- One row per account. A plaintext password can never be stored: the column accepts only the text format produced by
-- a password hash (argon2 / bcrypt / scrypt / pbkdf2). Hashing happens in the application, never in SQL logs.

CREATE TABLE app.users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  email_verified_at timestamptz,
  auth_provider     text NOT NULL DEFAULT 'password',
  password_hash     text,
  status            text NOT NULL DEFAULT 'active',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_format CHECK (
    email = lower(email) AND email = btrim(email)
    AND char_length(email) BETWEEN 3 AND 254 AND email ~ '^[^@\s]+@[^@\s]+$'),
  CONSTRAINT users_provider_known CHECK (auth_provider IN ('password', 'google', 'other')),
  CONSTRAINT users_status_known CHECK (status IN ('active', 'suspended')),
  CONSTRAINT users_password_is_a_hash CHECK (
    password_hash IS NULL OR password_hash ~ '^\$(argon2id|argon2i|2[aby]|scrypt|pbkdf2[a-z0-9-]*)\$.{20,}$'),
  CONSTRAINT users_password_required CHECK (auth_provider <> 'password' OR password_hash IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_key ON app.users (email);

CREATE FUNCTION app.normalize_email() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  RETURN NEW;
END
$$;
CREATE TRIGGER users_normalize_email BEFORE INSERT OR UPDATE OF email ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.normalize_email();
CREATE TRIGGER users_touch BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Sign-up: the account, its profile, its preferences and the first activity row are created together or not at all.
CREATE FUNCTION app.register_user(p_email text, p_password_hash text DEFAULT NULL, p_provider text DEFAULT 'password')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO users (email, password_hash, auth_provider) VALUES (p_email, p_password_hash, p_provider) RETURNING id INTO v_id;
  INSERT INTO user_profiles (user_id) VALUES (v_id);
  INSERT INTO user_preferences (user_id) VALUES (v_id);
  INSERT INTO user_activity (user_id, activity) VALUES (v_id, 'account_created');
  RETURN v_id;
END
$$;

-- Login lookup: the only way the app can read a password hash, and only for one e-mail address at a time.
CREATE FUNCTION app.find_login(p_email text)
RETURNS TABLE (id uuid, password_hash text, auth_provider text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
  SELECT u.id, u.password_hash, u.auth_provider, u.status FROM users u WHERE u.email = lower(btrim(p_email))
$$;

-- Right to erasure: removes the account and everything that belongs to it. Operational logs keep their rows without the
-- user link (see ai/). Only the signed-in user can erase their own account.
CREATE FUNCTION app.erase_user(p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'an account can only be erased by its own signed-in user' USING ERRCODE = '42501';
  END IF;
  DELETE FROM users WHERE id = p_user;
  RETURN FOUND;
END
$$;

-- Password change: only the signed-in user, only for a password account. Every other session is signed out.
CREATE FUNCTION app.change_password(p_password_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
DECLARE
  v_user uuid := app.current_user_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no signed-in user in this request' USING ERRCODE = '42501';
  END IF;
  UPDATE users SET password_hash = p_password_hash WHERE id = v_user AND auth_provider = 'password';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this account does not use a password' USING ERRCODE = 'P0002';
  END IF;
  UPDATE user_sessions SET revoked_at = now() WHERE user_id = v_user AND revoked_at IS NULL;
  INSERT INTO user_activity (user_id, activity) VALUES (v_user, 'password_changed');
END
$$;

-- E-mail change: the new address starts unverified. A duplicate address raises 23505: the app must not tell the caller
-- whether the address is already registered.
CREATE FUNCTION app.change_email(p_email text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
DECLARE
  v_user uuid := app.current_user_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no signed-in user in this request' USING ERRCODE = '42501';
  END IF;
  UPDATE users SET email = p_email, email_verified_at = NULL WHERE id = v_user;
  INSERT INTO user_activity (user_id, activity) VALUES (v_user, 'email_changed');
END
$$;
