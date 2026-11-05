-- financial/savings_records.sql  (runs as ry_owner)
-- A savings goal and its contributions. saved_amount is a running total that must always equal the sum of the
-- contributions. Three layers keep it true: (1) the app can only add a contribution through app.add_savings_contribution,
-- which locks the goal row, so two requests at once cannot lose an update; (2) the app has no INSERT right on contributions
-- and no UPDATE right on saved_amount; (3) a deferred trigger (schema/database-constraints.sql) re-checks the equality
-- at COMMIT, so even a mistake in privileged code cannot commit a mismatch.

CREATE TABLE app.savings_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  goal_label    app.short_text NOT NULL,
  target_amount app.money NOT NULL CHECK (target_amount > 0),
  saved_amount  app.money NOT NULL DEFAULT 0,
  target_date   date CHECK (target_date BETWEEN DATE '1950-01-01' AND DATE '2100-01-01'),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'achieved', 'abandoned')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  CONSTRAINT savings_achieved_means_reached CHECK (status <> 'achieved' OR saved_amount >= target_amount)
);
CREATE TRIGGER savings_records_touch BEFORE UPDATE ON app.savings_records
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE app.savings_contributions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  savings_id     uuid NOT NULL,
  user_id        uuid NOT NULL,
  amount         app.money NOT NULL CHECK (amount > 0),
  contributed_on date NOT NULL CHECK (contributed_on BETWEEN DATE '1950-01-01' AND DATE '2100-01-01'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- the contribution must belong to a goal of the SAME user
  FOREIGN KEY (savings_id, user_id) REFERENCES app.savings_records (id, user_id) ON DELETE CASCADE
);

CREATE FUNCTION app.add_savings_contribution(p_savings_id uuid, p_amount numeric, p_on date DEFAULT current_date)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_catalog
AS $$
DECLARE
  v_user   uuid := app.current_user_id();
  v_amount numeric := round(p_amount, 2);
  v_new    numeric;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no signed-in user in this request' USING ERRCODE = '42501';
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RAISE EXCEPTION 'a contribution must be greater than zero' USING ERRCODE = '22023';
  END IF;
  -- FOR UPDATE: a second request for the same goal waits here until this transaction ends
  PERFORM 1 FROM savings_records WHERE id = p_savings_id AND user_id = v_user AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active savings goal found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO savings_contributions (savings_id, user_id, amount, contributed_on) VALUES (p_savings_id, v_user, v_amount, p_on);
  UPDATE savings_records
     SET saved_amount = saved_amount + v_amount,
         status = CASE WHEN saved_amount + v_amount >= target_amount THEN 'achieved' ELSE status END
   WHERE id = p_savings_id
   RETURNING saved_amount INTO v_new;
  RETURN v_new;
END
$$;
