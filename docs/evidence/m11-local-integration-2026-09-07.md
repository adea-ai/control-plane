# M11 local integration checkpoint

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
