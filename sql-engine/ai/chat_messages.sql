-- ai/chat_messages.sql  (runs as ry_owner)
-- The text of saved conversations. The CHECK is a last line of defence, not a scanner: it refuses text that looks like an API
-- key, a bearer token or a private key. The app must still redact before saving; a refused insert tells it that it did not.

CREATE TABLE app.chat_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL,
  user_id    uuid NOT NULL,
  role       text NOT NULL CHECK (role IN ('user', 'assistant')),
  content    text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (session_id, user_id) REFERENCES app.chat_sessions (id, user_id) ON DELETE CASCADE,
  CONSTRAINT chat_messages_no_obvious_secrets CHECK (
    content !~ '(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[Bb]earer [A-Za-z0-9._~+/=-]{20,})')
);
CREATE TRIGGER chat_messages_opt_in BEFORE INSERT ON app.chat_messages
  FOR EACH ROW EXECUTE FUNCTION app.require_chat_opt_in();

CREATE FUNCTION app.bump_chat_session() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
BEGIN
  UPDATE chat_sessions SET last_message_at = NEW.created_at WHERE id = NEW.session_id;
  RETURN NEW;
END
$$;
CREATE TRIGGER chat_messages_bump AFTER INSERT ON app.chat_messages
  FOR EACH ROW EXECUTE FUNCTION app.bump_chat_session();
