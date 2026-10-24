# C7 — read-only open contract and test spec (draft spec; no implementation)

Boundary: no artifact issuer may be enabled until this contract and its tests exist. No production issuer, no live capture.

## Today (verified in SDK 1.1.0 dist, unpatched)

`openNodeSqliteDatabase`: `mkdir -p dirname`, `new DatabaseSync(path)` (creates the file if absent), `PRAGMA journal_mode = WAL`, `synchronous`, `wal_autocheckpoint`. `SqliteStorage.open`: runs migrations (`CREATE TABLE`, `INSERT`). `close()`: `PRAGMA wal_checkpoint(TRUNCATE)`. Every step can change bytes, so opening a captured artifact can change its identity.

## Contract (SDK-owned)

1. `openNodeSqliteStorage(path, { mode: 'read-only' })`:
   - fails if the file is absent (no `mkdir`, no create); opens with SQLite `readOnly` / `immutable=1` semantics;
   - issues no PRAGMA that writes (no `journal_mode`, no `wal_autocheckpoint`), runs no migration, and fails closed on a newer or unrecognized schema version instead of migrating; an older known version is readable as is;
   - refuses a file with `-wal` / `-shm` sidecars unless the caller selects a documented snapshot-consistent mode;
   - `close()` performs no checkpoint;
   - every `Storage.commit` / `mintId` rejects with `PI_STORE_READ_ONLY`.
2. Reads return detached values; no handle to the database is exposed.
3. A read-only open never acquires a writer fence and never bumps an epoch (C2/C3 unaffected).

## Tests (disposable files in a temp dir)

- Byte identity: SHA-256 of the file and a stat (size, mtime) are unchanged after open, read and close.
- Absent file: open fails and creates neither the file nor its directory.
- Unknown or newer schema: fails closed, no migration, bytes unchanged.
- Older known schema (for example a version 1 store opened beside the C2 candidate's migration 2): readable without migrating, because the receipt ledger lives in tables that predate the fence; the fence table is not required for a read.
- Sidecars: `-wal` or `-shm` present is refused in the default mode.
- Every mutating call rejects with `PI_STORE_READ_ONLY` and leaves bytes unchanged.
- `data_version` unchanged around a read.
- A concurrent writer holding a transaction does not make the read-only open mutate anything.
- Close without checkpoint: the WAL size is unchanged.
- Read of the receipt ledger returns the same ledger a live owner would, from the same cut (ties to #1312).

## Not claimed

No issuer, no live capture, no quiescent-capture method, and no production wiring.
