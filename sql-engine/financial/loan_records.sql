-- financial/loan_records.sql  (runs as ry_owner)
-- The terms of a loan the person has. The outstanding balance and the interest paid are CALCULATIONS: they belong to the
-- calculation engines, not to a stored column that could drift out of date. No loan account number is stored.

CREATE TABLE app.loan_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  label               app.short_text NOT NULL,
  loan_type           text NOT NULL CHECK (loan_type IN ('home', 'personal', 'vehicle', 'education', 'credit_card', 'other')),
  lender_label        app.short_text,                       -- a name such as "HDFC", never an account number
  principal           app.money NOT NULL CHECK (principal > 0),
  annual_rate_percent app.percent NOT NULL,
  tenure_months       integer NOT NULL CHECK (tenure_months BETWEEN 1 AND 600),
  start_date          date NOT NULL CHECK (start_date BETWEEN DATE '1950-01-01' AND DATE '2100-01-01'),
  emi_amount          app.money CHECK (emi_amount > 0),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER loan_records_touch BEFORE UPDATE ON app.loan_records
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
