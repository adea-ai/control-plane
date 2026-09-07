# M11 local integration checkpoint

Optional Runtime Worker startup follow-up: direct startup previously reported ready without an
injected worker in production, and a failed worker readiness probe skipped worker cleanup. Both
behaviors were reproduced by failing regressions. Staging/production now require an injected
worker and register its cleanup before probing; local bootstrap remains available. The full
lint/type/format/test command passed with 800 unit tests and 3,293 assertions. No external worker,
database, provider or deployment was started for these tests. This closes a false-readiness and
startup-cleanup gap in the optional service, not the missing gateway command-consumption loop or
live cancellation acceptance. It does not change the accepted two-application-service Cloud topology.

Decision: incomplete milestone; local integration passed. This is not final release approval.

Validated candidate: `dac6dd6a15272a345aa57f4ad586ed9a5d8de7c4` on local branch
`codex/m11-integration-candidate`. The candidate combines these exact PR heads:

| PR                                                   | Head                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| #392 component disclosure and CI prerequisites       | `b49c63b85623eb72f4cb4c3f85bded7c996dd022` |
| #393 Hosted Restate identity                         | `1c6ff75960377fdd054a7fa1ab222f4f5f8bf2eb` |
| #394 evaluation authority and metrics                | `4624360aae532e9c6100b825b22be7e8c53605a0` |
| #395 canonical source and contributor reconciliation | `b441d8eec339ed2aaad894a456a902fdd4a3bb29` |
| #396 command retention                               | `d85e0b8f7f0c6bef4548507afe5c23e4180c3f5f` |

All local merges completed without conflicts. No branch was merged into `main`, no release
was published, and no deployment or Neon permissions changed.

## Checks on the candidate

`bun install --frozen-lockfile`, `bun run lint`, `bun run type-check`,
`bun run format:check`, and `bun run test` exited successfully. The test command includes
the workspace build. Results: 754 unit, 47 smoke and 98 E2E tests; zero failures.
Coverage: 87.40% lines and 83.83% functions, exceeding the configured 80% minimum.
Requirement validation checked 80 entries and 103 historical issue audits; architecture
validation checked 41 packages, 13 operations and four profiles. Those validator counts
do not establish that all underlying requirements are implemented or accepted.

The signed-request negative test deliberately logs a rejected invalid JWT. Its test passes;
that expected rejection is not an observed authentication failure for valid requests.

## Remaining acceptance

At the initial checkpoint no PostgreSQL integration, live Hosted Compose, Railway/Neon/R2, fresh Linux VPS, load/soak,
adversarial live-provider, human calibration or independent final audit was run on this
combined candidate. Earlier branch-specific evidence must not be relabeled as exact-candidate
evidence. The existing requirements ledger candidate remains a historical audit record, not
this integration checkpoint. M11 issues #188 and #190–#197 remain open acceptance work.

Neon CI requires the build prerequisite already included from #392 and separately has a
role-membership blocker on that PR. Local integration success does not waive remote CI.
Permission approval remains outstanding. Execution-lifetime retention, physical cleanup and
legacy remediation remain separate from the accepted-command retention boundary tests.

The local integration worktree is intentionally retained for subsequent candidate testing.
No new persistent server or database container was created by this checkpoint. Existing
unrelated containers were left untouched.

## PostgreSQL follow-up

At `9a76a046e375f6c18fc9b4870f917655e2524954` (only this report differs from the
validated code candidate), an isolated PostgreSQL 18.3 Compose project ran on an
automatically allocated loopback port with repository-owned local fixture roles.
The direct database suite passed 22 tests. `bun run test:integration` then passed
the 22 database tests, one shared-harness isolation test and one profile-migration
test, with 33 successful build/integration tasks. The backup/restore drill preserved
the asserted evaluation, execution, event and usage evidence.

The migration test covers its named catalog subset; it is not full product-data
migration certification. The integration runner explicitly skipped the disruption
drill because the container was already running when that runner began. That skip
is not a pass, and no database-process interruption is claimed in this follow-up.

Compose project `m11-integration-db` was removed with its container, network and
volume; label-filtered container and volume inventories were empty afterward.
No remote credentials or Neon permission changes were used. Cloud/VPS, full recovery,
physical retention and independent final acceptance remain open.

## PostgreSQL disruption follow-up

At `5a54200` (code unchanged from the combined candidate), the dedicated local
`m11-integration-disruption` project ran `scripts/run-postgres-disruption-drill.mjs`.
The initial attempt failed: Docker changed the ephemeral port from 55005 to 55006
on service restart, leaving the test client aimed at a closed port. That attempt
is not passing recovery evidence. After pinning the same test project's loopback
port to 55005, the unchanged drill exited zero: database access failed while the
service was stopped, and the committed evaluation digest survived restart.

This is a single-instance stop/start test, not replicated failover, full execution
recovery, or a measured production RTO certification. The script enforces its
configured recovery bound but does not emit an exact recovery duration.
The test container, network and volume (including data from the failed first
attempt) were removed; label-filtered inventories were empty. No shared database,
Neon role or production service was modified.

