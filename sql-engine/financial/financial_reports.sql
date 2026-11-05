-- financial/financial_reports.sql  (runs as ry_owner)
-- A report the person chose to keep: a frozen snapshot, never edited afterwards. source_engine and engine_execution_id say
-- which engine produced the numbers (NULL when the numbers were not computed by an engine). The link to the engine run is
-- added in schema/database-constraints.sql.

CREATE TABLE app.financial_reports (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  report_type         text NOT NULL CHECK (report_type IN ('net_worth', 'cashflow', 'loan_summary', 'investment_summary', 'custom')),
  title               app.short_text NOT NULL,
  period_start        date NOT NULL,
  period_end          date NOT NULL,
  payload             jsonb NOT NULL,
  source_engine       text CHECK (source_engine IN ('cpp', 'julia', 'python', 'rust')),
  engine_execution_id uuid,
  generated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_reports_period CHECK (period_end >= period_start),
  CONSTRAINT financial_reports_payload CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 1000000),
  CONSTRAINT financial_reports_engine_link CHECK (engine_execution_id IS NULL OR source_engine IS NOT NULL)
);
