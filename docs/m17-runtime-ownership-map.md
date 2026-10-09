# M17.01 runtime ownership and layer replacement map (CP #941)

Evidence-backed keep/replace/retire map for the custom lifecycle/hosted runtime, Restate,
transports, auth, policy, billing, artifacts, and device supervision, plus the exact Node and
Cloudflare Pi adapter surfaces on current `main`. Every claim below links an exact source location.
Measurements come from the new tooling `scripts/m17-runtime-baseline.mjs` (temp-only probes;
report to stdout or an explicit `--out` path).

**Baseline status as of this capture (2026-10-09): no #941 accepted or published baseline was
found.** A dated repository search for `M17.01`, `#941`, and `runtime ownership` before this change
matched no pre-existing baseline artifact under `docs/`, `scripts/`, `packages/`, or `tests/`;
`docs/evidence/` contained no M17 file. The only prior measurement history is unrelated: the M9/M10
performance record in [`docs/performance.md`](performance.md), which is explicitly profile-specific
and not a #941 baseline. This document and `docs/evidence/m17-01-runtime-ownership-baseline.json`
are a **candidate** baseline for this repository state only; acceptance is a separate, explicitly
dated root review act, and the tool's export deliberately makes no repository-wide absence claim.

## Scope, method, and safety

- Candidate: base `747a7cf7aec3b7d800d03deb447cd46a2d6eba9c` (= `origin/main` at capture),
  tooling `52c256ba0a70d5a7916775ee68ebff63a14e474c` plus review repair
  `0104d31e0d6e0d7c921cdc8eb018b46277a8ab09` (evidence captured at the repair commit), branch
  `feat/m17-runtime-ownership-baseline-941`, `report.candidate.dirty = false`.
- Environment (from the evidence report): bun 1.4.2 on macOS 25.6.0 `darwin/arm64`, Apple M2 Max
  ×12, 64 GiB, SQLite 3.51.0. `environment.runtime` is bun's Node-compatible `process.version`
  (`v26.3.0`); the repository engine pin remains Node 24.21.0.
- Exact command: `bun scripts/m17-runtime-baseline.mjs --out docs/evidence/m17-01-runtime-ownership-baseline.json`
  (≈2 s report wall warm on this host — a cold-cache first run took ≈19 s; defaults: 50
  queue/object/ledger rounds, 200 policy rounds, per-layer import probes).
  Reproduce with `M17_QUEUE_ITERATIONS`, `M17_OBJECT_ITERATIONS`, `M17_LEDGER_ITERATIONS`,
  `M17_POLICY_ITERATIONS`, `M17_IMPORT_PROBES=0`.
- Write policy: probe state is created only inside fresh `os.tmpdir()` directories that are
  removed before the report is emitted; the report itself goes to stdout or, with `--out`, to that
  explicit path (which may be inside the repository), as recorded in `configuration.writePolicy`.
  Failure reasons in the export are bounded reason codes only — raw exception text, child
  stdout/stderr, and ambient environment values are never copied in. No credentials, no network,
  no production or Local profile state, no cloud or device contact. The Local embedded-SQLite path
  is exercised only on disposable temp databases.
- Removals performed: **none**. Production components are neither removed nor activated. Local
  embedded-SQLite behavior is untouched.
- Coordination: no shared contract was changed. Any future shared-contract change (packages/contracts,
  runtime-sdk public types) must first coordinate with #1026 (profile adapters/authority boundaries)
  and #935 (cancellation/effect fencing). Files owned by #1016, #1018, #1019 (PR #973), and #1020
  were deliberately not edited; this PR touches only `scripts/m17-runtime-baseline.mjs`,
  `packages/production-readiness/src/m17-runtime-baseline.test.mjs`, this document, and the evidence
  JSON.

## Durable owner per process (no stacked journals)

One durable owner per process; Pi task state, workflow state, and any future Code Mode journal must
never be layered by default.

