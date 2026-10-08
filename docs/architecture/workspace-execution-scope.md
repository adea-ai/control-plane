# Workspace execution scope

This is the additive kernel seam for runtime authority issue #932 (logical
M12.03). It does not enable a runtime or grant workspace execution authority.

Legacy project correlation remains exactly
`{workspaceId, projectId, taskId, agentId, requestId}`. Historical plans and
contexts keep schema version 1, existing canonical digests, and existing
project command and retired-command keys. Normalization helpers compare scope;
they never serialize new scope fields into historical objects.

New scope is explicit:

```ts
// No projectId field in workspace correlation.
executionScope: { schemaVersion: 1, kind: 'workspace' }
// A real matching flat projectId is required in explicit project correlation.
executionScope: { schemaVersion: 1, kind: 'project', projectId }
```

Explicit plans use schema version 2. Workspace plans require
`execution.scope.workspace.v1` with required/supported semantics. Existing
adapters and project-only operations fail closed before project reads/effects.
R1 owns the runtime capability enum, opt-in Pi adapter, SDK lead operations and
Node admission composition.

The capability prerequisite is the minimal enum and compatibility schema in
#952, merged as `c76e25c376cb19b92875f2cf3a93f19180a0067e`. Earlier local
qualification used exact immutable overlays from runtime draft #949 at
`c1fe684a0e4fd2cd5b3cd93347fe99f940d76633`, excluded from the kernel commits.
Those two files now come from canonical main. This kernel still needs fresh
exact-head qualification on that dependency, followed by full runtime
composition on the canonical kernel. The original full runtime draft is not a
merge prerequisite; earlier overlay checks alone do not qualify a new head.

Context version 2 retains the `projectState` property name for repository
compatibility and supports either explicit scope. Workspace scope carries no
project ID or state items; explicit project scope requires the matching real
project ID. SQLite and PostgreSQL enforce the same scope/version pairing.
`ContextPackageCompiler.compileWorkspace` takes a server-owned authority
revision and already authorized workspace resources. It does not invent a
project, query project state or authorize resources itself. Legacy context
compiler, authoring and provider grant operations remain project-only.

## Current admission and effect authority

`CurrentExecutionScopeAuthority.readCurrent(input)` is a server composition
port. Input binds workspace/scope, caller principal and the exact
`{executionPlanId, contentDigest, schemaVersion}` pin. Its snapshot binds the
same fields plus active principal/grant, allowed principal IDs and expiry.
Project scope additionally requires the actual project's owning workspace.
`currentExecutionScopeAllows` checks these values; request/model scope and
capability declarations are only targets/support metadata.

Explicit CommandInbox admission/replay requires `authorizeScope`. Legacy
custom validators without that method reject explicit scope. Current authority
is checked even when the historical workspace plan has been retired. Exact
project retries that normalize to a legacy key check current scope authority
against the retained winner's original plan pin, including concurrent replay.
The retained command and execution keep their historical serialization. Exact
plan validation and current catalog policy continue to apply. Effects must
recheck current authority through their adapter/composition owner; the retained
marker alone cannot grant authority. Existing native model broker and per-send
budget authority remain in force.

`deriveExecutionPlan` still denies cross-scope child creation.
`deriveExecutionPlanWithAuthority` verifies current parent and child authority
and a real same-workspace project for workspace-to-project narrowing.
`bindProjectContextPackageToWorkspaceParent` and
`assertExecutionPlanDerivedFrom` verify structural/digest lineage only. They
cannot mint a grant, audience membership or effect permission. Constraints,
context resources and budgets must remain narrowed.

## Storage and retention

PostgreSQL migration 0068 adds nullable project columns paired with explicit
scope columns and strict consistency checks. Workspace admissions use a
partial unique index; null project IDs cannot create duplicate admission keys.
No historical JSON/digests are rewritten. SQLite migration 3 adds equivalent
JSON constraints and scope uniqueness; migrations 1/2 and checksums remain
unchanged and old version 2 backups remain restorable.

Execution, command, plan, cancellation, event and context mappings preserve
scope through restarts and CAS. Workspace execution retention targets carry an
explicit scope marker so unrelated project holds do not become workspace
holds; incomplete historical targets retain fail-closed behavior. Retention,
cleanup and outcome ownership gates remain applicable.

Explicit child lineage checks apply even when optional budget reservation is
disabled. Disabling ledger reservation does not disable owner, plan or context
narrowing checks. Event replay checks retained identities before requiring a
live owner; a new event cannot hide a workspace owner's scope by supplying
legacy project fields. SQLite context scope constraints also cover the nested
`projectState` representation.

## Qualification and rollout

Focused deterministic source fixtures exercise historical digests, workspace
round trips, rejected authority, unsupported adapters, duplicate/concurrent
admission, cancellation/restart, event ownership, retention and narrowed child
budgets. They do not qualify live providers or deployed runtime profiles.

Emitted SQLite fixtures include crash/reopen/replay with one command, execution
and budget reservation and zero replay writes. Native PostgreSQL fixtures use
isolated databases and fixture-only roles to exercise the actual migration,
constraints and repositories. Exact check results accompany the draft PR.
Combined R1/Adea candidate proof remains required before workspace Pi admission
is enabled. Production migrations and
registry publication are outside this task's authorization. Rollout must retain
compatible readers, current authority and single-attempt ownership; old readers
cannot be assumed to understand new version 2 records. No destructive rollback
or cleanup is performed here.

## Kernel acceptance map

| Invariant                                                            | Deterministic evidence                                                                                                     | Remaining owner proof                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Historical project digests and replay identities survive             | Context/execution-plan historical negative fixtures, CommandInbox legacy replay, SQLite migration checksum/reopen fixtures | Composed runtime retries                                        |
| Workspace scope has no synthetic project                             | Workspace context/plan compiler and admission round trips in both stores                                                   | R1 Node/Pi opt-in and Adea canonical intent                     |
| Current scope is required on admission and replay                    | Exact plan-pin, absent-port, revoked audience/grant/principal, expiry and concurrent-winner fixtures                       | Product actor and transport-service authority at each effect    |
| Unsupported adapters fail closed                                     | Workspace capability requirements and project-only consumer guards                                                         | R1 actual adapter inspection/start                              |
| Nullable projects cannot duplicate admissions                        | SQLite unique index and independent connections; PostgreSQL partial unique index/concurrent fixtures                       | Composed HTTP retries                                           |
| Restart, cancellation, events and retention preserve scope           | SQLite process-exit/reopen, event/tombstone ownership, cancellation and retention; native PostgreSQL restart/readback      | Runtime recovery and public cursor/cancel proof                 |
| Workspace parent narrows only to a real same-workspace project child | Current authority on both immutable pins, plan/context lineage and default-budget-disabled SQLite/PostgreSQL fixtures      | J1 governed child bridge                                        |
| Context version2 supports matching project and workspace scope       | SQLite raw INSERT/UPDATE positives and mismatch negatives; PostgreSQL scope constraints                                    | No runtime authority is implied by context storage              |
| Provider spending remains independently governed                     | Existing broker/per-send budget tests and unchanged reservation authority                                                  | R2 trusted per-physical-send composition and live qualification |
