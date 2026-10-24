# Acceptance ledger for the CP #1204 and #1048 backend outcome

This ledger records what the published `#1204` and `#1048` source proves, what
remains unproved, and which gate proves what. It is a custody record for the
integrated outcome, not a claim that any live deployment, native effect,
installed profile or production activation is qualified.

## Historical custody and preservation

The table and W1 integration account below record the earlier integration checkpoint.
Its preserved heads and conflict count are historical; they are not the final
current-main reconciliation inputs or a fresh validation receipt.

| Item                             | Value                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Published #1204 head (preserved) | `253b4ada58e3560fedef142fc7cbd926ed5662ce` (`feat/pi-durable-completion-20261020`)                                               |
| Published #1048 head (preserved) | `7cf6d67e7175fa25bc4012f666aa02c53819335e` (`feat/profile-recovery-rollback-1025`)                                               |
| Integration base                 | remote `main` at `27f17bd55e0266439b5b3089163195c9e7a669be`                                                                      |
| Integration commits              | merge of the published #1204 head, then the published #1048 head, then the writer-coverage qualification                         |
| History rewrite                  | none. Both published heads are ancestors of the published head                                                                   |
| Merge conflicts                  | two, both single-line list additions in the shared test-group inventory; resolved as the union of both sides, no design decision |

At that checkpoint, the `#1048` branch already contained the recorded `#1204`
head as an ancestor, so the integrated outcome was published on the `#1048`
branch. The `#1204` branch was preserved unchanged at its then-published head.

## Current integration inputs and evidence boundary

The reconciliation retains the published #1048 history and integrates current
`main` at `ab931d068142a0c5629ed4d6cc2c96a1b377a986`, the #1204 SDK/lifecycle
source input at `3a8bee3aa630acb7def053e42df6e3ea1a5aa827`, and the policy
input at `f561ca52c2f6cef6a3c76465d581dc7d567a9a6b`. These identify source
inputs, not a new published head or validation result. The subsequent integration
adds #1204/current-main input `5ccd978fc9073a205e1f5d152bc5f910ad454e6e`,
the cancellation-recovery repair at `0d2a76e35f2fbd9aaced0c215be452713748db97`,
and the merged model-policy main input at
`4f9967dc50dfb5dc3ffa13a305f4e3623ae20fe1`. The scope below continues to use
the stable main base above, so it includes the later main/toolchain and
architecture changes as well as the Pi integration. It is regenerated from the
resolved integration index; the final commit must carry this ledger and pass
its unchanged scope check before publication is qualified.

The next source input is the checked #1204 repair
`df1f8f95e53333d0ab2ec6da793304141b652893`: the exact reviewed Bun 1.4.4 /
ICU 78.1 historical reader qualification and deterministic SQLite pending-event
ordering before the batch limit. Actual original-path replay tests passed without
preload or module substitution; this does not qualify native cancellation or
restore authority. The outage fixtures distinguish safe pre-engine resumption
from retained physical-send quarantine without deleting dispatch evidence.

The retained source includes the HTTP child-publication reader, Hosted accepted
model forwarding, and Node child-delivery/startup/close reconciliation. Their
presence does not establish installed SDK adoption, a deployed lifecycle,
independent restore-generation authority, or complete native/full-writer
acceptance. Earlier qualification receipts below remain historical; no full
current-candidate test pass is claimed here.

## The current published scope

The published scope is the diff from the base `ab931d068142a0c5629ed4d6cc2c96a1b377a986`
to the published head, which is the head that carries this section. The complete changed scope is
**276 paths: 90 added, 186 modified**; no path was deleted.
`tests/pi-durable-cp1048-evidence-discipline.test.mjs` checks this list, these counts and this
area table against the repository, so the published scope cannot drift away from the code
without that lane failing.

