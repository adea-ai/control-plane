# Context-read command ledger foundation

This is a separate context-read ledger, not a runtime execution with fabricated
execution, attempt, or RuntimeConnection IDs. It is not yet a complete gateway
delivery implementation or proof of all deployment profiles.

## Domain contract

- Scope is workspace, principal, provider reference, and stable operation ID.
  Racing allocation of different command IDs for that same scope returns the first
  command when semantic hashes match; changed semantics conflict. Cross-scope
  command-ID collisions fail without returning the other scope's record.
- The bounded inline `context.read` envelope is checked against the persisted
  identity and semantic digest. Runtime-execution fields and context writes are
  rejected. The digest uses the adapter's node/workspace/provider/authorization,
  operation, driver, capabilities, and complete payload semantics.
- Updates use sequential versions and immutable command identity. Redelivery must
  advance its sequence or channel generation. Terminal commands cannot reopen.
  Success requires an Artifact reference; failures require a bounded classified
  code. Chronology and delivery/terminal metadata are validated.

## Implemented storage and evidence

The in-memory implementation is a reference implementation only. The SQLite
repository stores the command, scoped operation index, and pending-work index in one transaction,
validates its index on replay, and applies the shared transition rules under CAS.
Tests reopen the actual database and inject failure at the second and third writes to
prove rollback leaves no partial record or index behind. Temporary databases are owned test
directories, removed after their providers close.

The initial seven focused domain/SQLite tests passed with 46 assertions. A separate smoke test
passed with three assertions: it captures a command from the real Cortana adapter,
validates the ledger's independent semantic hash, and writes it to SQLite before
calling a deterministic provider fixture. This proves contract compatibility, not
network delivery, node-side deduplication, or live provider acceptance. The smoke
test is registered in the repository test runner.

The PostgreSQL implementation uses Drizzle migration 0041, a unique scoped
operation key, and a version predicate on updates. Projected columns are checked
against the validated JSON record on every read. The initial real-Neon integration
test passed with 11 assertions, including racing allocations, conflicting payloads,
workspace isolation, concurrent CAS, and terminal-state fencing. Its owned isolated
database was disposed; staging and production were not modified. With pending
queries added, all 32 PostgreSQL integration tests passed with 407 assertions,
including the 17-assertion context-command test. The owned database was again
disposed. Eight domain/SQLite tests passed with 67 assertions. Full repository
validation passed 1,311 tests (1,104 unit, 127 E2E, 80 smoke), type-check, lint,
format, and the unchanged 80% coverage thresholds (86.94% lines, 84.44% functions).

All three implementations support workspace/node-scoped pending queries, with an
exclusive command-ID cursor and a maximum page of 128 records. Pending includes
expired grants so a dispatcher can mark them expired instead of losing them from
recovery. SQLite scans a dedicated per-workspace/node index and removes terminal
entries in the same transaction as the record update; the operation index remains
for duplicate detection. PostgreSQL filters and limits in SQL. These queries are
not a snapshot: a later recovery pass starts without a cursor to include newly
inserted earlier IDs. No dispatcher is wired yet.

Apply the additive Drizzle migration before using the PostgreSQL repository.
Rollback can stop using the new repository while retaining its table and records;
do not drop command history as an application rollback step. SQLite's namespaces
are new and have not been used by a deployed composition. Real-Neon testing here
used an isolated database on the staging-derived PR preview, not production data
or a production rollout.

## Remaining work

Authenticated gateway
ACK/result routing, result Artifact storage, the node-side context driver and
deduplication boundary, binding allocation/composition, and production-shaped
restart/replay acceptance remain unimplemented here. No running composition uses
this repository yet. Do not close M11 from these domain or SQLite tests. Live
Cortana is not introduced as an ordinary M11 prerequisite; independent conforming
fixtures remain valid where the acceptance criteria allow them.
