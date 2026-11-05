-- ai/chat_sessions.sql  (runs as ry_owner)
-- A saved conversation. Rows exist ONLY while the person's preference "save_chat_history" is on: the trigger below refuses the
-- insert otherwise, so a bug in the app cannot store chats for someone who did not opt in.

CREATE TABLE app.chat_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  title           app.short_text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);

CREATE FUNCTION app.require_chat_opt_in() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM user_preferences WHERE user_id = NEW.user_id AND save_chat_history) THEN
    RAISE EXCEPTION 'saving chat history is switched off for this account' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chat_sessions_opt_in BEFORE INSERT ON app.chat_sessions
  FOR EACH ROW EXECUTE FUNCTION app.require_chat_opt_in();
