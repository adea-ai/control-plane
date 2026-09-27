# M11 native SQLite durable usage store checkpoint

This checkpoint adds the versioned transactional usage-store port, shared durable
accounting service, and native SQLite adapter. It does not complete M11.3 or M11.9,
activate production budget enforcement, or
implement raw usage retention.

## Changes

- Native transactions store budget projections, immutable entries, execution sequence
  identities and workspace-global operation receipts atomically. The adapter stores no
  authoritative projection in process memory.
- Writes verify execution/workspace/parent correspondence and exact attempt ownership.
  Corrupt budget/receipt state cannot be silently overwritten. Reopen preserves original
  entries and receipts; divergent duplicate writes conflict.
- Execution retention checks all four usage namespaces before deleting an owner, including
  parent and child-funding references. Positively identified damaged records still pin their
  owner. Usage records are not age-deleted by this guard.
- Ordered reads reconcile sequence identities with immutable entries in both directions and
  check the budget's sequence high-water mark. Missing entries, damaged attribution, orphan
  indexes and loss of both rows are errors, not silently reduced usage totals.
- The workspace-only dependency and public contract export are reflected in the generated
  architecture inventory. Bun also synchronized existing workspace versions in the lockfile
  with their already-versioned manifests; no external dependency versions were changed.

## Verification

- Shared service integrated at `c1036d52`: the usage-ledger package passed 18 tests with
  84 assertions. The actual compiled public service with native SQLite passed 18 tests
  with 117 assertions across the usage-store and execution-retention files in 10.76s.
  Native cases cover reopen/replay, rollback, independently money- and token-bound
  concurrent admission, and child finalization without duplicate charges.
- Canonical type-check then all three workspace test groups completed successfully
  against that source. The type-check included 43 fresh build/OpenAPI tasks (11m8.468s),
  migration drift, SDK compatibility, live 200-requirement/103-issue audits, architecture,
  and infrastructure types. Unit results: 1,596 passed, zero failed, 7,092 assertions,
  204 files, 280.25s. E2E/smoke output was truncated by the command-output collector;
  the enclosing command exited zero, but exact counts and skip totals are not asserted
  from that incomplete transcript. This does not substitute for live PostgreSQL evidence.
- The LCOV coverage gate passed: 82.76% lines and 84.39% functions, preserving the
  configured 80% minimum. Bun's displayed aggregate is not that weighted calculation.
- Independent bounded core review found an unchecked released amount in replay receipts.
  RED regressions also confirmed substitution of another valid immutable entry. Correction
  `cf99d857` binds replayed entries to their original deterministic operation identity and
  validates settlement released amounts. The isolated corrected package passed 20 tests,
  87 assertions, build, lint, root-relative format, and compiled public import. Root native
  verification passed actual usage-ledger/SQLite TypeScript builds and 38 tests, zero
  failures, 204 assertions across four files in 7.24s. The first invocation used test
  filters without the required `./` prefix and selected no tests; only the corrected
  explicit-path run is counted as verification.
- Full lint passed 41 package tasks, dependency boundaries (1,477 files, 41 packages), and
  canonical ordering. The initial full format check failed on the two new core files;
  root-relative formatting corrected them. The final full format check passed all 1,092
  files in 14.74s, followed by a clean whitespace check.
  The repository credential scanner passed 1,250 files; this is not a full security audit.
- Final bounded replay-guard review found no actionable defect, but requested explicit
  positive settlement replay after finalization and native reopen. That assertion and
  actual SQLite persisted receipt corruption coverage were added. Valid-schema substitution
  of another charge or alteration of released money survives reopen and is rejected without
  changing entries; restoring the original receipt restores exact replay. Focused native
  store/retention verification passed 19 tests, zero failures, 128 assertions in 6.69s.
  These are additional native regressions, not a new full workspace run.
- Complete native SQLite package after those regressions passed 169 tests, zero failures,
  zero skips, 1,088 assertions across 27 files in 17.07s at `660d1c8`. This includes actual
  CLI subprocesses, crash recovery, hold contention, and the native accounting cases.
