-- calculators/calculator_history.sql  (runs as ry_owner)
-- A calculation is stored ONLY when the person pressed "save". saved_by_user has no default on purpose: every insert has
-- to say it explicitly, and a row where it is not true is refused. Inputs and results are kept exactly as they were
-- shown, together with the version that produced them, so an old result is never silently recomputed under new rules.

CREATE TABLE app.calculator_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('emi', 'sip', 'fd', 'tax')),
  label         app.short_text,
  inputs        jsonb NOT NULL,
  result        jsonb NOT NULL,
  calc_version  text NOT NULL CHECK (char_length(calc_version) BETWEEN 1 AND 64),
  saved_by_user boolean NOT NULL,
  saved_at      timestamptz NOT NULL DEFAULT now(),
  -- the typed detail tables point at (id, kind, user_id) so a detail row can never belong to another kind or another user
  UNIQUE (id, kind, user_id),
  CONSTRAINT calculator_saved_explicitly CHECK (saved_by_user IS TRUE),
  CONSTRAINT calculator_inputs_object CHECK (jsonb_typeof(inputs) = 'object' AND pg_column_size(inputs) <= 20000),
  CONSTRAINT calculator_result_object CHECK (jsonb_typeof(result) = 'object' AND pg_column_size(result) <= 100000)
);
