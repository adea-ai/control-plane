# M11 PostgreSQL runtime admission and integration audit

Source candidate: `2b9c1b3d7e36f821f1d40773af93434a59e268ea`, including
worker test `35d48741` integrated as `0fb09707`. This is partial #188/#194/#195
progress, not full Milestone 11 acceptance or deployment evidence.

## Actual worker composition boundary

One gated test uses the actual Cloud worker composition, a canonically migrated
isolated PostgreSQL database and separate application/migration/administration
roles. Acceptance uses that composition's real command repository and the same
plan/catalog validator; a separate command service supplies fixture execution
IDs because the worker command service deliberately cannot mint new owners.
The real lifecycle repository creates the current attempt.

The guard allows valid dispatch and re-checks durable allowance evidence after
composition reconstruction without changing command, owner, attempt or accounting
rows. Missing budget, missing opening receipt, corrupted opening fingerprint and
settled allowance reject before runtime callbacks. Corrupted evidence also denies
interaction and graph-start callbacks. Cancellation and cleanup remain available.

Both reconstructed compositions share the isolated application's connection.
This is not a fresh-connection/process restart test. The valid second dispatch
invokes the controlled callback again; it proves admission re-check, not runtime
effect idempotency. Runtime/graph callbacks are controlled ports, not Restate,
Runtime Gateway, Pi, a model provider or a real sandbox. The fixture's explicit
finalization is not production terminal settlement.

## Integration regression and cleanup repair

The complete randomized PostgreSQL lane first returned 128 passed / 14 failed
across 20 files. Foundation and portability suites shared one database across
tests; stable fixture IDs, derived migration records and intentionally corrupted
rows escaped their originating cases. Portability reproduced 2 passed / 1 failed
with seed 1104; the foundation tamper case passed alone (a diagnostic only).

Each case now gets its own migrated database. Original identity, digest, retention
and integrity assertions remain intact. A first isolated rerun returned 65 passed /
1 failed: the outbox test relied on another case's execution. It now creates its
own canonical plan/owner and passed its focused diagnostic with all assertions.

The shared fixture binds disposal before CREATE, including ambiguous creation
failure. Cleanup attempts application closure, exact generated-name session
termination, exact generated-name database deletion and administration closure
in order, even when a preceding step fails. Concurrent disposal shares one promise;
later calls retain the same failure rather than silently claiming cleanup success.
Setup preserves both initialization and cleanup failures. Failed cleanup requires
explicit resource inspection, not blind automatic retries. Failure-injection unit
tests exercise these callbacks; they do not simulate a physical network outage.

## Executed verification

- Full PostgreSQL integration lane: **143 passed / 0 failed / 1,222 Bun assertions /
  21 files / 236.55s**, randomized seed 1104, no skips or filters. This includes
  the new worker guard and all existing admission, retention, migration, graph
  checkpoint, Hosted HTTP/reconciliation and persistence-foundation tests.
- After replacing only the worker fixture's wall-clock publication time with a
  fixed timestamp, worker admission, cleanup units and repository scheduling
  checks passed together: **32 passed / 0 failed / 40 Bun assertions / 3 files**.
- Cleanup's original sequence produced behavioral RED: 1 passed / 1 failed.
  Final cleanup units pass 4 tests / 16 assertions.
- Final type-check passes: 43 build/OpenAPI tasks, all successful, zero cached;
  schema drift, SDK compatibility, infrastructure types, architecture
  (41 packages / 16 operations / 4 profiles) and live requirements
  (200 requirements / 103 issue audits) pass.
- Changed-code strict lint, full formatting and whitespace checks pass. Full
  workspace lint passed, with nonfatal warnings outside this change's files;
  this is not a zero-warning workspace claim.
- Bounded independent Luna review caught transaction/custom-activities wording
  and setup/disposal gaps, which were corrected. Its final source review found
  no other actionable isolation/cleanup/denial-path issue. The reviewer ran no
  tests; this is not the independent final milestone audit.

The three previously skipped Hosted files also ran separately: seven actual tests
passed. The historical 13-skip count included six lifecycle hooks, not 13 tests.

Reproduce against an explicitly owned PostgreSQL fixture with distinct local roles:

