# Acceptance ledger for the CP #1204 and #1048 backend outcome

This ledger records what the published `#1204` and `#1048` source proves, what
remains unproved, and which gate proves what. It is a custody record for the
integrated outcome, not a claim that any live deployment, native effect,
installed profile or production activation is qualified.

## Custody and preservation

| Item                             | Value                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Published #1204 head (preserved) | `253b4ada58e3560fedef142fc7cbd926ed5662ce` (`feat/pi-durable-completion-20261020`)                                               |
| Published #1048 head (preserved) | `7cf6d67e7175fa25bc4012f666aa02c53819335e` (`feat/profile-recovery-rollback-1025`)                                               |
| Integration base                 | remote `main` at `27f17bd55e0266439b5b3089163195c9e7a669be`                                                                      |
| Integration commits              | merge of the published #1204 head, then the published #1048 head, then the writer-coverage qualification                         |
| History rewrite                  | none. Both published heads are ancestors of the published head                                                                   |
| Merge conflicts                  | two, both single-line list additions in the shared test-group inventory; resolved as the union of both sides, no design decision |

The `#1048` branch already contained the `#1204` head as an ancestor, so the
integrated outcome is published on the `#1048` branch. The `#1204` branch is
preserved unchanged at its published head.

## The acceptance items and their proofs

| Issue | Acceptance item                                                                               | State in the integrated source                                                                                                                                                                                                                                                 | The proof                                                                                           |
| ----- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| #1018 | Transactionally reserve child/descendant budgets with depth, concurrency and authority limits | present: `apps/control-api/src/pi-durable/production-child-bridge.ts` reserves the budget and records the estimate and the reservation as cost-state evidence in one step; `apps/workflow-worker/src/child-runtime-budget-admission.integration.test.mjs` drives the admission | the disposable PostgreSQL integration lane                                                          |
| #1018 | Prove concurrent admission, retry and compaction behaviour with deterministic race tests      | present: `packages/pi-durable-adapter/src/compaction-child-admission.test.mjs`, `packages/pi-durable-adapter/src/recovery-races.test.mjs`                                                                                                                                      | the durable adapter lane                                                                            |
| #1019 | Keep the lead responsive while children run; coalesce routine progress                        | present: `packages/pi-durable-adapter/src/usage-authority.ts` and its completed-turn usage sources                                                                                                                                                                             | the durable adapter lane                                                                            |
| #1019 | Distinguish estimated, reserved, reported, reconciled, settled and unknown cost               | present: `packages/pi-durable-adapter/src/usage-authority.ts`, `packages/pi-durable-adapter/src/completed-turn-usage-sources.test.mjs`                                                                                                                                         | the durable adapter lane                                                                            |
| #1022 | Persist one canonical job/attempt/native-session mapping and an idempotent admission receipt  | present: `packages/pi-durable-adapter/src/child-continuation.ts`, `packages/pi-durable-adapter/src/child-continuation-authority.ts`                                                                                                                                            | the durable adapter lane                                                                            |
| #1022 | Atomically retain the terminal outcome plus a repairable publication intent                   | present: `packages/sqlite-persistence/src/delegation-terminal-receipt.ts` and its test                                                                                                                                                                                         | the durable adapter lane and the disposable PostgreSQL integration lane                             |
| #1025 | Prove crash/recovery, upgrade/drain/rollback and backup/restore from the supported roots      | present: `tests/profile-recovery-fenced-rollback.test.mjs`, `tests/profile-recovery-rebind-fencing.test.mjs`, `tests/profile-recovery-selfhosted-server-wake-replay.boundary.test.mjs`, `tests/profile-recovery-postgres-restore.integration.test.mjs`                         | the profile recovery lane, the disposable PostgreSQL restore drill, the disposable integration lane |
| #1025 | Revalidate reconnect grants, target generations and input                                     | **the target-generation part was unproven and is now qualified**: `packages/pi-durable-adapter/src/durable-writer-coverage.test.mjs` proves the restore generation is bound into the request digest and that no writer accepts a rewound one                                   | the writer-coverage qualification                                                                   |
| #1025 | Fence one attempt owner throughout rollback                                                   | **the writer-coverage part was unproven and is now qualified**: the writers that accept a target or an epoch are enumerated from the source and each refuses a rewound epoch or restore generation                                                                             | the writer-coverage qualification                                                                   |

