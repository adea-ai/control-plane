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
30-second runner fallback (existing explicit case deadlines unchanged), no
skips/filters/retries. This includes all six
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

## Integrated legacy terminal replay checkpoint

Candidate `6f94e69712342ef8ec231c9b3a1d05624cae7826` integrates Luna commit
`73721a72466059450583991ff7677b065388ed3e`. Both concrete acceptance repositories
allow retained outcome lookup only after immutable source identity matches and
supplied/persisted status and state match: completed/completed, or failed with
failed, cancelled or timed_out. The shared acceptance wrapper does not submit
these terminal commands. No allowance, receipt or ledger is created or repaired.
This is not ledger-health certification, funding, reservation or settlement.
Active, one-sided, mismatched, forged and reconciliation snapshots retain the
existing fail-closed admission verification.

The actual SQLite regression closes/reopens the database and returns the exact
stored command and owner; both backends cover all four terminal pairs and deny
unsafe snapshots without changing stored accounting. A fresh-domain behavioral
RED failed with `STORE_STATE_INVALID` when only the two terminal predicates were
removed. Earlier invalid lifecycle test setup and stale Domain build artifacts
were separately corrected; they are not behavioral RED evidence. Bounded
independent Luna source review found no actionable issue and ran no tests.

Root verification on this frozen candidate:

- Canonical `bun run test` completed with exit 0 after rebuilding the workspace:
  **1,852 unit tests / 8,054 assertions / 219 files / 89.64s**, **177 E2E tests /
  1,068 assertions / 18 files / 67.27s**, and **208 smoke tests / 2,154 assertions /
  24 files / 39.08s**, all with zero failures. PostgreSQL profile cases were
  enabled rather than skipped. Coverage: 82.55% lines / 84.20% functions,
  unchanged 80% minimum.
- Full enabled PostgreSQL integration lane completed with exit 0:
  **146 tests / zero failures / 1,287 assertions / 21 files / 194.69s**. Seed
  1104, no filters, retries or raised deadlines. This is a measured duration,
  not an integration-budget pass; no such budget is configured.
- Full type-check, lint, formatting, canonical credential scan and whitespace
  checks passed. Existing nonfatal lint warnings remain. A mistaken nonexistent
  secret-scan command failed to start; the canonical `bun run security:scan`
  then passed across 1,291 repository files.
- Configured distribution, dependency, unit, E2E and smoke budgets passed.
  No Railway/Neon deployment, PR readiness transition or issue closure occurred.

All test sessions completed; final PostgreSQL inventory contained only the
fixture and administration databases. The owned local container was stopped
and its listener verified closed. Luna lanes completed with no owned process;
worktrees and the database volume are retained for unfinished M11 work.

Active pre-upgrade owners without valid opening authority remain a rollout
blocker. Migration 0051 does not backfill authority. A paginated read-only
inventory plus verified intake quiescence, drain and explicit reconciliation is
still required; a clean snapshot alone cannot prove rollout safety. Historical
usage is not funding authority, and an unknown effect cost must not become zero.

## Durable intake pause and permission checkpoint

Code checkpoint `bd22f7b` integrates Luna's initial gate and two permission
verification fixes. Migration 0052 seeds an empty database open and an existing
execution-related inventory paused. Both new-owner writers acquire the shared
advisory fence before domain locks; privileged pause takes its exclusive lock.
Application-role pause and direct writes are denied. Exact retained replay is
still available. Audit/resume/CLI are not implemented, so this is not a safe
production rollout or financial acceptance claim.

The shared lightweight Domain error contract now gives Database and API one
class identity. Actual signed Cloud HTTP intake while paused returns sanitized
503, has no dispatch or owner/accounting writes, and remains paused across API
restart. Existing replay still succeeds after removing its retained plan.

Regression evidence distinguishes behavioral failures from setup failures:

- Removing the command gate assertion accepted fresh intake while paused.
- A valid signed HTTP request returned 500 before sharing the Domain error;
  the original service-only four-case regression likewise failed to return 503.
- The actual old production privilege SELECT omitted effective column grants;
  the updated SELECT detects column INSERT, UPDATE and REFERENCES grants.
- Missing direct-driver dependency, invalid fixture ID, and a new-intake
  assertion after intentional plan deletion were separately corrected test
  setup/ordering failures, not behavioral RED evidence.

Root full validation on frozen pre-column-verifier checkpoint `27b61e0`:

- Canonical build/unit/E2E/smoke completed exit 0: **1,856 unit / 8,070 assertions /
  219 files / 88.07s**, **177 E2E / 1,068 assertions / 18 files / 66.00s**,
  **209 smoke / 2,154 assertions / 24 files / 49.10s**, all zero failures.
  PostgreSQL profile cases were enabled. Coverage: 82.38% lines / 84.03%
  functions, unchanged 80% minimum.
- Full discovered PostgreSQL lane completed exit 0: **147 tests / 1,316
  assertions / 21 files / 163.42s**, no failures, filters or retries; seed 1104,
  default 30-second runner timeout with existing per-case deadlines preserved.
  No integration time budget is configured.
- Distribution 11.7 MiB/12, dependencies 274/285, and measured unit, E2E and
  smoke durations passed configured budgets.

The final verifier/column test delta passed **53 focused tests / 180 assertions /
5 files / 15.36s**. The real PostgreSQL regression executes the exact production
privilege SELECT and bootstrap gate statements. It proves table UPDATE can be
false while column UPDATE is true and actually usable, then confirms bootstrap
REVOKE ALL clears those grants. An initial reviewer claim that bootstrap did
not revoke column grants was retracted after primary documentation and this
actual test; no redundant revocation code was added. Final bounded Luna review
found the verifier issue resolved, not full M11 acceptance.

