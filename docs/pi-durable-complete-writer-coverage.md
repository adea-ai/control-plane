# Writer coverage of the durable Pi state, and the restore-generation gap

## What this file is

`packages/pi-durable-adapter/src/durable-writer-coverage.test.mjs` enumerates the
modules that write the durable Pi state from the source, records per writer what
authority it actually holds, and proves the properties each one genuinely has.

It is **not** a proof of complete writer coverage. The native cancellation
boundary states its own limit in the source:

> Matching installation evidence never proves canonical R, drain D or complete
> writer coverage.

The earlier version of this file claimed to close that gap. It did not, and this
revision corrects the claim rather than narrowing the writer universe to obtain
a pass.

## What is proved

### 1. Tamper consistency

A digest binds the fields it covers. A body whose generation is changed while
its old digest is retained is refused by
`PiCancellationRetainedIntentSchema` with a `request digest mismatch`. Two
bodies that are each internally consistent but differ are an idempotency
conflict.

### 2. Tamper consistency is not restore authority

This is the limit the earlier version overstated. The digest is computed **over
the body**, so a rollback that restores the generation **and** recomputes the
digest over the rolled-back generation is internally consistent. The regression
asserts that the pure contracts accept it:

- `PiCancellationRetainedIntentSchema` accepts the rolled-back body with its
  recomputed digest.
- `PiCancellationPermitSchema` accepts a permit over the rolled-back target.
- `assertPiCancellationPermitSnapshot` accepts it when the current fence
  agrees with the same rolled-back generation.
- `assertPiNativeCancellationReceiptBinding` accepts the rolled-back generation,
  because the receipt carries the intent's own generation.

The assertion is non-vacuous: inverting it makes the test fail.

**Why.** Nothing in these pure contracts holds an independent generation
authority. `restoreGeneration` is a `Reference` that callers supply, and
`PiCancellationOwnerPort` has only one implementation,
`UnavailablePiCancellationOwner`, which throws
`PI_CANCELLATION_AUTHORITY_UNAVAILABLE`. No production consumer reads a current
fence and compares it to the target's generation. A digest over a supplied
value proves tamper consistency only.

Establishing independent, non-rewound restore-generation authority needs
production authority that does not exist in the current architecture: a
generation source that survives a snapshot restore and is not derived from the
restored snapshot. That is outside this scope and is recorded below as an open
acceptance gap.

### 3. Rewound epochs are refused where the architecture grants one

| Writer                            | Authority it holds                                 | What is proved                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cancellation-owner.ts`           | a cancellation target, a permit, a barrier epoch   | a barrier that does not advance the epoch is refused; a permit whose fence epoch is behind the current fence is refused                                                                          |
| `native-cancellation-boundary.ts` | a native target, a fence epoch, a commit receipt   | a fence request that does not advance the epoch is refused; the fence receipt must match every field of the request it answers; the commit receipt must carry the exact generation of its intent |
| `journal.ts`                      | an epoch over its own records, and a process claim | a claim or transition that expects a superseded epoch is refused with `STALE_STATE`; a released claim no longer holds the record                                                                 |
| `effect-gate.ts`                  | a revision over its own records                    | a compare-and-set against a superseded revision is refused, and the stored record is the one the successful compare-and-set wrote                                                                |
| `lease.ts`                        | a process identity on the host                     | a second owner for the same session is refused while the first holds it, and a new owner is admitted after the release                                                                           |
| `resume-permit.ts`                | an in-process identity                             | the permit is identity-bound, not shape-bound: a structurally identical literal that was never issued does not pass                                                                              |
| `upgrade-manifest.ts`             | byte identity of the store it reads                | a store that was rolled back to different bytes is refused by the manifest check                                                                                                                 |

## The writers that carry no restore generation

These write or hold durable state but have **no** independent generation
authority, so the restore-generation property is **not** proven for them:

| Writer                | Why it has no generation authority                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect-gate.ts`      | Its revision is local to the gate's own record, not a restore generation.                                                                                                                                             |
| `journal.ts`          | Its epoch is the journal's own epoch over its own record, not a restore generation.                                                                                                                                   |
| `lease.ts`            | Its ownership is a host process identity, not a generation.                                                                                                                                                           |
| `upgrade-manifest.ts` | It **reads** the store and produces a digest of it. Its own contract says "grants no execution or restore authority". It is not a writer. It detects a rolled-back store by byte identity, which is not a generation. |
| `resume-permit.ts`    | It is an in-process `WeakSet` identity and is deliberately **not** re-exported from the package entry point, so a consumer can pass a permit on but not mint one.                                                     |

The enumeration test derives the writer set from the source, so a module that
starts writing the durable state without being classified fails the file. The
classification is what each writer actually holds, not a claim that it holds
everything.

## The open acceptance gap

The full-writer restore-generation acceptance **remains open**. Two things are
missing:

1. **An independent generation authority.** Nothing outside the restored
   snapshot holds the current restore generation, so a rolled-back generation
   with a matching digest is indistinguishable from a genuine request.
2. **A writer that refuses it.** Only the two cancellation modules bind a
   generation, and they compare it against values derived from the same request
   chain rather than against an independently read current state.

Closing this needs production authority beyond the current scope. The
qualification stops here and records the gap rather than narrowing the writer
universe or weakening a comparison to make a pass.

## What this does not prove

- It does not prove native effect behaviour. The boundary refuses a mismatched
  request before any native effect; it does not observe one.
- It does not qualify a live deployment, an installed profile, or a native
  zero-effect acceptance. See
  [`pi-durable-cp1048-reconciliation.md`](pi-durable-cp1048-reconciliation.md)
  for the remaining gates.
- It does not close #1025, #1018, #1019 or #1022. It closes the
  restore-generation and all-writer sub-gaps of #1025's "revalidate ... target
  generations" and "fence one attempt owner throughout rollback" only in the
  sense of **recording them precisely**: the tamper-consistency property is
  proved, the independent-authority property is proved not to hold, and the
  writers without generation authority are named.

## Reproduction

```
bun test packages/pi-durable-adapter/src/durable-writer-coverage.test.mjs
```

The fixtures are pure contracts plus a disposable SQLite journal in a temporary
directory. No fixture supplies production authority, no live resource is
touched and no effect is performed.