## Named release-command follow-up

At `dc5a48a` (code unchanged from the combined candidate), the documented commands
`bun run test:m10-conformance`, `bun run test:m10-operability` and
`bun run test:m11-standalone` completed successfully in sequence. The standalone
command ran 77 acceptance tests plus context (19), Cortana-compatible adapter (7),
relay (18), profile-portability (13) and deployment (9): 143 passing tests.
The profile package explicitly skipped one PostgreSQL migration test because this
credential-free invocation did not enable database integration. That same named
test passed separately in the PostgreSQL follow-up above; the skip is not counted
as a pass here.

These commands exercise their checked-in reference transports and fixtures,
including Local direct runtime and packaged RPC scenarios. Command success alone
does not prove every #188 scenario, live external providers, fresh VPS deployment,
managed cloud or the independent final #197 acceptance procedure.

## Live Hosted Server signing follow-up

At `3917c80` (code unchanged from the combined candidate), a local isolated server-profile
Compose run built the Hosted image, bootstrapped PostgreSQL roles, migrated the database and
started Restate plus Hosted. `/ready` returned 200 and unsigned `/discover` returned 401.
Restate and Hosted were then force-recreated with the same persisted signing key; readiness
and unsigned rejection passed again. Harness process exited zero.

Project: `m11-integration-signing-80690`. The local test image
`control-plane/m11-signing-test:80690` is intentionally retained for inspection. The temporary
private signing material and database/application data were removed, all five Compose
containers and their network were removed, and a label-filtered container inventory was empty.

This proves the exercised local Hosted Server startup/signing/recreation path. It does not
prove full representative execution, remote runtime identity integration, Hosted Simple,
fresh VPS deployment, cross-product relay or managed-cloud acceptance. The local temporary
harness was `/tmp/m11-hosted-signing-live.mjs`; it is not a versioned release command.

## Live Hosted Simple startup follow-up

At `8522e32` (code unchanged from the combined candidate), isolated Compose project
`m11-integration-simple-83214` built and started the Simple image with one application
container and its embedded Restate runtime. No separate PostgreSQL or Runtime Gateway
service was started. Readiness returned 200 and the SQLite file existed on the bind-mounted
data path. Force-recreation against the same directory passed those checks again.

This checks startup/recreation and file presence, not recovery of an accepted execution,
exactly-once effects, graceful shutdown or fresh VPS behavior. The temporary harness was
`/tmp/m11-hosted-simple-live.mjs`. It exited zero and removed the container, network and
temporary application data, including local credentials. Follow-up checks found no container
with that project label and confirmed the data directory absent. Test image
`control-plane/m11-simple-test:83214` is intentionally retained for inspection.

## Hosted Simple shutdown correction

The combined candidate at `892cfd39894fac82cb9289642e3c6804be82f0cc` includes
the process stop-timer cleanup. Its sequential lint, type-check, format-check and
full test command exited zero; the unit suite reported 756 passes and no failures.
Independent review identified a possible orphan child in the regression test's
timeout path. Commit `e523ec9` isolates the launcher process group and cleans it
up in `finally`; a second review found no remaining actionable issue. The owning
package passed all 11 tests, with repository formatting and lint checks passing.

At combined candidate `af5a22f78c3e916ccbdc1aba23b0e024221f9eda`, isolated project
`m11-integration-simple-91956` rebuilt the Simple image and passed readiness 200
and persistent SQLite file checks. Explicit Compose stop completed in 351 ms;
container inspection reported exit code 0 and OOMKilled false. Force-recreation
against the same data directory passed the probes again. The harness exited zero.
The process, container, network and temporary data directory were verified absent.
Image `control-plane/m11-simple-test:91956` is intentionally retained for inspection.

This is a single local idle-service shutdown measurement, not a performance bound,
in-flight execution recovery test or fresh VPS acceptance. The earlier run whose
output was lost is not counted as evidence. This follow-up does not close M11.

## Updated-main candidate and SQLite restore follow-up