- Summary receipt correction `be870cd5` followed additional RED tests demonstrating
  altered schema-valid opening and child/parent finalization summaries. Its isolated
  package passed 23 tests, 96 assertions, build, lint, format, and aggregate import. Opening
  expectations use the original operation-bound credit plus zero-use snapshot; finalization
  uses the operation-bound settlement and validated settled rollups. Tests preserve child
  replay after later parent activity and finalization. Future extensions require retained
  opening money/token provenance rather than comparing historical receipts to extended maxima.
- Root reproduced the opening-summary defect in an actual SQLite file after close/reopen
  before integrating that correction. Final actual usage/SQLite TypeScript builds and all
  four focused files passed 42 tests, zero failures, 234 assertions in 2.90s. Native coverage
  now includes all four receipt types (opening, charge, settlement, finalization), corruption
  surviving physical reopen, rejection without new entries, and exact replay after restoring
  the original receipt. The broad workspace run predates these final corrections; no new
  full-workspace or deployed-profile acceptance is claimed from this focused result.

- Initial native tests: four usage-store tests passed after correcting a fixture's missing
  expected revision. The native optimistic-concurrency guard was preserved.
- Retention regression RED: the new test demonstrated owner deletion despite a retained usage
  budget. After the reference guard, both focused files passed: 12 tests, 83 assertions.
- Exact stored-ID regression RED: a canonical owner payload under another execution's storage
  ID was accepted. Exact owner/attempt ID checks corrected that behavior; the final focused
  run passed 13 tests, 87 assertions across two files in 3.95 seconds.
- Actual TypeScript builds passed for usage-ledger and sqlite-persistence.
- Complete native SQLite package suite: 163 passed, zero failed, zero skipped, 1,047 assertions
  across 27 files in 69.36 seconds before the independent read-integrity correction.
- Independent Luna review identified silent omission of missing/scope-damaged indexed entries.
  The failing regression reproduced that behavior. After correction, the focused native
  store/retention run passed 14 tests, 92 assertions in 6.30 seconds. Additional pair-loss and
  populated foreign-workspace regressions passed two tests with nine assertions.
- Full canonical type-check passed 43 fresh build/OpenAPI tasks in 4m13.488s, plus migration,
  SDK compatibility, live 200-requirement/103-issue audits, architecture and infrastructure
  checks, before the read-integrity correction. That correction subsequently passed the
  actual SQLite TypeScript build. Final combined service validation remains pending.
- Scoped formatting, lint and whitespace checks passed. Workspace dependency boundaries
  passed over 1,473 files in 41 packages. Architecture inventory refresh was required for
  the reviewed manifest changes; it did not upgrade acceptance classifications.

Fixtures use canonical execution/attempt records in a real SQLite file with native commit,
rollback, close and reopen. They are store-level evidence, not authenticated execution
admission, provider-metering, cross-process capacity, or deployed profile acceptance.

## Required continuation

### Read-time attempt ownership correction

A schema-valid execution-attempt record reassigned to another execution was accepted by
ordered usage reads after native close/reopen. The regression failed for the intended
reason (`3a445e`); an earlier fixture-only failure used a nonexistent initialization API
and was corrected to the provider's canonical `migrate()` reopen path. Recovery now checks
the persisted attempt schema, exact attempt ID, and execution owner for every attributed
entry, rejecting damaged references with `STORE_STATE_INVALID`.

Actual SQLite TypeScript build and all 12 focused store tests passed (81 assertions).
The complete SQLite package subsequently passed 170 tests with zero failures and 1,099
assertions across 27 files in 26.90 seconds. Changed-file lint with warnings denied,
formatting, and whitespace checks passed. This proves the native recovery guard, not
production accounting activation or whole-milestone acceptance.

Implement policy-authorized extensions with retained opening-history provenance,
implement and independently validate the PostgreSQL store, then activate the service at
supported composition boundaries. Preserve both money and token
funding through child finalization; reserve before external work; reconcile real terminal
usage without inventing provider prices. Implement the full 400-day retention lifecycle with
surviving aggregates/replay fences and restore/hold coordination. Complete the remaining
security, evaluation, documentation, skill, profile and independent human acceptance gates.
