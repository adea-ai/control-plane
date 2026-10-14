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
denial before controlled runtime callbacks and cold replay. The lifecycle now atomically reserves the attempt allowance before dispatch;
this allocation is not proof of provider payment. See the
[runtime admission checkpoint](evidence/m11-runtime-budget-admission-2026-09-27.md)
for exact tested profiles and limitations.

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
provider-send activation, trusted funding/cost provenance, charges, terminal reconciliation,
complete PostgreSQL runtime/profile acceptance and deployed activation remain required.
Policy-authorized budget extensions are not yet implemented by the
durable service. Opening-summary replay verifies the original zero-use allocation rather
than comparing it with later reservations or current parent availability. Finalization
replay verifies the operation-bound terminal settlement and validated settled rollups.
Future budget extensions must retain original opening authority so those historical
receipts remain verifiable; extensions must not reuse the current maxima as that history.

### Child allowance in the accepted plan

A child is funded only from its parent's unreserved balance, and a runtime attempt reserves
everything that is left. A plan therefore states what it holds back for children:
`limits.childExecutions.budgetAllowance` (`maximumMicrounits`, `maximumTokens`). The allowance is
both a holdback and a cap, from the same definition (`unfundedChildAllowance`): the part of it no
child has been funded from yet. An open child funding counts at its ceiling and a settled one at
what it spent.

- **Holdback:** a runtime attempt reserves the available balance minus the unfunded allowance, so a
  child can be funded.
- **Cap:** child allocation passes the parent plan's statement (`parentChildAllowance`) to
  `openBudget`, which funds the child at the smallest of its requested ceiling, the parent's
  available balance and the unfunded allowance, and fails with `BUDGET_EXHAUSTED` when either
  resource has none left. The cap is an invariant of the parent's budget ledger, not of the lead's
  attempt: it counts funding still open at its ceiling and funding already settled at what it
  spent, so it bounds outstanding funding plus spend, not a one-off total. A child that settles
  below its ceiling returns the difference to the allowance for later siblings. The statement is a
  constant of the parent's accepted plan, so a replayed opening is identical.
- **Lifecycle:** the production allocators (SQLite and PostgreSQL) also require the parent
  execution to be running and its latest attempt running or awaiting input, so after the lead's
  attempt ends no child is allocated at all. The cap is the second, independent line of defence for
  the window where the lead's usage reservation has settled but its attempt record has not moved
  on: balance released then is never available to children beyond the allowance. Both are tested
  (`tests/child-runtime-budget-admission.test.mjs`, the ledger and worker suites, and the
  PostgreSQL child allocator suite). No reachable production path is claimed beyond the lifecycle
  fence; the ledger-level cap does not depend on it.
- The allowance must be below both execution ceilings, so the execution keeps a nonzero share, and
  it needs at least one child and one level of depth. Plans that omit it keep their exact shape and
  digest, and their children are funded from whatever is available as before.

- **Omitted:** a plan that allows children but states no allowance reserves everything left in its
  attempt, so no child can be funded (`BUDGET_EXHAUSTED`). Nothing invents a default share; the plan
  has to state one.
- **Layers:** constraint layers on one execution (profile and request) compose to the smaller stated
  allowance, a layer that states none has no opinion, and the result is clamped under the composed
  ceilings or dropped when no child remains.
- **Nested:** the allowance is the execution's own, not an inherited restriction. A child plan states
  its own allowance for its own children or none; it is not compared with its parent's, because a
  grandchild is funded only from the child's budget, which the parent already bounded. Every other
  child limit is still compared exactly.
- **Clamped:** a child is funded at the smaller of its requested ceiling, what its parent has
  available and the unfunded allowance, so its budget can be below its plan's ceiling. Its allowance scales by the same ratio
  and rounds down, so the plan keeps the share it asked for and a nonzero budget always leaves a
  nonzero attempt envelope. A root budget is never clamped.
- **Siblings:** siblings share one allowance. Each is clamped to what is left, and once the allowance
  is funded or spent no further child can be opened. A settled child counts at what it spent, so its
  unused funding is available again to a sibling and to a later attempt.
- **Retries:** a retry reserves only what is released, never a share a child was already funded from.

`DurableRuntimeBudgetAdmission` applies this to a root execution accepted by a command.
`DurableChildRuntimeBudgetAdmission` is the production `reserveBudget` implementation for the
delegation bridge. A delegated child has no accepted command, so it checks the delegation record,
the allocator's opening receipt (whose fingerprint covers the parent plan's statement) and the
parent's funding reservation before reserving the same envelope. A child's own budget is opened with its own reservations: nothing it spends or reserves
changes its parent's attempt envelope.

#### Where each case is tested

The same cases run over both stores. SQLite: `tests/child-runtime-budget-admission.test.mjs`.
PostgreSQL: `apps/workflow-worker/src/child-runtime-budget-admission.integration.test.mjs`, with
`packages/database/src/child-budget-admission.integration.test.mjs` for the cap and the denial
cleanup.

| Case                                                                                            | SQLite                                                             | PostgreSQL                     |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------ |
| Allocation after the lead's reservation settled is capped at the allowance                      | yes                                                                | yes                            |
| An outstanding child funding exhausts the allowance for a sibling (`BUDGET_EXHAUSTED`, no rows) | yes                                                                | yes                            |
| Settled child spend frees only the unspent difference                                           | yes                                                                | yes                            |
| The child admission binds the parent plan's statement (a different or absent statement denies)  | different and absent statement, foreign plan, receipt and identity | different and absent statement |
| Cancelled lead attempt is refused by the allocator (`CHILD_ADMISSION_DENIED`, no rows)          | yes                                                                | yes                            |

