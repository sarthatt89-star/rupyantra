# Recovery strategy

Read `backup_strategy.md` first. Section "Full restore" is the procedure the automated test follows; the other scenarios are written
from the same pieces and are **not tested** unless stated.

## Which situation is it?
| Situation | Go to |
|---|---|
| Somebody deleted or changed rows by mistake | Recover rows from a side copy |
| The database is lost or corrupted | Full restore |
| A migration went wrong | Bad migration |
| The application password (`ry_app`) or a backup may have leaked | Credential leak |
| A person asks for their data to be erased | Erasure requests and backups |

## Full restore (tested by tests/backup_restore_test.sh, with a new empty database)
1. **Stop the application** (or point it at a maintenance page). Do not write to the old database any more.
2. Take the newest dump that passes `sha256sum -c`. If it is encrypted, decrypt it first.
3. On the new PostgreSQL server (15 or newer), as the administrator, **create the four group roles** if the server does not have them yet
   (a restore into the same server already has them). The dump needs them to exist; this is the first half of `security/database_roles.sql`:
   ```sql
   DO $$ DECLARE r text; BEGIN
     FOREACH r IN ARRAY ARRAY['ry_owner','ry_app','ry_readonly','ry_auditor'] LOOP
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
         EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
       END IF;
     END LOOP;
   END $$;
   ```
   Do **not** run the whole `database_roles.sql` here: it also creates the empty `app` schema, and the restore must create it itself.
4. `createdb ry_restored` (as the administrator).
5. Restore **as the administrator, keeping owners** (do not use `--no-owner`; the objects must belong to `ry_owner`):
   ```
   pg_restore --dbname="postgresql://admin@host/ry_restored" --exit-on-error ry-20261104-0200.dump
   ```
6. Re-apply the database settings (time zone, timeouts), which are not inside a dump:
   `psql "$RY_ADMIN_URL" -X -f schema/database-config.sql`
7. Create the login users again (`database-config.example` shows how) and re-run step 6, so they get their limits.
8. Check: `psql "$RY_ADMIN_URL" -X -f backups/integrity_checks.sql` (every line `ok`) and `bash migrations/apply.sh verify` (`ok`).
9. Smoke test as the application login: sign-in lookup for a known e-mail, one saved calculation, one record list.
10. Point the application at the new database (change `DATABASE_URL`), start it, watch the logs.
11. Note the time of the dump you used. Everything written after it is lost: tell the people affected if it matters.

## Recover rows from a side copy (not tested end to end; every step is part of the full restore)
1. Restore the dump into a **separate** scratch database (steps 4 and 5 above), never over production.
2. In the scratch database, select the rows you need (`COPY (SELECT ...) TO STDOUT`).
3. Load them into production in a transaction (`BEGIN; ... ; verify; COMMIT;`). Remember the audit trail: the loads are recorded by the
   normal triggers. Rows of a person who has erased their account since must **not** be put back.
4. Run `integrity_checks.sql` on production afterwards.

## Bad migration
`apply.sh up` runs every file of a migration in **one transaction**: if any file fails, nothing is applied (tested). So a half-applied migration does not
exist. If a migration applied cleanly but is wrong:
1. `bash migrations/apply.sh verify` and `status` to see what is recorded.
2. Take a dump now.
3. The rollback of migration 0001 deletes the whole schema and **all data** (it is the first migration), so it is only for a database that holds no data
   you want. It refuses to run unless `RY_CONFIRM_ROLLBACK` equals the exact database name (tested). Later migrations get their own, smaller rollback files.
4. If data exists, fix forward with a new numbered migration instead, and test it on a restored copy first.

## Credential leak (not tested)
* **ry_app password leaked:** `ALTER ROLE <login> PASSWORD '<new>'` (as the administrator), update the application secret, restart the application.
  Remember what row-level security does and does not do: with the app password an attacker can claim to be any user, so also revoke sessions:
  `UPDATE app.user_sessions SET revoked_at = now() WHERE revoked_at IS NULL;` (as `ry_owner`), and ask people to sign in again.
* **A backup or its key leaked:** treat every person's data as exposed. Rotate the application password, force password resets (set a new
  `password_hash` flow in the application), and follow your legal duty to notify.
* **Administrator password leaked:** rotate it, then review `app.audit_logs` (`SELECT * FROM app.audit_logs WHERE db_actor NOT LIKE '<your login prefix>%'`).

## Erasure requests and backups
`app.erase_user` removes a person from the live database at once. Their data stays in existing backups until those expire. If you ever restore a backup,
re-run the erasures requested since its date. Keep a small, separate list of erased account ids (ids only, no personal data) for this purpose.