Initial full type-check and lint passed; full formatting identified two
generated Drizzle JSON files. They were normalized with identical canonical
JSON hashes before/after and migration consistency passed. On final code
checkpoint `bd22f7b`, full type-check, lint, formatting, credential scan
(1,296 repository files) and whitespace checks completed exit 0. Final enabled
smoke completed exit 0: **209 tests / 2,154 assertions / 24 files / 33.51s**,
zero failures. These final delta checks do not relabel the preceding full
unit/E2E/PostgreSQL runs as tests of a different source checkpoint.

All owned test handles are terminal. Six native workers are completed, with
zero live delegated lanes. PostgreSQL inventory contained only the fixture and
administration databases, with no generated test sessions. The owned container
was stopped and its listener verified closed. Worktrees and the fixture volume
are retained for the unfinished goal; no cloud resources, release, PR readiness,
merge or issue closure were changed.

Next required work remains the complete paginated owner/attempt/delivery audit,
drain and fresh privileged resume under the exclusive fence; concurrency,
restart and old-replica cutover proof; and the operator CLI/runbook. No allowance
backfill, fabricated funding, arbitrary capacity or unknown-cost-as-zero is
permitted. Migration 0052 must not be promoted alone to bypass these gates.

## Operator connection and CLI implementation checkpoint

Added an explicit migration-profile connection factory without weakening the
application factory's role boundary. Its new tests first failed because the
factory was absent (three assertion failures, not a module-load failure), then
passed after implementation. Both factories sanitize invalid URL errors; the
migration factory rejects application and administration profiles. A profile
label is configuration, never proof of database authority.

The CLI requires an exact host/port/database target and explicit confirmation for
pause/resume. It never substitutes application/admin URLs, accepts a force flag,
uses a saved audit report, performs migration or enables a deployment. Current
real operations are status/pause only; audit/resume await the database core.

Verification in the root checkout:

- Connection and CLI adapter tests: **16 pass, 0 fail, 123 assertions**, two files.
- Database package build: exit 0; scoped lint, formatting and diff checks pass.
- Database package test command: **46 pass, 133 skip, 0 fail, 212 assertions**.
  Its PostgreSQL cases are deliberately disabled in that package run; the enabled
  CLI acceptance below is recorded separately, not inferred from skipped cases.
- Test inventory readback assigns the new adapter test to the unit lane.
- Enabled PostgreSQL CLI acceptance: **1 pass, 0 fail, 14 assertions**, 4.63s.
  Four separate bounded CLI processes targeted one migrated isolated database.
  An application URL placed in `DATABASE_MIGRATION_URL` could not pause intake;
  the actual migration role paused it, and a new process read the identical
  durable status/revision/role. The fixture database was disposed in `finally`
  and the post-test generated database inventory was empty.
- Bounded independent read-only review found no actionable defect in the new
  factory, CLI, tests or operator checkpoint; it did not run tests or certify the
  broader milestone.

The initial CLI test run only failed because the new script did not exist; this
is not counted as a behavioral regression proof. An initial inventory invocation
used an unsupported runner flag; direct `discoverTestInventory()` readback
corrected that check. No broader suite, safe resume, concurrent cutover, cloud
activation or milestone completion is claimed by this checkpoint.

## Context-node failed-start ownership repair

The follow-on runtime audit found that `composeContextNode()` opened its owned
SQLite store before recording a cleanup callback, and had no failure guard for
migration or later composition. PostgreSQL allocation also preceded the required
inbox check without a failure cleanup path.

The regression opened and migrated a real SQLite handle, injected a migration
failure, and observed **zero close calls instead of one** (RED: 0 pass, 1 fail,
3 assertions). Its own `finally` closed the leaked test handle. The fix records
ownership immediately after allocation and guards all remaining setup. Successful
composition transfers the callback to its caller; failed setup closes the owned
store. A simultaneous cleanup failure retains both errors in `AggregateError`,
with the immediate cleanup failure as `cause`. Grant/channel behavior is unchanged.

Executed checks:

- Final focused failure/ownership tests: **3 pass, 0 fail, 16 assertions**. They
  verify actual `SQLITE_CLOSED` after migration and post-migration setup failures,
  successful ownership transfer, and preservation of both failure objects.
- Final runtime-worker build: exit 0. Package tests: **60 pass, 0 fail,
  196 assertions**, five files; log
  `/tmp/m11-context-node-cleanup-package-2026-09-27.log` (ephemeral local evidence,
  not a repository artifact).
- Context gateway/node composition E2E: **5 pass, 0 fail, 40 assertions**, 2.11s.
  This ran before the final cause-only lint correction; no channel/grant logic
  changed afterwards. Fixture-owned HTTP/WebSocket servers and stores closed.
- Final scoped lint with warnings denied, formatting, diff and test inventory
  checks passed; the new test is unit-lane owned. The initial lint warning was
  resolved by preserving the immediately caught cleanup error as `cause` while
  retaining the original startup error in `AggregateError.errors`.
- Independent read-only review found no actionable defect in the guarded setup
  or regression tests; it ran no additional checks.

This repairs startup cleanup only. It does not implement operator RuntimeNode
socket/host activation, trusted capacity/funding, safe intake resume, deployed
profile acceptance or the independent final milestone gate.

## Remaining full-scope gates (unchanged)

Allowance preflight remains read-only, not capacity reserved across an effect.
Actual runtime/provider/graph reservations, parent/child allocation, trusted
funding/cost provenance, charges, unknown-cost reconciliation, terminal settlement,
extensions and complete retention/restore/capacity acceptance remain required.
So do deployed/frozen profile scenarios and the original security, adversarial,
documentation/Google Drive, Skill and independent human gates. Original issues
#188, #190, #191, #194, #195, #196 and #197 remain open; PR #743 remains draft.
