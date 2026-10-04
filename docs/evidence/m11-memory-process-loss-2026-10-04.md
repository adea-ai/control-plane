# M11 memory process-loss evidence — 2026-10-04

## Scenario and authority

A separate Bun process constructs the selected application composition, persists the real
approval/proposal pair and commit intent, and enters a synthetic provider write. The provider
fsyncs and renames its file-backed effect ledger, then signals readiness without returning a
write result. The parent sends `SIGKILL` to that exact child PID and waits for its exit.

The replacement root reads the durable `committing` proposal. Fresh writes are disabled and
the provider is read-only; a separate current authority permits only status. Recovery preserves
the full approved intent and advances its version once to `committed/reconciled`. Replaying
that result adds no provider write, status lookup, or authority call. The durable provider ledger
contains exactly one write call, one status call, and one record.

Local and Hosted Simple use actual SQLite files. Cloud and Hosted Server cases use their
separate isolated PostgreSQL integration databases. All four cases call the actual composition
factory, but never start its workflow runtime or HTTP endpoint.

This follows section 8 of the accepted [Execution Consistency specification](https://docs.google.com/document/d/1hba0jHco891TK4BHXZUZo07L3LZN8yDJ9Qw9UtzsIf4/edit)
and CP-CONS-026. A read-only native Docs capture on 2026-10-04 revalidated interrupted-proposal
status recovery, durable identity and non-canonical provider state. Its file metadata was modified
`2026-10-01T15:24:49.605Z`; the saved capture SHA-256 is
`5b089e8afdc0a284e8a30f916013ada51e99cb0947b4895574cd2e5886bf9032`.
Some source implementation-gap annotations remain stale after the recent memory repairs;
this capture does not waive the normative invariants or change the accepted Drive document.

## Validation and cleanup

The seven-file focused source run passed 47 tests with 246 Bun assertions in 1.73 seconds
(1.793 seconds including the bounded runner). Fifteen PostgreSQL-dependent cases were skipped
because `RUN_DATABASE_INTEGRATION=false`; the two new Cloud/Hosted Server crash cases still
require actual PostgreSQL CI results. Native assertions inside the fixture additionally check
the approved intent, write/status counts, exact authority scope, version and replay equality.

Two cleanup assertions first failed because storage-close errors skipped directory removal.
The fixture now attempts child reaping, both storage closes and directory removal through
`finally` boundaries. Both regressions pass, including refusal to leave a directory after
SQLite or PostgreSQL close failure. The outer source runner has a twenty-second deadline;
each fixture owns one directory and one child. Local/Simple retain eight-second readiness
and a ten-second child. PostgreSQL uses the existing integration budget, capped at 120 seconds:
readiness reserves the final third for recovery (20/80 seconds), and the child watchdog expires
within that budget (25/100 seconds for local/remote PostgreSQL). A regression reproduced the
old fixed PostgreSQL limits and verifies the scaled deadlines, hard cap and unchanged Local limits. Planned/started/reaped/removed
receipts record the exact PID and directory without database URLs or credentials.

All four scenarios belong to `tests/memory-process-loss.integration.test.mjs`, a repository-owned
integration suite because it spans application roots. Both unsharded integration and Neon shard 3
select it; unit discovery excludes it. The first ready head passed all four SIGKILL cases in
PostgreSQL CI run 37176101531, but failed `turbo boundaries` on three imports from application
packages to repository fixtures. Moving the scenarios to the repository suite preserves the
package boundary policy. The relocated suite still requires PostgreSQL CI for its current head. A bounded focused check
of the relocated suite, shard inventory and repository discovery passed 13 cases (144 Bun
assertions), with two PostgreSQL cases skipped, in 1.382 seconds (1.43 seconds including the
bounded runner). `turbo boundaries` checks
768 files in 42 packages with no issues; scoped lint and formatting also pass.

CI on the relocated head exposed an undeclared root import of `@control-plane/testing`;
the source-alias runner had hidden it. A parsed-import regression first reproduced the missing
manifest dependency. The suite now uses `createIsolatedTestDatabase` and credential loading
from existing root dependencies, with the same isolated setup/migration/disposal lifecycle.
No dependency or lockfile change is needed. Current-head PostgreSQL CI remains required.

## Limits

This kills a process owning the application memory boundary. It does not restart a running
daemon, container, host, workflow runtime or real provider. The fsynced synthetic ledger models
a durable external effect; it does not establish real provider transport, power-loss durability,
revocation at delivery, credentials, cross-product HTTP/IPC, complete retention, or full frozen
profile acceptance. No local Docker, database server, dependency installation or persistent
service was used. Historical candidate/classification metadata remains unchanged.

Related acceptance owners: [#188](https://github.com/adea-ai/control-plane/issues/188),
[#189](https://github.com/adea-ai/control-plane/issues/189),
[#194](https://github.com/adea-ai/control-plane/issues/194),
[#195](https://github.com/adea-ai/control-plane/issues/195).
