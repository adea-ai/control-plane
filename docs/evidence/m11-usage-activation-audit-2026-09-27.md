# M11 durable usage activation audit

Source snapshot: `7dc61b1976a534ffda35fd75f09785dfcbe61f3f`. This is a source-backed
implementation guide, not executed acceptance evidence or a scope reduction for #188/#194.
The PostgreSQL store is being implemented in a separate bounded lane; it was not part of
this snapshot. Original milestone acceptance criteria remain unchanged.

Later component implementation and executed PostgreSQL checks are recorded in the
[PostgreSQL checkpoint](m11-postgres-durable-usage-store-2026-09-27.md). They do not
complete the transaction-bound application activation described here.

## Verified seams and gaps

| Boundary                  | Current source                                                                                                                                   | Remaining implementation                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Public acceptance         | `apps/control-api/src/executions/execution-acceptance.service.ts` accepts through the command service, then dispatches                           | Durable budget admission must complete atomically before work is submitted                                                         |
| Immutable limits          | `packages/domain/src/command-inbox.ts` validates the plan pin; `packages/execution-plan/src/index.ts` resolves and validates the plan            | Carry the hydrated, correlated compiled plan into admission; use `constraints.limits.budget` and `constraints.limits.tokens`       |
| Native acceptance         | `packages/sqlite-persistence/src/repositories.ts` creates command and owner inside one transaction                                               | Bind ledger writes to that existing transaction; do not start a queued nested provider transaction                                 |
| PostgreSQL acceptance     | `packages/database/src/command-inbox-repository.ts` creates command and owner inside one transaction                                             | Bind ledger writes to the same transaction and acquire usage/retention locks before existing command/plan/owner locks              |
| Runtime dispatch          | `apps/workflow-worker/src/cloud-execution-activities.ts` reloads the owner/plan before runtime dispatch; Local composes it over direct transport | Reserve a deterministic per-attempt money/token envelope before any external start                                                 |
| Native terminal usage     | `apps/local-control-plane/src/direct-runtime-activities.ts` persists completed `result.usage` or unsuccessful `terminalUsage`                    | Account from retained terminal evidence, including cancellation/recovery; absence remains unknown                                  |
| Runtime metering contract | `packages/runtime-sdk/src/adapter.ts` has aggregate tokens/duration and optional cost/currency, without funding/component attribution            | Add trusted funding and cost provenance; do not relabel aggregate runtime usage as model/tool/sandbox charges                      |
| Managed model results     | Model results carry funding class and tokens, but no exact price; no production model gateway construction was found                             | Activate the actual provider route and authoritative cost source, preserving zero-cost/non-exact external-subscription attribution |
| Tool/sandbox paths        | Component implementations exist, but no production construction was found in this bounded audit                                                  | Wire supported production routes and verify each charge and reservation boundary                                                   |

The map was gathered by a bounded read-only Luna lane. It did not execute tests, inspect
live providers, or establish whole-profile acceptance. The root verified the inspected
snapshot and relevant acceptance, constraint, terminal receipt and retention sources.

## Root implementation decisions

1. Derive ceilings from the immutable, validated and workspace-correlated compiled plan,
   not client-provided monetary limits or adapter-reported authority.
2. On the winning new-owner path, create the owner and open its budget in the same native
   or PostgreSQL acceptance transaction. Child opening reserves parent money and tokens
   in that transaction. Any budget failure rolls back owner and command creation; there
   must be no externally dispatched work after denied admission.
3. Add a transaction-bound usage adapter instead of recursively calling the standalone
   store's transaction method. For PostgreSQL, acquire the execution-retention class mutex
   and workspace usage lock before existing acceptance command/plan/owner locks. Revalidate
   the full combined lock order with real contention tests, not source comments alone.
4. Replayed acceptance must verify matching durable budget authority before redispatch.
   Accepted legacy owners without a budget fail closed into explicit reconciliation;
   inventing a new allowance during replay is not a migration strategy.
5. Reserve deterministic per-attempt money and token authority immediately before external
   dispatch. Reuse effect identities on retries; retain uncertain dispatches for reconciliation
   rather than releasing authority and starting another potentially billable attempt.
6. A plan ceiling is a spending constraint, not evidence of prepaid funds or an exact
   provider price. Root budget provisioning needs a trusted, recorded spending/funding
   authorization source. Current zero-cost opening credits are allocation records, not
   proof of purchased funding. Production activation must define and verify that source.
7. Require explicit funding metadata and authoritative cost provenance for terminal
   accounting. Do not infer subscription funding from a provider class, or exact HQ cost
   from aggregate runtime counters. Missing terminal usage/cost remains unresolved with
   bounded diagnostic/reconciliation state. Known external-subscription effects retain
   measured units, zero authoritative provider cost, and `costExact: false`.
8. Charge measured usage, settle reservations, then finalize budgets exactly once. Child
   finalization rolls up consumption without duplicate billable entries. Keep original
   opening authority verifiable when implementing authorized money/token extensions.

## Required proof before activation is accepted

- Actual authenticated Local and PostgreSQL acceptance: denied budgets leave no owner,
  command, receipt or dispatch; successful admission persists owner and budget together.
- Native/PG concurrency and restart: identical replay preserves allowance, conflicting
  replay rejects, child admission cannot escape either parent ceiling, and no live runtime
  is started when admission or per-attempt reservation fails.
- Actual cancellation, failure, timeout, reconnect and lost acknowledgement paths reconcile
  retained usage without invented zero costs, duplicate charges or premature authority release.
- Independently prove the reachable runtime/model/tool/sandbox/provider routes and funding
  provenance for every supported composition. Scripted ports and direct store tests are
  component evidence only.
- Complete PostgreSQL store/retention contention, performance/capacity, policy-authorized
  extensions, 400-day usage deletion with surviving aggregates/replay fences, and hold/restore
  coordination. Existing historical profile/benchmark evidence does not certify new paths.

The original security, evaluation, documentation, Skill, deployed-profile and independent
human gates also remain required. This guide does not close any milestone issue.
