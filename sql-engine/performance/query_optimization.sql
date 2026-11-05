-- performance/query_optimization.sql  (runs as ry_owner; part of the migration)
-- The heavy report queries, written once as parameterised functions. A function takes its inputs as typed parameters, so no
-- caller can paste text into the query. They are SECURITY INVOKER: row-level security applies to the caller, who must have
-- called app.begin_request first. Each one starts from an index that begins with user_id (see tests/performance_tests.sql).

-- Income and expense per month and category, from the person's own transactions
CREATE FUNCTION app.monthly_cashflow(p_from date, p_to date)
RETURNS TABLE (month date, kind text, category text, total app.money, entries bigint)
LANGUAGE sql STABLE SET search_path = app, pg_catalog
AS $$
  SELECT date_trunc('month', t.occurred_on)::date, t.kind, coalesce(t.category, '(none)')::text, sum(t.amount)::app.money, count(*)
  FROM transactions t
  WHERE t.user_id = app.current_user_id() AND t.occurred_on >= p_from AND t.occurred_on < p_to AND t.kind IN ('income', 'expense')
  GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
$$;

-- Assets minus liabilities from the person's own financial_records, per currency (a plain sum, no conversion between currencies)
CREATE FUNCTION app.net_position()
RETURNS TABLE (currency char(3), assets numeric, liabilities numeric, net numeric)
LANGUAGE sql STABLE SET search_path = app, pg_catalog
AS $$
  SELECT r.currency::char(3),
         coalesce(sum(r.amount) FILTER (WHERE r.category = 'asset'), 0),
         coalesce(sum(r.amount) FILTER (WHERE r.category = 'liability'), 0),
         coalesce(sum(r.amount) FILTER (WHERE r.category = 'asset'), 0) - coalesce(sum(r.amount) FILTER (WHERE r.category = 'liability'), 0)
  FROM financial_records r WHERE r.user_id = app.current_user_id() GROUP BY r.currency ORDER BY r.currency
$$;

-- The most recent saved calculations of one kind, newest first (the "history" screen); limit is capped
CREATE FUNCTION app.recent_calculations(p_kind text, p_limit integer DEFAULT 20)
RETURNS TABLE (id uuid, label text, saved_at timestamptz, calc_version text, inputs jsonb, result jsonb)
LANGUAGE sql STABLE SET search_path = app, pg_catalog
AS $$
  SELECT h.id, h.label, h.saved_at, h.calc_version, h.inputs, h.result FROM calculator_history h
  WHERE h.user_id = app.current_user_id() AND h.kind = p_kind ORDER BY h.saved_at DESC LIMIT least(greatest(p_limit, 1), 100)
$$;

GRANT EXECUTE ON FUNCTION app.monthly_cashflow(date, date), app.net_position(), app.recent_calculations(text, integer) TO ry_app;
