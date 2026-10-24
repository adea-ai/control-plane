# C7c — detached snapshot, method A (offline candidate; not consumable)

Boundary: this is a design and an offline test-only candidate. It is not wired into the adapter, the build, an export, a
runtime path or an issuer. No SDK adoption, live capture, migration, credential or resource is involved. Root decision of
2026-10-24 18:14Z (relayed): implement method A as an uncompiled candidate on temporary SDK copies, and specify method B
without implementing it.

## Status

- Candidate patch: `packages/pi-durable-adapter/candidates/c7c-detached-snapshot/c7c-detached-snapshot.candidate.patch`.
  It is uncompiled and applies on top of the compatibility patch and the C2, C4 and C7 candidates. It adds two new SDK modules
  under `dist/storage/sqlite/` (`snapshot.js` and `open-registry.js`, plus declarations) and a four-line hook in `node.js`.
  It changes no export, no `index.js` and no migration. It is not listed in `patchedDependencies`.
- Tests: `packages/pi-durable-adapter/src/candidate-c7c-detached-snapshot.test.mjs` (Bun, disposable SQLite files, temporary
  SDK copies). They include a mutation proof that weakens one candidate check at a time (below).
- Default C7 is unchanged. A store with `-wal`, `-shm` or `-journal` sidecars is still refused with
  `PI_STORE_READ_ONLY_SIDECARS`, an unknown schema is still refused, and no mode or alias reads a database together with its
  WAL. See `docs/pi-durable-c7-read-only-open-spec.md`.
- Hosted CI has not run on this candidate. Draft pull requests skip the hosted heavy lanes, and the local results below are
  local results only.

## What a detached snapshot is, and what it is not

A detached snapshot is a regular file that is a byte copy of a store that was closed with the C4 writer-closure and then shut
down cleanly (so SQLite checkpointed and removed its sidecars), plus a sealed handle that records facts the SDK derived from
that file. It is **historical evidence of one committed cut**: the receipt ledger as it stood at the closure's `lastSeq`.

It is **not**:

- proof that any process was quiescent, at the time of the copy or ever. No in-process registry entry, no stable bytes and no
  coherent rows prove cross-process quiescence. That is an out-of-band attestation the caller owns (for example an operator or
  a controller that stopped the owner and recorded it). The SDK neither performs nor replaces it.
- proof that the artifact was copied from the store the pins name. The pins are compared with what the artifact says about
  itself. An artifact built to say the same things passes. Provenance of the copy is also out-of-band.
- production attestation of any kind. No caller-supplied boolean is accepted as attestation anywhere in this candidate, and the
  existing `detached: true` and `coherent: true` assertions of the #1312 seal are produced in the test glue only from facts the
  SDK derived.
- authority. A sealed snapshot never settles a journal, never authorizes or releases an effect, and never proves that an effect
  did not happen. "Absent" in the snapshot means no receipt in this ledger at this cut.

## Method A: closed-and-checkpointed disposable copy

Procedure the caller follows (outside this candidate; no code here performs it against a live store):

1. Close the writers with C4 `closeWriterFence({ mutationId })`. This commits the closure row and bumps the fence epoch. The
   former holder and every unfenced opener are fenced out afterwards.
2. Shut the storage down. `close()` runs `PRAGMA wal_checkpoint(TRUNCATE)`, so no `-wal` remains; SQLite removes `-shm`.
3. Copy the single main file to a fresh path (a plain byte copy, `COPYFILE_EXCL` or equivalent). Do not copy sidecars.
4. Hold the six pins from the closure receipt the C4 call returned, not from the copy.

`sealSnapshot(artifactPath, pins)` then reads only the copy.

### Pins

Exactly six independently held values; extra keys, missing keys, getters and wrong types are refused
(`PI_SNAPSHOT_PINS_INVALID`). Each is read once into a primitive before the first `await`.

| Pin                                   | Meaning                                                             |
| ------------------------------------- | ------------------------------------------------------------------- |
| `mutationId`                          | The C4 closure key. An unknown id is `PI_SNAPSHOT_CLOSURE_MISSING`. |
| `ownerKey`, `lineageId`, `generation` | The fence holder that was closed.                                   |
| `epoch`                               | The closure epoch (previous epoch plus one).                        |
| `lastSeq`                             | The last committed sequence at the closure.                         |

Session-level pins (`sessionId`, `conversationId`, `restoreGeneration` with its `revision`) are adapter-level facts. They are
not in the SDK store and are not accepted by `sealSnapshot`; they are validated at the sealing boundary (below) and again by
`readPiFrozenReceipt`.

### Coherence rule

All of the following must hold, and any failure refuses with a code and returns no handle:

1. The artifact is an absolute, canonical path (`realpath` equals the path given), an `lstat` regular file that is not a
   symlink, with `nlink` equal to 1 and at most 256 MiB. A second hard link is another name for bytes some other party may hold.
