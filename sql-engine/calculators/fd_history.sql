-- calculators/fd_history.sql  (runs as ry_owner)

CREATE TABLE app.fd_history (
  calc_id             uuid PRIMARY KEY,
  kind                text NOT NULL DEFAULT 'fd' CHECK (kind = 'fd'),
  user_id             uuid NOT NULL,
  principal           app.money NOT NULL CHECK (principal > 0),
  annual_rate_percent app.percent NOT NULL,
  tenure_months       integer NOT NULL CHECK (tenure_months BETWEEN 1 AND 600),
  compounding         text NOT NULL CHECK (compounding IN ('monthly', 'quarterly', 'half_yearly', 'yearly', 'at_maturity')),
  maturity_amount     app.money NOT NULL,
  interest_earned     app.money NOT NULL,
  FOREIGN KEY (calc_id, kind, user_id) REFERENCES app.calculator_history (id, kind, user_id) ON DELETE CASCADE,
  CONSTRAINT fd_maturity_not_below_principal CHECK (maturity_amount + 1 >= principal)
);