| Area                                | Added | Modified | Total |
| ----------------------------------- | ----- | -------- | ----- |
| `(repository root)`                 | 0     | 6        | 6     |
| `apps/control-api`                  | 18    | 25       | 43    |
| `apps/hosted-control-plane`         | 2     | 5        | 7     |
| `apps/local-control-plane`          | 0     | 1        | 1     |
| `apps/runtime-worker`               | 0     | 1        | 1     |
| `apps/workflow-worker`              | 0     | 6        | 6     |
| `docs`                              | 10    | 4        | 14    |
| `docs/architecture`                 | 0     | 2        | 2     |
| `docs/evals`                        | 0     | 1        | 1     |
| `docs/evidence`                     | 4     | 0        | 4     |
| `docs/requirements`                 | 0     | 1        | 1     |
| `infrastructure`                    | 0     | 2        | 2     |
| `packages/acp-adapter`              | 0     | 4        | 4     |
| `packages/config`                   | 0     | 4        | 4     |
| `packages/context`                  | 0     | 1        | 1     |
| `packages/contracts`                | 1     | 8        | 9     |
| `packages/control-sdk`              | 2     | 8        | 10    |
| `packages/cortana-context-adapter`  | 0     | 1        | 1     |
| `packages/credential-vault`         | 0     | 1        | 1     |
| `packages/database`                 | 1     | 4        | 5     |
| `packages/domain`                   | 0     | 6        | 6     |
| `packages/events`                   | 0     | 1        | 1     |
| `packages/execution-plan`           | 0     | 1        | 1     |
| `packages/langgraph-adapter`        | 0     | 1        | 1     |
| `packages/managed-pi-adapter`       | 0     | 1        | 1     |
| `packages/memory-writeback`         | 0     | 1        | 1     |
| `packages/model-gateway`            | 0     | 1        | 1     |
| `packages/orchestration`            | 0     | 5        | 5     |
| `packages/pi-durable-adapter`       | 23    | 20       | 43    |
| `packages/policy`                   | 0     | 5        | 5     |
| `packages/production-readiness`     | 7     | 1        | 8     |
| `packages/profile-adapters`         | 3     | 6        | 9     |
| `packages/profile-portability`      | 0     | 1        | 1     |
| `packages/remote-control-relay`     | 0     | 1        | 1     |
| `packages/runtime-gateway-protocol` | 0     | 1        | 1     |
| `packages/runtime-sdk`              | 0     | 4        | 4     |
| `packages/sandbox`                  | 0     | 1        | 1     |
| `packages/sqlite-persistence`       | 0     | 7        | 7     |
| `packages/tool-execution`           | 0     | 4        | 4     |
| `packages/tool-sdk`                 | 0     | 1        | 1     |
| `packages/usage-ledger`             | 0     | 1        | 1     |
| `packages/workflow-runtime`         | 0     | 1        | 1     |
| `patches`                           | 2     | 0        | 2     |
| `scripts`                           | 1     | 8        | 9     |
| `tests`                             | 16    | 22       | 38    |

The complete path list, as published:

