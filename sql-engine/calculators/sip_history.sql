-- calculators/sip_history.sql  (runs as ry_owner)

CREATE TABLE app.sip_history (
  calc_id                 uuid PRIMARY KEY,
  kind                    text NOT NULL DEFAULT 'sip' CHECK (kind = 'sip'),
  user_id                 uuid NOT NULL,
  monthly_amount          app.money NOT NULL CHECK (monthly_amount > 0),
  expected_return_percent app.percent NOT NULL,
  years                   numeric(5,2) NOT NULL CHECK (years > 0 AND years <= 60),
  step_up_percent         app.percent NOT NULL DEFAULT 0,
  invested_total          app.money NOT NULL,
  future_value             app.money NOT NULL,
  FOREIGN KEY (calc_id, kind, user_id) REFERENCES app.calculator_history (id, kind, user_id) ON DELETE CASCADE,
  -- with a non-negative return the end value cannot be below what was put in (1.00 of rounding slack)
  CONSTRAINT sip_future_value_not_below_invested CHECK (future_value + 1 >= invested_total)
);
