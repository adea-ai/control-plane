# Authoritative usage ledger

`@control-plane/usage-ledger` records immutable reservation, model, tool, sandbox, adjustment,
release, settlement, refund, and credit entries. Every effect carries workspace, execution,
attempt, source, idempotency, unit, currency, funding, and time attribution. The PostgreSQL adapter
exposes append and ordered-read operations only; unique execution-sequence and workspace-idempotency
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

Execution retention keeps owners referenced by these usage namespaces, including parent and
funded-child references. This is an owner-safety guard, **not** the 400-day usage deletion
implementation. Raw usage retention, surviving aggregates/replay fences, the PostgreSQL budget
store, and activation before runtime/model/tool/sandbox work remain required under M11.3/M11.9.
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
The service and native adapter remain component implementations: application admission,
terminal reconciliation, PostgreSQL budget persistence and production activation are
still required. Policy-authorized budget extensions are not yet implemented by the
durable service. Opening-summary replay verifies the original zero-use allocation rather
than comparing it with later reservations or current parent availability. Finalization
replay verifies the operation-bound terminal settlement and validated settled rollups.
Future budget extensions must retain original opening authority so those historical
receipts remain verifiable; extensions must not reuse the current maxima as that history.
