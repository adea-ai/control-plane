# C7 — read-only open contract and test spec (offline candidate implemented; not consumable)

Boundary: no artifact issuer may be enabled until this contract and its tests exist. No production issuer, no live capture.

## Status

The contract below is implemented as an **offline candidate**, not as an SDK change: the uncompiled patch
`packages/pi-durable-adapter/candidates/c7-read-only-open/c7-read-only-open.candidate.patch` (#1318) applies to a temporary
copy of the installed SDK on top of the compatibility, C2 and C4 patches, and its 19 tests
(`src/candidate-c7-read-only-open.test.mjs`) run on disposable SQLite files. Nothing is wired into the adapter, the build or
a runtime path. A second test (`src/candidate-c7-receipt-ledger-cut.test.mjs`, #1319) shows the receipt ledger read through
this open equals the ledger a read-write reopen of a byte copy reads at the C4 closure's `lastSeq`, and that a store whose
newer receipts live only in a WAL is refused. Session admission sealing (`candidates/c4b-session-admission-sealing/`, #1321) is
a separate stacked candidate.

Beyond the contract, the candidate also resolves the real path once (a symlink alias cannot hide sidecars at the real path) and
fails closed on any sidecar inspection error other than a proven absent file.

**Not implemented:** the "documented snapshot-consistent mode" named below. A separate offline candidate for a detached
snapshot (method A, a closed-and-checkpointed disposable copy of a store, with its own sealing call and no change to this open)
is described in `docs/pi-durable-c7c-detached-snapshot-design.md`; it does not add a mode to this open, does not read a WAL, and
is not consumable. Only the default read-only mode exists; an unknown
mode is refused (`PI_STORE_OPEN_MODE_INVALID`), and a store with `-wal`, `-shm` or `-journal` sidecars is refused
(`PI_STORE_READ_ONLY_SIDECARS`). That check is sidecar presence at the real path plus the schema version; it does not establish
owner or process liveness, and absent sidecars are not proof that no live writer exists. There is also no issuer, no quiescent-capture method, no SDK adoption and no live use. The
C7 patch adds no migration and reads schemas 1, 2 and 3 as they are; the C2 and C4 candidates it is stacked on raise the
store schema and are not rollback-safe.

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
