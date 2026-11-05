-- ai/chat_feedback.sql  (runs as ry_owner)
-- A thumbs up/down on an ANSWER, once per person per answer. Feedback on the person's own words makes no sense and is refused.

CREATE TABLE app.chat_feedback (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id bigint NOT NULL,
  user_id    uuid NOT NULL,
  rating     smallint NOT NULL CHECK (rating IN (-1, 1)),
  reason     text CHECK (reason IN ('wrong_number', 'wrong_engine_label', 'unclear', 'unsafe', 'other')),
  comment    app.note_text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id),
  FOREIGN KEY (message_id, user_id) REFERENCES app.chat_messages (id, user_id) ON DELETE CASCADE
);

CREATE FUNCTION app.feedback_on_answers_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM chat_messages WHERE id = NEW.message_id AND role = 'assistant') THEN
    RAISE EXCEPTION 'feedback can only be given on an assistant answer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER chat_feedback_answers_only BEFORE INSERT ON app.chat_feedback
  FOR EACH ROW EXECUTE FUNCTION app.feedback_on_answers_only();
