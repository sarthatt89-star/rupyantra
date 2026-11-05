-- users/user_profiles.sql  (runs as ry_owner)
-- Only what the product needs to speak to the person. No phone, address, PAN, Aadhaar or date of birth.

CREATE TABLE app.user_profiles (
  user_id            uuid PRIMARY KEY REFERENCES app.users (id) ON DELETE CASCADE,
  display_name       app.short_text,
  preferred_language text NOT NULL DEFAULT 'hinglish' CHECK (preferred_language IN ('en', 'hi', 'hinglish')),
  country            char(2) NOT NULL DEFAULT 'IN' CHECK (country ~ '^[A-Z]{2}$'),
  timezone           text NOT NULL DEFAULT 'Asia/Kolkata' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  risk_comfort       text CHECK (risk_comfort IN ('low', 'medium', 'high')),   -- the person's own words about themselves
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_profiles_touch BEFORE UPDATE ON app.user_profiles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