```text
M  .release-please-manifest.json
M  CHANGELOG.md
M  apps/control-api/CHANGELOG.md
M  apps/control-api/package.json
M  apps/control-api/src/app.module.ts
M  apps/control-api/src/executions/execution-acceptance.service.ts
A  apps/control-api/src/fastify-logging-compatibility.test.mjs
M  apps/control-api/src/index.ts
A  apps/control-api/src/models/production-cancellation-authority.test.mjs
M  apps/control-api/src/models/production-child-configuration.test.mjs
M  apps/control-api/src/models/production-model-composition-terminal-surface.test.mjs
M  apps/control-api/src/models/production-model-composition.ts
A  apps/control-api/src/pi-durable/cancellation-authority.test-fixture.mjs
M  apps/control-api/src/pi-durable/child-progress-scanner.test.mjs
M  apps/control-api/src/pi-durable/child-progress-scanner.ts
A  apps/control-api/src/pi-durable/child-publication-current.controller.ts
A  apps/control-api/src/pi-durable/child-publication-current.service.ts
A  apps/control-api/src/pi-durable/child-publication-current.test.mjs
A  apps/control-api/src/pi-durable/child-timeline-delivery.test.mjs
A  apps/control-api/src/pi-durable/child-timeline-delivery.ts
M  apps/control-api/src/pi-durable/current-tool-authority.test.mjs
M  apps/control-api/src/pi-durable/lead-fence-consumer.test.mjs
A  apps/control-api/src/pi-durable/lead-fence-cross-store-interleavings.test.mjs
A  apps/control-api/src/pi-durable/lead-fence-late-authority.test.mjs
M  apps/control-api/src/pi-durable/lead-fence-live-harness.mjs
A  apps/control-api/src/pi-durable/lead-fence-native-guard.test.mjs
A  apps/control-api/src/pi-durable/lead-fence-service.test.mjs
M  apps/control-api/src/pi-durable/lead-fenced-observation.test.mjs
M  apps/control-api/src/pi-durable/lead-terminal-settlement.test.mjs
M  apps/control-api/src/pi-durable/node-admission.test.mjs
M  apps/control-api/src/pi-durable/node-admission.ts
M  apps/control-api/src/pi-durable/node-candidate.fixture.mjs
A  apps/control-api/src/pi-durable/node-canonical-classification.test.mjs
M  apps/control-api/src/pi-durable/node-composition-lifecycle.test.mjs
M  apps/control-api/src/pi-durable/node-composition.ts
M  apps/control-api/src/pi-durable/pi-durable-lead-target.test.mjs
M  apps/control-api/src/pi-durable/pi-durable-lead.service.ts
M  apps/control-api/src/pi-durable/pi-durable-lead.test.mjs
A  apps/control-api/src/pi-durable/postgres-cancellation-request-reader.fixture.mjs
A  apps/control-api/src/pi-durable/postgres-cancellation-requests.integration.test.mjs
A  apps/control-api/src/pi-durable/postgres-cancellation-requests.ts
A  apps/control-api/src/pi-durable/postgres-cancellation-test-database.fixture.mjs
A  apps/control-api/src/pi-durable/postgres-cancellation-test-database.test.mjs
M  apps/control-api/src/pi-durable/runtime-authority-router.ts
M  apps/control-api/src/pi-durable/sqlite-publication-reader.ts
M  apps/hosted-control-plane/package.json
M  apps/hosted-control-plane/src/composition.ts
A  apps/hosted-control-plane/src/hosted-model-forwarding.integration.test.mjs
M  apps/hosted-control-plane/src/index.test.mjs
M  apps/hosted-control-plane/src/index.ts
M  apps/hosted-control-plane/src/reconciliation-wiring.test.mjs
A  apps/hosted-control-plane/src/reconciliation-workflow-submitter.ts
M  apps/local-control-plane/package.json
M  apps/runtime-worker/package.json
M  apps/workflow-worker/CHANGELOG.md
M  apps/workflow-worker/package.json
M  apps/workflow-worker/src/cloud-composition.ts
M  apps/workflow-worker/src/index.test.mjs
M  apps/workflow-worker/src/runtime-attempt-router.test.mjs
M  apps/workflow-worker/src/runtime-attempt-router.ts
M  budgets.json
M  bun.lock
A  docs/1230-dependency-budget-attribution.md
A  docs/405-runtime-audit.md
M  docs/architecture/control-plane-architecture.md
M  docs/architecture/control-plane-architecture.v1.json
M  docs/evals/skill-evals/skill-eval-harness.mts
A  docs/evidence/cp1233-toolchain-qualification-2026-10-23.md
A  docs/evidence/m11-integration-runner-interruption-2026-10-15.md
A  docs/evidence/m11-security-trust-boundary-audit-2026-10-21.md
A  docs/evidence/m11-security-trust-boundary-matrix-2026-10-21.v1.json
M  docs/harnesses.md
A  docs/pi-durable-cancellation-owner-proposal.md
A  docs/pi-durable-committed-cancellation-authority.md
A  docs/pi-durable-complete-writer-coverage.md
A  docs/pi-durable-cp1048-path-ledger.md
A  docs/pi-durable-cp1048-reconciliation.md
A  docs/pi-durable-cp1204-1048-acceptance-ledger.md
A  docs/pi-durable-native-guarded-abort-compatibility.md
M  docs/pi-durable-report-back.md
M  docs/pi-durable-runtime.md
A  docs/profile-recovery-acceptance-map.md
M  docs/requirements/cp186-195-reconciliation-2026-10-21.md
M  docs/testing.md
M  infrastructure/containers/managed-pi/bun.lock
M  infrastructure/containers/managed-pi/package.json
M  package.json
M  packages/acp-adapter/CHANGELOG.md
M  packages/acp-adapter/package.json
M  packages/acp-adapter/src/acp-remote-crypto.ts
M  packages/acp-adapter/src/acp-remote-transport.ts
M  packages/config/CHANGELOG.md
M  packages/config/package.json
M  packages/config/src/managed-cloud.test.mjs
M  packages/config/src/managed-cloud.ts
M  packages/context/package.json
M  packages/contracts/CHANGELOG.md
M  packages/contracts/package.json
M  packages/contracts/src/control-api.test.mjs
M  packages/contracts/src/control-api.ts
M  packages/contracts/src/decision-resolution.ts
M  packages/contracts/src/index.test.mjs
M  packages/contracts/src/index.ts
A  packages/contracts/src/pi-child-publication.ts
M  packages/contracts/src/workspace-catalog.ts
M  packages/control-sdk/CHANGELOG.md
M  packages/control-sdk/openapi/control-plane.v3.json
M  packages/control-sdk/package.json
M  packages/control-sdk/scripts/openapi.mjs
M  packages/control-sdk/src/client.ts
M  packages/control-sdk/src/compatibility.test.mjs
M  packages/control-sdk/src/index.test.mjs
A  packages/control-sdk/src/openapi-model-id-parity.test.mjs
M  packages/control-sdk/src/operations.ts
A  packages/control-sdk/src/pi-child-publication.test.mjs
M  packages/cortana-context-adapter/package.json
M  packages/credential-vault/package.json
M  packages/database/CHANGELOG.md
M  packages/database/package.json
A  packages/database/src/execution-repository.test.mjs
M  packages/database/src/execution-repository.ts
M  packages/database/src/integration.test.mjs
M  packages/domain/CHANGELOG.md
M  packages/domain/package.json
M  packages/domain/src/command-inbox.test.mjs
M  packages/domain/src/command-inbox.ts
M  packages/domain/src/execution-lifecycle.test.mjs
M  packages/domain/src/execution-lifecycle.ts
M  packages/events/package.json
M  packages/execution-plan/package.json
M  packages/langgraph-adapter/package.json
M  packages/managed-pi-adapter/package.json
M  packages/memory-writeback/package.json
M  packages/model-gateway/package.json
M  packages/orchestration/CHANGELOG.md
M  packages/orchestration/package.json
M  packages/orchestration/src/delegation-tool-admission.ts
M  packages/orchestration/src/delegation.test.mjs
M  packages/orchestration/src/delegation.ts
M  packages/pi-durable-adapter/CHANGELOG.md
M  packages/pi-durable-adapter/package.json
M  packages/pi-durable-adapter/src/adapter.ts
A  packages/pi-durable-adapter/src/authority-outcome.ts
A  packages/pi-durable-adapter/src/cancellation-authority.test-fixture.mjs
M  packages/pi-durable-adapter/src/cancellation-generation.test.mjs
A  packages/pi-durable-adapter/src/cancellation-history.ts
A  packages/pi-durable-adapter/src/cancellation-owner.test.mjs
A  packages/pi-durable-adapter/src/cancellation-owner.ts
A  packages/pi-durable-adapter/src/cancellation-registration.test.mjs
A  packages/pi-durable-adapter/src/cancellation-registration.ts
M  packages/pi-durable-adapter/src/canonical-authority.ts
A  packages/pi-durable-adapter/src/committed-cancellation-authority.test.mjs
A  packages/pi-durable-adapter/src/competing-recovery-owners.test.mjs
A  packages/pi-durable-adapter/src/composition-drain.test.mjs
M  packages/pi-durable-adapter/src/composition.ts
M  packages/pi-durable-adapter/src/contracts.ts
A  packages/pi-durable-adapter/src/durable-writer-coverage.test.mjs
M  packages/pi-durable-adapter/src/index.ts
M  packages/pi-durable-adapter/src/journal.test.mjs
M  packages/pi-durable-adapter/src/journal.ts
A  packages/pi-durable-adapter/src/native-cancellation-boundary.test.mjs
A  packages/pi-durable-adapter/src/native-cancellation-boundary.ts
A  packages/pi-durable-adapter/src/native-fence-public-api-probe.test.mjs
A  packages/pi-durable-adapter/src/native-guarded-abort-compat.test.mjs
A  packages/pi-durable-adapter/src/pi-engine-receipt-observer.test.mjs
A  packages/pi-durable-adapter/src/pi-engine-request-valued.fixture.mjs
M  packages/pi-durable-adapter/src/pi-engine-tools.loopback.fixture.mjs
M  packages/pi-durable-adapter/src/pi-engine-tools.test.mjs
M  packages/pi-durable-adapter/src/pi-engine.test.mjs
M  packages/pi-durable-adapter/src/pi-engine.ts
A  packages/pi-durable-adapter/src/process-claim-fence.test.mjs
M  packages/pi-durable-adapter/src/reconcile-owner-fence.test.mjs
M  packages/pi-durable-adapter/src/recovery-races-owner.child.mjs
M  packages/pi-durable-adapter/src/recovery-races.fixture.mjs
M  packages/pi-durable-adapter/src/recovery-races.test.mjs
A  packages/pi-durable-adapter/src/recovery-races.worker.mjs
A  packages/pi-durable-adapter/src/restore-generation-authority.test.mjs
A  packages/pi-durable-adapter/src/restore-generation-authority.ts
A  packages/pi-durable-adapter/src/resume-permit.ts
A  packages/pi-durable-adapter/src/upgrade-manifest.ts
M  packages/pi-durable-adapter/src/usage-authority.test.mjs
M  packages/pi-durable-adapter/src/usage-authority.ts
M  packages/policy/CHANGELOG.md
M  packages/policy/package.json
M  packages/policy/src/decision-resolution.test.mjs
M  packages/policy/src/decision-resolution.ts
M  packages/policy/src/index.ts
A  packages/production-readiness/fixtures/dependency-after-bun143.txt
A  packages/production-readiness/fixtures/dependency-before-bun143.txt
M  packages/production-readiness/package.json
A  packages/production-readiness/src/audit-slice-closure.test.mjs
A  packages/production-readiness/src/budget-regression.test.mjs
A  packages/production-readiness/src/dependency-budget-scope.test.mjs
A  packages/production-readiness/src/startup-budget-probe.mjs
A  packages/production-readiness/src/startup-budget.test.mjs
M  packages/profile-adapters/README.md
M  packages/profile-adapters/package.json
M  packages/profile-adapters/src/guards.ts
M  packages/profile-adapters/src/index.test.mjs
M  packages/profile-adapters/src/index.ts
A  packages/profile-adapters/src/wake-restart.worker.mjs
M  packages/profile-adapters/src/wake.ts
A  packages/profile-adapters/tsconfig.type-tests.json
A  packages/profile-adapters/type-tests/retained-wake-repository-assignment.ts
M  packages/profile-portability/package.json
M  packages/remote-control-relay/package.json
M  packages/runtime-gateway-protocol/package.json
M  packages/runtime-sdk/package.json
M  packages/runtime-sdk/src/index.test.mjs
M  packages/runtime-sdk/src/pi-durable-lead.test.mjs
M  packages/runtime-sdk/src/pi-durable-lead.ts
M  packages/sandbox/package.json
M  packages/sqlite-persistence/CHANGELOG.md
M  packages/sqlite-persistence/package.json
M  packages/sqlite-persistence/src/delegation-repository.ts
M  packages/sqlite-persistence/src/delegation-terminal-receipt.test.mjs
M  packages/sqlite-persistence/src/delegation-terminal-receipt.ts
M  packages/sqlite-persistence/src/durability-repositories.test.mjs
M  packages/sqlite-persistence/src/durability-repositories.ts
M  packages/tool-execution/CHANGELOG.md
M  packages/tool-execution/package.json
M  packages/tool-execution/src/tool-execution.test.mjs
M  packages/tool-execution/src/tool-execution.ts
M  packages/tool-sdk/package.json
M  packages/usage-ledger/package.json
M  packages/workflow-runtime/package.json
A  patches/@earendil-works%2Fpi-durable@1.1.0.patch
A  patches/pi-durable-1.1.0-NOTICE.md
M  scripts/check-budgets.mjs
M  scripts/check-startup-budget.mjs
M  scripts/docker-pull-backoff.mjs
M  scripts/integration-shards.mjs
M  scripts/pull-postgres-image.mjs
M  scripts/requirements-ledger.mjs
M  scripts/run-bun-test-group.mjs
M  scripts/run-integration-tests.mjs
A  scripts/security-trust-boundary-probes.mjs
M  tests/docker-pull-backoff.test.mjs
A  tests/fixtures/pi-durable-child-host-cleanup.mjs
M  tests/fixtures/pi-lead-restart/host.mjs
A  tests/fixtures/pinned-process.mjs
A  tests/fixtures/profile-recovery-cleanup.mjs
A  tests/fixtures/runner-cleanup-signal.child.mjs
A  tests/fixtures/runner-cleanup.mjs
M  tests/integration-runner-lifecycle.test.mjs
M  tests/integration-shards.test.mjs
M  tests/j1-unfinished-child-process-restart.test.mjs
M  tests/j1-unfinished-child-process.fixture.mjs
M  tests/m11-architecture-audit-regression.test.mjs
M  tests/m11-architecture-audit.test.mjs
M  tests/m11-requirements-ledger.test.mjs
M  tests/m11-standalone-e2e.test.mjs
M  tests/managed-pi-docker-packaging.test.mjs
M  tests/pi-child-continuation-process.fixture.mjs
M  tests/pi-child-continuation-sqlite.test.mjs
M  tests/pi-durable-canonical-authority.test.mjs
M  tests/pi-durable-child-host.test.mjs
M  tests/pi-durable-compaction-governed-dispatch.fixture.mjs
M  tests/pi-durable-compaction-governed-dispatch.test.mjs
A  tests/pi-durable-cp1048-evidence-discipline.test.mjs
M  tests/pi-durable-production-child-composition.test.mjs
M  tests/pi-durable-workspace-scope.test.mjs
A  tests/process-evidence.fixture.mjs
A  tests/profile-recovery-cleanup.test.mjs
A  tests/profile-recovery-crash-restore.test.mjs
A  tests/profile-recovery-fenced-rollback.test.mjs
M  tests/profile-recovery-pi-lead-restart.test.mjs
A  tests/profile-recovery-postgres-restore.integration.test.mjs
A  tests/profile-recovery-rebind-fencing.test.mjs
A  tests/profile-recovery-self-hosted-simple-sigkill.integration.test.mjs
A  tests/profile-recovery-self-hosted-simple.integration.test.mjs
A  tests/profile-recovery-selfhosted-server-wake-replay.boundary.test.mjs
M  tests/repository.test.mjs
A  tests/runner-cleanup.test.mjs
M  tests/workspace-tooling.test.mjs
M  tsconfig.base.json
```

