# Authoritative usage ledger

`@control-plane/usage-ledger` records immutable reservation, model, tool, sandbox, adjustment,
release, settlement, refund, and credit entries. Every effect carries workspace, execution,
source, idempotency, unit, currency, funding, and time attribution, with attempt
identity where applicable. The raw PostgreSQL
entry repository exposes append and ordered-read operations; unique execution-sequence and workspace-idempotency
constraints prevent duplicate charge effects under retries and redelivery.

Executions reserve estimated or maximum cost before work. Charges are rejected when they exceed the
reservation, execution cost ceiling, or token ceiling. Unused reservation is released during a
deterministic settlement, and child executions inherit the lesser of their requested limit and the
parent's available authority. Extensions require a recorded policy authorization decision.

HQ-managed charges carry exact microunit attribution. External-subscription effects carry their
usage units but must record zero authoritative provider cost and `costExact: false`. Public summaries
aggregate safe units and funding classifications without exposing provider source IDs, idempotency
keys, credentials, or payloads.

## Implementation and activation status

The accounting rules above are the required behavior, not a claim that every production
composition enforces them. The existing `InMemoryUsageLedger` is not a durable authority.
The PostgreSQL append/read repository alone cannot recover budget openings, token ceilings,
reservation state, or whole-budget settlement after a restart.

The public `@control-plane/usage-ledger/durable-contract` port defines versioned budget
projections and workspace-global operation receipts. `SqliteDurableUsageStore` implements
that port using native SQLite transactions: budgets, raw entries, sequence identities, and
receipts commit or roll back together. New writes verify the stored execution's exact ID,
workspace and parent attribution, and any attempt's exact ID and owner. Identical entry and
receipt writes are immutable; divergent identities or damaged persisted state are rejected.

`PostgresDurableUsageStore` implements the same port with versioned budget and immutable
operation-receipt tables alongside raw entries. Migration 0051 widens sequence storage to
bigint while runtime guards require safe integers. Accounting acquires the execution-retention
class lock before the workspace lock and owner/attempt rows. Actual PostgreSQL tests prove
basic lifecycle, fresh-connection replay, callback rollback, concurrent money/token
admission, child rollup, ownership/corruption rejection and retention contention. These are
component tests, not production capacity or live-profile acceptance. Do not run the
old direct append repository as a concurrent authoritative budget writer. See the
[PostgreSQL checkpoint](evidence/m11-postgres-durable-usage-store-2026-09-27.md).

Both stores also expose callback-scoped `withTransaction(existingTransaction, workspaceId,
operation)` for atomic integration with command acceptance. These bound stores do not start
nested transactions; their capabilities expire after the callback, pending operations drain,
and caught callback failures still force rollback. PostgreSQL admission must call
`acquireTransactionLocks` before existing command/plan/owner locks. The
[admission preparation checkpoint](evidence/m11-usage-admission-replay-2026-09-27.md) records
native and actual PostgreSQL tests and replay verification. These APIs alone do not
activate production budget enforcement; their later application integration is described below.

### Plan-bounded allocation authority

The `accepted-plan-budget-allocation.v1` policy treats trusted execution acceptance
as authorization to allocate an execution allowance, not as proof of prepaid
funds or a provider charge. Acceptance must already enforce principal, scope,
catalog and approval policy. `executionPlanBudgetAllowance` reads money and token
ceilings only from the integrity-checked persisted plan and verifies its pin and
execution correlation; request-supplied limits cannot increase the allowance.
`executionBudgetAdmissionSource` binds the allocation to the recorded actor,
command, payload, immutable execution and parent through an opaque digest. Its
identity remains stable across lifecycle transitions and historical replay.

