# LangGraph legacy drain and retirement controls (M16.03, #940)

Status: repository-side controls only. Nothing here shuts down, deletes, converts, reconciles or migrates work. The implementation is `packages/langgraph-adapter/src/legacy-retirement.ts`. Tests: `legacy-retirement.test.mjs` (controls), `legacy-retirement-scenarios.test.mjs` (disposable-state scenarios), with shared helpers in `legacy-retirement.fixture.mjs`.

## Controls

- **Version and deprecation marker.** `LEGACY_GRAPH_API` marks the `graphs` v1 routes (`deprecate`, `publish`, `resolve`, `revoke`) as deprecated. The test reads the controller source and fails if the route set diverges. No HTTP behavior changes.
- **Bounded reader.** `readLegacyRemainder` pages the `langgraph-checkpoints-v1`, `executions` and `execution-plans` namespaces through the persistence transaction `scan` (1 to 128 records per page, with a per-namespace record budget). It reports exact counts only when every namespace was read completely. Otherwise the counts are lower bounds and `observation` is `incomplete`. Checkpoint rows that fail the reader's schema are counted as `unparseableCheckpointRecords`, and those with a version other than 1 are also counted as `unsupportedVersionCheckpointRecords`. Plan records are counted as `unparseablePlans` and `plansUnverified`.
- **Live work visibility.** A checkpoint thread is classified from its execution state. Non-terminal executions without a thread are reported as `execution-only` work. `reconciliation_required` is an `uncertain-effect` blocker.
- **Zero claims.** A disposable store never establishes zero (`DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO`). A `deployed-dsn` zero requires complete reads, an attestation, no retained threads, no in-flight or malformed executions, and no unparseable checkpoint records. This repository has no producer for a deployed observation or an attestation.
- **Selected durable owner.** `planLegacyDrain` keeps the legacy saver as owner unless an evidence-equivalent replacement exists for the item's exact graph and its profile and failure evidence is proven. A plan that fails canonical verification yields `PLAN_UNVERIFIED` and is never trusted for graph identity. `retainedDependencies` names the checkpoint namespace and the saver composition until the removal condition is satisfied, not merely until handoff is possible.
- **Fencing.** `claimLegacyDrainFence` returns a `LegacyDrainFenceClaim` (`storageThreadId`, `owner`, `generation`, `revision`). The live record and the per-thread generation counter are written with the persistence layer's revision CAS, so the fence survives a restart. Generations live in `langgraph-legacy-drain-fence-generations`, which no release deletes, so a reclaim never reuses one. Claiming again by the same owner while held is idempotent: it returns the same handle and spends no generation. `releaseLegacyDrainFence` takes the exact handle. A stale handle is refused with `LEGACY_DRAIN_FENCE_STALE` and a handle for another owner with `LEGACY_DRAIN_FENCE_NOT_OWNED`. Neither refusal deletes anything. Persisted fence records that fail to parse fail closed. `createDeclarativeGraphAssembly` requires the adapter's `resumeFence` port, and `resume` and `continue` are refused for a fenced thread. Local: `ManagedLocalGraphRuntime` fences its SQLite store with the module functions. Hosted: `PostgresLegacyDrainFenceRepository` (`packages/database/src/legacy-drain-fence-repository.ts`) stores fences in `langgraph_legacy_drain_fences`. That table is migration `0069`, in source only, and is not applied to any deployed database. Rows are never deleted: a release clears the owner and advances the revision, so generations and revisions are not reused. Hosted claim and release use the same semantics. A store error refuses resume (fail closed).
- **New-admission gate.** `evaluateLegacyAdmissionGate` defaults to `open`. Closure is eligible only with deployed-dsn zero, evidence for every admissible graph, and an explicit closure request. `createDeclarativeGraphAssembly` requires the adapter's `admissionGuard` port. Hosted observes no deployed inventory, so its `AdmissionEvidence.remainder` is absent and reported as `REMAINING_NOT_OBSERVED`. That is never closure-eligible, so hosted admissions stay open. Local reads its disposable store and stays open for the same reason. Nothing in this repository sets a closure request. A retained uncertain effect on the requested execution refuses that admission with `LEGACY_ADMISSION_UNCERTAIN_EFFECT_RETAINED`, whatever the gate says. The check is per execution, so other executions are not refused, and the refusal lifts once the control plane reconciles the effect. Only the hosted composition performs this check.

## Removal condition

Stated in `LEGACY_GRAPH_API.removalCondition`: zero retained legacy threads in deployed-dsn scope from complete reads with an attestation, every admissible legacy graph version covered by an evidence-equivalent replacement report, and profile and failure evidence proven for each replacement.

