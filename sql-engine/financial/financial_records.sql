-- financial/financial_records.sql  (runs as ry_owner)
-- Items the person types in about their own position: a salary, a rent, an asset, a liability.
-- Deliberately NOT stored anywhere in this database: account numbers, card numbers, PAN, Aadhaar, demat or folio numbers,
-- bank credentials. Labels are free text written by the person, so they must be kept clean of such numbers by the app.

CREATE TABLE app.financial_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  category    text NOT NULL CHECK (category IN ('income', 'expense', 'asset', 'liability')),
  label       app.short_text NOT NULL,
  amount      app.money NOT NULL,
  currency    app.currency NOT NULL DEFAULT 'INR',
  recorded_on date NOT NULL CHECK (recorded_on BETWEEN DATE '1950-01-01' AND DATE '2100-01-01'),
  note        app.note_text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER financial_records_touch BEFORE UPDATE ON app.financial_records
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
