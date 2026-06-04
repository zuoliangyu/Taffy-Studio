# DB Migration Guide

> If you add or change a column on the `messages` / `conversations` tables,
> **read this first**. Real users in production won't have a delete-the-db
> escape hatch.

## How the system works

- All schema lives in `src-tauri/src/lib.rs::migrations()`.
- Each `Migration { version: N, sql: "…", kind: Up }` is registered with
  `tauri-plugin-sql` and runs **inside a transaction** at startup.
- The plugin tracks applied versions in the `_sqlx_migrations` table. New
  versions run, applied ones are skipped.
- **Before** the plugin runs migrations, `startup_backup()` in `lib.rs` copies
  the current DB into `<app_config_dir>/backups/`. We keep the latest 7. A
  failed migration can be recovered by replacing the live DB with the most
  recent backup file.

## Rules

### 1. Never modify a published migration

Once a `Migration { version: N, ... }` ships in a release tag, that record is
on every user's machine in `_sqlx_migrations`. Re-editing the SQL **will not
re-run** for those users — they'll skip your change and end up with a schema
that doesn't match the code.

If you discover a bug in `version: N` after release, fix it by adding a new
`version: N+1` migration that patches the state forward.

### 2. Only add — never drop columns or tables

SQLite's `ALTER TABLE` does support `DROP COLUMN` since 3.35, but mixing
add-and-drop across user versions makes upgrade paths combinatorial. Stop
using a column instead. If you really must clean up, do it in a single
release where you also bump a "min supported version" check.

### 3. New columns must be NULLABLE or have a DEFAULT

Otherwise the `ALTER TABLE` fails on tables that already have rows. Example
(this is `migrations[1]` in lib.rs):

```sql
ALTER TABLE messages ADD COLUMN attachments TEXT NULL;
```

### 4. Don't put dependent DDL across migration steps without thinking

SQLite's DDL is *partially* transactional. If your migration does
`CREATE TABLE foo; INSERT INTO foo ...; DROP TABLE messages;` and the INSERT
fails, you may end up with `foo` alive and `messages` still there but in an
inconsistent state. Prefer one structural change per migration.

### 5. Don't reference data-format assumptions of code that doesn't exist yet

The migration only changes shape. If you need to backfill or transform data,
do it from Rust code that runs AFTER plugin init, with checks for whether the
backfill has happened (e.g., a sentinel row, or a separate
`_taffy_meta` table).

## Adding a new migration — checklist

1. Add a new entry at the end of `migrations()` in `lib.rs`:
   ```rust
   Migration {
       version: <next-integer>,
       description: "short imperative summary",
       sql: r#"…"#,
       kind: MigrationKind::Up,
   },
   ```
2. The version number is **monotonically increasing** and never reused.
3. Test the upgrade path locally:
   - Run the **previous** released binary, generate some realistic data.
   - Quit, swap in your new binary, start.
   - Confirm the new migration ran (check the `_sqlx_migrations` table in
     `taffy-studio.db` with `sqlite3` — there should be a row with your
     version).
   - Confirm the existing data is intact and the new schema works.
4. If the migration is non-trivial (joins old + new columns, copies data,
   etc.), write a TS-side smoke test that creates a conversation and a
   message, then re-opens it, to catch regressions in CI.

## When migrations go wrong in the wild

The user-facing safety net is in **Settings → Storage**:

- **Backups** section lists the auto-snapshots (`backups/*.bak-YYYYMMDD-HHMMSS`).
- **Open folder** reveals the app config directory in Explorer/Finder.
- **Reset…** wipes the live DB but takes one more snapshot first.

If a customer reports a corrupt DB:

1. Have them open Settings → Storage → "Open folder".
2. In the `backups/` subdirectory, find a `.bak-…` file dated before the bad
   upgrade.
3. Quit the app.
4. Rename or delete `taffy-studio.db`.
5. Rename the chosen backup to `taffy-studio.db`.
6. Reopen the app.

For internal testing, `backup_now` and `reset_database` are exposed as Tauri
commands — see `src/lib/storage.ts`.

## Tested upgrade matrix

| From | To | Status | Notes |
|---|---|---|---|
| (none) | v1 | ✅ Fresh install | |
| v1 | v2 | ✅ `attachments` column added | The very first user-facing migration. |

When adding a row, update both this table and your CI test.

## Future work

- [ ] CI job: spin up the previous release binary in Docker, seed sample
  data, upgrade to HEAD binary, assert all messages still readable.
- [ ] JSON export/import (`src/lib/storage.ts`) so users can move data
  across machines OR across major schema rebases.
- [ ] Stronghold-backed encrypted backup option for the keyring service.
