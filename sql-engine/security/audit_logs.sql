-- security/audit_logs.sql  (runs as ry_owner)
-- Who changed what, in which table, and WHICH COLUMNS changed. Values are never copied: a password hash, a balance or a name can
-- not leak through the audit trail because the trail never holds them. The application has no access to this table at all
-- (the trigger function runs with the owner's rights); only ry_auditor can read it.
-- Limit: this is tamper-RESISTANT, not tamper-PROOF. A person with the owner role or a superuser can still disable the triggers;
-- ship the table (or the database log) to storage that the database administrators cannot edit if that matters.

CREATE TABLE app.audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  table_name      text NOT NULL,
  operation       text NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
  row_id          text,
  app_user_id     uuid,                 -- the signed-in user of the request (no foreign key: the trail outlives the account)
  db_actor        text NOT NULL DEFAULT session_user,
  changed_columns text[]
);

CREATE FUNCTION app.audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
DECLARE
  v_row     jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  v_changed text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(n.key ORDER BY n.key) INTO v_changed
    FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.key <> 'updated_at';
    IF v_changed IS NULL THEN
      RETURN NULL;                       -- nothing but updated_at moved
    END IF;
  END IF;
  INSERT INTO audit_logs (table_name, operation, row_id, app_user_id, changed_columns)
  VALUES (TG_TABLE_NAME, TG_OP, coalesce(v_row ->> 'id', v_row ->> 'user_id'), app.current_user_id(), v_changed);
  RETURN NULL;
END
$$;

-- Not audited on purpose: transactions (bulk imports would flood the trail), and the logs themselves.
CREATE TRIGGER users_audit AFTER INSERT OR UPDATE OR DELETE ON app.users FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER user_preferences_audit AFTER UPDATE OR DELETE ON app.user_preferences FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER financial_records_audit AFTER INSERT OR UPDATE OR DELETE ON app.financial_records FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER loan_records_audit AFTER INSERT OR UPDATE OR DELETE ON app.loan_records FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER investment_records_audit AFTER INSERT OR UPDATE OR DELETE ON app.investment_records FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER savings_records_audit AFTER INSERT OR UPDATE OR DELETE ON app.savings_records FOR EACH ROW EXECUTE FUNCTION app.audit_row();
CREATE TRIGGER financial_reports_audit AFTER INSERT OR DELETE ON app.financial_reports FOR EACH ROW EXECUTE FUNCTION app.audit_row();

-- The trail itself cannot be edited, and rows leave it only through the retention routine.
CREATE FUNCTION app.protect_audit_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs cannot be changed' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER audit_logs_protect BEFORE UPDATE OR DELETE ON app.audit_logs FOR EACH ROW EXECUTE FUNCTION app.protect_audit_logs();
CREATE TRIGGER audit_logs_protect_truncate BEFORE TRUNCATE ON app.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION app.protect_audit_logs();
