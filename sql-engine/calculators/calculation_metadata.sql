-- calculators/calculation_metadata.sql  (runs as ry_owner)
-- Which engine produced a saved result, and the evidence it gave. Only what the engine itself reported is recorded; where
-- an engine reports no value (for example the in-process C++ engine has no execution id) the column stays NULL, it is
-- never filled in. The link to the engine-run record is added in schema/database-constraints.sql.

CREATE TABLE app.calculation_metadata (
  calc_id             uuid PRIMARY KEY REFERENCES app.calculator_history (id) ON DELETE CASCADE,
  user_id             uuid NOT NULL,
  engine              text NOT NULL CHECK (engine IN ('cpp', 'julia', 'python', 'rust')),
  engine_version      text NOT NULL CHECK (char_length(engine_version) BETWEEN 1 AND 64),
  execution_id        app.hex32,
  engine_execution_id uuid,
  duration_ms         numeric(12,3) CHECK (duration_ms >= 0),
  rules_version       text CHECK (char_length(rules_version) <= 64),
  computed_at         timestamptz NOT NULL DEFAULT now()
);
