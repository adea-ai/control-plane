# Profile recovery and rollback acceptance map (#1025 / M17.02.2)

This map states what repository tests prove about profile recovery, drain,
rollback, backup/restore, reconnect revalidation, and fencing. It does not
certify any live deployment. A "proven" result means a deterministic test in
this repository drives the named primitive; "unproven" means no test does.
Unsupported hosted candidates fail closed (`PROFILE_RUNTIME_NOT_QUALIFIED` for
the declared `CLOUD_PROFILE_UNQUALIFIED` denial, `PROFILE_RUNTIME_TRANSPORT_MISMATCH`
for the Node Pi Durable adapter's direct-local identity) rather than falling back
to a local or self-hosted runtime. The source-level profile map is in
`packages/profile-adapters/README.md`.

#1025 remains open. The acceptance clauses below are not all satisfied.

## Test ownership

| File                                                           | Lane                                              | Proves                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/profile-recovery-crash-restore.test.mjs`                | smoke                                             | Local composition: crash/restart recovery, fencing of the crashed owner, graceful drain of a scheduled reconciliation pass, portable backup refusal and total-loss restore                                                                                                                                                                                                         |
| `tests/profile-recovery-fenced-rollback.test.mjs`              | smoke                                             | Rollback continuation input binding, reconnect eligibility reasons (channel-generation fencing moved to the PostgreSQL integration proof)                                                                                                                                                                                                                                          |
| `tests/profile-recovery-rebind-fencing.test.mjs`               | smoke                                             | Adapter-level rollback fence (synthetic `MockRuntimeAdapter` and managed-Pi driver fixtures): after the fence closes, the eight post-start operations on the previous binding fail `PROFILE_AUTHORITY_REJECTED` before the upstream runtime; a new owner at the next generation resumes the exact retained handle; a rebound managed-Pi attempt does not resend the physical start |
| `tests/profile-recovery-postgres-restore.integration.test.mjs` | integration (`bun run test:integration`, PR lane) | Self-hosted-server PostgreSQL total-loss backup/restore into a freshly provisioned database; disposable-database cleanup contract                                                                                                                                                                                                                                                  |

Primitive semantics are owned by package tests and are not repeated in the
files above:

- `packages/workflow-runtime/src/embedded-job-store.test.mjs`: single-use lease
  tokens, reclaim after expiry, terminal jobs never reclaimed, token-holder-only
  renew/complete/fail, queue reopen, and `WORKFLOW_RECOVERY_PARENT_ALREADY_CONTINUED`.
- `packages/domain/src/execution-cancellation-command.test.mjs`: lost-ACK replay
  keeps the first identity, `EXECUTION_CANCELLATION_PAYLOAD_CONFLICT`,
  `EXECUTION_CANCELLATION_CALLER_MISMATCH`, `EXECUTION_CANCELLATION_EXECUTION_INACTIVE`.
- `packages/profile-portability/src/index.test.mjs`: `PORTABLE_ACTIVE_WORK`,
  interrupted import rollback to a pristine destination (`SIMULATED_IMPORT_INTERRUPTION`),
  idempotent replay, Local and Hosted Simple persistence round trips.
- `packages/sqlite-persistence/src/restore-validation.test.mjs` and `index.test.mjs`:
  `SQLITE_BACKUP_INVALID` digest rejection and restore validation.
- `packages/profile-adapters/src/index.test.mjs`: profile-to-deployment binding,
  `PROFILE_DEPLOYMENT_MISMATCH` / `PROFILE_PERSISTENCE_MISMATCH` / `PROFILE_WAKE_MISMATCH`,
  exact adapter/transport topology guards, the hosted cloud denial, and start-handle
  attempt binding.
- `packages/runtime-sdk/src/eligibility.test.mjs`: offline, stale, revoked,
  incompatible, and unverified candidates.
- `packages/database/src/runtime-channel-ownership-repository.test.mjs`: invalid
  credential fences fail closed before any write.
- `packages/deployment/src/reconciliation-scheduler.test.mjs`: the scheduler's own
  drain semantics.

## Clause map

| #1025 clause                                     | Proof in this PR                                                                                                                                                                                                                                                                                                                                                                                            | Result                                                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash/recovery from a supported composition root | `LocalControlPlaneComposition` test "an abandoned job is recovered once under the next attempt and the crashed owner is fenced": abandoned lease retained across reopen, not reclaimed before expiry, recovered at attempt 2 with the identical `workflowKey` and `input`, crashed token rejected, recovered owner completes once, terminal job never reclaimed                                             | Proven for Local. Self-hosted and Hosted: unproven                                                                                                                        |
| Drain                                            | `LocalControlPlaneComposition` test "close waits for an in-flight scheduled reconciliation pass before storage closes": `close()` does not resolve while the pass is held, and resolves after it completes                                                                                                                                                                                                  | Proven for Local scheduled reconciliation only. Workflow-queue stop, runtime-transport drain, Restate drain, and Pi-owned `drain()` are unproven                          |
| Upgrade                                          | No upgrade executor is reachable from a supported composition root, and no test drives one. Portable import rollback is a data-import primitive, proven in `packages/profile-portability`                                                                                                                                                                                                                   | Unproven for every profile                                                                                                                                                |
| Rollback                                         | (a) Recovery continuation admission rejects a mismatched parent input or checkpoint (`WORKFLOW_RECOVERY_PARENT_MISMATCH`) and an ambiguous parent (`WORKFLOW_RECOVERY_PARENT_AMBIGUOUS`), in `profile-recovery-fenced-rollback`. (b) Interrupted portable import rolls back to a pristine destination, in `packages/profile-portability`. No release or version rollback primitive exists                   | Recovery-continuation admission proven at store level for Local. Import rollback proven as a primitive. No composition-level rollback of a deployed version is proven     |
| Backup, Local                                    | Composition test "backup refuses active work, then restores the evaluation into a fresh composition after total loss": `PORTABLE_ACTIVE_WORK` refusal, export from the composition's persistence, restore into a fresh composition directory, reopen read-back                                                                                                                                              | Proven for Local                                                                                                                                                          |
| Backup/restore, Self-hosted server               | `profile-recovery-postgres-restore.integration.test.mjs`: export from a seeded database, restore into a freshly provisioned database, replay returns `replayed`. Runs in the PR integration lane (`postgres-pull-request.yml` → `bun run test:integration`)                                                                                                                                                 | Proven against disposable local PostgreSQL. CI result pending the PR's integration run                                                                                    |
| Backup/restore, Self-hosted simple               | Storage-level only: `restore-validation` and the Local/Hosted Simple port round trip in `packages/profile-portability`. No composition-level test                                                                                                                                                                                                                                                           | Unproven at composition level                                                                                                                                             |
| Backup/restore, Hosted                           | Portability export is covered by `packages/profile-portability/src/postgres.integration.test.mjs` (Postgres source and destination). No live hosted restore                                                                                                                                                                                                                                                 | Unproven live                                                                                                                                                             |
| Revalidate reconnect grants                      | `evaluateRuntimeEligibility` reasons: `RUNTIME_OFFLINE`, `RUNTIME_EXPIRED`, `LOCAL_PROJECT_GRANT_REVOKED`, `LOCAL_PROJECT_GRANT_MISSING`, `CAPABILITY_SNAPSHOT_STALE`. Plus package `RUNTIME_STALE`, `RUNTIME_REVOKED`                                                                                                                                                                                      | Contract proven. No live reconnect handshake exercised                                                                                                                    |
| Revalidate target generations                    | `PostgresRuntimeChannelOwnershipRepository` rejects a claim at or below the current channel generation, rejects a foreign workspace (`RUNTIME_CHANNEL_WORKSPACE_MISMATCH`), and refuses a heartbeat from a superseded generation. Driven through PostgreSQL (`packages/database/src/integration.test.mjs`): two physical owners, physical reconnect, stale refusal, and one inventory effect per generation | Proven against disposable PostgreSQL through the canonical repository and inventory unit of work. A live gateway handshake is not proven (gap 6). Not exercised for Local |
| Revalidate input                                 | Recovery continuation binds the parent's exact input and checkpoint (`WORKFLOW_RECOVERY_PARENT_MISMATCH`). Composition recovery returns the identical retained input. Cancellation payload conflict never re-dispatches (package test)                                                                                                                                                                      | Proven for Local queue and recovery continuation                                                                                                                          |
| Fence one attempt owner throughout               | Lease tokens are single-use (package test). Composition test: the crashed owner's token is rejected after recovery, and exactly one owner completes. Synthetic adapter-level fence in `tests/profile-recovery-rebind-fencing.test.mjs`                                                                                                                                                                      | Proven for Local. Self-hosted and Hosted: unproven                                                                                                                        |

## Per-profile matrix

| Clause                       | Local                                                                   | Self-hosted simple (SQLite + Restate) | Self-hosted server (PostgreSQL + Restate)                                                                                                                           | Hosted (cloud)           |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Crash/recovery               | Proven (composition)                                                    | Unproven                              | Unproven                                                                                                                                                            | Fail-closed binding only |
| Drain                        | Partly proven (scheduled reconciliation)                                | Unproven                              | Unproven                                                                                                                                                            | Unproven                 |
| Upgrade                      | Unproven                                                                | Unproven                              | Unproven                                                                                                                                                            | Unproven                 |
| Rollback                     | Recovery admission and import rollback proven as primitives             | Unproven                              | Partly: PostgreSQL rollback on invalid derivation (`packages/profile-portability/src/postgres.integration.test.mjs`). Interrupted rollback not tested on PostgreSQL | Unproven                 |
| Backup/restore               | Proven (composition)                                                    | Storage-level only                    | Proven against disposable local PostgreSQL                                                                                                                          | Unproven live            |
| Reconnect-grant revalidation | Contract proven (one profile-independent function; no per-profile test) | Same                                  | Same                                                                                                                                                                | Same                     |
| Target-generation fencing    | Not exercised                                                           | Unproven                              | Proven against disposable PostgreSQL (two physical owners, reconnect, one inventory effect); live gateway handshake unproven                                        | Fail-closed binding only |
| Exact input binding          | Proven                                                                  | Unproven at composition               | Unproven at composition                                                                                                                                             | Unproven                 |
| One attempt owner            | Proven (composition, package, and synthetic adapter-level fence)        | Unproven                              | Unproven                                                                                                                                                            | Fail-closed binding only |

"Fail-closed binding only" means `tests/...` and `packages/profile-adapters`
prove that Hosted refuses local storage, the embedded queue, direct-local
transports, and non-cloud placement. No hosted recovery behaviour is claimed.

## Remaining gaps (required before #1025 can close)

1. **Upgrade is unproven for every profile.** No upgrade executor is reachable
   from a supported composition root, so no test can drive one yet. Adding one
   needs an upstream-owned upgrade entry point; this PR does not build a
   recovery engine.
2. **Drain is partly proven.** Only scheduled-reconciliation drain at Local
   composition close is tested. Workflow-queue stop, runtime-transport drain,
   and Restate drain are unproven. The Pi-owned `drain()` is excluded from this
   scope.
3. **Restate wake and replay** for both self-hosted variants. No in-test harness
   runs the pinned `@restatedev/restate-server`.
4. **Self-hosted simple has no composition-level recovery or backup test.**
5. **Hosted live composition** over the managed-cloud adapter is unproven. The
   repository fails closed for unqualified candidates.
6. **Live reconnect handshake** is unproven. Grant revalidation is a contract.
7. **Channel-generation fencing** has disposable-PostgreSQL integration evidence (`packages/database/src/integration.test.mjs`). It is not yet exercised through a live gateway handshake (gap 6).