```sh
# Provide DATABASE_URL, DATABASE_MIGRATION_URL and DATABASE_ADMIN_URL to that fixture.
RUN_DATABASE_INTEGRATION=true bun scripts/run-bun-test-group.mjs integration --timeout 30000
RUN_DATABASE_INTEGRATION=true bun test ./apps/workflow-worker/src/runtime-budget-admission.integration.test.mjs ./packages/database/src/isolated-database-cleanup.test.mjs ./tests/repository.test.mjs --randomize --seed 1104 --timeout 30000
bun run type-check
bun run lint
bun run format:check
```

The worker package integration command and exact repository inventory now include
the new test. No new external dependency, database schema or acceptance waiver.
All isolated databases were disposed; the owned local PostgreSQL container was
stopped and its listener verified closed. Worktrees and its volume remain for the
unfinished milestone. No Railway staging wake, production deployment or merge.

## Later release-lane audit

At source `529eedb`, the first aggregate `bun run test` failed the smoke lane:
202 passed / 2 skipped / 3 failed; Bun cancelled the parallel unit/E2E lanes.
Those interrupted lanes are not passing evidence. Focused reproduction returned
42 passed / 3 failed in graph-composition and security-probe files.

The two graph fixtures lacked valid accepted execution/attempt/budget state and
failed the newly installed admission guard. Worker `c8124051`, integrated as
`20fe40fd`, repairs Local/Hosted-simple with real SQLite plan/context persistence,
atomic allowance admission and an actual lifecycle attempt. Run/resume/continue
forward to graph callbacks; settled-budget denial runs before each callback, while
cancellation stays available. SQLite graph approval resumes after reconstructing
the composition. Hosted-server moves to actual PostgreSQL integration, not a fake
Drizzle boundary; its later verification is recorded below. The security
probe omitted the permanent hashed writer-mode file from its permitted filenames.
It now requires the exact body, metadata and mode-fence filenames, rejects both
traversal inputs, verifies returned bytes and closes the store in `finally`.

Separate canonical unit validation passed **1,846 tests / 0 failed / 8,003 Bun
assertions / 219 files / 89.81s**, with 82.56% line and 84.20% function coverage
(80% minimum). The complete E2E lane first returned **176 passed / 1 failed**:
the portability R2 fake exposed only a bulk transform, while the hardened reader
requires incremental streams. The fake now uses two Node Readable chunks, traps
bulk-transform use, verifies byte equality and closes on failure. Production
streaming bounds are unchanged. The full corrected E2E lane passed **177 tests /
0 failed / 1,068 Bun assertions / 18 files / 44.78s**. Combined final artifact
probes passed **43 tests / 0 failed / 170 assertions**.

Strict changed-file lint, full formatting, whitespace, live requirements
(200 rows / 103 issue audits) and repository credential scan (1,291 files) passed.
Build output measures 11.6 MiB against 12 MiB; external dependencies count 274
against 285. Explicit lane budget checks pass for unit 89.9s/300s and E2E
44.9s/120s. These are local measurements, not cloud/VPS capacity or startup/RSS
certification. Bounded independent source review found no actionable issue in
the artifact test repairs; it ran no tests and is not the final milestone audit.

The credential-free smoke run's two CP1 PostgreSQL skips were subsequently
executed, not treated as passes: `RUN_M10_POSTGRES_CONFORMANCE=true` enabled the
complete CP1 embedded-durable and M10 portability files against the explicitly
owned PostgreSQL fixture. **13 tests passed / 0 failed / 83 assertions / 2 files /
25.14s**, randomized seed 1104, no skips/filters. This includes the Cloud
PostgreSQL direct-port baseline, partially acquired PostgreSQL cleanup and the
four-profile versioned semantic matrix with actual PostgreSQL repositories for
Cloud/Hosted-server. Runtime/model/provider ports remain controlled fixtures;
this is neither a Railway deployment nor fresh-VPS/Restate/runtime certification.
Final database inventory contained no generated test database. The complete
canonical smoke lane then ran with this PostgreSQL gate enabled at `20fe40fd`:
**207 passed / 0 failed / 2,149 assertions / 24 files / 24.80s**, randomized seed
1104, no skips/filters. The earlier aggregate failure remains recorded; final
unit, E2E and smoke evidence comes from separate canonical lane invocations.