Coverage is checked against the admissible graphs the caller supplies. With none supplied, removal is never satisfied (`NO_ADMISSIBLE_GRAPHS_OBSERVED`). A zero count alone never satisfies it. The module performs no removal.

## Operator status

`buildLegacyOperatorStatus({ remainder, plan, admission? })` returns a bounded, JSON-serializable object. It is read-only and contains no store path, record payload or secret. Entry identities are storage thread ids (`wsp_…:exe_…:<thread>`) or `execution:exe_…`.

| Field                  | Meaning                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scope`                | `disposable-local-store` or `deployed-dsn`. A disposable status never supports a zero claim.                                                                                                                                           |
| `readComplete`         | False when a namespace hit its read budget. Counts are then lower bounds, and `exact` is false.                                                                                                                                        |
| `zero`                 | `established` is true only when deployed scope, an attestation, complete reads and no blocking records all hold. `reasons` lists what blocks zero.                                                                                     |
| `counts`               | Totals for threads, execution-only work, checkpoint and write rows, unparseable and unsupported-version rows, executions, in-flight and malformed executions, plans, unparseable and unverified plans, and a per-classification tally. |
| `blockers`             | Tally of blocker codes across work items.                                                                                                                                                                                              |
| `owners`               | Tally of the selected owner. Every item stays with `legacy-langgraph-saver` until its evidence proves otherwise.                                                                                                                       |
| `retainedDependencies` | The checkpoint namespace and saver composition. Empty only when removal is satisfied.                                                                                                                                                  |
| `removal`              | The removal condition, `satisfied`, and the reasons it is not satisfied.                                                                                                                                                               |
| `admission`            | The new-admission gate decision and reasons, when supplied.                                                                                                                                                                            |
| `items`                | `total`, `shown` (at most `LEGACY_STATUS_ITEM_LIMIT` = 25), `truncated`, and entries in identity order. Each entry gives its classification, execution state, plan verification, selected owner, owner reasons and blockers.           |

What blocks:

| Code                                                                                               | Meaning                                                                                 |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `IN_FLIGHT_WORK`                                                                                   | The execution is non-terminal.                                                          |
| `UNCERTAIN_EFFECT_UNRECONCILED`                                                                    | The execution is `reconciliation_required`. Control-plane reconciliation is needed.     |
| `ORPHANED_THREAD`                                                                                  | A checkpoint thread has no execution record.                                            |
| `THREAD_EXECUTION_MISMATCH`, `THREAD_IDENTITY_UNPARSEABLE`                                         | The thread identity conflicts with its execution, or cannot be parsed.                  |
| `EXECUTIONS_NOT_FULLY_READ`                                                                        | The thread's execution could not be checked because the executions read was incomplete. |
| `READ_INCOMPLETE`                                                                                  | A read budget was hit. The item is not handoff-eligible.                                |
| `GRAPH_IDENTITY_UNKNOWN`                                                                           | No verified plan or graph reference exists for the item.                                |
| `PLAN_UNVERIFIED`                                                                                  | A plan record exists but fails canonical verification.                                  |
| `NO_COMPATIBLE_REPLACEMENT_EVIDENCE`, `EVIDENCE_DIVERGENT`, `PROFILE_OR_FAILURE_EVIDENCE_UNPROVEN` | Why the legacy owner stays.                                                             |
| `RETAINED_THREADS_PRESENT`                                                                         | Any checkpoint thread remains, terminal or not.                                         |
| `UNPARSEABLE_CHECKPOINT_RECORDS_PRESENT`                                                           | A checkpoint row failed the reader's schema, so it cannot be ruled out as live work.    |
| `IN_FLIGHT_EXECUTIONS_PRESENT`, `MALFORMED_EXECUTION_RECORDS_PRESENT`                              | Non-terminal or malformed execution records remain.                                     |
| `DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO`, `DEPLOYED_ATTESTATION_MISSING`                           | Why zero is not established.                                                            |
| `ADMISSIBLE_GRAPHS_NOT_COVERED`, `NO_ADMISSIBLE_GRAPHS_OBSERVED`, `LEGACY_OWNER_RETAINED`          | Why removal is not satisfied beyond zero.                                               |

## Pinned pre-existing behavior (not changed here)

- **Foreign checkpoint rows.** The saver parses every row in `langgraph-checkpoints-v1` with a strict schema on each read. One row of another version makes every saver resume in that namespace return `status: 'failed'` with `RESUME_FAILED` and `retryable: true`, and the finalize step does not run. A retry does not clear it, and an operator must handle the row. The reader counts it and blocks zero. The scenario test pins this result.
- **Payload version.** The reader does not inspect the checkpoint payload's `v` field, which the saver requires to be 4. A payload-version mismatch is therefore not reported here. The row still counts as a retained thread, so zero stays blocked.
- **Reader schema is lighter than the saver's.** A row that passes the reader's schema but fails the saver's strict schema is counted as retained work. It blocks zero but is not reported as unparseable.

## Scenario coverage (disposable state)

`legacy-retirement-scenarios.test.mjs` runs each condition against real sqlite stores. Stores are closed and reopened where a restart is part of the scenario.

- **Restart with retained work.** Three threads (interrupted, completed, orphaned) survive a restart. The interrupted thread resumes after the restart, and only the remaining step runs. Zero stays blocked, including under a caller-asserted deployed scope with an attestation.
- **Uncertain effect across restart.** The effect blocks handoff. Reconciliation observed after the restart makes the thread terminal, but zero is still not established.
- **Incompatible replacement.** Divergent or unproven evidence keeps the legacy owner, and the gate stays open. Fully proven equivalence hands the item off once it is terminal, and removal is still blocked while the thread is retained.
- **Removal arithmetic.** A caller-asserted deployed scope on an empty store is a labeled arithmetic check, not a deployed observation. Removal needs admissible-graph coverage. A divergent replacement blocks it, and the gate stays open.
- **Version mismatch.** A version-2 row and an unversioned row are both unparseable, and only the first is unsupported. Zero is blocked. Saver resume returns `RESUME_FAILED` (see pinned behavior above).
- **Plan verification.** An incomplete plan record yields `PLAN_UNVERIFIED`. A plan record that cannot be identified is counted as unparseable.
- **Status.** A mixed store reports every retained shape without paths. More than 25 items are truncated to 25 in identity order, and the full total is reported. The route marker matches the controller decorator.

## Integration lane

Registered in `scripts/integration-shards.mjs`, and `tests/integration-shards.test.mjs` checks that every integration file has exactly one owner:

- Shard 2, `packages/database`: `src/legacy-drain-fence-repository.integration.test.mjs`. Real disposable PostgreSQL: two owners race for one thread, the generation and revision advance exactly, a stale or foreign handle is refused, concurrent claims admit one owner, and a store that cannot be read refuses resume.
- Shard 3, `apps/hosted-control-plane`: `src/hosted-graph-legacy-fence.integration.test.mjs`. Real disposable PostgreSQL through `HostedServerGraphRuntime`: two-owner fencing with exact release, owner races across twelve rounds, a disconnected fence store refusing claim, release and resume, a retained uncertain effect refusing admission until it is reconciled, and an open gate without deployed inventory.

Shard placement was chosen without measured timings for these files. Measure them before relying on shard budgets.

## Example status

The output below is the complete status for `buildMixedStore` in `legacy-retirement.fixture.mjs`. That is a disposable store holding every retained shape at once. It is not a deployed observation.

<details>
<summary>Full status output</summary>

```json
{
  "schema": "langgraph-legacy-operator-status/v1",
  "api": {
    "path": "graphs",
    "version": "1",
    "lifecycle": "deprecated"
  },
  "scope": "disposable-local-store",
  "readComplete": true,
  "exact": true,
  "zero": {
    "established": false,
    "reasons": [
      "DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO",
      "RETAINED_THREADS_PRESENT",
      "IN_FLIGHT_EXECUTIONS_PRESENT",
      "UNPARSEABLE_CHECKPOINT_RECORDS_PRESENT"
    ]
  },
  "counts": {
    "threads": 3,
    "executionOnly": 1,
    "checkpoints": 6,
    "writes": 12,
    "unparseableCheckpointRecords": 1,
    "unsupportedVersionCheckpointRecords": 1,
    "executions": 3,
    "inFlightExecutions": 3,
    "malformedExecutions": 0,
    "plans": 1,
    "unparseablePlans": 0,
    "plansUnverified": 1,
    "byClassification": {
      "in-flight": 2,
      "uncertain-effect": 1,
      "terminal": 0,
      "orphaned": 1,
      "unclassified": 0,
      "unknown": 0
    }
  },
  "blockers": {
    "UNCERTAIN_EFFECT_UNRECONCILED": 1,
    "IN_FLIGHT_WORK": 2,
    "ORPHANED_THREAD": 1
  },
  "owners": {
    "legacy-langgraph-saver": 4
  },
  "retainedDependencies": [
    "langgraph-checkpoints-v1 namespace",
    "LangGraph checkpoint saver composition"
  ],
  "removal": {
    "condition": "Zero retained legacy threads in deployed-dsn scope from complete reads with an attestation, every admissible legacy graph version covered by an evidence-equivalent replacement report, and profile and failure evidence proven for each replacement. This module performs no removal.",
    "satisfied": false,
    "reasons": [
      "DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO",
      "RETAINED_THREADS_PRESENT",
      "IN_FLIGHT_EXECUTIONS_PRESENT",
      "UNPARSEABLE_CHECKPOINT_RECORDS_PRESENT",
      "ADMISSIBLE_GRAPHS_NOT_COVERED",
      "LEGACY_OWNER_RETAINED"
    ]
  },
  "admission": {
    "decision": "open",
    "reasons": [
      "REMAINING_NOT_DEPLOYED_SCOPE",
      "REMAINING_ZERO_NOT_ESTABLISHED",
      "REPLACEMENT_NOT_EQUIVALENT:deterministic-interrupt@1.0.0",
      "PROFILE_UNPROVEN:deterministic-interrupt@1.0.0",
      "FAILURE_UNPROVEN:deterministic-interrupt@1.0.0",
      "CLOSURE_NOT_REQUESTED"
    ]
  },
  "items": {
    "total": 4,
    "shown": 4,
    "truncated": false,
    "entries": [
      {
        "identity": "execution:exe_01JABCDEF0123456789ABCDEFK",
        "kind": "execution-only",
        "classification": "in-flight",
        "executionState": "queued",
        "planVerification": "absent",
        "selectedOwner": "legacy-langgraph-saver",
        "ownerReasons": ["GRAPH_IDENTITY_UNKNOWN"],
        "blockers": ["IN_FLIGHT_WORK"]
      },
      {
        "identity": "wsp_01JABCDEF0123456789ABCDEFG:exe_01JABCDEF0123456789ABCDEFG:thread-legacy-1",
        "kind": "checkpoint-thread",
        "classification": "in-flight",
        "executionState": "awaiting_input",
        "planVerification": "unverified",
        "selectedOwner": "legacy-langgraph-saver",
        "ownerReasons": ["PLAN_UNVERIFIED"],
        "blockers": ["IN_FLIGHT_WORK"]
      },
      {
        "identity": "wsp_01JABCDEF0123456789ABCDEFG:exe_01JABCDEF0123456789ABCDEFH:thread-uncertain",
        "kind": "checkpoint-thread",
        "classification": "uncertain-effect",
        "executionState": "reconciliation_required",
        "planVerification": "absent",
        "selectedOwner": "legacy-langgraph-saver",
        "ownerReasons": ["GRAPH_IDENTITY_UNKNOWN"],
        "blockers": ["UNCERTAIN_EFFECT_UNRECONCILED"]
      },
      {
        "identity": "wsp_01JABCDEF0123456789ABCDEFG:exe_01JABCDEF0123456789ABCDEFM:thread-orphan",
        "kind": "checkpoint-thread",
        "classification": "orphaned",
        "planVerification": "absent",
        "selectedOwner": "legacy-langgraph-saver",
        "ownerReasons": ["GRAPH_IDENTITY_UNKNOWN"],
        "blockers": ["ORPHANED_THREAD"]
      }
    ]
  }
}
```

</details>

## Not done and still open

- No attested deployed-dsn inventory is available to this repository. Deployed counts are unknown here.
- The replacement evidence producer (#939's compatibility validator, merged in #990) is not wired as an input. The gate consumes typed outcomes only.
- The profile and failure evidence producer belongs to the recovery owner (#1048). It is not merged.
- Hosted fence table `langgraph_legacy_drain_fences` (migration `0070`, renamed from `0069` to leave `0069` for #1052) was applied under the name `0069` through the migration role to one owned disposable database. The rename does not change the file content, so its applied hash still matches the source file. No deployed database has it, and no production migration or deployment is authorized here. The migration alone grants the application role no privileges. The test harness grants them, and the production grant procedure is not verified here.
- Local composition does not refuse admission on a retained uncertain effect. Only the hosted composition does.
- Operator surfaces are absent. `legacyDrainFence.claim` and `legacyDrainFence.release` on the hosted and local runtimes, and the local `legacyRetirementStatus()`, have no CLI or route.
- The reader does not read LangGraph's PostgreSQL checkpoint tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`) that the hosted runtime uses. Hosted retained-work inventory is therefore not measured.
- No shutdown, retirement, live deletion or checkpoint conversion. Checkpoint transplantation and cross-harness conversion are outside the approved boundary.

## Overlap

- #939 owns `packages/domain/src/replacement-compatibility.ts`. This change does not modify it.
- #1048 owns the `pi-durable-adapter` and profile-recovery paths. This change does not modify them.
- #1052 owns the M17 retirement gate in `apps/local-control-plane`. That gate is separate and is not modified here.
