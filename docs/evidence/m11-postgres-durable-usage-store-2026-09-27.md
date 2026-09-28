# M11 PostgreSQL durable usage accounting checkpoint

Scope: original issues #188 and #194. This is component implementation evidence,
not production activation or complete Milestone 11 acceptance.

## Implementation

The PostgreSQL adapter persists mutable versioned budget snapshots, immutable
workspace-global operation receipts, and the existing immutable raw usage entries
in one database transaction. Canonical migration 0051 creates the state tables
and widens usage sequence storage to bigint; runtime guards still require safe
JavaScript integers. Indexed receipt/budget identity must match its JSON payload.
Canonical execution and attempt records govern ownership, including reads of
persisted attributed entries. Divergent receipt or entry replays are rejected.

Lock order is execution-retention class advisory mutex, workspace accounting
advisory mutex, then owner/attempt and budget row locks. READ COMMITTED permits
a waiter to observe the committed winner. The coarse class mutex favors safety;
it is not capacity or production latency evidence. The old direct append
repository remains outside this accounting protocol and must not be used as a
concurrent authoritative budget writer during activation.

Execution retention recognizes budget scalar and JSON owner/parent identities,
funded children in reservation arrays, receipt scalar and JSON owners, and raw
entry owner/parent attribution. Neither foreign-key failure nor deletion ordering
is used as the retention policy. An unreadable reservation collection could hide
any child, so deletion conservatively retains the entire candidate set. The SQL
array expansion uses a guarded CASE and cannot assume damaged JSON is an array.

## Verification chronology

- Luna checkpoint `632bd2fe`: package build, codec/public aggregate tests (four
  passed, 15 assertions), migration metadata check and formatting passed.
  Package lint had one pre-existing warning in execution-plan-repository.
  No PostgreSQL server or integration tests were run by that lane.
- An accidentally launched root-level build was interrupted with exit 130;
  it is not a successful workspace validation result.
- Root integrated the adapter as `94910b37`, built the actual database package,
  and passed changed-file lint with warnings denied and migration metadata check.
- Root ran canonical migrations against a local PostgreSQL instance using
  distinct application, migration and administration roles. Three existing
  execution-retention integration tests passed with 20 assertions.
- The new funding-reference test passed with 12 assertions. It creates eight
  canonical execution owners and proves seven independent scalar/JSON funding
  references retain their owners while the unreferenced owner is deleted. A
  malformed reservation collection first retains all eight without journaling
  or foreign-key errors. Both isolated databases were disposed; a subsequent
  database inventory showed zero remaining test databases.
- The complete PostgreSQL foundation integration file subsequently passed all
  62 tests, zero failures, 652 assertions in 49.27 seconds, including actual
  acceptance/deletion contention, transaction timeout, crash recovery and the
  new funding references. Canonical migrations were enabled, not skipped.
  A subsequent database inventory again showed zero isolated test databases.
  This foundation run does not contain the pending durable accounting matrix.
- A subsequent focused public-service lifecycle test passed (one test, seven
  assertions): real PostgreSQL open/reserve/charge/settle/finalize, recreation of
  the service, identical operation replay without new entries, measured settled
  money/tokens, and divergent charge rejection. This uses the same live database
  connection, so it is not yet physical connection-recovery evidence. The added
  case postdates the 62-test foundation run.
- The first Luna-authored durable integration checkpoint was then executed by
  root on actual PostgreSQL: three tests passed, zero failed, 16 assertions in
  6.45 seconds. It proves replay over a fresh database connection, rollback of
  budget/entry/receipt writes when a callback throws, and simultaneous independent
  money/token reservations plus rejection of over-ceiling contenders.
- Independent bounded Luna source review found no actionable defect in the
  store, schema/migration and retention changes. That reviewer ran no tests and
  did not audit production composition or bypass writers.
- Canonical workspace type-check passed against the stable runtime source:
  43 fresh build/OpenAPI tasks in 1m8.168s, migration metadata, runtime SDK
  compatibility, live 200-requirement/103-issue checks, architecture and Railway
  infrastructure types. Dependency boundaries passed 1,485 files in 41 packages.
  At the initial three-case fixture checkpoint, the ordinary database package
  run passed 33 tests with 123 assertions and
  explicitly skipped 119 integration cases; those skips are not acceptance
  evidence. Enabled PostgreSQL results are recorded separately above.
- After the fixture extension, all nine durable PostgreSQL integration tests
  passed with zero failures and 53 assertions in 38.14 seconds. The actual matrix
  includes once-only child rollup, workspace/parent/attempt rejection, persisted
  budget/receipt/attempt corruption, raw-entry deletion high-water rejection, and
  both deletion-versus-accounting lock orders. Race fixtures observe actual
  PostgreSQL lock waits, release barriers in finally, handle expected rejection
  immediately, and drain all started operations. The canonical type-check above
  predates this test-only extension; runtime TypeScript was unchanged.

## Remaining acceptance

The functional store matrix above is executed evidence for its named cases,
not proof of the full production profile, capacity targets, or deployed recovery.

Transaction-bound command acceptance, pre-runtime reservation, trusted funding
authority, real terminal metering, authorized budget extensions, complete 400-day
usage retention/restore and live frozen-profile acceptance remain required.
The original security, evaluation, documentation, Skill and independent-human
milestone gates are unchanged.