Constraints observed in that scope, re-derived from the diff rather than from a summary:

- Main's `0074` and `0075` migrations, their snapshots and the Drizzle journal are
  preserved unchanged. No migration SQL, metadata snapshot or journal differs from the
  current main base in this scope. The earlier checkpoint's statement that `0075` did
  not exist is superseded by the landed main migration chain; this reconciliation
  does not apply any migration or establish migration-backed runtime acceptance.
- No path in the scope grants an independent restore-generation authority. The two modules
  that bind a generation bind a caller-supplied value, and the only `PiCancellationOwnerPort`
  implementation remains unavailable. The rollback fences the branch does have — the
  journal epoch, the effect-gate revision, the process claim and the ordinary-cancellation
  authority checks — are preserved unchanged.
- The native cancellation boundary remains fail closed before the unqualified native
  effect. Hosted forwarding and lifecycle changes are integrated source paths with
  repository fixtures; no live deployment, credential, provider activation or installed
  profile is exercised or qualified by their presence.

## The acceptance items and their proofs

| Issue | Acceptance item                                                                               | State in the integrated source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The proof                                                                                           |
| ----- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| #1018 | Transactionally reserve child/descendant budgets with depth, concurrency and authority limits | present: `apps/control-api/src/pi-durable/production-child-bridge.ts` reserves the budget and records the estimate and the reservation as cost-state evidence in one step; `apps/workflow-worker/src/child-runtime-budget-admission.integration.test.mjs` drives the admission                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | the disposable PostgreSQL integration lane                                                          |
| #1018 | Prove concurrent admission, retry and compaction behaviour with deterministic race tests      | present: `packages/pi-durable-adapter/src/compaction-child-admission.test.mjs`, `packages/pi-durable-adapter/src/recovery-races.test.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | the durable adapter lane                                                                            |
| #1019 | Keep the lead responsive while children run; coalesce routine progress                        | present: `packages/pi-durable-adapter/src/usage-authority.ts` and its completed-turn usage sources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the durable adapter lane                                                                            |
| #1019 | Distinguish estimated, reserved, reported, reconciled, settled and unknown cost               | present: `packages/pi-durable-adapter/src/usage-authority.ts`, `packages/pi-durable-adapter/src/completed-turn-usage-sources.test.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the durable adapter lane                                                                            |
| #1022 | Persist one canonical job/attempt/native-session mapping and an idempotent admission receipt  | present: `packages/pi-durable-adapter/src/child-continuation.ts`, `packages/pi-durable-adapter/src/child-continuation-authority.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | the durable adapter lane                                                                            |
| #1022 | Atomically retain the terminal outcome plus a repairable publication intent                   | present: `packages/sqlite-persistence/src/delegation-terminal-receipt.ts` and its test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the durable adapter lane and the disposable PostgreSQL integration lane                             |
| #1025 | Prove crash/recovery, upgrade/drain/rollback and backup/restore from the supported roots      | present: `tests/profile-recovery-fenced-rollback.test.mjs`, `tests/profile-recovery-rebind-fencing.test.mjs`, `tests/profile-recovery-selfhosted-server-wake-replay.boundary.test.mjs`, `tests/profile-recovery-postgres-restore.integration.test.mjs`, `packages/pi-durable-adapter/src/composition-drain.test.mjs`. The upgrade part of that clause is same-version store identity only, and it is opt-in: no production caller supplies the manifest, and a cross-version upgrade executor still does not exist                                                                                                                                                                                                                                                                                                            | the profile recovery lane, the disposable PostgreSQL restore drill, the disposable integration lane |
| #1025 | Revalidate reconnect grants, target generations and input                                     | **partially qualified, and the remainder is recorded as an open gap**: `packages/pi-durable-adapter/src/durable-writer-coverage.test.mjs` proves tamper consistency — a digest binds the fields it covers. It also proves that tamper consistency is **not** restore authority: a rollback that restores the generation _and_ recomputes the matching digest is accepted by the pure contracts. The independent, non-rewound generation authority that this acceptance needs does not exist in the current architecture                                                                                                                                                                                                                                                                                                       | the writer-coverage qualification                                                                   |
| #1025 | Fence one attempt owner throughout rollback                                                   | **partially qualified, and the remainder is recorded as an open gap**: the writers of the durable state are enumerated from the source across the whole workspace and each is classified by the authority it actually holds. A rewound epoch is refused by the two cancellation modules, the journal and the effect gate. The eighteen writers that carry **no** independent generation authority — the adapter's effect gate, journal, lease, adapter and cancellation history, the Cloudflare owner and session stores, the control API lead admission, preparation, running-lifecycle, management-call and lead-receipt stores, the three production selection stores, the shared live fence harness, the upgrade manifest and the resume permit — are named, and the full-writer restore-generation acceptance stays open | the writer-coverage qualification                                                                   |