Candidate `f0cf911e183a9cb09941d7d11cc4688d2b29d3ce` incorporates the previously
combined work plus newer main changes and SQLite restore commits `c912c5a` and
`5a14a88` (draft PR #401). Prior exact-tree results are historical, not certification
of this candidate. Fresh frozen-lockfile installation, lint, type-check, format-check,
build and full tests passed: 763 unit, 49 smoke and 98 E2E, with zero failures.
Coverage was 87.49% lines and 83.89% functions.

The SQLite fix stages and checks candidate backups before replacing live data.
Seven new regression cases cover partial-write cleanup, corruption, unrelated or
future-version databases, missing columns, missing constraints and missing indexes.
Invalid-candidate cases preserve original records through close/reopen. The owning
package passed 20 tests on its branch; independent follow-up review cleared the
two findings concerning staging cleanup and canonical schema checks. This does not
prove cross-process restore locking, filesystem replacement rollback or future
schema migration; documented operator quiescence and trusted-checkpoint duties remain.

The named `test:m10-conformance`, `test:m10-operability` and `test:m11-standalone`
commands also passed on this candidate with only a documentation assessment correction
in the worktree. The standalone command ran 145 passing tests. PostgreSQL profile
migration was explicitly skipped in the credential-free invocation; older PostgreSQL
evidence is not promoted to proof for this new tree.

The architecture assessment now agrees with the source ledger that six formerly
unavailable sources were retrieved. Its classification remains partially verified:
exhaustive extraction, implementation mapping and topology reconciliation remain open.

Remote run `34148375633`, job `101825207041`, for PR #401 at `5a14a88` failed
creating its Neon branch with HTTP 422, before migrations or integration tests.
The observed log does not establish the cause of that rejection. It is distinct
from the earlier #392 SET ROLE failure, and neither is counted as passing CI.
No external database permissions were changed, no main merge was performed, and
the integration branch remains local only. Full M11 acceptance is still unproven.

## Neon preview capacity diagnosis

Read-only authenticated CLI inspection on 2026-09-07 resolved the repository's
`NEON_PROJECT_ID` to the Control Plane project. Its project record reports
`owner.branches_limit = 10`; the branch inventory contains exactly 10 branches:
production, staging and previews for PRs #392, #393, #394, #395, #396, #397, #399
and #400. Six previews belong to this milestone's proposed changes. There is no
preview for #401. PRs #397 and #400 remain open, and the M11 PRs remain open;
none of these previews is established as stale cleanup material.

The exhausted branch capacity strongly explains #401's HTTP 422 creation failure,
but the action log omits the detailed API rejection body, so this is an inference
from current account state rather than a quoted server reason. No branch was
created, deleted or modified during diagnosis; no billing or role settings changed.
Freeing capacity requires an explicit preview-retirement choice or a limit change.
That decision is separate from the previously observed migrator role-membership gate.

## Current-candidate PostgreSQL integration and recovery

At `7c32969` (runtime code unchanged from `f0cf911`), `bun run test:integration`
completed with isolated Compose project `m11-candidate-pg-20260907` and fixed
loopback port 55009. It used only repository fixture credentials and PostgreSQL
18.3, not Neon or any shared database. All 24 integration tests passed: database
22, profile-portability migration 1 and isolated-test harness 1. The previously
skipped SQLite-to-PostgreSQL-to-SQLite catalog migration therefore has fresh
passing evidence on this candidate. All 33 orchestration tasks succeeded.

Because this runner created the fixture, it also executed its disruption drill:
access failed while PostgreSQL was stopped and the committed evaluation digest
survived service restart. Its backup/restore drill preserved the asserted immutable
evaluation, execution, event and usage evidence. These remain bounded local
single-instance tests, not replicated failover, managed-cloud certification,
complete domain migration or measured production recovery guarantees.

The command exited zero and stopped its service. Explicit follow-up removed its
container, network and disposable volume; label-filtered inventories were empty
and port 55009 had no listener. Unrelated database and release containers were
left untouched. The Neon capacity and role-authorization gates remain separate.

## Real SQLite measurement harness

Commit `d9f3d76ab69cdd7f3084d780ebe7a124d575032a` adds a bounded real-provider
SQLite record benchmark with independently checked values/revisions, integrity
verification, per-operation raw latency samples and an environment manifest.
Full lint, type-check, format, build and tests passed before the clean measurement:
763 unit, 51 smoke and 98 E2E. This introduces no release budget or benchmark score.

The default run verified 1,000 records at concurrency 8 on the recorded Apple M2 Max
developer host, using Bun 1.4.0 and SQLite 3.51.0. The reported `process.version`
is Bun's Node-compatibility value, not proof of execution under a native Node binary.
Raw evidence is retained in [m11-sqlite-d9f3d76.json](./m11-sqlite-d9f3d76.json),
including all 2,000 write/read latency samples. Observed write/read-pair throughput
was approximately 4,276 records/second; write p95 was 1.79 ms, replay-read p95
1.46 ms, backup time 2.47 ms and measured WAL size 2,138,312 bytes.

This single fresh-database run is measurement-only, not a cold-host/warm-host study,
peak-memory profile, baseline comparison, statistical confidence bound, execution
acceptance throughput, VPS capacity or production release approval. The benchmark
removed its temporary database before emitting successful evidence. The existing
synthetic M9 harness and this real SQLite harness have different workloads and
must not be compared as equivalent baselines.

The original raw artifact's `dataDigest` identifies the workload descriptor, not
the resulting SQLite file bytes. The harness now names that field `workloadDigest`.
Review also identified that the test subprocess timeout could bypass child cleanup;
the test runner now owns the temporary root and isolated process group and removes
both after timeout. A forced-timeout regression confirms partial-file-tree cleanup.
These follow-ups do not rewrite the historical raw samples or their candidate ID.

## Context authoring service and SQLite persistence follow-up

The pre-validation `ContextPackageAuthoringService` now separates request selection
from composition-owned policy and Artifact adapters. Caller authorization flags,
state content, Artifact metadata and compilation timestamps are rejected. Scope,
principal, decision expiry, Artifact availability and policy budget ceilings are
checked before persistence. Expired or disallowed item decisions fail before state
reads. These are internal service semantics, not a new authenticated HTTP operation.

On 2026-09-07, the candidate passed `bun run lint`, `bun run type-check`,
`bun run format:check` and `bun run test`: 771 unit, 52 smoke and 98 E2E tests,
with 87.56% line and 83.96% function coverage. The SQLite package's focused 24-test
run also passed, including creation from persisted ProjectState, unauthorized
principal rejection, policy budget narrowing, and identical package lookup by ID
and digest after a file-backed database close/reopen. Its temporary database was
removed in the test's finally block.

Independent review identified premature Artifact resolution for stale optional
items. Authoring now shares one trusted freshness timestamp with compilation and
skips those references before resolution; a regression verifies successful
`STALE_OPTIONAL` exclusion without Artifact reads. Policy expiry is rechecked
after asynchronous resolution. Review also recorded that authoring observations
do not establish ongoing lifecycle authorization: execution-time revocation or an
authoritative revision/lease contract remains necessary.

This does not establish production reachability, a product Artifact adapter,
optional-provider enrichment, entrypoint authentication/idempotency or PostgreSQL
authoring conformance. Those gates remain open under
`COMPAT-CONTEXT-COMPILER-REACHABILITY`; no all-profile completion is claimed.

## Context authoring PostgreSQL recovery follow-up

The recovery scripts now seed an atomic authoring command/package pair in addition to their
existing evidence. The service-restart drill compares the exact record and full package through
application repositories before and after a real PostgreSQL stop/start. The backup/restore drill
compares both JSON values and validates package integrity in a separate restored database using
admin SQL. Restore excludes privileges, so this is data recovery evidence, not restored application
permissions or end-to-end execution-validation replay evidence.

The integration runner passed on 2026-09-07, including its integration suites, connection-loss
check and both extended recovery drills. The canonical lint, type-check, format-check and test
chain also exited successfully (773 unit tests; 87.28% line and 83.85% function coverage).
Disposable project `m11-authoring-recovery-20260907`, its PostgreSQL volume and network were
removed; loopback port 55039 was verified closed. No new agents or persistent servers were started.
The candidate remains local-only and full M11 acceptance remains unproven.

## Execution validation trusted-principal boundary

The validation controller now forwards the guard-authenticated principal separately from caller
assertions in the request body. The durable service rejects absent and mismatched principals before
any profile/state/package/skill reads or plan writes. A regression first failed against the previous
service, then passed with this explicit boundary; the same test verifies the authenticated HTTP path.
This is composition hardening, not a demonstrated bypass of the existing HTTP authentication guard.
Non-HTTP callers remain responsible for authenticating the principal they supply.

The canonical lint/type-check/format-check/test chain passed on 2026-09-07, including 773 unit tests
and 87.29% line / 83.85% function coverage. No new agents or persistent servers were started.
Execution validation still lacks its own durable command result replay, and inline authoring remains
disabled. Neither this change nor the internal context-authoring repository closes that requirement.

## Upstream refresh and preview cleanup

Candidate merge `567d80b` incorporated upstream `301aa7a` (SDK publication fixes and the
adopted Code Foundry v1.4.1 callers). The canonical local gate chain passed after integration.
Authenticated GitHub inspection then confirmed that cleanup run `34152272912` failed because
PR #404's preview did not exist. The pinned deletion action has no missing-branch no-op option.

The local workflow now resolves a unique exact preview name through the paginated Neon list API
before invoking that same pinned action with a validated branch ID. Verified absence skips deletion;
API failures, malformed responses, unsafe targets and incomplete pagination still fail. Eight focused
workflow tests pass, including six cleanup cases, and the full lint/type/format/test chain passes
(773 unit tests; 87.29% line and 83.85% function coverage). The CI guide now matches the adopted
runtime pin and direct-main PR topology. These are local checks, not hosted cleanup certification.

No Neon branches or role grants were changed. The prior read-only inventory still showed ten
branches, including the preview for closed PR #400; removing that exact preview remains pending
user approval. The independent `SET ROLE control_plane_migrator` failure remains unresolved.

## PostgreSQL validation-command persistence

Migration 0033 and `PostgresExecutionValidationCommandRepository` add atomic first-result
command/plan persistence. The integration test passes eight competing commits through four
connections, first-result replay, changed-hash conflict, caller isolation, injected transaction rollback,
repository reconstruction and corrupted metadata rejection. An initial fixture collision with an
earlier shared-suite plan was corrected using distinct inputs plus pre-test absence assertions.

The integration runner passed 28 tests (24 database, two LangGraph, one portability and one harness)
and its existing connection-loss/restart/backup drills. Those drills do not yet seed validation-command
records, so they are not proof of this record type's recovery. Full local lint/type/format/test gates
also passed; profile portability, production API wiring and end-to-end validation replay remain open.

## Validation-command portability follow-up

The portable manifest category and SQLite/PostgreSQL mappings now retain validation-command
records with their exact plans. Manifest verification rejects missing plans, forged keys, aliased plan
IDs and scope/request/digest mismatches. The real SQLite → PostgreSQL → SQLite test verifies the
record through both repositories and preserves all exported logical IDs and record digests. Its
SQLite providers are closed during teardown even if an assertion fails.

The full local lint/type/format/test chain passed (776 unit tests; 87.14% line and 83.81% function
coverage), as did all 28 PostgreSQL integration tests and the existing recovery drills. The drills
still do not seed validation commands. This closes the bounded record-portability check, not live
cutover, production API replay or full milestone acceptance. No remote infrastructure was changed.

## Validation service replay wiring

The reference-only validation service now uses the atomic command repository in managed cloud,
Hosted Server and shared Local/Hosted Simple compositions. It verifies the authenticated principal
before lookup, computes semantic input identity itself, uses a trusted compilation clock for new
records, replays the recorded plan without rereading compilation inputs, and returns 409 for changed
inputs under the same key. The HTTP test covers replay, missing credentials and conflicts. A real
Local SQLite test covers eight concurrent service calls, one stored command/plan pair and replay
from a reconstructed composition after closing/reopening the database with inputs/clock unavailable.

The full lint/type/format/test chain passed with 777 unit tests and 87.15% line / 83.80% function
coverage. Architecture evidence was regenerated for the reviewed composition changes; it also
picked up the already-adopted SDK patch versions, without changing readiness classifications.
No persistent server or agent was started for these tests, and their temporary SQLite files were
removed. No remote infrastructure was changed. Cloud/Hosted API restart certification, historical
validation retry rollout handling, execution-time revocation and inline authoring remain separate
acceptance gates; replay is not a fresh grant of execution authority.

## Validation-command recovery drills

The PostgreSQL restart drill now seeds a validation command and its exact execution plan, verifies
both after stopping and restarting PostgreSQL, and retries the repository commit to prove the same
record is returned. The backup-restore drill checks the exact restored command/plan pair plus plan
integrity and command binding. This supersedes the earlier notes that these drills did not seed
validation commands. Restore uses an administrator connection and excludes ownership/privileges;
it is data-recovery evidence, not application permission restoration or an API restart certification.

The integration runner and its connection-loss, restart and backup-restore drills exited zero, as did
`bun run lint && bun run type-check && bun run format:check && bun run test`. The disposable Compose
project `m11-validation-recovery-20260907` used port 55069; its container, network and volume were
removed after validation and the port was verified closed. No remote infrastructure was changed.

## Cloud validation HTTP and PostgreSQL reconstruction

The cloud composition integration test uses real PostgreSQL repositories, the actual HTTP handlers
and signed Ed25519 service credentials. Eight concurrent requests persist one command/plan pair.
After closing the application and its connection and reconstructing both, replay returns the exact
plan with compilation readers and clock unavailable. Changed inputs return 409; invalid and revoked
credentials return 401. HTTP injection does not open a listening socket and is not a separate-process
crash or deployed restart test. Test-only configuration and locally generated keys are not production
identity issuance evidence.

The new case passed 25 assertions; all 29 integration tests and PostgreSQL recovery drills passed.
The repository test-inventory assertion was updated to include this integration lane. Full lint,
type-check, format and test gates passed (777 unit tests, 85.54% line / 74.59% function coverage).
An initial HTTP status expectation was corrected from 201 to the route's documented 200; no
production behavior was changed. The disposable `m11-cloud-replay-20260907` Compose resources were
removed and port 55079 was verified closed. No remote infrastructure was changed.

## Inline context-input validation boundary

The validation request now accepts exactly one context source: the existing immutable reference or
strict caller-selection inputs. The service forwards authenticated scope/principal to an injected
authoring service, hashes the full validation payload, and retains final plan replay. Missing authoring
composition returns 503. HTTP tests cover forwarding, unavailable composition, replay without the
authoring service and changed-input conflict. A real SQLite fixture creates an authored package and
validation plan, closes/reopens persistence, and replays the same result without compilation inputs.
The fixture is not a production policy/Artifact adapter and does not close entrypoint reachability.

OpenAPI was regenerated without changing the v3 baseline. The compatibility checker now handles
plain request unions conservatively: every old branch must remain accepted by at least one new
branch; removed/narrowed alternatives and unsupported sibling constraints fail the gate. Focused
regressions cover those cases. An initial Local test used stale built API output; rebuilding the
dependency resolved it without changing persistence behavior.

Full lint/type/format/test checks passed (779 unit tests, 85.56% line / 74.61% function coverage).
All 29 PostgreSQL integration tests and the connection-loss/restart/restore drills passed; these
remain reference-validation PostgreSQL evidence, not inline-authoring coverage on that backend.
The disposable `m11-inline-validation-20260907` database resources were removed and port 55089
verified closed. No remote infrastructure, production authority, or compatibility baseline changed.

## Authoring composition wiring

All composition families now accept server-owned `ContextAuthoringCompositionOptions` and construct
the authoring service with their durable repositories. Managed-cloud startup and the embedded/Hosted
launcher options forward the configuration. Missing configuration remains unavailable for new inline
requests. No environment variable or request flag grants authority, and no product adapter was
fabricated. Concrete policy/Artifact adapters and deployed all-profile acceptance remain open.

Local SQLite coverage now uses constructor injection. The cloud PostgreSQL HTTP case now authors
inline context and replays it after application/connection reconstruction without the authoring option;
it passed 31 assertions. Hosted tests check launcher propagation and service construction, not live
Hosted inline execution. All 29 PostgreSQL integration tests and recovery drills passed. Full local
gates passed with 779 unit tests and 85.53% line / 74.38% function coverage.

The Hosted application gained its explicit workspace Context dependency. Lockfile generation also
reconciled already-existing SDK manifest versions (1.3.3, 1.5.3, 1.2.3); no external package was
upgraded. Architecture inventory/fingerprints were refreshed without readiness reclassification.
The disposable `m11-authoring-composition-20260907` container, network and volume were removed;
port 55099 was verified closed. No remote infrastructure was changed.

## Live milestone and CI gate refresh

Authenticated GitHub reads after the authoring composition checkpoint confirmed that upstream
`main` remains `301aa7a650fcdaf19b5b3a3a3127b74d8245524c`, already contained in this candidate.
Issues #186, #187 and #189 are closed, but their closure is not current acceptance evidence.
Issues #188 and #190–#197 remain open; their current criteria still require full standalone feature,
security, eval, maintainability, performance, operations, source reconciliation, Skill and independent
frozen-candidate verification. The candidate's recent local work has not been pushed or deployed.

PRs #392–#396, #399 and #401 remain open with failing `Migrate Neon Branch` checks despite green
`Validation / Gate` checks. OpenCode scanning is skipped on those ordinary feature PRs by the
workflow's release-PR/manual-dispatch trigger, not because a completed scan found no issues.

On release PR #397, [OpenCode run 34152343159](https://github.com/adea-ai/control-plane/actions/runs/34152343159/job/101837093271)
stopped during preparation with `OpenCode reported an unknown error` and exit code 2. The artifact
upload found no output files. This is unavailable security evidence, not a vulnerability report or
a passing scan; the log does not establish the underlying provider/runtime cause. Its configured
scanner source is `137698ef3545204af8fad00fc8bd64d663c8122e` and model is
`opencode-go/muse-spark-1.3-contributor`. No paid scan was retried or model/budget changed.

The release PR's separate [Neon run 34152342719](https://github.com/adea-ai/control-plane/actions/runs/34152342719/job/101837056645)
failed before migration with `Cannot find module '@control-plane/config'`. That is the build-order
failure already addressed in the candidate, distinct from the previously evidenced SET ROLE and
preview-capacity failures on other heads. A green aggregate gate does not override any of these
separate failed or unexecuted acceptance checks. No remote permissions, branches, issues or PRs
were changed by this read-only refresh.

## Evidence-audit evaluator controls

A bounded offline harness now independently observes requirement inspections and prohibited action
attempts, then checks structured reports against host-owned candidate/evidence states. Six regression
tests cover honest controls and narrowed scope, invented inspections, fabricated green results,
self-scoring, prohibited attempts, mutation, timeout/overflow and metamorphic order/name/summary
variants. Fixture/harness versions, digests, seed and host runtime metadata accompany results.

The fixture covers only an evidence-reporting portion of the public corpus. Scripted executor controls
validate the evaluator; they are not agent-quality results, an executed 28-task benchmark, human
calibration or promotion evidence. The in-process API is not a sandbox and cannot observe side effects
outside its tools or cancel arbitrary external executor work. These limits are explicit in the corpus
documentation; trusted adapters and full independent runtime observation remain required.

Full local lint/type/format/test gates passed with 785 unit tests and 85.59% line / 74.48% function
coverage. No provider, database service, remote infrastructure or persistent task-owned server was
started for this harness. PostgreSQL integration was not rerun for this isolated evaluator addition.

## Observed evaluation-metric binding

`createEvidenceAuditMetricsExecutor` snapshots fixtures and checks case ID/digest before execution.
It derives binary audit metrics from the harness assertions, not executor-provided scores, and awaits
the host evidence recorder before returning metrics. Recorder mutation cannot alter those metrics.
Tests exercise the existing EvaluationService/release-gate path: honest partial reporting passes the
audit, fabricated green reporting fails and blocks promotion, and evidence-storage failure leaves no
saved run. Fixture mutation after adapter construction does not change the bound input digest.

This is a scripted evaluator integration, not evidence that an agent completed a product milestone.
The host must still implement durable receipt storage, run/case linkage and reconciliation for
partially recorded suites. No calibrated statistical quality thresholds or production promotion
authority were introduced. Complete corpus/runtime bindings and independent review remain open.

The full local chain passed with 787 unit tests and 85.64% line / 74.57% function coverage. The final
focused package suite and format check passed after strengthening the fixture-snapshot assertion.
No provider or persistent service was started; database integration was not rerun for this adapter.

## Atomic evaluation run and observation receipts

Observed evaluation results now embed their complete receipt in the run record. Schema checks bind
the task/case ID and fixture input digest, verify receipt content digests/observation sequences and
assertion uniqueness, and require stored metrics to match derived receipt metrics. The existing
PostgreSQL JSONB run row stores these together without a schema migration. Metric-only historical
runs remain readable; older strict readers may reject receipt-bearing runs, so downgrade remains a
release gate. Hashes detect inconsistent content, not external executor authenticity.

The PostgreSQL integration case verifies an observed run through a reconstructed repository and
rejects deliberately corrupted stored trace content. Unit tests also reject mismatched metrics and
fixture digests. An initial negative test exposed an outer Zod refinement re-parsing an already-invalid
receipt; the refinement now leaves nested validation failures intact rather than throwing from
`safeParse`. The optional extra-archive callback remains isolated and awaited, but is no longer
needed to retain the receipt associated with a successfully saved run.

Full local gates passed with 787 unit tests and 85.64% line / 74.57% function coverage. All 29
PostgreSQL integration tests and existing recovery drills passed on the final change. Those drills
do not yet seed observed evaluation receipts. SQLite persistence, receipt-bearing backup recovery,
retention, actual agent executions and calibrated full-corpus acceptance remain unverified.
The disposable `m11-eval-receipts-20260907` container/network/volume were removed and port 55109
was verified closed. No remote infrastructure or production data was changed.

## SQLite evaluation persistence and cross-profile receipt portability

### Explicit cloud remote-runtime composition checkpoint

Network-boundary follow-up: `apps/runtime-gateway/src/websocket-network.test.mjs` now runs the
native Bun WebSocket server on an OS-assigned loopback port and connects a real client. It verifies
non-upgrade rejection, unsigned upgrade rejection, device-signed synthetic identity authentication,
hello negotiation, exact outbound command bytes, incoming acknowledgement/source routing, credential
revocation and denied reauthentication. Shutdown closes the socket, removes channel coordination
and refuses a subsequent HTTP connection. The signing authority, upgrade-header convention and
in-memory coordination are test fixtures; no production identity API or distributed coordination
claim is introduced. This does not yet cover PostgreSQL-backed cloud execution, RuntimeNode host
launch, terminal Artifact transfer or usage settlement through the socket. Full local gates passed
with 793 unit tests. No persistent server/provider was started; PostgreSQL integration was not rerun
for this isolated transport test.

The bundled workflow worker now accepts `CONTROL_PLANE_CLOUD_RUNTIME=remote` and constructs the
existing durable remote runtime with PostgreSQL attempt/command/event/interaction/context repositories,
the managed-Pi command factory, outcome polling and scoped discovery routing. Tests verify concrete
adapter/router selection, production startup/shutdown without the certification R2 writer, and
failure before connection allocation when an absent runtime is requested outside remote mode.
Disabled and staging-only certification tests remain passing. No Railway mode, remote credential,
runtime identity, gateway or production service was changed. This does not add ACP or graph execution.

The architecture binding registry and generated map now reflect this explicit mode without upgrading
readiness. Full local gates passed with 792 unit tests; the existing PostgreSQL integration and
recovery suite also passed. That suite does not yet execute the new composition through a real
Gateway/RuntimeNode: scoped dispatch, terminal Artifact/usage delivery and frozen deployed-candidate
end-to-end acceptance remain required. The disposable `m11-cloud-remote-20260907` database, network
and volume were removed and port 55149 was verified closed.

Subsequent recovery coverage: the application-role restore drill now restores objects under the
migration role while excluding source ACLs, verifies an application permission denial before
bootstrap, reapplies the existing isolated migration/grant contract, and exercises receipt reads,
evaluation/context-authoring/validation replay and a new evaluation write. It checks that the
application identity is `control_plane_app`, with no superuser, database-creation, role-creation or
public-schema creation privileges. This closes the earlier local admin-only restore limitation,
not the managed Neon/hosted acceptance gap. The full local gates (790 unit tests) and PostgreSQL
integration/recovery command passed. The disposable `m11-role-recovery-20260907` database,
network and volume were removed and port 55139 was verified closed; no remote roles were changed.

`SqliteEvaluationRepository` now stores complete schema-validated evaluation runs, including bound
observation receipts, in one transaction. Identical concurrent saves retain one immutable record;
changed content conflicts. Tests exercise injected transaction rollback, real file close/reopen,
detached reads, embedded-ID mismatch and receipt corruption.

Portable exports now include evaluation runs as a dedicated `evaluation-run` category, independent
of optional selected history. Logical identities use the SHA-256 of the run ID, preserving bounded
portable identifiers and the SQLite physical key. Imports require revision zero and matching run
identity and validate the full receipt. PostgreSQL uses the existing row conversion and consistency
checks; no database schema migration or external dependency upgrade is introduced. Existing private
path and sensitive-value export checks still apply; receipts are not silently redacted. Older strict
importers do not support this added category and must be upgraded before importing these manifests.

Unit coverage verifies exact SQLite-to-SQLite preservation and rejects forged identities, revisions,
receipt traces and mismatched physical keys. The live PostgreSQL integration fixture now includes an
observed run in the SQLite-to-PostgreSQL-to-SQLite round trip and checks exact repository contents and
manifest digests. These are scripted evaluator controls, not agent-quality acceptance results.

The canonical lint/type/format/test chain passed, including 789 unit tests. The full PostgreSQL
integration command and existing disruption/restore drills passed. The drills still do not seed
receipt-bearing evaluations, so receipt-specific backup recovery remains open, alongside production
composition, retention policy, actual agent executions and full calibrated corpus acceptance.
The generated architecture inventory was refreshed for the two workspace dependency additions; no
readiness classification was changed. The disposable `m11-eval-portability-20260907` database,
network and volume were removed and port 55119 was verified closed. No remote infrastructure or
production data was changed.

## Observed evaluation backup recovery and JSONB replay

Receipt-specific recovery is now exercised beyond the earlier persistence/portability checks.
The SQLite evaluation test backs up the real file, deletes the stored run, proves it absent,
restores the snapshot and verifies the exact complete run both immediately and after reopening.
The PostgreSQL disruption drill seeds a second, receipt-bearing run, verifies the full run after
service restart and replays its immutable save. The dump/restore drill verifies its complete
schema-validated JSONB evidence in the restored database. Legacy metric-only recovery checks remain.

The first PostgreSQL drill exposed an actual immutable-save defect: JSONB reordered metric object
keys, making JSON-string comparison reject an otherwise deeply identical run. A focused regression
test reproduced this before the fix. PostgreSQL now uses structural equality, matching SQLite;
reordered keys replay successfully while changed metric values still conflict.

Final lint/type/format/test gates passed with 790 unit tests, and the full PostgreSQL integration
command passed including both updated recovery drills. The disposable
`m11-observed-recovery-20260907` container, network and volume were removed and port 55129 was
verified closed. No provider, Neon or production resource was changed. PostgreSQL restore continues
to exclude privileges and checks data as admin; application-role recovery, production composition,
retention policy, actual agent executions and calibrated full-corpus acceptance remain open. These
scripted controls prove storage behavior, not agent quality or whole-milestone completion.

## Cloud remote dispatch and replay checkpoint

The integration runner now exercises the managed-cloud `remote` composition against an
isolated PostgreSQL database, with a real loopback WebSocket and signed synthetic RuntimeNode
identity. It routes a compiled, integrity-valid grant-bearing plan, persists and delivers the
command, accepts its ACK, stores a scripted successful result through the filesystem Artifact
store, and ingests the Artifact-backed terminal event. Repeating dispatch must return the same
result, leave the full terminal command unchanged, and retain exactly one execution event.

This drill exposed a real replay defect: reconstructing a command with a later wall-clock time
conflicted with its previously persisted envelope. The workflow runtime now compares a conflicting
candidate using the original envelope's three issuance/transport timestamps and returns the
original record without updating it. All remaining envelope fields must be structurally equal;
the repository's immutable identity rule is unchanged. Focused tests cover advancing clocks,
eight concurrent retries, and conflicts for changed payload, capabilities, driver or idempotency
key. Structural comparison also avoids treating PostgreSQL JSONB key ordering as a semantic change.

The canonical lint, type-check, format and test command passed with 796 unit tests and 3,263
assertions. The PostgreSQL integration command passed the cloud drill and the existing restart
and application-role restore drills. This is local plumbing evidence, not live Pi execution,
Restate journaling, production identity provisioning, R2 certification or usage settlement.
Replay after command-factory eligibility/deadline checks remains separate acceptance work;
this checkpoint does not claim that path is complete.

Cancellation follow-up: the real Managed Pi factory originally hashed a new `requestedAt` into
every cancellation retry, causing a conflict even after envelope timestamp handling was fixed.
The durable runtime now reconstructs a conflicting cancellation using the first persisted
issuance time, then compares the full resulting envelope and payload. This internal replay input
is not a public caller-supplied lease. The original record and expiry are never updated.
The real-factory unit regression covers eight concurrent retries through reconstructed runtime
instances after the original expiry, and verifies that a changed driver still conflicts.
The full local gates passed with 797 unit tests and 3,277 assertions. The PostgreSQL cloud drill
also checks the same immutable cancellation record across eight retries using a scripted waiter;
that portion proves persistence, not delivery of cancellation or a provider stopping work.
