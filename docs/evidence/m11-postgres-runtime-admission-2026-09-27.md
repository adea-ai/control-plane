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

## Remaining full-scope gates

Allowance preflight remains read-only, not capacity reserved across an effect.
Actual runtime/provider/graph reservations, parent/child allocation, trusted
funding/cost provenance, charges, unknown-cost reconciliation, terminal settlement,
extensions and complete retention/restore/capacity acceptance remain required.
So do deployed/frozen profile scenarios and the original security, adversarial,
documentation/Google Drive, Skill and independent human gates. Original issues
#188, #190, #191, #194, #195, #196 and #197 remain open; PR #743 remains draft.