The last two rows are the outcome of this custody. The native boundary module
states in its own source that matching installation evidence "never proves
canonical R, drain D or complete writer coverage", and no test in the repository
proved the coverage. The new qualification records exactly what holds and what
does not: it proves tamper consistency, proves that tamper consistency is not
restore authority, proves that a rewound epoch is refused where the
architecture grants one, and names the writers that carry no independent
generation authority. The full-writer restore-generation acceptance **remains
open**; it needs production authority that does not exist in the current
architecture. See
[`pi-durable-complete-writer-coverage.md`](pi-durable-complete-writer-coverage.md).

## What remains unproved

These are **not** closed by this ledger and must not be read as closed.

| Gate                                                 | Why it stays open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native zero-effect acceptance                        | The boundary refuses a rewound request before any native effect. Nothing here observes a native effect or proves the effect is zero.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SDK adoption and upstream publication                | The outcome is repository source and tests. No SDK release, upstream publication or consumer adoption is performed or claimed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Installed cross-repo and profile acceptance          | The proofs are repository tests against a disposable local PostgreSQL and the local composition. No installed profile, cross-repo consumer or production topology is exercised.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Production activation                                | No production action is taken. `compose.yaml` supplies a disposable local service; nothing is deployed, activated or released.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The aggregate unit lane                              | The historical integrated-tree run recorded a Bun 1.4.3 panic (`range end index 1884 out of range for slice of length 1024`) and 7 test failures: the runtime-gateway host credential startup case, the two qualified-cancellation deadline and revocation cases, the crash-at-admission-boundary case, and the three canonical recovery-outage cases. **The same 7 failures and the same panic reproduce with the writer-coverage file held aside**, so they are pre-existing on the integrated tree and not caused by this qualification. That receipt recorded W4's CP #1030 isolation scope; it is not a fresh ownership or final-candidate result. The complete current aggregate lane remains unverified by this ledger. |
| The durable writers outside the target-accepting set | The effect gate store, the journal, the lease, the adapter, the cancellation history classifier, the Cloudflare owner and session stores, the control API lead admission, preparation, running-lifecycle, management-call and lead-receipt stores, the three production selection stores, the shared live fence harness, the upgrade manifest and the resume permit do not carry an independent restore generation, so the restore-generation property is not proven for them. They are named and classified in the writer-coverage qualification rather than excluded.                                                                                                                                                        |
| The independent restore-generation authority         | Nothing outside the restored snapshot holds the current restore generation. `restoreGeneration` is a caller-supplied reference, the only `PiCancellationOwnerPort` implementation throws `PI_CANCELLATION_AUTHORITY_UNAVAILABLE`, and no production consumer reads a current fence to compare it against the target's generation. A rollback that restores the generation and recomputes the matching digest is therefore indistinguishable from a genuine request. Closing this needs production authority beyond the current scope.                                                                                                                                                                                          |
| The source-plan and Railway lifecycle scope          | The historical handoff assigned this to W4 for CP #1030. That is not a current custody or deployed-lifecycle receipt; this reconciliation does not establish source-plan or Railway runtime acceptance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The Linux-pidfd proof family                         | `tests/profile-recovery-self-hosted-simple-sigkill.integration.test.mjs` fails closed on macOS because the pinned-process fixture needs a Linux pidfd, and the ownership record cannot be taken without it. That file and its fixture are byte-identical to the published #1048 head. The CI runs this lane on `ubuntu-latest`, where the proof is intended to run.                                                                                                                                                                                                                                                                                                                                                            |

