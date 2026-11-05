-- schema/database-schema.sql  (runs as ry_owner)
-- Shared building blocks. Every table lives in schema "app". Money is always exact decimal (never float).

-- Value types: the rule is written once here and every table that uses the type gets it.
CREATE DOMAIN app.money        AS numeric(18,2) CHECK (VALUE >= 0 AND VALUE < 1e16);
CREATE DOMAIN app.signed_money AS numeric(18,2) CHECK (VALUE > -1e16 AND VALUE < 1e16);
CREATE DOMAIN app.percent      AS numeric(9,4)  CHECK (VALUE >= 0 AND VALUE <= 1000);
CREATE DOMAIN app.currency     AS char(3)       CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN app.short_text   AS text          CHECK (char_length(VALUE) BETWEEN 1 AND 200);
CREATE DOMAIN app.note_text    AS text          CHECK (char_length(VALUE) <= 1000);
CREATE DOMAIN app.hex32        AS text          CHECK (VALUE ~ '^[0-9a-f]{32}$');

-- Who is making this request. The API calls app.begin_request(<user id>) at the start of every transaction; row-level
-- security then shows that user's rows only. The setting is local to the transaction, so a pooled connection cannot
-- carry one user's identity into the next request. With nothing set, ry_app sees no rows at all.
CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app.begin_request(p_user uuid) RETURNS void
LANGUAGE sql SET search_path = pg_catalog
AS $$ SELECT set_config('app.user_id', coalesce(p_user::text, ''), true) $$;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
