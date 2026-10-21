# Complete writer coverage of the restore generation

## The gap this closes

`packages/pi-durable-adapter/src/native-cancellation-boundary.ts` states its own
limit in a comment on the boundary observation:

> Matching installation evidence never proves canonical R, drain D or complete
> writer coverage.

Nothing in the repository proved the coverage. The phrase "every writer" and the
phrase "non-rewound" appear nowhere in the durable or profile scope before
`packages/pi-durable-adapter/src/durable-writer-coverage.test.mjs`, which
enumerates the writers from the source and proves each one refuses a rewound
epoch or a rewound restore generation.

Two properties are proved independently, because they fail independently:

1. **No writer accepts a rewound epoch or a rewound restore generation.** A
   restore cannot re-point work that a later owner has already fenced.
2. **The restore generation is independent of the snapshot it came from.** It is
   bound into the request digest, so a restore that re-points it produces a
   different request and cannot be replayed as the same one.

The second property is what makes the first meaningful: a restore generation
that were derived from the restored snapshot could be rolled back together with
it, and the fence would be satisfied by the very state it is meant to distrust.

## The writers

The registry is derived from the source: a module that accepts a cancellation
target or an epoch declares one of the target or epoch schemas. The adapter
issues the epoch and the journal records the current owner; neither accepts
one, and neither is a target-accepting writer.

| Writer                                                            | Accepts                                                                | Refuses a rewound epoch                                                                                            | Refuses a rewound restore generation                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `packages/pi-durable-adapter/src/cancellation-owner.ts`           | a cancellation target, a retained intent, a permit and a barrier epoch | the barrier schema refuses a non-advancing epoch; the permit snapshot refuses a fence epoch behind the current one | the retained intent refuses a re-pointed restore generation because the request digest no longer matches |
| `packages/pi-durable-adapter/src/native-cancellation-boundary.ts` | a native target, a preparation, a commit receipt and a fence epoch     | the fence request schema refuses a non-advancing epoch                                                             | the commit receipt must carry the exact restore generation of the intent it answers                      |

The coverage test fails when a writer is dropped from the registry, so the
registry cannot silently fall behind the source.

## What this does not prove

- It does not prove that the durable writers outside the durable adapter — the
  effect gate store, the journal, the lease, the upgrade manifest and the
  resume permit — are fenced against a restore. Those writers do not accept a
  cancellation target or an epoch, so they are outside this registry by
  construction, not by omission.
- It does not prove native effect behaviour. The boundary refuses a rewound
  request before any native effect; it does not observe one.
- It does not qualify a live deployment, an installed profile, or a native
  zero-effect acceptance. See
  [`pi-durable-cp1048-reconciliation.md`](pi-durable-cp1048-reconciliation.md)
  for the remaining gates.
- It does not close #1025, #1018, #1019 or #1022. It closes the writer-coverage
  sub-gap of #1025's "fence one attempt owner throughout rollback" and the
  restore-generation sub-gap of "revalidate ... target generations".

## Reproduction

```
bun test packages/pi-durable-adapter/src/durable-writer-coverage.test.mjs
```

The fixtures are pure contracts. No fixture supplies production authority, no
database is opened and no effect is performed.
