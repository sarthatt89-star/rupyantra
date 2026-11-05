# Rupeyantra SQL engine (PostgreSQL)

The database layer: users, saved financial records, calculator history, chat history (only if the person opts in), engine-run records and audit logs.
One database, one schema (`app`), PostgreSQL **15 or newer**. No second database is installed.

## What is here
| Folder | Contents |
|---|---|
| `migrations/` | `apply.sh` (plan / up / status / verify / rollback), the manifest, the rollback script |
| `security/` | roles, audit trail, row-level security, retention, permissions |
| `schema/` | settings, base schema, constraints, indexes, views |
| `users/ financial/ calculators/ ai/` | the tables, one file each |
| `performance/` | indexes, query notes, maintenance. `materialized_views.sql` and `partitioning.sql` are **not applied**: measurements did not justify them yet |
| `backups/` | `integrity_checks.sql`, `backup_strategy.md`, `recovery_strategy.md` |
| `tests/` | `bash tests/run_all.sh` runs everything against a throw-away PostgreSQL |
| `database-config.example` | template for connection settings (no secrets) |

## Install (you, by hand: nothing here runs by itself)
```
export RY_ADMIN_URL='postgresql://ry_admin@HOST:5432/rupeyantra?sslmode=verify-full'   # password via ~/.pgpass or PGPASSWORD
bash migrations/apply.sh plan      # shows what would happen, changes nothing
bash migrations/apply.sh up        # applies in ONE transaction; all or nothing
bash migrations/apply.sh verify    # checksum of the applied files
psql "$RY_ADMIN_URL" -X -f backups/integrity_checks.sql    # every line must be ok
```
Then create the login users (see `database-config.example`) and re-run `schema/database-config.sql`.

## Test
Needs a local PostgreSQL 15+ and a superuser in `PGUSER`/`PGPASSWORD`. It creates and drops its own test databases and never touches others.
`bash tests/run_all.sh` ends with `ALL PASSED: N checks` or lists what failed.

## Honest limits
* Row-level security protects against application bugs. Someone holding the application's database password can claim any user id.
* The audit trail is tamper-resistant, not tamper-proof (the administrator can bypass it).
* The check that refuses API keys in chat text is a best-effort pattern match.
* Retention is not scheduled: an operator must run `SELECT * FROM app.run_retention(false)`.
* Point-in-time recovery, TLS and hosting are decisions for the host you choose; not built or tested here.
* No application code uses this database yet (`api/chat.js` is untouched).
