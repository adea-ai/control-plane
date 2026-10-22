# Testing

The repository uses Bun's native test runner. Keep tests deterministic, isolate mutable state, and prefer real local implementations over mocks when they are inexpensive and safe. Deployment-profile certification must distinguish **historical executable evidence** from **current release evidence**.

## Milestone ownership

- **M9** finishes and certifies the managed-cloud Railway + Neon + R2 + Restate profile.
- **M10** adds Local and Hosted deployment adapters/conformance.
- **M11** rebuilds the complete validation program into deterministic release lanes and independently reruns all three profiles.
- **M12** is the first live Adea/optional Cortana cross-product release gate; CP-M12 also includes the Local/Hosted deployment-profile substrate and the cross-product certification/release built on it, per the [2026-09-24 owner decision in #195](https://github.com/adea-ai/control-plane/issues/195#issuecomment-5822863459).

A historical M1–M9 test remains useful evidence, but it cannot certify a component after its architecture has been superseded. In particular, former AWS/ECS/Terraform and Temporal-specific tests do not prove the accepted Railway/Restate deployment.

## Current commands

The following commands describe the repository as it exists today. M9.7/M9.8/M10/M11 will update them as implementation changes land.

- `bun run test` builds once, then runs the current test groups.
- `bun run test:unit` runs colocated unit tests and coverage enforcement.
- `bun run test:integration` currently exercises PostgreSQL-backed integration boundaries and recovery fixtures. These PostgreSQL fixtures remain valid for server/cloud persistence testing but are not the M10 Local product database.
- `bun run test:e2e` runs the existing cross-package acceptance scenarios. In CI the lane runs as
  two shards: the runner asks for `E2E_TOTAL_SHARDS` and `E2E_SHARD_INDEX`, and
  `scripts/run-bun-test-group.mjs` splits the same files into balanced shards using the measured
  per-file costs it records. Every file, test and assertion runs in exactly one shard, and each
  shard is measured against the same lane ceiling, so the lane's wall clock is the slower shard
  instead of the sum of all files. A local run without the shard variables keeps every file in one
  process.
- `bun run test:smoke` runs repository policy, infrastructure, requirements/architecture audit drift, and service-bootstrap checks.
- `bun run requirements:check` validates the M11.1 machine ledger, reachable evidence paths, and generated report drift; `requirements:refresh` refreshes the M1–M10 GitHub issue inventory before review.
- `bun run architecture:check` validates the M11.2 package, operation, profile, persistence, ownership, lifecycle, and generated-diagram audit; `architecture:refresh` refreshes package manifests and reviewed public operations.
- `bun run test:foundation` runs the current foundation suite from a clean checkout.
- `bun run test:acceptance` runs the existing repository acceptance baseline.
- `bun run compatibility:check` validates machine-readable runtime compatibility evidence.
- `bun run test:m3-acceptance` through `test:m7-acceptance` preserve the historical feature acceptance seams.
- The M2-M6 acceptance flows remain available as historical feature acceptance evidence while M9/M10
  replace the deployment topology.
- `bun run test:m5-acceptance` runs the Runtime Gateway security, delivery, recovery, and protocol matrix.
- `bun run test:m9-acceptance` runs the production-hardening/security/load evidence. It remains a
  local gate; M9.6 additionally completed the required live Railway staging certification.
- `bun run test:m10-conformance` runs the versioned Cloud/Local/Hosted semantic matrix plus the
  profile export/import, rollback, idempotency, and secret-canary suites.
- `bun run test:m11-standalone` is the credential-free clean-state standalone matrix. It builds the
  frozen workspace, reruns the accepted durable workflow, runtime fabric, Runtime Gateway,
  managed-Pi/ACP, tools/models/sandbox, orchestration, and portability suites, then executes both
  supported Local adapter families through `DirectLocalRuntimeTransport`, the Local composition,
  SQLite persistence, filesystem Artifacts, and a restart/reopen recovery check. This lane never
  starts a Runtime Gateway process and does not require Railway, Neon, R2, PostgreSQL, Cortana, or
  reusable provider credentials. It also reruns the no-provider, disabled-provider, fake alternate,
  repository-local Cortana-compatible fixture, encrypted relay, profile migration, and deployment
  conformance suites. Profile-portability's ordinary test command explicitly excludes PostgreSQL
  integration files; it does not report them as skipped or as passing evidence. The separate
  `bun run test:integration` lane is required for PostgreSQL cross-profile migrations and recovery.
  Passing the credential-free matrix alone cannot satisfy the full M11 acceptance gate.
  It also explicitly selects Restate mode for a Local graph approval through the pinned real Restate runtime, stops/reconstructs
  Local and Restate while awaiting input, and resumes from SQLite checkpoints to an Artifact-backed
  terminal result. An invalid approval is rejected with HTTP 400 before a subsequent valid approval completes the same
  workflow. Interaction value validation runs before durable promise resolution and again on consumption.
  This test uses command-inbox acceptance, internal workflow submission and controlled graph operations.
  It is controlled-restart evidence, not hard-crash, live-provider or
  authenticated public graph-selection acceptance. Finished workflow output is retrieved using
  Restate's documented [workflow attach endpoint](https://docs.restate.dev/services/invocation/http).
  These explicit Restate-mode scenarios do not establish the default Local embedded-queue path.
  `apps/local-control-plane/src/embedded-composition.test.mjs` and
  `tests/cp1-embedded-durable-execution.test.mjs` cover the embedded composition and durable workflow
  contracts without a Restate process; full frozen-candidate acceptance remains separate.
- `bun run test:recovery-matrix` runs current disposable recovery fixtures.

The Railway manifest validator checks repository-owned service composition. A green local validation
is not Railway staging evidence; the completed M9.6 activation record is the live reference.

## M9 validation record

M9.7–M9.13 established a reproducible managed-cloud validation path covering:

- dependency-aware Railway service builds from a clean clone;
- repository-owned Railway service configuration;
- explicit Neon Drizzle migration and schema-version verification;
- least-privilege runtime versus migration database authority;
- Restate lifecycle/restart/redeploy/recovery;
- R2 adapter operations;
- staging-only Cloud certification execution with deterministic R2 write/get/head and replay;
- Railway private service networking/public ingress boundaries;
- service authentication/secrets/configuration;
- health/readiness/draining;
- public schema/OpenAPI/SDK compatibility;
- deterministic Profile/Skill resolution;
- ContextProvider policy/cache/failure behavior;
- operational retry/heartbeat/expiry/retention/payload defaults;
- M9.1–M9.5 observability/security/recovery/performance evidence rerun against the real staging candidate.

M9.6 #73 closed after the complete bounded live Cloud path passed. Production certification remains
a separate release gate.

## Required M10 validation additions

M10 profile-aware conformance covers:

- Local `node:sqlite` + Drizzle versus PostgreSQL domain parity;
- Local embedded SQLite durable execution versus the accepted M9 cloud Restate semantics;
- all-in-one Local composition from clean state;
- direct Local RuntimeTransport with no Runtime Gateway process;
- Hosted `simple` Compose with SQLite;
- Hosted `server` with PostgreSQL;
- user-controlled filesystem/S3-compatible storage;
- Local/Hosted SecretsProvider adapters;
- host-side HPKE remote-control contract;
- explicit export/import/migration;
- backup/restore, restart, upgrade/rollback, and small-VPS resource evidence;
- one versioned conformance suite comparing M9 managed cloud, Local, Hosted `simple`, and Hosted
  `server` for deployment-independent semantics. Its report names the owning port, concrete adapter,
  profile, normalized digest, and divergence result for every case.

PostgreSQL-backed cases run against an isolated database on the pinned local PostgreSQL fixture in
the required integration and migration/profile lanes. The bounded Neon provider-compatibility proof
is a separate live-provider check; it does not substitute for those cases. SQLite-backed cases use
disposable database files. An in-memory cloud baseline is contract evidence only and never
substitutes for the live PostgreSQL lane. Neon compatibility branches expire automatically and are
deleted after evidence is recorded.

The required Code Foundry `Test/Integration` lane builds once, starts one runner-owned disposable
PostgreSQL service, and runs the three `test:integration` shards from
`scripts/integration-shards.mjs` concurrently against it. Files remain serial within each shard;
bounded test cases create isolated databases. Repository-level integration files that span
composition roots are assigned to those same shards. The separate local PostgreSQL pull-request
workflow checks migration/schema consistency, the PostgreSQL profile conformance matrix, and Hosted
PostgreSQL/Restate graph behavior. The ruleset check is `Validation / Gate`; it depends on the mode,
Code Foundry runtime, and PostgreSQL qualification results, and fails closed if any dependency is
not successful, including when a dependency is skipped or cancelled. The local aggregate uses
the canonical `validation` job ID required by Code Foundry doctor and retains the full
`Validation / Gate` check name; the reusable caller stays `validation_runtime` so its nested
gate cannot publish a competing required context. New integration files must be
assigned to one shard or to the explicit dedicated-qualification manifest, which
`tests/integration-shards.test.mjs` enforces. The expanded database foundation file has
complementary case filters on shards 1 and 2. The partition check uses the development-only Acorn
JavaScript parser (independent of the TypeScript compiler API) to inventory literal test names,
bounds each slice, and executes those names through Bun using the runner's actual arguments to
reject missing or duplicate selection. The local integration lane runs
cloud-remote and PostgreSQL recovery drills once after all shards finish.

The trusted-main Neon lane creates one short-lived branch and checks pooled and direct application
connections plus the direct migrator role, TLS, and transaction round trips. The compatibility
check also runs a transaction as the migrator that creates a uniquely named table in `app`, writes
and reads a marker, then drops the table. This narrow DDL probe checks provider permissions; it does
not apply the application migration set. The lane does not run the portable integration suite,
migrations, build, profile matrix, or Hosted Restate qualification on Neon. Its five-minute budget
starts before branch creation and ends after exact branch lookup, deletion, and absence verification;
the compatibility command itself has a 90-second timeout. A successful baseline requires the
compatibility proof and every cleanup/budget step to succeed.
Complete historical three-shard Neon runs remain accepted as stronger baselines while they are in
the classifier lookback window. New full-suite files still need their single local owner, recorded
in `tests/integration-shards.test.mjs`.
The complete database budget-admission file runs on shard 1. In trusted-main run
`37177353771`, that file took 955.20 seconds on shard 2, whose integration step took
2,602 seconds without retries. Moving the file uses shard 1's spare capacity while
keeping three branch owners and every case. This addresses imbalance near the job
deadline; actual runner billing and Neon cost savings remain unmeasured. See
[the timing evidence](evidence/m11-neon-budget-balance-2026-10-04.md).
The historical 2026-10-11 main run reached shard 2's 45-minute limit after its
foundation, retention, and partial usage-store work. A shard-rebalance proposal
then moved the measured tail files to shard 1 and the unmeasured workspace-scope
file to shard 3; its censored durations remain lower bounds pending a complete
hosted run. This is historical partition evidence, not the current trusted-main
Neon workflow. See [the shard rebalance evidence](evidence/m11-neon-shard-rebalance-2026-10-11.md).
Historical measurements explain why the full suite remains on the local lane. The complete trusted-
main run [38198473355](https://github.com/adea-ai/control-plane/actions/runs/38198473355) measured
791s/416s/1,047s of integration work on shards 1/2/3; Hosted Restate qualification took 31s on
shard 3. Later run [38209161123](https://github.com/adea-ai/control-plane/actions/runs/38209161123)
measured 37m09s on shard 1 and 18m14s on shard 2 before shard 3 was canceled at 45m23s. All three
branches were deleted and their absence verified. The former candidate that moved the 263.7s
LangGraph inventory test was only a projection and did not solve this runtime. See the
[compatibility budget evidence](evidence/m11-neon-compatibility-budget-2026-10-12.md) for current
scope and the local pull-request timing record.

Preview cleanup resolves the exact run/attempt/branch name and validates the project, parent,
protection flags, and complete listing before exporting a branch ID for deletion. Each listing
page allows three attempts for transport failures or HTTP 408/429/500/502/503/504, with ten-second
request deadlines and 500/1000 ms backoff. Other HTTP failures and invalid metadata fail closed.
The lookup step has a two-minute ceiling, including the existing twenty-page limit; exhausting
retries leaves the workflow failed and requires follow-up cleanup. The one-day branch expiration
is a fallback, not evidence that deletion succeeded. Cleanup retries do not repeat integration tests.
A remote branch stretches tests that finish in seconds locally to tens of seconds and its pooler
occasionally severs pooled connections. The runner's remote mode keeps a 120-second per-test ceiling
for explicit remote integration invocations; the trusted-main compatibility check uses its own
bounded command instead. Every integration file runs once in a fresh process. Connection-drop
evidence, assertion failures, timeouts and all other errors fail the owning shard; no automatic file or slice rerun can turn a failed attempt green. The runner streams complete child output to the job
log and retains only a 16 KiB tail per stream for bounded failure diagnostics. The local lane keeps
the 30-second fast-fail ceiling. Because an explicit
bun `test()` timeout argument always overrides the CLI `--timeout` default, the
PostgreSQL integration suites author their explicit budgets through
`integrationTestTimeout()` (`@control-plane/database/testing`), which the runner scales through
`INTEGRATION_TEST_TIMEOUT_MS` — at least 120 seconds remotely, while preserving any longer
authored budget. The Local runner preserves the authored local values.

The workflow does not rerun an entire slice or individual file after a failure.
A failed integration file or later drill remains a failed check. The cloud
remote drill uses a five-minute fixture validity window so remote setup does not
consume its command deadline; its explicit post-deadline replay and new-command
rejection checks still exercise expiration. This window is not a product timeout,
resource budget or measured acceptance SLO.

## M11 test architecture

The M10 Hosted Compose CI lane uses `scripts/run-hosted-compose-acceptance.sh`
with one exclusive runner-temp fixture and an explicit unique project. Cleanup
starts before setup and reports failures; only a successfully stopped owned
project permits ownership-checked fixture removal. Local fake-CLI lifecycle
tests exercise failure, signals and caller-data preservation without Docker.
Actual service behavior remains a separate remote CI requirement. See
[the Hosted Compose cleanup evidence](evidence/m11-hosted-compose-cleanup-2026-10-04.md).

Standard RuntimeAdapter dispatch and interaction resume use an atomic attempt
reservation through `DurableRuntimeBudgetAdmission.reserve()`. The read-only
`authorize()` preflight remains separate for graph effects, whose operations own
their funding. The supported Local, Simple, hosted PostgreSQL, and Cloud worker
compositions already install this admission adapter. Focused regressions verify
reservation before the runtime callback, immutable replay, remaining/clamped
money and token authority, denied starts, supersession during reservation,
rollback, and native SQLite reopen and concurrency. Open runtime reservations
also fence attempt creation until explicit settlement; native regressions exercise
both transaction orderings, contention, replay, corrupt-state rejection and
alternate writer denial. PostgreSQL uses the same retention-mutex/workspace-lock
order and has corresponding isolated-store contention coverage. Profile composition tests additionally inspect the committed
reservation inside the actual runtime callback; PostgreSQL exercises concurrent
rebuilds over the same isolated owner. This proves allocation where observed,
not terminal charging, provider price provenance, or safe retention eligibility.
See [the reservation evidence](evidence/m11-runtime-attempt-reservation-2026-10-04.md).

M11 owns the final release validation layout. At minimum it must classify each suite as one primary lane:

Failure-injection tests use recording or deliberately failing adapters and assert durable state,
recovery, and idempotency rather than internal call order.

- unit;
- contract/schema;
- integration;
- end-to-end;
- smoke/configuration;
- security/adversarial;
- eval;
- performance/capacity;
- recovery/chaos;
- infrastructure/live-provider certification.

The aggregate release gate cannot pass when a required lane is skipped, cancelled, missing, or inconclusive. M11 must identify the exact deployment profile/configuration/version used by each production-shaped test.
Independent test groups run in parallel where their resources are isolated.

`scripts/run-bun-test-group.mjs` is the executable primary-lane inventory. Every
tracked `*.test.mjs` under `apps/`, `packages/`, and `tests/` belongs to exactly
one of the public Code Foundry jobs: unit, integration, E2E, or smoke. The
machine requirement ledger separately assigns every requirement to exactly one
of the ten validation classes above; security, eval, performance, recovery, and
live-provider suites may supplement a primary test job without duplicating its
ownership.

All Bun group runs randomize order with the fixed seed `1104`. A caller may set
another explicit seed for diagnostic reproduction, but automatic `--retry` and
`--rerun-each` are rejected: a retry is diagnostic evidence, never a way to turn
a flaky failure green. The per-test budget is 30 seconds for normal groups and
60 seconds for the standalone matrix. GitHub job timeouts remain the outer
resource limit, and mutable PostgreSQL, Compose, process, port, and filesystem
fixtures own their cleanup in the lane that created them.

## Integration fixture ownership

A remote integration target is classified and validated before any Docker command;
Neon verification does not require a local Docker engine. Local runs preserve an
already running PostgreSQL service. When the runner starts its own fixture and no
`COMPOSE_PROJECT_NAME` was supplied, it records a unique project name before startup
and removes that project's containers, network and volume in `finally`, including
partial startup and test failures. Before startup, the runner and pull-request CI
use `scripts/pull-postgres-image.mjs` to retry only a registry rate-limit response
(`toomanyrequests`, HTTP 429, or pull-rate-limit text), with three bounded backoffs.
Before each backoff it first tries the same digest on `mirror.gcr.io` and then
`docker.io`, without credentials: a digest names the content, so a fallback cannot
change which image runs. The digest comes from the image Compose itself resolves
(`docker compose config` with the same working directory and environment as the pull, so
`.env`, `COMPOSE_FILE` and override files count); when Compose cannot name a pinned ECR
Public image, or exporting the variable would not make Compose select the fallback
(an override that fixes the image), the fallback is disabled and only the bounded
backoff applies. The compose files read the image as
`${CONTROL_PLANE_POSTGRES_IMAGE:-<pinned reference>}`; the runner, the Hosted Compose
script and the pull-request workflow (through `GITHUB_ENV`) set that variable to the
fallback they pulled, so Postgres starts from the local image.
`docker compose up --wait` and health checks then run once; startup errors are not
retried. The runner's Docker commands and the nested
PostgreSQL disruption/restore Docker calls have a 90-second process bound;
SQL readiness probes have a five-second bound within the 30-second readiness window.
Cleanup failure fails verification and preserves any original failure alongside it.

An explicit caller project remains caller-owned: the runner may stop the PostgreSQL
service it started, but does not delete that project's volume. The recovery matrix
removes its own project in its outer cleanup. Pull-request PostgreSQL CI likewise
uses a run/attempt-specific project and an `always()` cleanup step. These paths never
prune unrelated resources or shared build caches. Runner-owned children stay in the
runner's process group and are recorded, so installed `SIGINT`/`SIGTERM` handlers
reap only those recorded children, refuse to start any new owned command after the
first signal (the shared cleanup is exempt), and run the same owned cleanup once
before the process exits with `128 + signal`; a recorded verification failure stays
observable instead of being masked by the signal or by cleanup. A second signal
stops immediately with the signal's status, and the bounded readiness probe
observes a signal delivered during its blocking wait instead of surfacing it as a
probe timeout. The image-configuration and pull commands are synchronous, so a
signal delivered while one of them held the event loop is not yet visible to the
next check; the pull path therefore yields one loop turn before every command it
may start, and no configuration, canonical pull or fallback pull begins after the
signal. A pending signal is reported as an interruption, never as a failed pull.
The recorded child's whole owned tree is terminated — a nested
build descendant that keeps the inherited pipes open is reaped with it, and a
descendant that is still alive after the termination is reported as a survivor,
because the direct child's exit is not proof that its tree was reaped. The
completion of a terminated child is bounded, so a pipe that a survivor still
holds can no longer keep the runner from finishing. The command-double lifecycle
suite injects a frozen startup, readiness, test and cleanup command, spawns an
owned descendant that holds the inherited pipes, and delivers a real signal to
prove those paths. That suite's own harness holds itself to the same standard: it
disposes of everything it spawned on every path — a passing case, a failing case
and a settle timeout alike — reaping the fixture's recorded descendants by those
exact PIDs and never by name or process group; a reap it cannot confirm retains
the receipt that names them, rather than deleting the identity while the
processes still run, and the failure is surfaced. A `SIGINT` during a
rate-limited image-pull backoff ends the run without starting a further pull
command, and the backoff wait ends with
the interruption instead of being run out. `SIGKILL`, daemon loss and machine shutdown cannot execute
JavaScript `finally`, so an interrupted run may still leave the owner-recorded
project identity behind. Once the
engine is available, the owning operator can use that exact `COMPOSE_PROJECT_NAME`
with `docker compose down --volumes --remove-orphans --timeout 60` from this
repository; never substitute a shared project or global prune. No disk reclamation
or full Docker acceptance is implied by the command-double lifecycle regression
suite.

## Current PostgreSQL integration fixture

The repository currently starts a pinned local PostgreSQL service for integration testing. That remains useful for:

- Neon/PostgreSQL-compatible domain behavior;
- Hosted `server` behavior;
- migration/transaction/recovery testing.

It must not be described as the M10 Local product profile. M10.3 adds SQLite and cross-adapter conformance.

## Runtime acceptance

Existing M4–M6 suites remain useful for Runtime Fabric, Runtime Gateway, Managed Pi, and ACP behavior. Their release interpretation changes by topology:

- Runtime Gateway evidence applies to non-co-located RuntimeNodes.
- M10 includes `DirectLocalRuntimeTransport` evidence for co-located managed Pi/ACP execution; remote-gateway
  evidence remains separately required for non-co-located RuntimeNodes.
- A runtime certification is tied to exact RuntimeAdapter + RuntimeDriver + RuntimeTransport + harness/protocol + deployment profile/location.

## Durable execution acceptance

The Restate workflow tests are active execution-lifecycle evidence. Historical Temporal tests and changelog entries may remain as migration provenance, but do not certify the accepted Railway/Restate deployment. Active evidence must preserve retries, waits, deadlines, cancellation, interactions, restart recovery, idempotency, reconciliation, parent/child execution, and bounded LangGraph integration.

M10.1 originally brought Restate workflow/conformance behavior to Local and Hosted compositions.
The later #548 decision makes embedded SQLite durable execution the default for Local, preserving
the same workflow contracts; Hosted and Cloud retain Restate. Explicit Local Restate-mode tests
remain compatibility evidence, not a requirement to run Restate in the default Local profile.

## Security and secret-canary testing

Secret canaries must cover:

- Railway build/deploy/configuration output;
- Neon connection/migration diagnostics;
- Restate state/logging;
- R2 metadata/errors;
- public API/SDK/events;
- runtime/gateway/direct transport;
- credential-vault use;
- SQLite/PostgreSQL persistence and backups;
- Local/Hosted exports;
- HPKE relay fixtures;
- telemetry and incident evidence.

Deployment bootstrap secrets and dynamic connector/provider credentials are separate secret classes and both require leak tests.

## Coverage goals

Unit coverage remains at or above the repository's configured 80% threshold unless an explicit accepted
change updates the policy. Add focused tests rather than lowering coverage to make a gate green.
The complete unit report is emitted as LCOV for CI coverage publication.

## Evidence rules

Every production-readiness result records exact commit, toolchain, deployment profile, persistence adapter/schema, Restate version, RuntimeAdapter/Driver/Transport, runtime/provider versions, relevant configuration digest, command, timestamp, environment, and outcome.

Mocked or sampled evidence must be labeled. It cannot replace required concrete evidence when the milestone acceptance explicitly requires Railway, Neon, R2, Restate, SQLite, Compose, or another real implementation.