| Process / execution path                      | Durable owner (exactly one)                                                                                                                                                                                                                  | Evidence                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local profile workflow execution              | `WorkflowJobStore` namespaces, including the `workflow-journal` namespace, over `SqlitePersistenceProvider`                                                                                                                                  | `packages/workflow-runtime/src/embedded-job-store.ts:13-18`, `:183` (`enqueue`), `:251` (`claimDue`), `:323` (`complete`); composition default `apps/local-control-plane/src/composition.ts:319`                                                                                                          |
| Hosted/self-hosted Restate workflow execution | Restate `execution-lifecycle` workflow (the embedded queue is empty in restate mode)                                                                                                                                                         | `packages/workflow-runtime/src/restate-endpoint.ts:17-18`, `:136`; `apps/local-control-plane/src/composition.ts:248`; hosted dispatcher `apps/hosted-control-plane/src/composition.ts:366`; `RestateExecutionWorkflowDispatcher` at `apps/control-api/src/executions/execution-acceptance.service.ts:237` |
| Node Pi Durable session                       | Adapter `authority.sqlite` journal (`SqliteDurableJournal`), separate from one Pi Harness SQLite store per admitted session                                                                                                                  | `packages/pi-durable-adapter/src/adapter.ts:72`, `packages/pi-durable-adapter/src/journal.ts:27`; ownership table `docs/pi-durable-runtime.md:20-33`                                                                                                                                                      |
| Cloudflare Durable Object (unregistered)      | One DO owns `cp_pi_owner`/`cp_pi_tasks`/`cp_pi_events`/`cp_pi_wake`                                                                                                                                                                          | `packages/pi-cloudflare-host/README.md:17`, `:46-50`                                                                                                                                                                                                                                                      |
| Managed Pi subprocess (retained)              | Existing managed subprocess path, retained and not replaced by this map                                                                                                                                                                      | `packages/managed-pi-adapter/src/index.ts:322` (`ManagedPiDriver`), `:511` (`ManagedPiAdapter`); `packages/pi-durable-adapter/README.md:5`                                                                                                                                                                |
| Code Mode journals                            | **None exist in this repository** (search for `codeMode`/`code-mode` under `packages/`, `apps/`, `docs/`, `scripts/` returns no matches) — so no journal stacking exists today; adding a second owner for any process would violate this map | repository search recorded with this PR                                                                                                                                                                                                                                                                   |

## Keep / replace / retire map

Decisions follow the #941 acceptance rules: no removal justified by feature lists, unresolved parity
gaps keep a bounded explicit component, Local embedded SQLite is preserved, and no fictional Local
Restate removal is planned (Local never had Restate).

