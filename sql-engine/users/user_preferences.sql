-- users/user_preferences.sql  (runs as ry_owner)
-- Everything that stores more than the minimum is OFF until the person turns it on.

CREATE TABLE app.user_preferences (
  user_id           uuid PRIMARY KEY REFERENCES app.users (id) ON DELETE CASCADE,
  default_currency  app.currency NOT NULL DEFAULT 'INR',
  number_format     text NOT NULL DEFAULT 'indian' CHECK (number_format IN ('indian', 'international')),
  save_chat_history boolean NOT NULL DEFAULT false,   -- chat messages are stored only while this is true
  marketing_opt_in  boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_preferences_touch BEFORE UPDATE ON app.user_preferences
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
