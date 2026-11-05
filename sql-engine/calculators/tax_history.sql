-- calculators/tax_history.sql  (runs as ry_owner)
-- Tax rules change every year, so no rate or slab is written in this database. The rules revision that produced the result
-- is kept in calculator_history.calc_version, and the numbers below are exactly what the calculator returned.

CREATE TABLE app.tax_history (
  calc_id        uuid PRIMARY KEY,
  kind           text NOT NULL DEFAULT 'tax' CHECK (kind = 'tax'),
  user_id        uuid NOT NULL,
  financial_year text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  regime         text NOT NULL CHECK (regime IN ('old', 'new')),
  gross_income   app.money NOT NULL,
  deductions     app.money NOT NULL DEFAULT 0,
  taxable_income app.money NOT NULL,
  tax_payable    app.money NOT NULL,
  FOREIGN KEY (calc_id, kind, user_id) REFERENCES app.calculator_history (id, kind, user_id) ON DELETE CASCADE,
  CONSTRAINT tax_taxable_not_above_gross CHECK (taxable_income <= gross_income),
  CONSTRAINT tax_payable_not_above_taxable CHECK (tax_payable <= taxable_income)
);
