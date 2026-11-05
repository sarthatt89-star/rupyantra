-- ai/ai_execution_logs.sql  (runs as ry_owner)
-- Metadata of each request to the AI provider: which model, how long, how many tokens, what happened. NO prompt, NO answer, NO
-- key, NO IP address. engines_claimed is what the answer SAID was used; engines_verified is what had execution evidence. The
-- constraint makes it impossible to store an answer that claimed an engine without evidence.

CREATE TABLE app.ai_execution_logs (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          uuid REFERENCES app.users (id) ON DELETE SET NULL,
  request_id       uuid,
  provider         text NOT NULL CHECK (provider ~ '^[a-z0-9_-]{1,40}$'),
  model            text NOT NULL CHECK (model ~ '^[A-Za-z0-9._:/-]{1,80}$'),
  status           text NOT NULL CHECK (status IN ('ok', 'error', 'timeout', 'refused', 'rate_limited')),
  error_type       text CHECK (error_type ~ '^[a-z0-9_]{1,40}$'),
  input_tokens     integer CHECK (input_tokens >= 0),
  output_tokens    integer CHECK (output_tokens >= 0),
  duration_ms      numeric(12,3) CHECK (duration_ms >= 0),
  engines_claimed  text[] NOT NULL DEFAULT '{}',
  engines_verified text[] NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_log_engines_known CHECK (
    engines_claimed <@ ARRAY['cpp', 'julia', 'python', 'rust']::text[] AND engines_verified <@ ARRAY['cpp', 'julia', 'python', 'rust']::text[]),
  CONSTRAINT ai_log_no_claim_without_evidence CHECK (engines_claimed <@ engines_verified),
  CONSTRAINT ai_log_error_has_type CHECK (status = 'ok' OR error_type IS NOT NULL)
);
CREATE UNIQUE INDEX ai_log_request_once ON app.ai_execution_logs (request_id) WHERE request_id IS NOT NULL;
