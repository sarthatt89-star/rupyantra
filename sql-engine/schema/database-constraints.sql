-- schema/database-constraints.sql  (runs as ry_owner, after every table exists)
-- Rules that need more than one table: links to engine runs, the savings total, and "this record is never edited".

-- 1) Links to the engine run that produced a result. If the run row is later purged, the link becomes NULL: the saved report
--    or calculation stays, and says nothing about a run it can no longer point at.
ALTER TABLE app.financial_reports
  ADD CONSTRAINT financial_reports_engine_run_fk FOREIGN KEY (engine_execution_id)
  REFERENCES app.engine_execution_history (id) ON DELETE SET NULL;
ALTER TABLE app.calculation_metadata
  ADD CONSTRAINT calculation_metadata_engine_run_fk FOREIGN KEY (engine_execution_id)
  REFERENCES app.engine_execution_history (id) ON DELETE SET NULL;

-- 2) saved_amount must equal the sum of the contributions at COMMIT. DEFERRABLE INITIALLY DEFERRED: inside a transaction the two
--    tables may be briefly out of step (that is how add_savings_contribution works); at commit they may not be.
CREATE FUNCTION app.check_savings_total() RETURNS trigger
LANGUAGE plpgsql SET search_path = app, pg_catalog
AS $$
DECLARE
  v_id    uuid;
  v_saved numeric;
  v_sum   numeric;
BEGIN
  IF TG_TABLE_NAME = 'savings_records' THEN
    v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    v_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.savings_id ELSE NEW.savings_id END;
  END IF;
  SELECT saved_amount INTO v_saved FROM savings_records WHERE id = v_id;
  IF NOT FOUND THEN
    RETURN NULL;                         -- the goal itself was deleted
  END IF;
  SELECT coalesce(sum(amount), 0) INTO v_sum FROM savings_contributions WHERE savings_id = v_id;
  IF v_saved <> v_sum THEN
    RAISE EXCEPTION 'saved_amount (%) does not equal the sum of its contributions (%)', v_saved, v_sum USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER savings_total_matches_goal AFTER INSERT OR UPDATE OR DELETE ON app.savings_records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_savings_total();
CREATE CONSTRAINT TRIGGER savings_total_matches_contributions AFTER INSERT OR UPDATE OR DELETE ON app.savings_contributions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.check_savings_total();

-- 3) Records that are history, not working data, are never edited. The only change allowed is the automatic unlinking that
--    happens when an account or a purged engine run disappears: a listed column going from a value to NULL, nothing else.
CREATE FUNCTION app.forbid_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
DECLARE
  v_ok boolean;
BEGIN
  SELECT bool_and(n.key = ANY (TG_ARGV) AND n.value = 'null'::jsonb) INTO v_ok
  FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
  WHERE n.value IS DISTINCT FROM o.value;
  IF coalesce(v_ok, true) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is a record of what happened and is never edited', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER calculator_history_frozen BEFORE UPDATE ON app.calculator_history FOR EACH ROW EXECUTE FUNCTION app.forbid_update();
CREATE TRIGGER calculation_metadata_frozen BEFORE UPDATE ON app.calculation_metadata FOR EACH ROW EXECUTE FUNCTION app.forbid_update('engine_execution_id');
CREATE TRIGGER financial_reports_frozen BEFORE UPDATE ON app.financial_reports FOR EACH ROW EXECUTE FUNCTION app.forbid_update('engine_execution_id');
CREATE TRIGGER engine_runs_frozen BEFORE UPDATE ON app.engine_execution_history FOR EACH ROW EXECUTE FUNCTION app.forbid_update('user_id');
CREATE TRIGGER ai_logs_frozen BEFORE UPDATE ON app.ai_execution_logs FOR EACH ROW EXECUTE FUNCTION app.forbid_update('user_id');
CREATE TRIGGER user_activity_frozen BEFORE UPDATE ON app.user_activity FOR EACH ROW EXECUTE FUNCTION app.forbid_update();
