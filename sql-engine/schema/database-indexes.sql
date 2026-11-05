-- schema/database-indexes.sql  (runs as ry_owner)
-- Every foreign key has an index that starts with its column (otherwise deleting an account scans whole tables), plus the
-- indexes the app's main screens need. Unique indexes live next to their tables. Time-ordered append-only logs use BRIN
-- (a few kilobytes instead of hundreds of megabytes). performance/indexes.sql shows how to find an index that does not earn its place.

CREATE INDEX user_sessions_user ON app.user_sessions (user_id);
CREATE INDEX user_sessions_expiry ON app.user_sessions (expires_at);
CREATE INDEX user_activity_user_time ON app.user_activity (user_id, occurred_at DESC);

CREATE INDEX financial_records_user_cat_date ON app.financial_records (user_id, category, recorded_on DESC);
CREATE INDEX transactions_user_date ON app.transactions (user_id, occurred_on DESC);
CREATE INDEX loan_records_user ON app.loan_records (user_id);
CREATE INDEX investment_records_user_type ON app.investment_records (user_id, instrument_type);
CREATE INDEX savings_records_user_status ON app.savings_records (user_id, status);
CREATE INDEX savings_contributions_goal ON app.savings_contributions (savings_id, user_id, contributed_on DESC);
CREATE INDEX financial_reports_user_time ON app.financial_reports (user_id, generated_at DESC);
CREATE INDEX financial_reports_engine_run ON app.financial_reports (engine_execution_id) WHERE engine_execution_id IS NOT NULL;

CREATE INDEX calculator_history_user_kind_time ON app.calculator_history (user_id, kind, saved_at DESC);
CREATE INDEX calculation_metadata_user ON app.calculation_metadata (user_id);
CREATE INDEX calculation_metadata_engine_run ON app.calculation_metadata (engine_execution_id) WHERE engine_execution_id IS NOT NULL;

CREATE INDEX chat_sessions_user_recent ON app.chat_sessions (user_id, last_message_at DESC);
CREATE INDEX chat_messages_session ON app.chat_messages (session_id, id);

CREATE INDEX engine_runs_user_time ON app.engine_execution_history (user_id, started_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX engine_runs_engine_function_time ON app.engine_execution_history (engine, function_name, started_at DESC);
CREATE INDEX engine_runs_time_brin ON app.engine_execution_history USING brin (started_at);
CREATE INDEX ai_logs_user ON app.ai_execution_logs (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ai_logs_time_brin ON app.ai_execution_logs USING brin (created_at);

CREATE INDEX audit_logs_row ON app.audit_logs (table_name, row_id);
CREATE INDEX audit_logs_time_brin ON app.audit_logs USING brin (occurred_at);
