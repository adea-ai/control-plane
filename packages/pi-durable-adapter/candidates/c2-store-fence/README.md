# CANDIDATE — C2 store-resident writer fence for Pi Durable 1.1.0 (not consumable)

**Status: candidate only. Not consumable until root explicitly approves it.** It is not listed in
`patchedDependencies`, no install step applies it, nothing imports it, and the preserved
compatibility patch (`patches/@earendil-works%2Fpi-durable@1.1.0.patch`) is untouched. No upstream
SDK repository or fork is claimed, created or accessed. No issuer, capture, Harness open or
production activation is involved.

`c2-store-fence.candidate.patch` is written to apply **on top of** the compatibility patch (it uses
`commitGuarded` and the same storage files). It adds, to the SQLite storage only:

- migration 2: singleton `durable_writer_fence(owner_key, epoch, armed, lineage_id, generation)`,
  inserted unarmed so existing writers behave as before until a writer is acquired;
- `SqliteStorage.acquireWriterFence({ ownerKey, lineageId, generation, expectedEpoch, expectedGeneration? })`:
  one transaction compare-and-sets the epoch to `expectedEpoch + 1`, arms the fence, and binds that
  storage to the new token. Each request property is read exactly once, before validation and before
  the first await (accessors included), and only those primitives are used for the compare-and-set, the
  update and the returned token; the caller's object is never read again. A request epoch that is not a
  safe integer is refused (`PI_STORE_FENCE_REQUEST_INVALID`), and a stored epoch that is not a safe
  integer, or whose successor is not, is refused before the update (`PI_STORE_FENCE_EPOCH_EXHAUSTED`);
- a fence check at the start of every `commit` / `commitGuarded` transaction: once armed, any commit
  without the current token, including one from an unregistered or older holder in any process, fails
  with `PI_STORE_FENCED` before any write.

Not in this candidate: `closeWriters` and the closure receipt (C4), the writer-surface declaration
(C1), other backends (C6) and the read-only open (C7). See the C1–C7 contract.

## Retry safety is not shown

`acquireWriterFence` has no request ledger: a caller whose response was lost cannot replay the same
acquisition, and a second call after a lost success fails `PI_STORE_FENCE_STALE`. The reference-model
tests (`native-store-fence-reference-model.test.mjs`) install a registration coordinator that dedupes lost
responses, but that behavior belongs to the model, not to this candidate. They do not prove retry safety of
`acquireWriterFence`, and nothing here should be cited as proving it. Any integration needs its own idempotency
design and tests. Likewise, `ownerKey` is stored and compared, but there is no per-owner closure contract; binding
a closure receipt to an owner is a design recommendation for the integration, not something this candidate does.

## Rollback status: NOT rollback-safe

Do not describe this candidate as rollback-safe. The only rollback target for a store is a byte-identical
copy preserved **before** the candidate first opens it (taken after a clean close). The tests prove: the
live file changes on open, the compat-patched SDK refuses it, and the preserved artifact stays
byte-identical and compat-readable. There is no downgrade path, and none is claimed.

## Known hazards (documented, not mitigated here)

- **Downgrade:** migration 2 raises the store schema to version 2. The unmodified 1.1.0 SDK and the
  compatibility-patched SDK refuse such a store ("schema version 2 is newer than supported version
  1"). A store that has opened under the candidate cannot be rolled back to the compatibility patch.
  Any consumption plan must account for this against the rollback requirements (#1025).
- **Open-time write:** applying migration 2 is an open-time write to an older store. The C7
  read-only open must not migrate.
- Reads are not fenced. Only commits are.

## Test

`packages/pi-durable-adapter/src/candidate-c2-store-fence.test.mjs` copies the installed SDK into a
temporary directory, applies the compatibility patch there only if it is not already applied, then the
candidate, and exercises the copy on disposable SQLite files. It modifies neither the installed
package nor any patch file.
