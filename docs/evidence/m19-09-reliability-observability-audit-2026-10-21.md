# M19.09 reliability, observability, recovery and production-operations audit (#194)

Status: **incomplete.** This is a source-and-evidence record for
[issue #194](https://github.com/adea-ai/control-plane/issues/194). It is not
deployed acceptance, not an incident sign-off, and not permission to delete
production data, restore a production snapshot or take a production action.

Issue #194 asks for a _proof_ that the portable Control Plane can be deployed,
observed, operated, degraded, recovered, upgraded and rolled back across the
managed-cloud, Local and Self-hosted profiles. Most of that proof is
operational, and every operational gate in this record is listed as an open
blocker with its owner rather than being asserted.

## Recovered scope

The issue's scope is tracked in the requirements ledger, which names the owner
and severity of every remaining finding. At this commit the ledger records:

| Surface                                                                           | #194-owned gap | Owner                                                                                    | Severity |
| --------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------- | -------- |
| `deploymentProfiles` — `cloud` (Railway + Neon + R2 + Restate + remote transport) | yes            | `managed-cloud`                                                                          | high     |
| `deploymentProfiles` — `local` (all-in-one Bun + node:sqlite + embedded queue)    | yes            | `local-control-plane`                                                                    | high     |
| 13 requirements (lanes `recovery/chaos` 6, `integration` 7)                       | yes            | `artifact-integration` 3, `durable-execution` 5, `context-provider` 3, `observability` 2 | high     |

The two deployment-profile gaps and ten of the thirteen requirement gaps need
live, hosted, packaged-desktop, native, billing or provider evidence, and are
therefore **not** closable by a source-only change. §"Open blockers" lists each
one with its reason.

## Recovered preserved work — durable-data retention and deletion

This is the part of #194 that is already built, and it is built around two
source artifacts that the issue itself owns:

- `packages/config/src/retention-policy.ts` — _"Durable-data retention policy
  (#194). … Those decisions were recorded on 2026-09-24; this module is their
  machine-readable form."_ 21 durable classes, each with a retention window
  (`retainMs: null` means reference-governed: retained while a reference or
  lifecycle state requires it) and a `holdOwner`.
- `scripts/retention-classes.mjs` — _"The retention class registry (#194): one
  place that says, for every class with an implemented deletion path, which
  backend classes and methods serve it."_

The two surfaces agree, and the agreement is now asserted in both directions.
At this commit:

| State                                                                                           | Count  | Classes                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deletion path implemented on the registered backends                                            | **11** | `command-inbox`, `retired-command-keys`, `execution-events`, `executions`, `context-packages`, `evaluation-runs`, `audit-records`, `execution-plans`, `interaction-receipts`, `runtime-ledgers`, `messaging`                                                   |
| Reference-governed by the owner decision (no path needed, and a path would be unreachable code) | **4**  | `project-state`, `state-proposals`, `native-admission-fences`, `checkpoints`                                                                                                                                                                                   |
| **Finite window decided, no deletion path yet**                                                 | **6**  | `native-terminal-snapshots` (30 d, `runtime-owner`), `workflow-references` (30 d, `platform-operator`), `usage` (400 d, `billing-owner`), `logs-traces` (30 d, `platform-operator`), `artifacts` (90 d, `release-owner`), `backups` (7 d, `platform-operator`) |

The 11 implemented classes have real deletion paths on both stores
(`deleteEligibleInbox`, `deleteEligibleEvents`, `deleteEligibleExecutions`,
`deleteEligibleContextPackages`, `deleteEligibleExecutionPlans`,
`deleteEligibleRuntimeCommands`, `deleteEligibleEvaluationRuns`,
`deleteEligibleReleaseAuditRecords`, `deleteEligibleRetiredCommandKeys`,
`sweepEligibleInteractionReceipts`, `sweepEligibleMessaging`), an operator
surface (`scripts/retention-apply.mjs`, `scripts/retention-reapply.mjs`,
`scripts/retention-hold-admin.mjs`, `scripts/retention-hold-operator.mjs`,
`scripts/retention-report.mjs`, `scripts/retention-production-dry-run.mjs`) and
restore-time reapplication from a durable journal
(`packages/database/src/retention-reapplication.ts` — _"Reapplies a deletion
journal to a restored PostgreSQL copy (#194) … The journal is at-least-once …
journal content is never turned into SQL."_).

**New in this change:** the six remaining classes are now an explicit,
machine-checked list rather than an absence. `tests/m11-retention-class-registry.test.mjs`
asserts that every policy class with a finite duration either has a registered
deletion path or is one of those six, and that each of the six names the
`holdOwner` the decided policy records. Adding a deletion path for one of them,
or deciding a finite window for a new class, fails that assertion until the
list is updated. The remaining #194 retention scope therefore cannot widen
silently.

## Closed in this change — terminal-state disagreement is a first-class incident

The ledger requirement **CP-CONS-024** ("Terminal disagreement precedence",
owner `durable-execution`) is `partially_verified`. Its adjudicated disposition
reads:

> the authoritative-resolution half is proven: the Control Plane record wins,
> runtime terminal claims without recorded references are never adopted, lost-ACK
> outcomes are recovered exactly once, and disagreements park in
> `reconciliation_required` with manual-intervention metrics and operator
> incident contracts. **Remaining: no first-class incident record type for
> terminal-state disagreement and no explicit administrative override path exist
> in the candidate** — override semantics are currently operator-runbook level
> (docs/operations.md).

This change closes the **first-class incident record** half:

- `packages/domain/src/execution-incident.ts` (new) — the `execution-incident/v1`
  record: a stable `incidentId`, `kind: 'terminal_state_disagreement'`,
  `severity: 'high'`, `owner: 'durable-execution'`, the execution and attempt
  identity, the reconciliation reason, the detection instant, the bounded
  diagnostic facts, `authoritativeResolution: 'control_plane_execution'` and
  `administrativeOverride: 'unavailable'`.
- `packages/domain/src/execution-reconciliation.ts` — the reconciliation service
  produces that record for every terminal-state disagreement and exposes it
  through `reconcileWithIncident()`. `reconcile()` is unchanged.
- `packages/domain/src/execution-reconciliation.test.mjs` — focused coverage: the
  record's shape and bounded evidence, the identity staying stable across
  replays and differing per attempt, and no record for a healthy or manually
  intervened observation.

Two properties are deliberate. The record carries **no runtime payload, result
body, credential or sensitive content** — only identifiers, the reason and the
same bounded diagnostic strings the checkpoint already carries. And
`administrativeOverride` is the literal `'unavailable'`, not an omitted field, so
no consumer can read the absence of an override path as an available override.

The **administrative override path** is explicitly _not_ implemented here: it is
an authority surface, and this change does not infer production authority.

## Open blockers — each needs evidence or authority this change must not assume

| #   | Blocker                                                                                                                                                               | Owner                      | Why it is not closable here                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Bounded staging evidence for the full frozen M11 runtime and recovery matrix; production readiness, capacity and timed recovery                                       | `managed-cloud`            | Railway/Neon/R2 live evidence; the deployment-profile gap is an operational gate                                                                                       |
| B2  | Repeat the operability matrix from a commit-pinned packaged desktop candidate and record the exact environment identity                                               | `local-control-plane`      | packaged desktop build and acceptance; not a source change                                                                                                             |
| B3  | Artifact cloud promotion, per-class artifact retention, provider migration and dual-read/dual-write                                                                   | `artifact-integration`     | no cloud promotion or multi-provider artifact flow exists; a new capability plus real provider evidence                                                                |
| B4  | Provider removal/replacement semantics, provider error taxonomy, memory-write proposal reconciliation                                                                 | `context-provider`         | the remaining halves are provider- and effect-authority-scoped, not offline-closable                                                                                   |
| B5  | Explicit protected logical-execution retention with indexed eligibility, holds, replay protection and authorized physical deletion                                    | `durable-execution`        | the deletion paths for the registered classes are built; the _protected_ retention class and the per-class holds/references are not                                    |
| B6  | Incident tabletop for the ten incident classes; every finding needs severity, owner, regression evidence and due date                                                 | root                       | human acceptance                                                                                                                                                       |
| B7  | The administrative override path for a terminal-state disagreement                                                                                                    | `durable-execution` / root | an authority surface; the record states its absence rather than inventing one                                                                                          |
| B8  | Durable persistence of the incident record in the Control Plane store                                                                                                 | `durable-execution`        | `reconciliation_checkpoints` is a column-typed table, so a stored incident needs a migration; the record is a value the host may persist in its own store              |
| B9  | Threading the accepted request's trace into the remote managed-pi dispatch envelope (CP-CONS-030)                                                                     | `observability`            | the accepted request's trace is not carried by the execution, the plan, the workflow input or the context package, so the authoritative carrier is a contract decision |
| B10 | Consistency series for provider latency/error/timeout, contribution rebuild/rejection, memory-write duplicate/reconciliation and sequence-gap detection (CP-CONS-031) | `observability`            | new cataloged metric surface; provider latency additionally needs a metric kind beyond the count-only adapter, and sequence-gap detection needs a detection rule       |

## What this record does not claim

It does not claim the #194 acceptance criteria are met, that any profile is
certified, that any incident is closed, or that any operational evidence is
current. It does not close the issue. A recovery unit test is not operational
acceptance, and every operational gate above stays open until its owner records
live evidence against a frozen candidate.
