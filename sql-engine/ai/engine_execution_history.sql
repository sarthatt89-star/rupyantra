-- ai/engine_execution_history.sql  (runs as ry_owner)
-- One row per engine run, copied from the engine's OWN execution record (never invented). The constraints make a false record
-- impossible to store: success needs executed; a failure needs an error code; Python and Rust must carry their 32-hex
-- execution_id. The C++ engine runs inside the JavaScript process and Julia does not report an id, so for those two the column
-- stays NULL. A run is recorded once: (engine, execution_id) is unique.

CREATE TABLE app.engine_execution_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid REFERENCES app.users (id) ON DELETE SET NULL,   -- erasing an account keeps the operational row, unlinked
  request_id     uuid,                                                -- correlates with ai_execution_logs.request_id
  engine         text NOT NULL CHECK (engine IN ('cpp', 'julia', 'python', 'rust')),
  function_name  text CHECK (function_name ~ '^[A-Za-z][A-Za-z0-9_]{0,79}$'),
  executed       boolean NOT NULL,
  success        boolean NOT NULL,
  execution_id   app.hex32,
  engine_version text CHECK (char_length(engine_version) BETWEEN 1 AND 64),
  duration_ms    numeric(12,3) CHECK (duration_ms >= 0),
  error_code     text CHECK (error_code ~ '^[A-Z][A-Z_]{1,39}$'),
  started_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engine_run_success_needs_executed CHECK (NOT success OR executed),
  CONSTRAINT engine_run_failure_has_code CHECK (success = (error_code IS NULL)),
  CONSTRAINT engine_run_has_evidence CHECK (execution_id IS NOT NULL OR engine IN ('cpp', 'julia')),
  CONSTRAINT engine_run_executed_has_version CHECK (NOT executed OR engine_version IS NOT NULL)
);
CREATE UNIQUE INDEX engine_run_recorded_once ON app.engine_execution_history (engine, execution_id) WHERE execution_id IS NOT NULL;