2. The file is not open for writing in this process (in-process registry, below).
3. No `-wal`, `-shm` or `-journal` sidecar exists beside it (the default C7 refusal, checked before and after the reads).
4. It opens through the C7 read-only open, has a known schema, and passes `PRAGMA quick_check`.
5. The closure row for `mutationId` exists, and its owner, lineage, generation and epoch equal the pins, and
   `epoch == previous_epoch + 1`.
6. The fence row's epoch equals the closure epoch, and its owner, lineage and generation equal the pins. A **higher** fence
   epoch means a successor acquired the fence after the closure and is `PI_SNAPSHOT_SUPERSEDED`. A lower or otherwise
   different one is `PI_SNAPSHOT_CLOSURE_MISMATCH`.
7. The last committed sequence (`next_seq - 1`) and the closure row's `last_seq` both equal the `lastSeq` pin
   (`PI_SNAPSHOT_CUT_MISMATCH`).
8. The digest (SHA-256 of the whole file) and the file identity (device, inode, size, mtime, ctime) are the same before and
   after the reads (`PI_SNAPSHOT_UNSTABLE`).

The handle is opaque and frozen, exposes no path, hash, store, statement or flag, and carries derived facts retrievable with
`snapshotFacts(handle)`: method, closure row, fence epoch, cut sequence, schema version and digest. The facts are frozen.

### Reads after sealing

`withSnapshotStorage(handle, read)` re-fingerprints the file, re-checks that it is still not open for writing, opens the C7
read-only storage, runs `read`, and fingerprints again. If bytes, identity or sidecars differ at either point it refuses and
drops the result (`PI_SNAPSHOT_UNSTABLE`, `PI_SNAPSHOT_NOT_DETACHED` or `PI_STORE_READ_ONLY_SIDECARS`). The storage it passes
cannot write: `mintId`, `commit`, `acquireWriterFence` and `closeWriterFence` reject with `PI_STORE_READ_ONLY`.

### Refusal codes

