# Profile recovery and rollback acceptance map (#1025 / M17.02.2)

This map states what the current code actually proves about profile recovery
and fenced rollback, per product profile. It complements the source-level
profile map in `packages/profile-adapters/README.md`.

**That profile map is source-level, not a live certification.** Nothing in
this repository runbook proves a live hosted deployment, a live Restate
ingress, or a live managed-cloud runtime. Every "proven" below means a
deterministic repository test exercises the real composition code; every
"unproven" stays unproven, and unsupported hosted candidates fail closed
(`PROFILE_RUNTIME_NOT_QUALIFIED` for the declared `CLOUD_PROFILE_UNQUALIFIED`
denial, `PROFILE_RUNTIME_TRANSPORT_MISMATCH` for the Node Pi Durable adapter's
direct-local identity) rather than falling back to a local or self-hosted
runtime.

## Clause ownership

| #1025 acceptance clause            | Owning test file and test-level proof                                                                                                                                                                                                                                 | Result                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Crash/recovery                     | `tests/profile-recovery-crash-restore.test.mjs` (smoke lane); corroborated by `tests/pi-durable-delegation-recovery.test.mjs`, `tests/memory-process-loss.integration.test.mjs`, `tests/m11-recovery-rpo-rto.test.mjs`                                                | Proven for Local; per-profile gaps below         |
| Upgrade/drain/rollback             | `tests/profile-recovery-fenced-rollback.test.mjs` (smoke lane)                                                                                                                                                                                                        | Proven for Local; unproven elsewhere             |
| Backup/restore                     | `tests/profile-recovery-crash-restore.test.mjs` (smoke lane); filesystem checkpoint in `packages/deployment` (`checkpoint.ts`), Postgres restore drill in the integration lane, portability export/import in `packages/profile-portability`                           | Proven for Local; Postgres path integration-lane |
| Reconnect-grant revalidation       | `tests/profile-qualification.test.mjs` pins the guard contract (authority is re-read current before and after every effect, bind-time and per-submit); live re-grant flow after reconnect is not exercised                                                            | Contract proven; live flow unproven              |
| Target-generation fencing          | `tests/profile-recovery-fenced-rollback.test.mjs`; composition-level support in `tests/profile-qualification.test.mjs` (exact-instance topology guard refuses substituted adapters/transports/dispatchers)                                                            | Proven for Local; unproven elsewhere             |
| Exact input binding                | `tests/profile-qualification.test.mjs` ("binds only the exact workflow dispatcher per profile and refuses every mismatch", "requires the trusted wake topology and current guards to approve each submit", start-handle attempt binding via the runtime-sdk contract) | Proven (composition contract, all profiles)      |
| One attempt owner through rollback | `tests/profile-recovery-fenced-rollback.test.mjs`; single-attempt handle binding pinned in `tests/profile-qualification.test.mjs` (handle/attempt identity checks reject foreign handles and statuses)                                                                | Proven for Local; unproven elsewhere             |

Test names inside the two recovery files are owned by their authors; the
registration above is additive and the files land in the smoke lane.

## Per-profile support matrix

| Clause                       | Local            | Self-hosted simple (SQLite + Restate) | Self-hosted server (PostgreSQL + Restate) | Hosted (cloud)                                                          |
| ---------------------------- | ---------------- | ------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Crash/recovery               | Supported-proven | Unsupported-unproven                  | Partially proven (integration lane)       | Fail-closed-by-design; live parity unproven                             |
| Upgrade/drain/rollback       | Supported-proven | Unsupported-unproven                  | Unsupported-unproven                      | Fail-closed-by-design; live parity unproven                             |
| Backup/restore               | Supported-proven | Unsupported-unproven                  | Partially proven (integration lane)       | Fail-closed-by-design; portability export proven, live restore unproven |
| Reconnect-grant revalidation | Contract-proven  | Contract-proven                       | Contract-proven                           | Contract-proven                                                         |
| Target-generation fencing    | Supported-proven | Unsupported-unproven                  | Unsupported-unproven                      | Composition-level fail-closed proven                                    |
| Exact input binding          | Supported-proven | Supported-proven                      | Supported-proven                          | Supported-proven                                                        |
| One attempt owner            | Supported-proven | Unsupported-unproven                  | Unsupported-unproven                      | Composition-level fail-closed proven                                    |

"Contract-proven" means the composition-boundary guard contract is pinned by
`tests/profile-qualification.test.mjs`: current authority and residency are
re-read before and after every runtime operation and wake submit, progress
rechecks before each emitted event, and a rejected grant produces no effect.
It does not exercise a live reconnect handshake.

"Composition-level fail-closed proven" (Hosted rows) means the hosted profile
binds only a healthy managed-cloud adapter over the authenticated
remote-gateway transport with trusted topology, authority, and residency
guards, and refuses everything else — the embedded queue is never a hosted
wake route, direct-local transports and non-cloud placements are refused, and
a declared `CLOUD_PROFILE_UNQUALIFIED` denial fails qualification even when
the adapter is healthy and advertises capabilities. No hosted recovery or
rollback behavior is claimed.

"Unsupported-unproven" marks the honest remainder: no repository test drives
recovery, drain, rollback, or fencing through a hosted-simple SQLite + Restate
composition or a hosted-server PostgreSQL + Restate composition. The hosted
control-plane integration suite covers graph lifecycle and cancellation, not
the #1025 recovery clauses, and it runs in the Postgres integration lane.

## Remainder (explicit gaps)

1. Self-hosted simple and self-hosted server have no recovery, drain,
   rollback, fencing, or restore-rollback tests; only storage/wake binding and
   the guard contract are proven for them.
2. Hosted (cloud) has no live managed-cloud runtime certification; the
   hosted-managed-Pi path is exercised with fixture clients only, and the
   repository deliberately fails closed for unqualified candidates.
3. Reconnect-grant revalidation is proven as a guard contract, not as a live
   re-grant flow; no test reconnects a transport and re-reads grants.
4. Backup/restore for the Postgres variants lives behind the
   `RUN_DATABASE_INTEGRATION` gate in `tests/profile-recovery-crash-restore.test.mjs`
   and in the integration lane (restore drill, portability Postgres
   source/destination). The smoke lane skips the gated describe, and because
   the file is smoke-registered under a plain `.test.mjs` name, no CI lane
   currently sets `RUN_DATABASE_INTEGRATION` for it; the self-hosted-server
   total-loss restore case therefore has no lane that runs it until it is
   split into an `.integration.test.mjs` file (registered in
   `scripts/run-integration-tests.mjs` and `scripts/integration-shards.mjs`)
   or an existing Postgres suite absorbs it.
5. The profile capability matrix is a source-level map; live certification for
   any profile remains future work (see `packages/profile-adapters/README.md`,
   "Source basis").
