# CANDIDATE — C4 `closeWriterFence` for Pi Durable 1.1.0 (not consumable)

**Status: candidate only. Offline planning and tests. Not consumable until root explicitly approves it.**
It is not listed in `patchedDependencies`, no install step applies it, nothing imports it, and neither the
compatibility patch (`patches/@earendil-works%2Fpi-durable@1.1.0.patch`) nor the C2 candidate is touched.
No SDK consumption, migration, activation, issuer, capture, Harness open or live-store mutation is involved.
Tests apply it only to temporary copies of the installed SDK and run on disposable SQLite files.

`c4-close-writers.candidate.patch` applies **on top of** the compatibility patch **and** the C2 candidate
(`../c2-store-fence/`). It adds, to the SQLite storage only:

- migration 3: `durable_writer_closure(mutation_id PRIMARY KEY, owner_key, lineage_id, generation,
  previous_epoch, epoch, last_seq, closed_at) STRICT`;
- `SqliteStorage.closeWriterFence({ mutationId })`: in one transaction it confirms this storage still holds the
  fence, bumps the epoch by one, and inserts the closure row. It returns a frozen receipt shaped as
  `PiWriterClosureReceiptSchema` (`src/cancellation-registration.ts`), then unbinds this storage, so the former
  holder is fenced like any other writer. `lastSeq` is the last committed sequence, read inside the same
  transaction that bumps the epoch.

`mutationId` is read once and validated before the first await. A replay of the same `mutationId` on the same
storage returns the same receipt after re-reading the stored row; the same `mutationId` from any other storage, or
with a changed row, fails `PI_STORE_CLOSURE_CONFLICT`. Other refusals: `PI_STORE_FENCE_NOT_HELD` (unbound storage),
`PI_STORE_FENCED` (the store no longer matches the held token), `PI_STORE_CLOSURE_REQUEST_INVALID`,
`PI_STORE_FENCE_EPOCH_EXHAUSTED` (before any write).

## What the receipt is, and is not

It is evidence that, at that epoch, the store accepted no commit after `lastSeq` from the old holder or from any
other writer without the new token. It is committed in the store and SELECT-readable from a detached snapshot.
It grants no authority. A caller still checks it against what it independently holds with
`assertPiWriterClosureReceipt`.

## Not in this candidate

- **Session admission sealing.** The contract's `closeWriters` also seals Session admission and settles
  admitted commits at the Session level. This patch settles at the storage level only (commits are serialized by
  the transaction). Admission sealing is a later slice and needs its own design against `Session.close`.
- **Retry safety across storages and processes.** Replay works on the same storage object only. A caller whose
  response was lost after the storage was dropped has no replay path; the receipt row can be read but the
  mutation cannot be re-issued. The reference model does not prove otherwise.
- C1 (writer-surface declaration), other backends (C6) and the read-only open (C7).

## Rollback status: NOT rollback-safe

Migration 3 raises the store schema to version 3. The unmodified SDK, the compatibility patch and the C2
candidate refuse such a store ("schema version 3 is newer than supported version 2"). The only rollback target for
a store is a byte-identical copy preserved **before** a candidate first opens it. No downgrade path exists and none
is claimed. Applying migration 3 is an open-time write to an older store; C7's read-only open must not migrate.

## Test

`packages/pi-durable-adapter/src/candidate-c4-close-writers.test.mjs` copies the installed SDK into a temporary
directory next to the installed package, applies the compatibility patch, the C2 candidate and this candidate
there only, and exercises the copy on disposable SQLite files. It changes neither the installed package nor any
patch file.
