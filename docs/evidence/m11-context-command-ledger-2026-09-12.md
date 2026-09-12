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
repository stores the command and scoped operation index in one transaction,
validates its index on replay, and applies the shared transition rules under CAS.
Tests reopen the actual database and inject failure between the two writes to
prove rollback leaves neither record behind. Temporary databases are owned test
directories, removed after their providers close.

Seven focused domain/SQLite tests passed with 46 assertions. A separate smoke test
passed with three assertions: it captures a command from the real Cortana adapter,
validates the ledger's independent semantic hash, and writes it to SQLite before
calling a deterministic provider fixture. This proves contract compatibility, not
network delivery, node-side deduplication, or live provider acceptance. The smoke
test is registered in the repository test runner.

## Remaining work

PostgreSQL storage, bounded dispatch/reconnect enumeration, authenticated gateway
ACK/result routing, result Artifact storage, the node-side context driver and
deduplication boundary, binding allocation/composition, and production-shaped
restart/replay acceptance remain unimplemented here. No running composition uses
this repository yet. Do not close M11 from these domain or SQLite tests. Live
Cortana is not introduced as an ordinary M11 prerequisite; independent conforming
fixtures remain valid where the acceptance criteria allow them.
