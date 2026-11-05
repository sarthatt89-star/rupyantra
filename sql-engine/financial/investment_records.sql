-- financial/investment_records.sql  (runs as ry_owner)
-- What the person says they invested and, optionally, what it is worth on a stated date. A current value always travels
-- with the date it was true on, so an old number cannot pass for today's. No folio, demat or policy numbers.

CREATE TABLE app.investment_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  label           app.short_text NOT NULL,
  instrument_type text NOT NULL CHECK (instrument_type IN
    ('mutual_fund', 'stock', 'fd', 'ppf', 'nps', 'gold', 'bond', 'crypto', 'real_estate', 'other')),
  amount_invested app.money NOT NULL CHECK (amount_invested > 0),
  units           numeric(24,8) CHECK (units > 0),
  invested_on     date NOT NULL CHECK (invested_on BETWEEN DATE '1950-01-01' AND DATE '2100-01-01'),
  current_value   app.money,
  value_as_of     date CHECK (value_as_of BETWEEN DATE '1950-01-01' AND DATE '2100-01-01'),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT investment_value_has_a_date CHECK ((current_value IS NULL) = (value_as_of IS NULL)),
  CONSTRAINT investment_value_not_before_purchase CHECK (value_as_of IS NULL OR value_as_of >= invested_on)
);
CREATE TRIGGER investment_records_touch BEFORE UPDATE ON app.investment_records
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