Parent capacity and same-workspace, same-project ownership must be enforced by
the admission repository within the command/owner transaction. Opening credits
describe allocation, not purchased funds. Actual charges still need explicit
funding and cost provenance; unknown costs must not become zero-cost settlement.
SQLite and PostgreSQL command acceptance opt into this policy with `budgetAdmission:
true`. Actual Local API, Cloud API/worker and Hosted command compositions enable it: command, owner, budget and
opening receipt commit together; duplicate/reopened admission validates the
original allocation and rejects missing accounting without creating new credit.
The Local composition regression proves allocation, approval-denial rollback,
cold replay and missing-budget rejection. Actual migrated PostgreSQL and signed
Cloud API composition tests prove atomic allocation, concurrent acceptance, child
exhaustion rollback and damaged-accounting denial. The Cloud HTTP fixture uses
mock Restate ingress, not a deployed runtime. See the
[acceptance admission checkpoint](evidence/m11-plan-budget-admission-2026-09-27.md).

`DurableRuntimeBudgetAdmission` is installed in actual Local, Hosted-simple,
Hosted-server and Cloud worker default lifecycle roots. Before runtime dispatch,
interaction continuation or graph run/resume/continue, it checks the current
attempt and accepted command/immutable plan; allowance tree, entries and original
opening evidence are then read in one read-only workspace transaction. A caller
supplying custom Local lifecycle activities owns their admission enforcement.
Cancellation and
cleanup stay available when admission is denied. Native composition tests prove
denial before controlled runtime callbacks and cold replay. This is a preflight,
not a serialized reservation or proof of provider payment; see the
[runtime admission checkpoint](evidence/m11-runtime-budget-admission-2026-09-27.md)
for exact tested profiles and limitations.

### Plan-bounded allocation authority

The `accepted-plan-budget-allocation.v1` policy treats trusted execution acceptance
as authorization to allocate an execution allowance, not as proof of prepaid
funds or a provider charge. Acceptance must already enforce principal, scope,
catalog and approval policy. `executionPlanBudgetAllowance` reads money and token
ceilings only from the integrity-checked persisted plan and verifies its pin and
execution correlation; request-supplied limits cannot increase the allowance.
`executionBudgetAdmissionSource` binds the allocation to the recorded actor,
command, payload, immutable execution and parent through an opaque digest. Its
identity remains stable across lifecycle transitions and historical replay.

Parent capacity and same-workspace, same-project ownership must be enforced by
the admission repository within the command/owner transaction. Opening credits
describe allocation, not purchased funds. Actual charges still need explicit
funding and cost provenance; unknown costs must not become zero-cost settlement.
SQLite and PostgreSQL acceptance now atomically records plan-bounded opening
allocations, and Local, Hosted and Cloud runtime roots install the admission
preflight. This does not reserve per-effect capacity or charge actual provider
usage; trusted cost provenance and terminal settlement remain open M11 gates.

Execution retention keeps owners referenced by these usage namespaces, including parent and
funded-child references. This is an owner-safety guard, **not** the 400-day usage deletion
implementation. Raw usage retention, surviving aggregates/replay fences, complete PostgreSQL
runtime/profile acceptance, and per-effect capacity enforcement before runtime/model/tool/sandbox
work remain required under M11.3/M11.9.
Native-store tests do not certify those production paths or provider billing attribution.

`DurableUsageLedger` now supplies the shared transactional accounting service for this
port. It persists budget opening, money and token reservations, charges, reservation
settlement, and whole-budget finalization. Child budgets reserve both resources against
the parent's available authority before admission; child finalization rolls actual usage
into the parent once without creating a duplicate billable charge. Identical operations
replay their original receipts after reopen; conflicting input is rejected. Entry-bearing
receipts are checked against immutable entries bound to the original operation, including
the released amount in a settlement receipt.

Budget summaries include finalized child funding consumption. Public usage summaries
describe billable entries owned by the requested execution, not duplicated descendant
charges. Neither summary includes provider credentials or source/idempotency identifiers.
Application allowance admission and runtime preflight now use the durable service/stores;
runtime reservations, trusted funding/cost provenance, charges, terminal reconciliation,
complete PostgreSQL runtime/profile acceptance and deployed activation remain required.
Policy-authorized budget extensions are not yet implemented by the
durable service. Opening-summary replay verifies the original zero-use allocation rather
than comparing it with later reservations or current parent availability. Finalization
replay verifies the operation-bound terminal settlement and validated settled rollups.
Future budget extensions must retain original opening authority so those historical
receipts remain verifiable; extensions must not reuse the current maxima as that history.
