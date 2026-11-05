-- financial/transactions.sql  (runs as ry_owner)
-- Individual money movements typed in or imported from a CSV the person uploaded.
-- external_ref makes an import repeatable: loading the same file twice cannot create the same row twice.

CREATE TABLE app.transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('income', 'expense', 'transfer')),
  category     app.short_text,
  amount       app.money NOT NULL CHECK (amount > 0),
  currency     app.currency NOT NULL DEFAULT 'INR',
  occurred_on  date NOT NULL CHECK (occurred_on BETWEEN DATE '1950-01-01' AND DATE '2100-01-01'),
  note         app.note_text,
  source       text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'csv_import')),
  external_ref text CHECK (char_length(external_ref) BETWEEN 1 AND 100),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transactions_import_once ON app.transactions (user_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE TRIGGER transactions_touch BEFORE UPDATE ON app.transactions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
