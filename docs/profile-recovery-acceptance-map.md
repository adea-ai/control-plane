# Profile recovery and rollback acceptance map (#1025 / M17.02.2)

This map states what repository tests prove about profile recovery, drain,
rollback, backup/restore, reconnect revalidation, and fencing. It does not
certify any live deployment. A "proven" result means a deterministic test in
this repository drives the named primitive; "unproven" means no test does.
The proofs cover the supported Local composition, the legacy `hosted-simple`
composition (SQLite with pinned Restate), PostgreSQL primitives, and Pi Durable
lead retained-record startup adoption after SIGKILL. They do not prove production
reconciliation evidence for safe continuation or OS orphan-process adoption; see
gap 8.
Unsupported hosted candidates fail closed (`PROFILE_RUNTIME_NOT_QUALIFIED` for
the declared `CLOUD_PROFILE_UNQUALIFIED` denial, `PROFILE_RUNTIME_TRANSPORT_MISMATCH`
for the Node Pi Durable adapter's direct-local identity) rather than falling back
to a local or self-hosted runtime. The source-level profile map is in
`packages/profile-adapters/README.md`.

#1025 remains open. The acceptance clauses below are not all satisfied, and this
map does not claim the milestone complete.

## Test ownership

| File                                                                     | Lane                                              | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/profile-recovery-crash-restore.test.mjs`                          | smoke                                             | Local SQLite composition crash/restart recovery, crashed-owner fencing, and scheduled-scan drain. Portable export/import refuses active work only when a supplied `activeWorkIds` result is nonempty, and round-trips a seeded evaluation record only                                                                                                                                                                                                                                                                                                                                                                         |
| `tests/profile-recovery-fenced-rollback.test.mjs`                        | smoke                                             | Rollback continuation input binding, reconnect eligibility reasons (channel-generation fencing moved to the PostgreSQL integration proof)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `tests/profile-recovery-rebind-fencing.test.mjs`                         | smoke                                             | Adapter-level rollback fence (synthetic `MockRuntimeAdapter` and managed-Pi driver fixtures): after the fence closes, the eight post-start operations on the previous binding fail `PROFILE_AUTHORITY_REJECTED` before the upstream runtime; a fresh authority binding to the same target resumes the exact retained handle (no target-generation change is exercised); a rebound managed-Pi attempt does not resend the physical start                                                                                                                                                                                       |
| `tests/profile-recovery-self-hosted-simple.integration.test.mjs`         | integration (`bun run test:integration`)          | Self-hosted simple (`hosted-simple`, SQLite, pinned `@restatedev/restate-server` 1.7.13): a paused approval keeps identity across close/reopen and filesystem checkpoint restore, rejects a stale owner, and resumes once. The separate portable export/import case round-trips a seeded evaluation record only; active-work refusal uses a supplied ID list                                                                                                                                                                                                                                                                  |
| `tests/profile-recovery-self-hosted-simple-sigkill.integration.test.mjs` | integration (`bun run test:integration`)          | Self-hosted simple SIGKILL: the composition process is killed while its pinned Restate launcher and native server run. The parent reaps only the recorded processes, each pinned by a Linux pidfd when recorded so no signal goes to a bare pid (the proof fails closed where pidfds are unavailable), then a second composition on the same data keeps the paused approval's execution, attempt, and version; a duplicate run submission starts no second effect; one approval resumes once. This is the legacy LangGraph test composition: it is not Pi Durable host wiring, and the orphan is reaped manually, not adopted |
| `tests/profile-recovery-postgres-restore.integration.test.mjs`           | integration (`bun run test:integration`, PR lane) | Self-hosted-server disposable PostgreSQL portable export/import of a seeded evaluation record; cleanup contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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
- `packages/pi-durable-adapter/src/adapter-process.test.mjs`: Pi adapter restart
  with real SQLite and SIGKILL at the physical-send, pre-dispatch, and approval
  boundaries. In addition, `tests/profile-recovery-pi-lead-restart.test.mjs`
  proves production lead-composition retained-record adoption after SIGKILL
  without resend. An already-forwarded inference remains unknown and pending;
  continuation is exercised only when a test-only loopback probe establishes
  that the inference did not reach HTTP dispatch. Production reconciliation
  evidence wiring remains unqualified.

## Bounded lifecycle and cancellation evidence

The lifecycle baseline below was reviewed at historical code head
`eb4b1a802f241f21f78aeec31e54af15130eea11`, not at this PR's head. PR head
`4fd4e09009123230c93f0db8ff563eb86909a767` adds a test that holds two accepted
public recovery passes (including a failed scan) until close drains them before
Pi lead adapter and journal teardown. This proves close ordering for those
passes, not Pi-owned task drain.

- `apps/control-api/src/pi-durable/node-composition-lifecycle.test.mjs` at the
  historical head held a periodic scan while close waited and refused
  recovery/store access after close. The current PR adds the public-recovery
  drain case described above. Both are teardown ordering, not Pi task drain.
- `apps/hosted-control-plane/src/reconciliation-wiring.test.mjs` covers close
  during seven awaited startup boundaries, release of late endpoint acquisition,
  shared close completion/rejection, original startup-error preservation, refusal
  to restart after terminal close, and draining accepted reconciliation before
  clearing its retained wake. Database/runtime/authority ports are fixtures;
  this does not prove PostgreSQL + Restate recovery or full transport drain.
- `tests/pi-durable-child-host.test.mjs` exercises sibling cancellation and
  runtime reopen with the existing test-only SQLite committed-cancellation owner.
  Its binding comes from retained admission and CP execution/attempt records.
  Existing sibling, usage and replay assertions remain. This proves the fixture
  owner path; production cross-store cancellation authority remains gap 11.

## Clause map

| #1025 clause                                     | Proof in this PR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crash/recovery from a supported composition root | `LocalControlPlaneComposition` test "an abandoned job is recovered once under the next attempt and the crashed owner is fenced": abandoned lease retained across reopen, not reclaimed before expiry, recovered at attempt 2 with the identical `workflowKey` and `input`, crashed token rejected, recovered owner completes once, terminal job never reclaimed. Self-hosted simple: `tests/profile-recovery-self-hosted-simple.integration.test.mjs` pauses an approval in the pinned Restate server, then closes and reopens it (restart and checkpoint-restore cases). `tests/profile-recovery-self-hosted-simple-sigkill.integration.test.mjs` SIGKILLs the composition while its Restate child runs and recovers with a manual orphan reap before restart. Pi Durable lead: `tests/profile-recovery-pi-lead-restart.test.mjs` SIGKILLs a held production lead composition and starts a fresh one on the same directory; it adopts the retained record, does not resend or admit twice, and keeps an already-forwarded uncertain inference `unknown`/pending, and resumes the same inference after a test-backed no-send reconciliation | Proven for Local. Self-hosted simple: close/reopen, checkpoint restore, and SIGKILL with a manual orphan reap. Product startup does not adopt or reap orphaned Restate processes. Pi Durable lead: startup adoption and no-resend after a forwarded request are proven. Safe continuation after a fresh, test-only no-send reconciliation is proven at composition level; production evidence wiring remains unqualified. Self-hosted server and Hosted: unproven |
| Drain                                            | `LocalControlPlaneComposition` scheduled-scan test holds reconciliation while `close()` waits; `node-composition-lifecycle.test.mjs` additionally holds two accepted public recovery passes (including a scan failure) and checks adapter/journal close waits for both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Partly proven: Local scheduled scans and accepted public recovery passes drain before teardown. Workflow-queue stop, runtime-transport drain, Restate drain, and Pi-owned `drain()` are unproven                                                                                                                                                                                                                                                                  |
| Upgrade                                          | No upgrade executor is reachable from a supported composition root, and no test drives one. Portable import rollback is a data-import primitive, proven in `packages/profile-portability`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Unproven for every profile                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Rollback                                         | (a) Recovery continuation admission rejects a mismatched parent input or checkpoint (`WORKFLOW_RECOVERY_PARENT_MISMATCH`) and an ambiguous parent (`WORKFLOW_RECOVERY_PARENT_AMBIGUOUS`), in `profile-recovery-fenced-rollback`. (b) Interrupted portable import rolls back to a pristine destination, in `packages/profile-portability`. No release or version rollback primitive exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Recovery-continuation admission proven at store level for Local. Import rollback proven as a primitive. No composition-level rollback of a deployed version is proven                                                                                                                                                                                                                                                                                             |
| Backup, Local                                    | Composition test restores only a seeded evaluation record after total loss. The `PORTABLE_ACTIVE_WORK` refusal is triggered by a supplied `activeWorkIds` result; it does not discover active work or back up workflow/runtime state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Proven for a portable evaluation-record round trip at Local composition level; active-work discovery and workflow/runtime backup are unproven                                                                                                                                                                                                                                                                                                                     |
| Backup/restore, Self-hosted server               | `profile-recovery-postgres-restore.integration.test.mjs`: export from a seeded database, restore into a freshly provisioned database, replay returns `replayed`. Runs in the PR integration lane (`postgres-pull-request.yml` → `bun run test:integration`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Evaluation-record round trip against disposable local PostgreSQL; CI result pending the PR integration run. No server composition recovery is shown                                                                                                                                                                                                                                                                                                               |
| Backup/restore, Self-hosted simple               | The portable export/import case restores only a seeded evaluation record; its source composition is not started and active-work refusal uses a supplied ID list. A separate filesystem checkpoint case restores and resumes a paused approval exactly once. Storage primitives: `restore-validation` and the port round trip in `packages/profile-portability`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Portable evaluation-record round trip plus a separate paused-approval checkpoint restore at composition level; live Hosted restore unproven                                                                                                                                                                                                                                                                                                                       |
| Backup/restore, Hosted                           | Portability export is covered by `packages/profile-portability/src/postgres.integration.test.mjs` (Postgres source and destination). No live hosted restore                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Unproven live                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Revalidate reconnect grants                      | `evaluateRuntimeEligibility` reasons: `RUNTIME_OFFLINE`, `RUNTIME_EXPIRED`, `LOCAL_PROJECT_GRANT_REVOKED`, `LOCAL_PROJECT_GRANT_MISSING`, `CAPABILITY_SNAPSHOT_STALE`. Plus package `RUNTIME_STALE`, `RUNTIME_REVOKED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Contract proven. No live reconnect handshake exercised                                                                                                                                                                                                                                                                                                                                                                                                            |
| Revalidate target generations                    | `PostgresRuntimeChannelOwnershipRepository` rejects a claim at or below the current channel generation, rejects a foreign workspace (`RUNTIME_CHANNEL_WORKSPACE_MISMATCH`), and refuses a heartbeat from a superseded generation. Driven through PostgreSQL (`packages/database/src/integration.test.mjs`): two physical owners, physical reconnect, stale refusal, and one inventory effect per generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Proven against disposable PostgreSQL through the canonical repository and inventory unit of work. A live gateway handshake is not proven (gap 7). Not exercised for Local or self-hosted simple                                                                                                                                                                                                                                                                   |
| Revalidate input                                 | Recovery continuation binds the parent's exact input and checkpoint (`WORKFLOW_RECOVERY_PARENT_MISMATCH`). Composition recovery returns the identical retained input. Cancellation payload conflict never re-dispatches (package test). Self-hosted simple: the paused approval's plan record and execution plan reference read back identical after reopen and after SIGKILL recovery (same tests as above)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Proven for Local queue and recovery continuation. Proven for self-hosted simple after close/reopen and SIGKILL                                                                                                                                                                                                                                                                                                                                                    |
| Fence one attempt owner throughout               | Lease tokens are single-use (package test). Composition test: the crashed owner's token is rejected after recovery, and exactly one owner completes. Synthetic adapter-level fence in `tests/profile-recovery-rebind-fencing.test.mjs`. Self-hosted simple (same tests as above): an owner holding a superseded execution version is refused with `STALE_EXECUTION_VERSION`, a duplicate run submission starts no second attempt or graph operation, and one approval resumes once, after close/reopen and after SIGKILL. Pi Durable lead restart also proves no second admission for the retained uncertain run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Proven for Local and self-hosted simple after close/reopen and SIGKILL (manual orphan reap). Pi Durable lead: no second admission/no resend proven for uncertain recovery; owner fencing throughout rollback remains unproven. Self-hosted server and Hosted: unproven                                                                                                                                                                                            |

## Per-profile matrix

| Clause                       | Local                                                                          | Self-hosted simple (SQLite + Restate)                                                                                      | Self-hosted server (PostgreSQL + Restate)                                                                                                                           | Hosted (cloud)                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Crash/recovery               | Proven (composition)                                                           | Proven at composition: close/reopen, checkpoint restore, and SIGKILL with a manual orphan reap. No product orphan adoption | Unproven                                                                                                                                                            | Fail-closed binding only                                                                    |
| Drain                        | Partly proven: scheduled scan and accepted public recovery drains before close | Unproven                                                                                                                   | Unproven                                                                                                                                                            | Partly proven: accepted reconciliation drains with injected ports; transport drain unproven |
| Upgrade                      | Unproven                                                                       | Unproven                                                                                                                   | Unproven                                                                                                                                                            | Unproven                                                                                    |
| Rollback                     | Recovery admission and import rollback proven as primitives                    | Unproven                                                                                                                   | Partly: PostgreSQL rollback on invalid derivation (`packages/profile-portability/src/postgres.integration.test.mjs`). Interrupted rollback not tested on PostgreSQL | Unproven                                                                                    |
| Backup/restore               | Portable evaluation-record round trip only; no workflow/runtime backup proof   | Portable evaluation-record round trip plus a separate paused-approval checkpoint restore                                   | Evaluation-record round trip against disposable local PostgreSQL                                                                                                    | Unproven live                                                                               |
| Reconnect-grant revalidation | Contract proven (one profile-independent function; no per-profile test)        | Same                                                                                                                       | Same                                                                                                                                                                | Same                                                                                        |
| Target-generation fencing    | Not exercised                                                                  | Unproven                                                                                                                   | Proven against disposable PostgreSQL (two physical owners, reconnect, one inventory effect); live gateway handshake unproven                                        | Fail-closed binding only                                                                    |
| Exact input binding          | Proven                                                                         | Proven at composition for the plan record across close/reopen and SIGKILL                                                  | Unproven at composition                                                                                                                                             | Unproven                                                                                    |
| One attempt owner            | Proven (composition, package, and synthetic adapter-level fence)               | Proven at composition (superseded-version refusal, single resume) across close/reopen and SIGKILL                          | Unproven                                                                                                                                                            | Fail-closed binding only                                                                    |

The Pi Durable lead composition is not a column. Its process-level SIGKILL tests
prove adoption after an already-forwarded request remains unresolved, and safe
continuation when a test-only authoritative probe proves the exact inference did
not reach the HTTP dispatch boundary. Production reconciliation evidence wiring
remains unqualified; see gap 8.

"Fail-closed binding only" means `tests/...` and `packages/profile-adapters`
prove that Hosted refuses local storage, the embedded queue, direct-local
transports, and non-cloud placement. No hosted recovery behaviour is claimed.

## Remaining gaps (required before #1025 can close)

Owners are existing issues. Where no open issue names a gap, the row says so.

1. **Upgrade is unproven for every profile.** No upgrade executor is reachable
   from a supported composition root, so no test can drive one yet. Adding one
   needs an upstream-owned upgrade entry point. Owner: #1025 upgrade clause
   (child of #942); no open issue names an upgrade executor. Closed #930 checks
   "upgrade behavior" for the Pi runtime; that does not prove this executor.
2. **Drain is partly proven.** Local scheduled scans and accepted public
   recovery passes drain before teardown. Hosted wiring also tests that accepted
   reconciliation drains and covers startup/close cleanup using injected ports
   (see the bounded lifecycle evidence above).
   These do not establish workflow-queue stop, runtime-transport drain, Restate
   drain or Pi-owned task drain. Owner: #1025 drain clause. Operator admission
   stops are #1029 (under #943). Legacy-work drain is #940, which depends on #939.
3. **Self-hosted-server profile wake/replay** (PostgreSQL + Restate) is unproven.
   `tests/profile-recovery-selfhosted-server-wake-replay.boundary.test.mjs` only
   checks that the composition prototype exposes no profile-wake member and the
   package has no wake topology-guard factory. `bindRetainedProfileWorkflowWake`
   now provides a reusable submit boundary that resolves the retained command,
   execution, and any latest attempt; it admits zero-attempt recovery only and
   fences the submit to current command/execution versions. Historical execution
   records without a retained deadline fail closed; missing legacy deadlines are
   not treated as unbounded. The same admission snapshot is supplied to
   pre-submit and post-submit workflow-wake guards. Hosted-server composition
   now has an opt-in binding that routes acceptance and reconciliation through
   this binder when callers provide placement and current guards. It does not
   construct those authorities. The retained command only identifies a `svc_*`
   service principal; there is no original product-actor/current-grant source,
   authoritative host/residency source, or independently re-read topology source
   to compose the required guards. The local child-process test uses JSON-backed
   records and a fake idempotent ingress; it is not PostgreSQL + Restate proof.
   Product-path SIGKILL wake/replay and active-attempt crash replay remain
   unproven.
   Self-hosted simple wake and replay after close/reopen, checkpoint restore, and SIGKILL is proven by
   `tests/profile-recovery-self-hosted-simple.integration.test.mjs` and
   `tests/profile-recovery-self-hosted-simple-sigkill.integration.test.mjs`.
   Owner: #1025 (child of #942).
4. **Self-hosted simple** composition-level recovery is proven for
   close/reopen, checkpoint restore, and SIGKILL (with a manual orphan reap).
   The separate portable export/import case round-trips a seeded evaluation
   record only; full portable workflow/attempt backup is unproven. Product-startup
   adoption or reaping of an orphaned Restate child, Restate drain, upgrade, and
   rollback also remain unproven.
   The SIGKILL proof's main teardown requests a fresh ownership handshake after
   startup timeout or partial identity capture, waits for startup to settle,
   and pins both Restate processes under the live composition before killing it.
   The fixture retains the original launched process handle until its exit settles,
   including an injected provider stop rejection while the child is pending.
   That injection occurs before the requested signal is forwarded to the
   underlying process handle; it does not prove post-signal health-PID clearing.
   If that handshake cannot be completed, it keeps the live owner, partial
   handles, and work directory for diagnosis; it does not force-kill an
   unrecorded process chain. Linux pidfds are required and unsupported platforms
   fail closed. A composition whose parent ends its pipe closes itself and its
   Restate child, and the test runner runs its registered cleanups when it
   receives SIGINT, SIGTERM or SIGHUP, serialized with afterEach so a signal waits
   for cleanup already in flight. A runner killed by SIGKILL cannot run
   cleanup; the composition then closes on the ended pipe. This is test cleanup,
   not product orphan adoption or recovery.
   Unexpected Restate launcher death before the parent pins the complete chain
   remains unqualified; this proof does not recover an unanchored native orphan.
   Owner: #1025 crash/recovery, drain, upgrade, and rollback clauses. Its listed
   dependencies are #935 (fence cancellation retries and uncertain effects) and
   #939 (typed durable tasks).
5. **Hosted live composition** over the managed-cloud adapter is unproven. The
   repository fails closed for unqualified candidates. Owner: #1025 and the
   Hosted scope of parent #942.
6. **Live reconnect handshake** is unproven. Grant revalidation is a contract.
   Owner: #1025. The nearest open dependency is #1023 (secure ACP transport and
   fencing offline devices); root to confirm.
7. **Channel-generation fencing** has disposable-PostgreSQL integration evidence
   (`packages/database/src/integration.test.mjs`). It is not yet exercised
   through a live gateway handshake (gap 6). Owner: #1025.
8. **Production evidence for Pi Durable safe continuation after SIGKILL remains
   unproven.** Retained-record startup adoption is proven, but the production
   reconciliation source is not. Startup recovery runs when the host constructs
   the runtime:
   `createNodePiDurableRuntime` (`packages/pi-durable-adapter/src/composition.ts`)
   calls `recover()` before it returns. `createNodePiDurableLeadComposition`
   (`apps/control-api/src/pi-durable/node-composition.ts`) runs the preparation and
   child-progress startup scans and the terminal settlement at construction, then
   repeats them on a timer (`periodicRecoveryIntervalMs`, default 30 s). Production
   constructs it in `apps/control-api/src/models/production-model-composition.ts`
   (around line 256). Adapter-level SIGKILL restart is proven in
   `packages/pi-durable-adapter/src/adapter-process.test.mjs`. The SIGKILL reclaim in
   `apps/control-api/src/pi-durable/preparation-dispatch-recovery.test.mjs` drives
   `SqlitePiLeadPreparations` alone, not the composition. Approval close/reopen
   (`apps/control-api/src/pi-durable/current-tool-authority.approval-restart.test.mjs`)
   is a unit-level reopen, not a process kill. The production composition-level
   adoption proof is `tests/profile-recovery-pi-lead-restart.test.mjs`: a held turn
   is SIGKILLed and a fresh process opens the same disposable directory. It adopts
   the same handle, attempt, and execution at a higher epoch, with no owner PID,
   second admission, model request, or stream resend. If a dispatched request is
   recorded, the run remains `unknown` with `inferencePending=true`. A second SIGKILL
   case stops after the usage hold and before native fetch; an exact-key no-send
   reconciliation resumes the same Pi task, produces one request, and completes at the
   composition boundary. The probe uses a test-only loopback evidence log; production
   reconciliation source remains unqualified. Owner: #1025 crash/recovery clause. Approvals
   across restart are #932 (open). Closed #930 checks "restart/hibernation recovery"
   but does not cover composition-level adoption.
9. **Pi-owned `drain()`** is excluded from this map's scope. I found no open issue
   that names it; root to assign an owner.
10. **PostgreSQL restore in GitHub CI** has not run. The disposable local run passes
    (4 tests). Owner: #1025 PR integration lane.
11. **Production committed-cancellation authority is unqualified.** The adapter
    requires a server-owned committed intent/outbox port; without it, ordinary
    and fenced cancellation refuse before mutation or abort, and inspected
    capabilities omit cancellation. Optional injection and the test-only SQLite
    coordinator prove ordering, idempotency, generation targeting and replay.
    They do not supply a production owner coordinating current product authority,
    CP execution/attempt versions and deadlines through a shared serializable
    transaction or fencing lease. The default production wiring has no such
    owner. Independent reads and final rechecks do not close that race. Owner:
    #935, with the recovery acceptance boundary retained by #1025/#942.