The last two rows are the outcome of this custody. The native boundary module
states in its own source that matching installation evidence "never proves
canonical R, drain D or complete writer coverage", and no test in the repository
proved the coverage. The new qualification closes exactly that sub-gap. See
[`pi-durable-complete-writer-coverage.md`](pi-durable-complete-writer-coverage.md).

## What remains unproved

These are **not** closed by this ledger and must not be read as closed.

| Gate                                                 | Why it stays open                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native zero-effect acceptance                        | The boundary refuses a rewound request before any native effect. Nothing here observes a native effect or proves the effect is zero.                                                                                                                                                                                                      |
| SDK adoption and upstream publication                | The outcome is repository source and tests. No SDK release, upstream publication or consumer adoption is performed or claimed.                                                                                                                                                                                                            |
| Installed cross-repo and profile acceptance          | The proofs are repository tests against a disposable local PostgreSQL and the local composition. No installed profile, cross-repo consumer or production topology is exercised.                                                                                                                                                           |
| Production activation                                | No production action is taken. `compose.yaml` supplies a disposable local service; nothing is deployed, activated or released.                                                                                                                                                                                                            |
| The aggregate unit lane                              | The lane hits a Bun 1.4.3 panic (`range end index 1884 out of range for slice of length 1024`) in the memory-writeback compiled-worker case, and a runtime-gateway startup case fails. Both reproduce **with the writer-coverage file held aside**, so they are pre-existing on the integrated tree and not caused by this qualification. |
| The durable writers outside the target-accepting set | The effect gate store, the journal, the lease, the upgrade manifest and the resume permit do not accept a cancellation target or an epoch, so they are outside the writer registry by construction.                                                                                                                                       |
| The source-plan and Railway lifecycle scope          | Held by W4 for CP #1030. No source-plan path is in this change set.                                                                                                                                                                                                                                                                       |

## The qualified gates and their evidence

| Gate                              | Command                                         | Result                                                                                                                                                                   |
| --------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The focused durable adapter lane  | `bun test src` in `packages/pi-durable-adapter` | 328 pass, 0 fail, 2061 assertions across 33 files                                                                                                                        |
| The writer-coverage qualification | `bun test src/durable-writer-coverage.test.mjs` | 2 pass, 0 fail; fails when a writer is dropped from the registry                                                                                                         |
| The profile recovery lane         | `bun test tests/profile-recovery-*.test.mjs`    | 12 pass, 0 fail                                                                                                                                                          |
| The build                         | `bun run build`                                 | 47/47 tasks successful                                                                                                                                                   |
| The type check                    | `bun run type-check`                            | 200 requirements and 103 issue audits; 45 packages, 55 operations, 4 profiles; no type errors in 208 infrastructure files                                                |
| The lint                          | `bun run lint`                                  | 1250 files in 45 packages, 0 boundary violations; 39 digest writer flows matched                                                                                         |
| The format                        | `bun run format:check`                          | all matched files use the correct format                                                                                                                                 |
| The architecture audit            | `bun run architecture:check`                    | 45 packages, 55 operations, 4 profiles                                                                                                                                   |
| The disposable restore drill      | `bun run test:recovery`                         | backup and restore preserved full evidence and restored application-role reads, immutable replay and new evaluation writes without DDL or role-administration privileges |
| The disposable integration lane   | `bun run test:integration`                      | the disposable PostgreSQL shards; see the run log                                                                                                                        |

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

## Custody boundaries observed

- W4's CP #1030 lifecycle, architecture, inventory and shared-runner paths were
  not edited. The only shared-runner edit is the mechanical merge resolution
  named above, which keeps both sides' files.
- Sol's shared runner and inventory surfaces carry no feature work from this
  outcome.
- The published branches, the stale preservation refs and the untracked
  `.bun-cache` are preserved. No force push, no history rewrite, no deletion.
- Both draft PRs keep auto-merge off. Root retains readiness and merge.
