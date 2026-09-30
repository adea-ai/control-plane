# M11 graph catalog continuation — 2026-09-30

This implementation starts from main `379e02544dded874d65a3fbf7bd6d7f2762feea1`.
It incorporates main through `2a2ba5fbee0af0fe43a552ab4df4c80ba2515e2a`;
the final base update changes only generated release metadata.
It adds graph definition persistence, a prerequisite for the supported graph
execution path required by #188. It does not establish public graph admission,
production LangGraph execution, or full milestone acceptance.

## Catalog authority and persistence

Graph definition content and its digest remain immutable. A repository instance
is bound to a validated workspace; the same graph ID/version in another workspace
is a separate catalog entry. SQLite uses a hash of the workspace/ID/version tuple
in its existing transactional store. PostgreSQL uses a workspace/ID/version
primary key and a row lock for lifecycle updates. Stored scope, reference,
revision and content are validated on reads. These are internal repositories;
composition must supply the authenticated workspace rather than trusting caller
content to select a tenant.

The common lifecycle fence requires one revision increment, unchanged content,
reference and publication time, monotonic change time, and published-to-deprecated
or revoked, or deprecated-to-revoked transitions. Revoked versions cannot revive.
A stale or competing update cannot overwrite the winning lifecycle revision.
Graph checkpoints, workflow/domain state, and ProjectState remain separate
responsibilities. No automatic deletion or graph retention waiver is introduced.

## Remaining production path

The current public validation payload and immutable ExecutionPlan have no graph
pin; execution acceptance therefore cannot derive a graph invocation from a
persisted plan. Graph activities default to disabled in Local, Hosted Server
and Cloud. The LangGraph adapter uses injected registrations and operation ports;
its fixed test graphs are not a production compiler or operation dispatcher.

The remaining implementation must provide authenticated graph administration,
workspace-authorized immutable plan pinning, acceptance derived from that plan,
a restricted definition compiler, bounded segments and parallel work, and
policy/approval/budget-aware runtime, model, tool and delegation dispatch. It must
wire those paths through each supported profile's composition and prove
checkpoint/interrupt recovery, child inheritance, cancellation, fan-out/fan-in,
and explicit promotion through the public product path. Existing injected graph
fixtures and catalog persistence tests do not satisfy those requirements.

## Validation scope

Focused tests cover lifecycle immutability and revision fences, SQLite close/reopen
persistence and workspace isolation, PostgreSQL persisted pins and workspace
isolation, concurrent insert/update winners, stale/replayed updates, and corrupt
stored identity/digest rejection. PostgreSQL tests use a disposable instance of
the repository-pinned image and real application/migration/administration roles.
They are database adapter evidence, not Railway or fresh-VPS acceptance.

The implementation build passed all 41 packages. The canonical unit group passed
1,960 tests with 81.54% line and 84.07% function coverage (80% minimum), before
adding one further safe-integer regression. The final focused core/SQLite run
passed 10 tests and 54 assertions, including that regression; the installed Zod
integer validator already rejects unsafe revisions. The canonical E2E group
passed 185 tests and 1,089 assertions. The full PostgreSQL integration run passed
158 tests; the final catalog-only run after the timestamp/CAS changes passed four
tests and 24 assertions. Its generated databases, container and anonymous volume
were removed, and the owned database port was closed. Formatting and lint passed.

Local validation is not entirely green. An initial smoke run exposed a missing
entry in the explicit integration-test inventory; that entry is now registered.
A later parallel run failed the existing pinned-build process-group test with
`EPERM`. The same unchanged assertion and deadline passed in the sequential
smoke group. The sequential smoke group finished with 231 passes,
two conditional PostgreSQL skips, two failures and one error: the unchanged
source-audit and generated-report ledger tests exceeded their 30-second deadline,
and a killed formatter child produced the error. In an isolated diagnostic using
the same deadline, the source-audit test still timed out while the generated-report
test passed. The cause of those timeouts remains undiagnosed. No test deadline,
assertion or required check was weakened. The full required CI gates must pass
before merge.

Independent bounded patch review found no remaining actionable issues after
the timestamp validation fix and safe-integer regression. All original #188
requirements remain open; these results establish catalog-adapter evidence only.