| Layer                                         | Decision                                                                                        | Durable owner today                                                                                                                                    | Exact source evidence                                                                                                                                                                                                                                                                                                                                                                                    | Removal / change gate                                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom lifecycle/hosted runtime               | **KEEP (bounded)**                                                                              | Embedded queue (`WorkflowJobStore` + `EmbeddedWorkflowRuntime`) for Local; runtime workers/gateway for hosted paths                                    | `packages/workflow-runtime/src/embedded-runtime.ts:88`, `:405`, `:479`; `apps/workflow-worker/src/execution-workflow.ts`; `apps/runtime-worker/src/composition.ts`; `packages/runtime-sdk/src/adapter.ts:465` (`RuntimeAdapter`), `:517` (`inspectRuntimeCapabilities`)                                                                                                                                  | Retire only with #941 behavior/profile/rollback evidence per removal; until then retained as the qualified owner for current profiles                           |
| Restate                                       | **KEEP for hosted/self-hosted; not present in Local — no Local removal is planned or possible** | Restate server 1.7.13 (`RESTATE_SERVER_VERSION`) + `execution-lifecycle` endpoint                                                                      | `packages/restate-runtime/src/index.ts:12`; `packages/workflow-runtime/src/restate-endpoint.ts:17-18`; `apps/workflow-worker/src/restate-worker.ts:1`; hosted wiring `apps/hosted-control-plane/src/composition.ts:85`, `:366`, `:618-619`; Local default `apps/local-control-plane/src/composition.ts:319` (`local → embedded-sqlite`); Local has no Restate requirement `docs/local-deployment.md:3-9` | Replace only after a qualified hosted replacement proves recovery/rollback parity; parity gaps keep this bounded component                                      |
| Transports                                    | **KEEP**                                                                                        | `direct-local` vs `remote-gateway` transport kinds; Runtime Gateway WebSocket protocol for device channels; remote-control relay                       | `packages/runtime-sdk/src/transport.ts:17`, `:29-32`, `:134`; `docs/runtime-gateway-protocol.md:1`, `:15-17`; `packages/remote-control-relay/src/index.ts:1-25`; `docs/remote-control-relay.md`                                                                                                                                                                                                          | Topology metadata only — transport swaps may not change semantic payloads (`packages/runtime-sdk/src/transport.ts:26-28`); replacement requires measured parity |
| Auth                                          | **KEEP**                                                                                        | Service/device principal claims in contracts; Ed25519 service credential verification; credential vault (service credentials only); secrets providers  | `packages/contracts/src/authentication.ts:17-21` (kinds incl. `runtime_device`), `:32` (claims); `apps/control-api/src/auth/service-authentication.ts:60`; `apps/runtime-gateway/src/authentication.ts:110` (`RuntimeNodeChannelAuthenticator`); `packages/credential-vault/src/vault.ts:29`, `packages/credential-vault/src/index.ts:70`; `packages/secrets/src/index.ts:35`, `:79`, `:121`             | Credential ownership must survive every removed layer (#941 acceptance); no retirement proposed                                                                 |
| Policy                                        | **KEEP**                                                                                        | Cedar policy decision point (`PolicyDecisionPoint`) with snapshot/digest pins                                                                          | `packages/policy/src/index.ts:99`, `:209`, `:262`; `docs/policy-decision-point.md`                                                                                                                                                                                                                                                                                                                       | Policy, approvals, and revocation must survive every removed layer (#941 acceptance)                                                                            |
| Billing/accounting                            | **KEEP**                                                                                        | Durable usage ledger (`DurableUsageLedger`) over SQLite (Local) and PostgreSQL (Hosted) stores; repo budget gates                                      | `packages/usage-ledger/src/durable.ts:227`; `packages/usage-ledger/src/index.ts:19`; `packages/sqlite-persistence/src/usage-store.ts:26`; `packages/database/src/usage-store.ts:92`; `budgets.json`; `scripts/check-budgets.mjs`                                                                                                                                                                         | Accounting reconciliation and receipts must survive every removed layer (#941 acceptance)                                                                       |
| Artifacts                                     | **KEEP**                                                                                        | Local filesystem object store; S3/R2-compatible hosted stores; runtime artifact verification                                                           | `packages/object-store/src/filesystem.ts:39`; `packages/object-store/src/index.ts:86`, `:93`; `apps/runtime-gateway/src/runtime-artifact-verifier.ts:16`; `apps/runtime-worker/src/hosted-managed-pi-artifact-stores.ts:12`, `:49`; `docs/object-store.md`                                                                                                                                               | Profile packaging (#1026) owns storage adapter packaging; removal requires residency/rollback evidence                                                          |
| Device supervision                            | **KEEP**                                                                                        | Adea-owned `RuntimeNodeRef` identity (`authority: agent_hq`) — Control Plane supervises connections, channels, and host processes, not device identity | `packages/runtime-sdk/src/models.ts:54-56`; `docs/runtime-capabilities.md:11-12`; `apps/runtime-gateway/src/runtime-node-identity-port.ts:8`; `packages/database/src/schema/runtime-connections.ts:69`, `:121`; `packages/deployment/src/process-runtime.ts:37`, `:114`; `packages/deployment/src/local-adapters.ts:13`, `:40`; desktop supervision contract `docs/local-deployment.md:21-22`            | Host credential/filesystem/device/E2E authority must be preserved per profile (#1026); no retirement proposed                                                   |
| Node Pi Durable adapter (successor candidate) | **REPLACE-CANDIDATE — opt-in, not yet the owner**                                               | `authority.sqlite` journal + host-supplied current authority (see surfaces section)                                                                    | `packages/pi-durable-adapter/README.md:1-14`; `packages/pi-durable-adapter/src/composition.ts:31`; `docs/pi-durable-runtime.md:42-47` (disposition: Restate/LangGraph/managed Pi retained)                                                                                                                                                                                                               | Becomes the owner only with #941 behavior/profile/rollback evidence; until then current owners stay                                                             |
| Cloudflare Pi host                            | **KEEP (unregistered — do not activate)**                                                       | Durable Object tables; no production route or advertised capability                                                                                    | `packages/pi-cloudflare-host/README.md:9-11`; `packages/pi-cloudflare-host/src/adapter.ts:70`, `:72`; `packages/pi-cloudflare-host/src/durable-object.ts:50`                                                                                                                                                                                                                                             | Activation is a separate, explicitly gated act (#930/#187 open); this PR activates nothing                                                                      |

Cross-layer coupling recorded by the tool as `report.coupling` with its label in
`report.couplingMethod`: a **static import heuristic** (string match, no type resolution) —
`@control-plane` scope only (external `@other-scope/…` specifiers never match an internal package
by basename), package directory mapped to its first-owning layer when one package spans multiple
layers, relative `.js`→`.ts` spelling resolved, test files and self-edges excluded; it is **not a
compiler-resolved dependency graph**. Totals for this capture: device-supervision 37,
custom-runtime 43, pi-durable-node-adapter 23, pi-cloudflare-host 12, artifacts 9, auth 7, billing
6, transports 5, policy 3, restate 2. Coupling is an observation, not a decision.

## Gates for any future removal (definition only — no removal is part of #941)

#941 requires these gates to be **defined** for any removal candidate; this PR performs no removal,
so no gate is executed here and none is claimed passed. A future removal PR must attach all three
evidence sets for the exact pinned profile and supported entry points:

1. **Behavior gate** — pinned crash/recovery/restore tests pass from each supported entry point on a
   disposable fixture; policy and approval decisions, credential ownership, accounting
   reconciliation, revocation, durable receipts, idempotency, retention, and rollback semantics are
   each demonstrated to survive the removal (trace: REQ 010/120/155/160, tests A21/A29/A32, gates
   #187/#194).
2. **Profile gate** — the capability-matrix row for the selected Local/Self-hosted/Hosted profile is
   behaviorally unchanged, selection stays independent with no silent failover to managed cloud,
   end-to-end residency is unchanged, and every bounded parity gap of the removed component is
   enumerated as satisfied; a feature list alone never qualifies.
3. **Rollback gate** — an executed upgrade → drain → removal → rollback rehearsal on a disposable
   fixture showing the prior version restores state and resumes, with retained logs/receipts and
   pinned versions in the plan.

A removal lacking any gate stays blocked; a component with unresolved parity gaps stays a bounded,
explicit component (per #941 acceptance).

## Node and Cloudflare adapter / capability / authority surfaces (exact current `main`)

### Node — `@control-plane/pi-durable-adapter`

| Surface                                                                                                                                                                                                                                               | Exact location                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PiDurableRuntimeAdapter implements RuntimeAdapter`                                                                                                                                                                                                   | `packages/pi-durable-adapter/src/adapter.ts:59`                                                                                                                                                                             |
| Advertised capabilities (`stream.output`, `stream.events`, `interaction.user-input`, `interaction.approval`, `execution.cancel`, six session capabilities, `model.select`, conditional `execution.child`, conditional `execution.scope.workspace.v1`) | `packages/pi-durable-adapter/src/adapter.ts:76-89`                                                                                                                                                                          |
| Inspection metadata (`adapterName: 'pi-durable'`, `transportKind: 'direct-local'`)                                                                                                                                                                    | `packages/pi-durable-adapter/src/adapter.ts:93-101`                                                                                                                                                                         |
| Declared limitations (`NODE_SQLITE_REMOTE_HOST_ONLY`, `CLOUD_PROFILE_UNQUALIFIED`, `PAID_INFERENCE_RESTART_REQUIRES_RECONCILIATION`, …)                                                                                                               | `packages/pi-durable-adapter/src/adapter.ts:104-112`                                                                                                                                                                        |
| Capability evaluation is checked before start (`capabilityEvaluation.eligible`, family/location checks)                                                                                                                                               | `packages/pi-durable-adapter/src/adapter.ts:118`, `:455-459`                                                                                                                                                                |
| Durable journal owner (`authority.sqlite`)                                                                                                                                                                                                            | `packages/pi-durable-adapter/src/adapter.ts:72`; `packages/pi-durable-adapter/src/journal.ts:27`                                                                                                                            |
| Canonical authority (`CanonicalPiDurableAuthority`, server-side read/assert)                                                                                                                                                                          | `packages/pi-durable-adapter/src/canonical-authority.ts:122`                                                                                                                                                                |
| Workspace scope authority port (`CurrentExecutionScopeAuthority`, opt-in)                                                                                                                                                                             | `packages/pi-durable-adapter/src/contracts.ts:163`                                                                                                                                                                          |
| Effect gate / spending / usage / provider authorities                                                                                                                                                                                                 | `packages/pi-durable-adapter/src/effect-gate.ts:40`; `packages/pi-durable-adapter/src/spending-authority.ts:62`; `packages/pi-durable-adapter/src/usage-authority.ts:169`; `packages/pi-durable-adapter/src/provider.ts:31` |
| Process/session fencing (`NodeSessionLease`)                                                                                                                                                                                                          | `packages/pi-durable-adapter/src/lease.ts:14`                                                                                                                                                                               |
| Runtime composition factory                                                                                                                                                                                                                           | `packages/pi-durable-adapter/src/composition.ts:31` (`createNodePiDurableRuntime`)                                                                                                                                          |
| Control API lead composition (canonical admission + HTTP receipts)                                                                                                                                                                                    | `apps/control-api/src/pi-durable/node-composition.ts:51` (`createNodePiDurableLeadComposition`), options `:24`                                                                                                              |

### Cloudflare — `@control-plane/pi-cloudflare-host`

| Surface                                                                                                       | Exact location                                                                                                          |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CloudflarePiRuntimeAdapter implements RuntimeAdapter` (partial, unregistered)                                | `packages/pi-cloudflare-host/src/adapter.ts:50`                                                                         |
| Inspection metadata (`adapterName: 'pi-cloudflare'`, `health: 'degraded'`)                                    | `packages/pi-cloudflare-host/src/adapter.ts:60-68`                                                                      |
| **`capabilities: []` — nothing advertised**                                                                   | `packages/pi-cloudflare-host/src/adapter.ts:70`                                                                         |
| Limitations: “Internal Cloudflare owner composition only; no deployment profile or capabilities advertised.”  | `packages/pi-cloudflare-host/src/adapter.ts:71-75`                                                                      |
| Capability evaluation runs over the empty set                                                                 | `packages/pi-cloudflare-host/src/adapter.ts:77`                                                                         |
| Server-only authority port `CloudflareCurrentAuthority` (`readAccepted`/`assertCurrent`; never an HTTP claim) | `packages/pi-cloudflare-host/src/host.ts:17`, `:34` (`CloudflarePiHost`); `packages/pi-cloudflare-host/README.md:25-33` |
| No production Worker route / registration / deployment profile                                                | `packages/pi-cloudflare-host/README.md:9-11`; `packages/pi-cloudflare-host/src/durable-object.ts:50`                    |
| DO-owned storage table set (`cp_pi_owner`, `cp_pi_tasks`, `cp_pi_events`, `cp_pi_wake`)                       | `packages/pi-cloudflare-host/README.md:46-51`                                                                           |

Both surfaces are distinct and must not be conflated: the Node adapter advertises real capabilities
and enforces `CLOUD_PROFILE_UNQUALIFIED`; the Cloudflare host deliberately advertises none and has
no activation path in this PR.

## Candidate baseline measurements

Source of truth: `docs/evidence/m17-01-runtime-ownership-baseline.json` (captured by the exact
command above; values below are copied from it).

### Complexity (static, per measurement group)

| Layer                   | Files | Source files | Source LOC | Test files | Test LOC | Export statements | Cold import (ms) | Import RSS Δ (MiB) |
| ----------------------- | ----: | -----------: | ---------: | ---------: | -------: | ----------------: | ---------------: | -----------------: |
| custom-runtime          |    88 |           49 |     10,536 |         39 |   10,782 |               396 |            132.3 |               62.9 |
| restate                 |     4 |            3 |        527 |          1 |      254 |                15 |             10.5 |                7.1 |
| transports              |    17 |           15 |      2,760 |          2 |    1,299 |               137 |             98.0 |               47.0 |
| auth                    |    17 |           14 |      2,745 |          3 |      893 |               103 |             80.4 |               41.1 |
| policy                  |     4 |            2 |        685 |          2 |      457 |                25 |             76.8 |               39.1 |
| billing                 |    10 |            6 |      3,637 |          3 |    1,802 |                46 |             72.4 |               40.7 |
| artifacts               |    10 |            5 |      1,683 |          5 |    1,482 |                19 |            136.8 |               54.9 |
| device-supervision      |    45 |           28 |      7,229 |         17 |    6,397 |               149 |              7.7 |                5.4 |
| pi-durable-node-adapter |    42 |           26 |      6,400 |         16 |    5,155 |               109 |            283.4 |               82.3 |
| pi-cloudflare-host      |    21 |           10 |      1,636 |         11 |    2,460 |                43 |            113.1 |               47.2 |

Import time and RSS delta come from one fresh bun child per layer entry; RSS delta is not peak
memory. Layer file sets are disjoint (the tool fails with `M17_LAYER_OVERLAP` on any overlap).

### Latency (local, disposable state; n per layer as configured)

| Probe                                  | Workload                                        | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |   n |
| -------------------------------------- | ----------------------------------------------- | -------: | -------: | -------: | -------: | --: |
| Local embedded-SQLite queue round trip | enqueue → claim → complete (`WorkflowJobStore`) |     2.35 |     3.79 |    10.27 |    10.27 |  50 |
| — enqueue phase                        |                                                 |     0.74 |     1.13 |     5.46 |     5.46 |  50 |
| — claim phase                          |                                                 |     0.92 |     1.43 |     3.04 |     3.04 |  50 |
| — complete phase                       |                                                 |     0.69 |     1.27 |     1.76 |     1.76 |  50 |
| Local filesystem artifact put/get      | `FilesystemObjectStore` 1 KiB object            |     2.63 |     4.67 |     6.11 |     6.11 |  50 |
| Durable usage ledger reserve           | `DurableUsageLedger.reserve` on SQLite          |     8.95 |    14.42 |    16.79 |    16.79 |  50 |
| — budget open (one-off)                |                                                 |    13.20 |        — |        — |    13.20 |   1 |
| In-process policy authorize            | Cedar PDP + **fake** evaluator                  |     0.04 |     0.07 |     0.12 |     1.88 | 200 |

Honesty labels: single-process developer host; the policy probe uses `FakeCedarEvaluator`, not a
real Cedar engine; the ledger probe seeds an execution owner record in its own disposable database;
outliers reflect an unsandboxed shared host. These are regression baselines, not capacity numbers.

### Memory

Per-layer cold-import RSS deltas are in the complexity table (5.4–82.3 MiB); the probe process ended
at ~177 MiB RSS after all probes (`rssAfterProbesBytes` in the evidence JSON). RSS snapshots are not
peak memory.

### Unavailable costs (labeled, not estimated)

Recorded verbatim in the evidence report (`unavailableCosts`):

1. Restate server invocation latency/state growth (hosted profiles) — needs a running Restate server; Local has none.
2. Managed-cloud operational cost (Railway/Neon/R2/Restate) — needs live billing accounts; no credentials used or requested.
3. Cloudflare Worker/DO latency and cost — no deployment/account; Cloudflare host advertises no capability.
4. Live model-provider latency and spend — no provider credentials; out of scope for #941 tooling.
5. Physical RuntimeNode device supervision health — no device attached.
6. PostgreSQL hosted-server profile latency — local Postgres fixture not started for this run.
7. Review and acceptance handling time — not machine-measurable (a cost item, not an acceptance gate).

### Precise cost-baseline gap

Measured: local marginal cost proxies for the four instrumented paths (latency distributions and
memory) on one developer host — that is the full extent of the retained cost baseline. Not measured
and **not claimed passed**:

- hosted idle/active operational cost (Railway CPU/RAM/network, Neon compute/storage/egress, R2
  storage/ops, Restate server state growth) — requires live metered accounts and billing exports;
  no credentials are used or requested;
- Cloudflare Worker/Durable Object billing — no deployment or account;
- live model-provider spend — no provider credentials;
- physical device supervision cost — no attached hardware;
- PostgreSQL hosted-store latency — fixture not started for this run.

The M9/M10 records in [`docs/performance.md`](performance.md) are profile-specific history, not a
#941 cost baseline. The gap above stays labeled `unavailable` — never estimated — and closes only
with a future live metered profile capture.

## What this candidate does not claim

- It performs **no removal**: no keep/replace/retire decision here is executed. Per-layer
  behavior/profile/rollback evidence packages (the #941 evidence-per-removal requirement) remain
  future work, as do measured before/after comparisons — this is the _before_ snapshot.
- It activates no production component: no Cloudflare Worker route, no Restate mode change, no
  hosted profile change, no credential creation, no package publication.
- Local behavior is preserved: Local remains embedded SQLite without Restate
  (`docs/local-deployment.md:3-9`, `apps/local-control-plane/src/composition.ts:319`), and the
  probes touched only disposable temp databases.
- Acceptance: this is an automated agent-produced review/test run, recorded as such — never as a
  human attestation, and with no human-only acceptance gate: acceptance is the root acceptance
  review, an explicitly dated act that has not yet been performed for this candidate. The search
  recorded above found no accepted/published #941 baseline as of this capture.

## Tooling tests and validation

- `packages/production-readiness/src/m17-runtime-baseline.test.mjs` runs the CLI end-to-end with
  bounded iterations and asserts layer coverage for all eight #941 areas plus both adapter surfaces,
  the run-scoped candidate statement, the corrected write policy, absence of ambient environment
  values, four measured probes, and unavailable-with-reason labeling for every unmeasured cost.
- `packages/production-readiness/src/runtime-baseline-analysis.ts` holds the shared analysis with
  exact-edge fixtures covering package-subpath and `.js`→`.ts` coupling resolution, external-scope
  basename rejection, and the `couplingMethod` heuristic label, plus the bounded failure-reason /
  import-probe classifiers (successful-exit and finite-nonnegative measurement validation with
  exact regressions); a forced-failure CLI run (unusable TMPDIR) asserts the export carries only
  bounded reason codes and leaks no raw error or child output.
- Commands: `bun test src/m17-runtime-baseline.test.mjs` (package), `bunx oxfmt --check`,
  `bunx oxlint --deny-warnings`, `bun run check:boundaries`, `bun --cwd=packages/production-readiness run build`.

## Traceability

REQ 010, 120, 155, 160 · Tests A21, A29, A32 · Reuse/gates: adea-ai/control-plane#187,
adea-ai/control-plane#194 · Dependencies of record: #936 (J3), #938 (L1) · Coordination before any
shared-contract change: #1026, #935.