The allowance bounds outstanding child funding plus settled spend, not a lifetime allocation: in the
PostgreSQL test a 4M allowance funds a 4M child, the child spends 1M and settles, and the next
sibling is funded 3M (its 3M of unspent funding returned) after which the allowance is exhausted
again (1M spent plus 3M outstanding).

#### Composition contract for `DurableChildRuntimeBudgetAdmission`

No composition root builds `CanonicalDelegationRuntimeBridge` in this repository yet, so the class
is exported but unused. A root that builds the bridge wires it as follows; this contract is for the
Local and Hosted composition owners (CP #1047, #1048):

```ts
new CanonicalDelegationRuntimeBridge({
  // ...records, lifecycle, plans, delegations, runtime, runtimeConnectionId, assertAuthority...
  reserveBudget: new DurableChildRuntimeBudgetAdmission({ store: usageStore, plans }).reserve,
})
```

- `store` is the same `DurableUsageStore` the root's child allocator opens child budgets in
  (`SqliteDurableUsageStore` for Local, `PostgresDurableUsageStore` for Hosted and Cloud). A
  different store sees no child budget and denies.
- `plans` is the same `ExecutionPlanRepository` the bridge reads. It supplies the parent plan whose
  statement the opening receipt was fingerprinted with.
- Pass `.reserve` itself, unwrapped. It denies with `RuntimeBudgetAdmissionError`
  (`RUNTIME_BUDGET_ADMISSION_DENIED`) and never partially reserves; it is replay-safe, so recovery
  may call it again for the same delegation and attempt and receives the same envelope.
- The bridge calls it after `assertAuthority` and before `runtime.start`, so a denial starts no
  runtime. The reservation is allocation authority, not a charge. Child usage settlement and
  `finalizeBudget` stay with the existing child-completion path.
- The root's lead admission remains `DurableRuntimeBudgetAdmission`; neither class replaces the
  other.

### Model-request holds inside an attempt

`reserveModelRequest` subdivides an existing open attempt reservation. The caller
supplies the exact workspace/execution/attempt and model-call identity, request
digest, price snapshot digest, funding class, and maximum money/token usage.
Concurrent open holds plus actual charges must fit both attempt ceilings. The
execution totals count the attempt envelope once; nested holds do not allocate
its capacity again. Each hold has an immutable `model_reservation` entry.

`reserveModelRequestForDispatch` creates the same hold and receipt atomically but
rejects an existing receipt with `MODEL_REQUEST_DISPATCH_ALREADY_ADMITTED`, even
after known settlement or process restart. A physical send must use this method
once, then forward only if admission succeeds. A committed hold with a lost ACK
requires reconciliation; replaying it is never permission to send again. The
ordinary `reserveModelRequest` remains idempotent for accounting/reconciliation.
Do not prepare a hold with that method and then attempt to dispatch it. Both APIs
require trusted grant, scope, funding and price evidence supplied by the server.

`settleModelRequest` accepts authoritative known usage, charges it once, and
records the unused monetary hold in a `model_release` entry within the same
transaction. Its funding class comes from the original hold. External
subscription usage has zero authoritative provider cost and `costExact: false`.
Unknown outcomes retain their hold and block attempt settlement. Over-limit
usage, conflicting replay, foreign ownership, and inconsistent persisted
projections fail closed; none release capacity. Aggregate model charges cannot
be introduced after an attempt starts per-request accounting.

SQLite persists these additive version-1 projection and entry fields. PostgreSQL
migration 0065 adds the two entry kinds and nullable model identity, reserved
tokens, quote digest, and request digest columns; existing entries remain valid.
The migrated PostgreSQL reconnect test is part of the database integration suite.
The migration is expand-only, but older ledger binaries cannot parse new request
entries or hold projections. Upgrade all ledger readers and writers before
activating these APIs. Once request records exist, rollback requires a binary
that understands them; never delete accounting evidence to permit rollback.

These APIs are accounting primitives. They do not establish purchased funding,
authenticate a price quote, authorize a provider send, or intercept native Pi
requests, compaction, retries, or cached responses. Activation requires a trusted
funding/quote authority and enforcement at the actual provider-send boundary.
A missing or uncertain usage receipt must not be replaced with zero-cost usage.

### Pinned server model prices

`PinnedModelPrice` validates and privately copies a versioned text-model price
snapshot from the operator/provider side of the server boundary. The snapshot
binds deployment, provider/model, funding class, USD rates, input/output ceilings
and a validity interval; its canonical digest changes when any of these change.
Parsing it does not authenticate its source or grant access to a provider.

`quote` checks price validity against its server-owned clock; callers cannot
backdate a request to revive an expired snapshot. It binds an exact outbound
request digest and bounded output maximum. It
reserves the full configured input ceiling, without accepting a caller's token
estimate. Input/output rates are integer USD microunits per million tokens;
products and sums use `bigint`, and the final aggregate rounds upward once. An
unsafe monetary result fails closed. Cached input must be a subset of input and
cannot have a higher rate. Reasoning tokens must be a subset of output and are
not counted twice. Protocol adapters must normalize those semantics; modalities,
cache writes or other priced units outside this text-only snapshot are unsupported.

The immutable quote prices validated authoritative usage within its original
ceilings. Missing, malformed or excessive usage cannot become zero cost. External
subscription snapshots require zero HQ rates, retain token ceilings and produce
`costExact: false`; this does not claim that external inference is free.

The price producer and dispatch fence are prerequisites for the native broker.
Local/remote composition still needs to supply approved grants and price snapshots,
intercept every physical provider send (including retries and compaction), keep
credentials outside the native process, and reconcile ambiguous outcomes. These
component APIs do not activate those paths by themselves.
