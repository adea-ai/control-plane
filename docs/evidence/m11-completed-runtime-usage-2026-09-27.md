# M11 completed-runtime usage receipt audit

## Finding and correction

Successful runtime status carries mandatory measured usage in `result.usage`.
The runtime contract reserves optional `terminalUsage` for unsuccessful terminal
states. Local's direct-runtime activity recorded only `terminalUsage`, so successful
execution usage was present in the result artifact but absent from its durable
SQLite usage receipt.

The activity now selects completed result usage or unsuccessful terminal usage
according to the validated status. The existing execution/attempt receipt identity,
transaction, and conflict checks are unchanged. Receipt persistence precedes result
artifact publication and runtime cleanup. No model prices, costs, or usage are
inferred from a plan; optional runtime-reported cost is preserved as reported.

## Regression evidence

- Before the production change, both new completed cases failed because the receipt
  was missing at artifact publication. An initial fixture omitted `runtime.status`;
  that fixture error was corrected before confirming the product regression.
- After the change, `bun test src/terminal-usage.test.mjs` in the Local package:
  4 passed, 0 failed, 34 assertions. Covers successful completion, unsuccessful
  cancellation, SQLite reopen, lost result publication, unchanged replay,
  conflicting reported usage, and no duplicate runtime start.
- Complete Local package `bun run test`: 77 passed, 0 failed, 433 assertions across
  16 files. Includes native-wire composition, durable recovery, and interaction cases.
- A bounded independent Luna source review found no actionable bugs in the two-file
  implementation/test delta; it did not execute tests.
- Workspace `bun run type-check` passed: 43 fresh build/OpenAPI tasks, database
  migration check, runtime compatibility, live 200-requirement/103-audit ledger,
  41-package/16-operation/4-profile architecture, and Railway configuration typing.
- Workspace lint and formatting passed; five pre-existing package warnings remain.
- Embedded execution consumer: 4 passed, 1 PostgreSQL matrix skipped, 0 failed,
  20 assertions. Covers actual Local completion/restart and SQLite profile contract
  parity. The skipped direct-port matrix is not passing cloud evidence.
- Actual PostgreSQL profile-portability integration: 3 passed, 0 failed, 41
  assertions. Covers cross-store catalog/evaluation/receipt round-trip identity,
  lineage reference clocks and replay, and transactional rollback on invalid
  derivation. This is database integration, not live hosted ingress certification.
- Separately, the prior immutable `c920c773` database checkpoint passed the actual
  PostgreSQL package integration suite: 108 passed, 0 failed, 927 assertions across
  10 files. This suite used isolated migrated databases with distinct application,
  migration, and administration roles. No isolated test databases remained; the
  owned container was stopped and its listener verified closed.

## Acceptance boundary

This is a durable runtime receipt correction, not complete billing accounting or
production certification. It adds no budget reservation, budget settlement,
PostgreSQL accounting wiring, price authority, or usage retention deletion.
Production durable budget enforcement and accounting across Cloud, Hosted Server,
Local, and Hosted Simple remain open under M11.3 and M11.9. Raw usage must not be
deleted solely by age without durable settlement, reference, hold, and replay proof.
M11.12 still requires the full independent production-readiness gate.