| Code                                                                                                        | Meaning                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_SNAPSHOT_PINS_INVALID`                                                                                  | Pins are not exactly the six values, or a value is malformed.                                                                                                        |
| `PI_SNAPSHOT_ARTIFACT_INVALID`                                                                              | Not an absolute canonical regular file, a symlink, oversized, unreadable, not a database, or it fails the integrity check.                                           |
| `PI_SNAPSHOT_NOT_DETACHED`                                                                                  | A second hard link, or the file is open for writing in this process.                                                                                                 |
| `PI_STORE_READ_ONLY_SIDECARS`, `PI_STORE_READ_ONLY_SCHEMA_NEWER`, `PI_STORE_READ_ONLY_SCHEMA_UNINITIALIZED` | The unchanged default C7 refusals. A file that holds no readable `durable_schema` table (random bytes, an empty file, a truncated file) is refused as uninitialized. |
| `PI_SNAPSHOT_CLOSURE_MISSING`                                                                               | No closure row for the mutation id, or no fence or closure table.                                                                                                    |
| `PI_SNAPSHOT_CLOSURE_MISMATCH`                                                                              | A closure or fence field differs from the pins, or the epoch arithmetic fails.                                                                                       |
| `PI_SNAPSHOT_SUPERSEDED`                                                                                    | The fence epoch is above the closure epoch.                                                                                                                          |
| `PI_SNAPSHOT_CUT_MISMATCH`                                                                                  | The cut sequence is not the pinned `lastSeq`.                                                                                                                        |
| `PI_SNAPSHOT_UNSTABLE`                                                                                      | Bytes, identity or sidecars changed while sealing or reading.                                                                                                        |
| `PI_SNAPSHOT_NOT_ISSUED`                                                                                    | A handle that `sealSnapshot` did not issue.                                                                                                                          |

### In-process open registry

`open-registry.js` records file-backed read-write opens made through `openNodeSqliteDatabase`, keyed by device and inode (so a
hard link or another spelling is the same entry), and forgets them when that database closes. `sealSnapshot` and
`withSnapshotStorage` refuse a file that is registered. It sees only opens made through this module instance in this process:
not another process, not a second copy of the package, not a crashed owner. It exists to refuse the obvious mistake of sealing
the live store from the process that holds it. It is not a lock and not an attestation.

## Sealing boundary and the frozen receipt reader

The adapter's #1312 seam (`sealPiReceiptSnapshot`, `readPiFrozenReceipt`) is unchanged, and adapter source does not grow (the
dist budget stays at its ceiling). The glue that would sit at a real sealing boundary is therefore test-local
(`sealDetachedLedger` in the test file) and is not an issuer. It shows the intended shape:

1. Validate the session-level pins (`sessionId`, `conversationId`, `restoreGeneration`, `revision`).
2. Take `detached`, `coherent` and `ownerEpoch` only from `snapshotFacts(handle)`; never from the caller.
3. Read the held restore generation through the existing `PiRestoreGenerationEvidenceReader` for the lineage the closure names,
   so a closing, replaced or different-lineage generation is refused (`PI_RESTORE_GENERATION_EVIDENCE_CONFLICT`).
4. Replay the ledger through `withSnapshotStorage`; require the pinned conversation to exist in the snapshot and every receipt
   to belong to it (`PI_SNAPSHOT_SESSION_MISMATCH`); at most one ledger document (`PI_SNAPSHOT_LEDGER_INVALID`). An absent ledger
   document is an empty ledger: a snapshot taken before any abort receipt reads as absent, which is history only.
5. Seal through `sealPiReceiptSnapshot`. `readPiFrozenReceipt` then checks the session pin again and the whole ledger before it
   answers `found` or `absent`.

The seal's `sessionId` and `restoreGeneration` are the caller's pins, bound into the handle; the store does not contain them.
The glue guarantees only that the pins used at the boundary are the ones the reader compares, and that the restore generation
was current when it sealed. That read is a point-in-time read, not atomic write authority.

## Method B: SQLite backup (specified, not implemented)

Method B would produce the artifact from a live connection with SQLite's online backup (`sqlite3_backup`, or `VACUUM INTO`),
so the owner need not be shut down first. It is deferred because it needs a read connection to the live store (a production
path), produces a consistent page image but proves nothing about closure by itself, and moves the attestation question rather
than removing it. If it is ever implemented it must:

- run only against a store whose fence epoch equals a closure epoch the caller pins, and verify, on the produced file, the same
  coherence rule above (closure row, fence epoch, cut, digest) rather than trusting the backup call;
- write to a fresh exclusive path and never into the live directory's sidecar names;
- produce an artifact that `sealSnapshot` seals with `method` distinct from `closed-checkpointed-copy`, so a reader can tell the
  two apart; and
- keep every statement above about quiescence, provenance and authority unchanged.

It needs its own approval, tests and root review before any code.

## Tests and the mutation proof

Local, on Bun 1.4.4 over temporary SDK copies and disposable files. Nothing is written outside the scratch directory, which
the test removes by its own run directories only.

- Eighteen scenarios, each pinned to the exact code it must answer with, including a clean seal, every pin-versus-row and
  pin-versus-fence comparison on isolated tampers, epoch arithmetic, a lower fence epoch, a successor acquiring the fence,
  the `lastSeq` and `next_seq` cut checks, hard link, symlink, symlinked directory and in-process open.
- Pin validation (21 malformed shapes, read-once), forged handles, missing closure and missing closure table, sidecars of each
  kind, a successor's uncheckpointed WAL copied beside the file, garbage, empty, truncated and damaged artifacts, bytes changed
  between sealing and a read and during a read, a sidecar that appears later, a sealed file later opened for writing, and the
  read-only storage's write refusals.
- The glue and reader: found and absent from a coherent snapshot, equal to a read-write reopen of a byte copy; empty ledger;
  malformed, wrong-conversation and wrong-restore-generation pins at the boundary; the session pin again at the reader; a
  foreign-conversation receipt; and a ledger altered after the cut.
- Mutation proof: eighteen entries, each rebuilding an SDK copy with exactly one candidate check weakened and requiring the
  scenario that check exists for to answer something else, with the answer pinned. Fifteen weakenings fail open to a seal. Two
  move to a different refusal that a second check still provides (superseded falls to closure mismatch; an unregistered
  writer is caught by its sidecars), and one weakening makes a closed writer stay registered forever (refused after close).

Not covered by an isolated probe, so not proven by the mutation run: `PRAGMA quick_check` (a damaged-page test covers the
behaviour but a second layer also answers), the before/after fingerprint comparison inside `sealSnapshot` itself (a race inside
one call cannot be forced deterministically; `withSnapshotStorage`'s equivalent is probed), the sidecar presence check (the C7
open repeats it), and the test-local glue's own checks, which are asserted directly rather than mutated.

## Limits to carry forward

- Out-of-band attestation stays with the caller: that the owner process stopped, that the copy came from the named store, and
  that nothing else wrote to the original between the closure and the copy that the closure row does not already fence.
- Another process opening the original does not change the copy. A successor that acquired the fence before the copy is
  visible in the copy (`PI_SNAPSHOT_SUPERSEDED`); one that acquires it afterwards is outside the artifact and not detected.
- A replayed older copy of the same store still seals if the pins match it; pins identify a cut, not recency. Recency is the
  restore generation authority's job and the glue only reads it at one instant.
- Digest stability across the reads shows the bytes did not change while the SDK read them, not that they were never changed.
- C2, C4 and C7 are candidates too. This candidate inherits their schema (migration 3 is not rollback-safe) and every limit
  stated in `docs/pi-durable-c7-read-only-open-spec.md` and the C4 README.
- Dist budget: the adapter's dist is at its ceiling. This candidate adds no adapter source; adopting it would add SDK patch
  surface and a real issuer, each needing their own review.
