# LangGraph legacy drain and retirement controls (M16.03, #940)

Status: repository-side controls only. Nothing here shuts down, deletes, converts, reconciles or migrates work. The implementation is `packages/langgraph-adapter/src/legacy-retirement.ts`, with tests in `legacy-retirement.test.mjs`.

## Controls

- **Version and deprecation marker.** `LEGACY_GRAPH_API` marks the `graphs` v1 routes (`deprecate`, `publish`, `resolve`, `revoke`) as deprecated. The test reads the controller source and fails if the route set diverges. No HTTP behavior changes.
- **Bounded reader.** `readLegacyRemainder` pages the `langgraph-checkpoints-v1`, `executions` and `execution-plans` namespaces through the persistence transaction `scan` (1 to 128 records per page, with a per-namespace record budget). It reports exact counts only when every namespace was read completely. Otherwise the counts are lower bounds and `observation` is `incomplete`.
- **Live work visibility.** A checkpoint thread is classified from its execution state. Non-terminal executions without a thread are reported as `execution-only` work. `reconciliation_required` is an `uncertain-effect` blocker.
- **Zero claims.** A disposable store never establishes zero (`DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO`). A `deployed-dsn` zero requires complete reads and an attestation. This repository has no producer for either.
- **Selected durable owner.** `planLegacyDrain` keeps the legacy saver as owner unless an evidence-equivalent replacement exists for the item's exact graph and its profile and failure evidence is proven. Any blocker or incomplete read retains the checkpoint namespace and the saver composition.
- **Fencing.** `claimLegacyDrainFence` and `releaseLegacyDrainFence` use a revision-checked record in the existing persistence transaction, so the fence survives a restart. `createLegacyResumeFence` can be injected into the adapter as `resumeFence`. When injected, `resume` and `continue` are refused for a fenced thread. The default composition injects nothing.
- **New-admission gate.** `evaluateLegacyAdmissionGate` defaults to `open`. Closure is eligible only with deployed-dsn zero, evidence for every admissible graph, and an explicit closure request. `createLegacyAdmissionGuard` can be injected as `admissionGuard`. No composition injects it, and nothing in this repository sets a closure request.

## Removal condition

Stated in `LEGACY_GRAPH_API.removalCondition`: zero retained legacy threads in deployed-dsn scope from complete reads with an attestation, every admissible legacy graph version covered by an evidence-equivalent replacement report, and profile and failure evidence proven for each replacement.

## Not done and still open

- No attested deployed-dsn inventory is available to this repository. Deployed counts are unknown here.
- The replacement evidence producer (#939's compatibility validator, merged in #990) is not wired as an input. The gate consumes typed outcomes only.
- The profile and failure evidence producer belongs to the recovery owner (#1048). It is not merged.
- The fence and the guard are not wired into any composition.
- No shutdown, retirement, live deletion or checkpoint conversion. Checkpoint transplantation and cross-harness conversion are outside the approved boundary.

## Overlap

- #939 owns `packages/domain/src/replacement-compatibility.ts`. This change does not modify it.
- #1048 owns the `pi-durable-adapter` and profile-recovery paths. This change does not modify them.
- #1052 owns the M17 retirement gate in `apps/local-control-plane`. That gate is separate and is not modified here.