Independent graph review found a fixture cleanup gap: setup now opens SQLite
before `start()`, while an unstarted composition's `close()` returns early.
Root `72cb76e5` applies explicit persistence cleanup in both graph fixture
finalizers, attempts that closure even when composition closure fails, and
removes temporary directories in a finalizer. A real pre-opened SQLite regression
with an injected composition-close failure was RED with the old sequential
helper (0 passed / 1 failed); the corrected complete graph file passes 5 tests /
41 assertions. This checks fixture cleanup, not an actual production outage.

The final full enabled smoke lane at `72cb76e5` passed **208 tests / 0 failed /
2,154 assertions / 24 files / 28.68s**, randomized seed 1104, no skips/filters.
Its explicit 28.7s/90s lane budget passes. Final type-check passes all 43 cached
build/OpenAPI tasks plus schema, compatibility, live requirements, architecture
and infrastructure typing checks. Full lint passes all 41 tasks (zero cached),
strict repository tests, boundaries (1,511 files / 41 packages / zero issues)
and canonical ordering. Four nonfatal warnings remain in unchanged files across
Control API, contracts and database; this is not a zero-warning workspace claim.

The historical native-host gap now clarifies the current topology: the bare
Runtime Worker is not a Railway Cloud service. Real operator-provisioned
RuntimeNode/gateway host activation remains required; no synthetic host or
permissive startup default was introduced. Original acceptance scope remains
unchanged.

Worker `16700af7`, integrated as `e4aaa4f2`, adds Hosted-server graph coverage
to the actual PostgreSQL HTTP integration fixture. It accepts a published
catalog profile and immutable plan through the production validator and atomic
budget-admission repository, seeds an actual lifecycle attempt, and checks all
three graph operations' forwarded inputs. Removing only that test owner's
allowance denies run/resume/continue before callbacks without changing accounting
snapshots. Cancellation still forwards its exact payload after denial. Runtime
callbacks remain controlled ports; this is not discovery, routing, Restate or
provider transport acceptance. Cleanup independently attempts application,
composition, isolated database and temporary-directory disposal and reports
aggregate failures.

The final canonical enabled PostgreSQL lane at `e4aaa4f2` passed **144 tests /
0 failed / 1,235 Bun assertions / 21 files / 163.54s**, randomized seed 1104,
original 30-second case timeout, no skips/filters/retries. This includes all six
Hosted HTTP cases and the earlier actual Cloud admission case. Final database
inventory contained only the fixture database and PostgreSQL administration
database, with no generated test database. The explicitly owned local container
was stopped and its host listener verified closed; its volume and both worktrees
are retained for the unfinished milestone. No Railway/Neon deployment occurred.
Required current-head CI and release/rollout acceptance remain unproven.

After this integration run, final current-head type-check, full lint, full
formatting (1,132 files), credential scan (1,291 files) and whitespace checks
passed. Independent bounded Luna review of the final SQLite cleanup and Hosted
PostgreSQL test deltas found no additional actionable finding; it ran no tests
and is not the final milestone audit. The integration lane has no configured
performance budget: an explicit integration-budget query rejected that missing
configuration, so 163.54s is a measurement, not a budget pass. Existing unit,
E2E and smoke configured budget results above remain separate evidence.

Reproduction commands:

```sh
bun run test:unit
bun run test:e2e
bun test ./tests/m11-security-probes.test.mjs ./tests/m10-portability-conformance.test.mjs --randomize --seed 1104 --timeout 30000
bun scripts/check-budgets.mjs dist
bun scripts/check-budgets.mjs deps
bun scripts/check-budgets.mjs lane --group unit --seconds 89.9
bun scripts/check-budgets.mjs lane --group e2e --seconds 44.9
# Supply the three separately scoped local PostgreSQL role URLs.
RUN_M10_POSTGRES_CONFORMANCE=true bun test ./tests/cp1-embedded-durable-execution.test.mjs ./tests/m10-portability-conformance.test.mjs --randomize --seed 1104 --timeout 30000
```

## Remaining full-scope gates (unchanged)

Allowance preflight remains read-only, not capacity reserved across an effect.
Actual runtime/provider/graph reservations, parent/child allocation, trusted
funding/cost provenance, charges, unknown-cost reconciliation, terminal settlement,
extensions and complete retention/restore/capacity acceptance remain required.
So do deployed/frozen profile scenarios and the original security, adversarial,
documentation/Google Drive, Skill and independent human gates. Original issues
#188, #190, #191, #194, #195, #196 and #197 remain open; PR #743 remains draft.
