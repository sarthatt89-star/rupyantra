-- tests/_helpers.sql  --  test-only helpers. Created by tests/run_all.sh in the TEST database only; never part of a migration.
CREATE SCHEMA IF NOT EXISTS ry_test;
GRANT USAGE ON SCHEMA ry_test TO PUBLIC;

CREATE TABLE IF NOT EXISTS ry_test.ids (name text PRIMARY KEY, id uuid NOT NULL);
GRANT SELECT ON ry_test.ids TO PUBLIC;
CREATE OR REPLACE FUNCTION ry_test.id(p_name text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM ry_test.ids WHERE name = p_name $$;

CREATE OR REPLACE FUNCTION ry_test.ok(p_cond boolean, p_name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond IS NOT TRUE THEN
    RAISE EXCEPTION 'FAILED: %', p_name;
  END IF;
  RAISE NOTICE 'ok - %', p_name;
END $$;

-- p_sql must fail with exactly this SQLSTATE
CREATE OR REPLACE FUNCTION ry_test.raises(p_sql text, p_state text, p_name text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
    v_msg := SQLERRM;
  END;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'FAILED: % (the statement was accepted but must be refused)', p_name;
  ELSIF v_state <> p_state THEN
    RAISE EXCEPTION 'FAILED: % (refused with % "%" instead of %)', p_name, v_state, v_msg, p_state;
  END IF;
  RAISE NOTICE 'ok - %', p_name;
END $$;

-- number of rows a query returns, as the current role
CREATE OR REPLACE FUNCTION ry_test.rows(p_sql text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  EXECUTE 'SELECT count(*) FROM (' || p_sql || ') q' INTO n;
  RETURN n;
END $$;

-- milliseconds a query takes (EXPLAIN ANALYZE), and whether its plan used an index
CREATE OR REPLACE FUNCTION ry_test.timed(p_sql text, OUT ms numeric, OUT plan text) LANGUAGE plpgsql AS $$
DECLARE
  j json;
BEGIN
  EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || p_sql INTO j;
  ms := round(((j -> 0 ->> 'Execution Time'))::numeric, 2);
  plan := j::text;
END $$;

-- number of rows an UPDATE or DELETE touched, as the current role
CREATE OR REPLACE FUNCTION ry_test.affected(p_sql text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
