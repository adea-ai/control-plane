# CANDIDATE — Session admission sealing for Pi Durable 1.1.0 (not consumable)

Offline candidate. It is an uncompiled patch (`c4b-session-admission-sealing.candidate.patch`) that applies to a
**temporary copy** of the installed SDK package, on top of the compatibility patch, the C2 store fence, the C4 writer
closure and the C7 read-only open, in that order. Nothing here is wired into the adapter, the build or a runtime path,
and the installed package is never touched. It adds no compiled output, so the dist budget is unchanged.

**Not consumable:** no issuer, no live capture, no SDK adoption switch, no activation, and no live store.

## What it adds

`Session.closeWriters({ mutationId }, context)`, inherited by the Harness. It is the Session-level half of the
contract's `closeWriters`. C4 gave the storage a `closeWriterFence`, but a caller had to run it on the storage while
the Session was still open, which does not settle commits the Session had already admitted (see the control test).

## Exact order

A call runs these steps in order. Steps 1 to 4 are synchronous refusals that change nothing.

| Step | What happens                                                                                                                                                                                                                                                                                                                                                                               | Outcome if it fails                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 1    | `mutationId` must satisfy C4's own rule: a string of 1 to 8192 characters with no leading or trailing whitespace. It is checked here so an ID the storage would refuse after sealing cannot seal the Session.                                                                                                                                                                              | `PI_SESSION_CLOSE_WRITERS_REQUEST_INVALID`; not sealed.                                            |
| 2    | A closure was already accepted on this Session: the same `mutationId` returns the same result; another is refused.                                                                                                                                                                                                                                                                         | `PI_SESSION_CLOSURE_CONFLICT`; nothing changes.                                                    |
| 3    | `close()` already began: admission is sealed and storage is closing, so no closure is taken.                                                                                                                                                                                                                                                                                               | `PI_SESSION_CLOSING`.                                                                              |
| 4    | The Session must not be poisoned, and the storage must have `closeWriterFence` (C4).                                                                                                                                                                                                                                                                                                       | The poison error, or `PI_SESSION_CLOSE_WRITERS_UNAVAILABLE`; not sealed, the Session stays usable. |
| 5    | **Seal admission**, synchronously: commits, reads, snapshots and subscriptions now reject `Session is closed`. The Harness mirrors it (`root()` and `conversation()` reject `Harness is closed`). Close listeners fire.                                                                                                                                                                    | —                                                                                                  |
| 6    | `beforeClose`: the Harness aborts its running task invocations at the seal and joins them. It writes no task outcome. The real join waits with `Promise.allSettled`, so it cannot reject, even when a task throws while being aborted. If an overriding `beforeClose` did reject (the documented contract forbids it; the test injects one), the closure is skipped and step 8 still runs. | The join error, raised after step 8; no closure is taken.                                          |
| 7    | **On the mutation line**, behind every commit admitted before step 5, call `storage.closeWriterFence({ mutationId })`. One storage transaction bumps the C2 epoch and inserts the C4 closure row, then the holder is unbound.                                                                                                                                                              | The storage code (for example `PI_STORE_FENCE_NOT_HELD`), raised after step 8.                     |
| 8    | Drop listeners and loaded documents, then `storage.close` (checkpoint, no sidecars left).                                                                                                                                                                                                                                                                                                  | —                                                                                                  |
| 9    | Resolve with the closure receipt, or reject with step 7's error.                                                                                                                                                                                                                                                                                                                           | —                                                                                                  |

Once step 5 has run the Session always ends closed, with its storage closed, whether the closure committed, failed, or
was skipped because the join rejected. A failed call never leaves a half-open Session.

The caller's `context` only bounds how long that caller waits. Aborting it rejects the caller's promise, but the seal, the
join, the closure and the cleanup carry on without it, and a later call with the same `mutationId` returns the receipt.

## Invariants the tests check

1. **Nothing admitted after the seal reaches storage.** A commit started after step 5 rejects without calling
   `storage.commit` or `storage.commitGuarded`.
2. **Admitted commits settle first.** A commit already on the line, even one held up inside its own preparation, commits
   before the closure, and the receipt's `lastSeq` equals the highest sequence in the file. The ledger a read-only (C7)
   reader sees is exactly those commits.
3. **One closure per Session.** A repeat with the same `mutationId` returns an equal receipt and bumps no epoch; a
   different `mutationId` is refused; `close()` afterwards adds nothing; `closeWriters` after `close()` began is refused.
4. **The unsealed path is worse.** With only the C4 storage call, an admitted commit loses the race and fails
   `PI_STORE_FENCED`; admission stays open, so each later caller is fenced one at a time. Both leave the file unchanged
   after the closure, but only `closeWriters` makes the closure the cut of the commits that were admitted.
5. **Fail closed.** No fence held: `PI_STORE_FENCE_NOT_HELD`, with the Session and storage closed and no closure row. A
   poisoned Session and a storage without `closeWriterFence` are refused before sealing.
6. **Validation matches C4 and runs before sealing.** Whitespace-padded IDs, IDs over 8192 characters and non-strings are
   refused by both layers; each leaves the Session usable, and a corrected retry (including a 8192-character ID) works.
7. **Tasks are joined before the closure.** A running task is aborted at the seal and has ended before the closure is
   taken (ordering log in the test). A task that throws while being aborted does not stop the closure. No real Harness
   join failure was observed; a rejecting join is injected into a plain Session to prove cleanup (no closure, Session and
   storage closed).
8. **Cancellation does not cancel the closure.** An aborted or already-aborted caller context rejects that caller only; a
   same-`mutationId` retry gets the receipt and the file holds exactly one closure.

## Test

`packages/pi-durable-adapter/src/candidate-c4b-session-admission-sealing.test.mjs` copies the installed SDK into a
temporary directory next to the installed package, applies the five patches there only, and runs a genuine Harness on
disposable SQLite files. It removes only the directories it created. It changes neither the installed package nor any
repository file, and it opens no live store.

## Not in this candidate

- **Retry safety across Sessions, storages and processes.** The same-`mutationId` replay works on one Session object only.
  A reopened Session has no memo, and the C4 storage-level replay has the same limit. The reference model does not
  prove otherwise.
- **Task semantics.** Harness tasks that try to commit after the seal are rejected exactly as with `close()`. This slice
  does not change how tasks are joined or what they write.
- **Quiescent capture, an issuer and a production caller.** None exists, and this does not describe how a store should be
  captured.
- C1 (writer-surface declaration) and other backends (C6). The C4 README now points to this candidate where it once said
  admission sealing was "a later slice".

## Rollback status: NOT rollback-safe

This patch adds no migration, but it needs C4's schema 3, so the C4 position applies unchanged. Only a byte-identical
copy preserved before a candidate first opens a store is a rollback target. No downgrade path exists and none is claimed.
