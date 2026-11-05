# Backup strategy

What is written here is what `tests/backup_restore_test.sh` actually does (dump, checksum, restore elsewhere, compare). Anything not
tested is marked **not tested**.

## What is backed up, and how
| What | How | Why this way |
|---|---|---|
| All data, structure, grants, policies, triggers, functions | `pg_dump --format=custom --file=ry-YYYYMMDD-HHMM.dump "$RY_ADMIN_URL"` | One consistent snapshot, taken while the service keeps running. The custom format is compressed and `pg_restore` can pick single tables out of it. |
| Proof the file is whole | `sha256sum ry-....dump > ry-....dump.sha256`, and `sha256sum -c` after every copy | A damaged or altered backup is noticed before you need it (tested: a changed byte and a truncated file are both caught). |
| The four group roles and their members | `pg_dumpall --roles-only > roles.sql` | Roles belong to the whole server and are **not** inside a database dump. This file contains password hashes: treat it like a secret. |
| Server settings (`postgresql.conf`, `pg_hba.conf`) | Kept in your infrastructure repository or your host's configuration | Not inside any dump. |

## Schedule (suggested; you decide)
* Every night: one dump. Keep 14 daily, 8 weekly (Sunday), 12 monthly (first of the month).
* Before every migration and before every `retention` run with `run_retention(false)`: one extra dump. It costs seconds.
* **Monthly: a restore drill** (below). A backup that was never restored is a hope, not a backup.

## Where the backups live
* On a different machine (and ideally a different provider or account) than the database. A backup on the same disk dies with the disk.
* **Encrypted before it leaves the database host**, for example `age -r <public key> -o ry.dump.age ry.dump`. Keep the decryption key somewhere
  other than the backup store, and keep a second copy of that key offline. Without the key the backup is useless; with a stolen key and a stolen
  backup, every person's data is exposed.
* Writable by the backup job only, readable by the administrators only. Never by the application role.
* Backups contain **personal data**. When a person erases their account (`app.erase_user`), the data stays in older backups until they expire
  (at most 12 months with the schedule above). Say so in the privacy notice; never restore an old backup into production without re-applying
  the erasures that happened since.

## What a backup of this kind can and cannot do
* **Recovery point: the time of the last dump** (up to 24 hours with a nightly dump). Anything written after it is lost on a full restore.
* To lose less, use point-in-time recovery: continuous WAL archiving (`archive_mode`, `pg_basebackup`, or your managed provider's "PITR"/"snapshots"
  feature). It is the right tool when 24 hours of data matters. **Not built and not tested here**: it depends on the host that will run PostgreSQL.
* **Recovery time: not measured at production size.** The test database restores in seconds; measure the real figure in the first drill on the real
  host and write it in your runbook.

## The commands
```
# backup (run on a schedule on the database host, with a backup-only login that can read everything: the administrator or a role with pg_read_all_data)
pg_dump "$RY_ADMIN_URL" --format=custom --file="ry-$(date +%Y%m%d-%H%M).dump"
sha256sum ry-*.dump > SHA256SUMS

# check a backup file at any time
sha256sum -c SHA256SUMS
pg_restore --list ry-20261104-0200.dump > /dev/null

# monthly drill: restore into a scratch database and compare (see recovery_strategy.md, "Full restore")
```

## The drill, step by step (about 10 minutes)
1. Pick last night's dump. `sha256sum -c`.
2. Restore it into a new scratch database following `recovery_strategy.md`, "Full restore".
3. `psql "$SCRATCH_URL" -X -f backups/integrity_checks.sql`: every line must say `ok`.
4. `RY_ADMIN_URL="$SCRATCH_URL" bash migrations/apply.sh verify`: must print `ok`.
5. Compare a few row counts with production (`select count(*) from app.users`, `app.calculator_history`).
6. Write down the date, the time it took and any surprise. Drop the scratch database.

`tests/backup_restore_test.sh` performs steps 1 to 4 plus a content-hash comparison of every table, automatically, against a test database.