## The qualified gates and their evidence

| Gate                              | Command                                                                                                                                                                                                                                                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The focused durable adapter lane  | `bun test src` in `packages/pi-durable-adapter`                                                                                                                                                                                                                                     | 338 pass, 0 fail, 2120 assertions across 33 files. The earlier entry recorded 328 pass and 2061 assertions; that count was taken at an earlier head, and the lane has since grown. This change adds no test case to the package: it adds assertions to one existing file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The writer-coverage qualification | `cd packages/pi-durable-adapter && bun test src/durable-writer-coverage.test.mjs`                                                                                                                                                                                                   | 12 pass, 0 fail, 72 assertions. It proves tamper consistency, proves that a generation rollback with a matching digest is **accepted** by the pure contracts, proves that a rewound epoch is refused where the architecture grants one, proves that the upgrade manifest detects a rolled-back store by byte identity, and enumerates the durable writers from the source across the whole workspace: a direct durable write or an exported durable store/owner seam in the adapter package, a direct durable write to a `pi_`/`cp_pi_` table anywhere in the workspace, or a write through an injected durable-journal seam. Eighteen writers are named; only the two cancellation modules bind a restore generation, and both bind a caller-supplied value. The load-bearing assertions are negative-proven: inverting the rollback assertion fails the file, inverting the upgrade-manifest assertion fails the file, dropping a writer from the classification fails the file, and introducing a new durable Pi writer fails the file |
| The profile recovery lane         | `cd <repo> && bun test tests/profile-recovery-crash-restore.test.mjs tests/profile-recovery-cleanup.test.mjs tests/profile-recovery-fenced-rollback.test.mjs tests/profile-recovery-rebind-fencing.test.mjs tests/profile-recovery-selfhosted-server-wake-replay.boundary.test.mjs` | 20 pass, 0 fail, 93 assertions across 5 files. The earlier entry recorded `bun test tests/profile-recovery-*.test.mjs` as "12 pass, 0 fail"; that glob also selects the three `.integration.test.mjs` files, which need PostgreSQL and Restate and are not gated by `skipIf`, so the recorded command did not describe the recorded result. The command above is the smoke lane, and it reproduces 20 cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| The build                         | `bun run build`                                                                                                                                                                                                                                                                     | 47/47 tasks successful                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The type check                    | `bun run type-check`                                                                                                                                                                                                                                                                | 200 requirements and 103 issue audits; 45 packages, 55 operations, 4 profiles; no type errors in 208 infrastructure files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The lint                          | `bun run lint`                                                                                                                                                                                                                                                                      | 1268 files in 45 packages, 0 boundary violations; 39 digest writer flows matched. The lane was re-run at this head: the orchestrator lint task reports 47/47 successful, the root `oxlint --deny-warnings tests` is clean, the boundary check reports 0 violations, the canonical-ordering check passes, and the digest-writer check matches 39 flows. The earlier entry recorded 1250 files; that count was taken at an earlier head, before the repository grew, so it did not reconcile with the lane                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The format                        | `bun run format:check`                                                                                                                                                                                                                                                              | all matched files use the correct format                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The architecture audit            | `bun run architecture:check`                                                                                                                                                                                                                                                        | 45 packages, 55 operations, 4 profiles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| The disposable restore drill      | `bun run test:recovery`                                                                                                                                                                                                                                                             | backup and restore preserved full evidence and restored application-role reads, immutable replay and new evaluation writes without DDL or role-administration privileges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The disposable integration lane   | `bun run test:integration`                                                                                                                                                                                                                                                          | 359 pass, 12 fail. All 12 failures are in `tests/profile-recovery-self-hosted-simple-sigkill.integration.test.mjs` and are `PINNED_PROCESS_UNSUPPORTED: platform darwin has no pidfd` plus the `RESTATE_OWNERSHIP_UNRECORDED` consequence. That file and its fixture are byte-identical to the published #1048 head, and the CI runs this lane on `ubuntu-latest` only. The receipt previously read "across 40 files"; the local lane inventory at this head is 60 unique integration files, so that file count does not reconcile with the lane and is not reproducible from repository evidence. The lane was not re-run for this change: it needs a Docker daemon and a disposable PostgreSQL, which this change does not use. Treat it as a recorded receipt, not a result for this head                                                                                                                                                                                                                                              |

