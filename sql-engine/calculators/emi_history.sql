-- calculators/emi_history.sql  (runs as ry_owner)
-- The headline numbers of a saved EMI calculation as real columns, so saved results can be compared and sorted in SQL.

CREATE TABLE app.emi_history (
  calc_id             uuid PRIMARY KEY,
  kind                text NOT NULL DEFAULT 'emi' CHECK (kind = 'emi'),
  user_id             uuid NOT NULL,
  principal           app.money NOT NULL CHECK (principal > 0),
  annual_rate_percent app.percent NOT NULL,
  tenure_months       integer NOT NULL CHECK (tenure_months BETWEEN 1 AND 600),
  emi_amount          app.money NOT NULL,
  total_interest      app.money NOT NULL,
  total_payment       app.money NOT NULL,
  FOREIGN KEY (calc_id, kind, user_id) REFERENCES app.calculator_history (id, kind, user_id) ON DELETE CASCADE
);