The aggregate unit lane and the aggregate `bun run test` are gated by the Bun
panic named above, not by this outcome.

## The environment the proofs ran in

- The repository's pinned toolchain: `bun@1.4.3`, `node@24.21.0`, `darwin-arm64`.
- A disposable local PostgreSQL from the repository's own `compose.yaml`, with the
  repository's pinned `postgres:18.6-alpine` image, on `127.0.0.1:54329`, with
  the repository's three distinct roles. The database was created for this
  qualification and torn down with it; no account, credential or production
  resource was touched.
- The requirements ledger reads the GitHub issues with the existing read-only
  token. No credential was created or changed.

## Bounded correction of the writer universe and of these receipts

A later read-only advisory of this head found two classes of inaccuracy in the
records above, and both were corrected in source and documentation without
changing a single product behaviour:

1. **The writer universe was narrower than the claim.** The enumeration derived
   its writer set from this package alone, so it never reached the Cloudflare
   host's durable Pi state, the control API's lead stores, or the two modules
   that write durable state through the journal they were handed. The
   enumeration is now derived from the source across the whole workspace, and
   eighteen writers are named and classified by the authority they actually
   hold. Two of them — the adapter and the cancellation history classifier —
   write through the journal seam and hold no restore generation; the
   cancellation history classifier is no longer filed as a reader.
   **This widens the open gap; it does not close it.** Only the two
   cancellation modules bind a restore generation, and both bind a
   caller-supplied value. The independent-authority gap, the live-rollback gap
   and the native-acceptance gap are unchanged and remain open.
2. **Three receipts did not describe what they recorded.** The profile recovery
   lane's command selected more cases than the recorded result; the integration
   lane's recorded file count does not reconcile with the lane inventory; and
   the durable adapter lane's counts were taken at an earlier head. Each receipt
   now states the command that reproduces it, the count that command produces,
   and the limit of the receipt.

The correction adds no product source, no migration, no journal change and no
grant. It reads source text and a disposable SQLite journal only.

## Custody boundaries observed

- W4's CP #1030 lifecycle, architecture, inventory and shared-runner paths were
  not edited. The only shared-runner edit is the mechanical merge resolution
  named above, which keeps both sides' files.
- Sol's shared runner and inventory surfaces carry no feature work from this
  outcome.
- The published branches, the stale preservation refs and the untracked
  `.bun-cache` are preserved. No force push, no history rewrite, no deletion.
- Both draft PRs keep auto-merge off. Root retains readiness and merge.
