# M11 durable admission replay gate — 2026-09-27

This checkpoint prepares command acceptance for durable budget admission. It is not
production activation or Milestone 11 completion.

## Defect and change

`CommandInboxService.acceptExecution` has two duplicate paths: an early identical replay
from the optimistic scope read, and a duplicate discovered by the acceptance transaction.
A repository-only new-owner budget hook would miss the early replay. An accepted legacy
execution without a budget could consequently reach redispatch unless replay also checks
persisted admission authority.

`CommandAcceptanceRepository.verifyAdmission(command, execution)` is a provider-neutral
optional capability for budget-enabled repositories. The service awaits it on both duplicate
paths before returning an execution to its caller. Errors propagate; successful verification
does not allocate a new owner or revalidate a historical plan. Conflicting payloads retain the
existing conflict-audit path. New-owner admission must still be atomic inside `accept`.

## Evidence

- Before implementation, the three new regression tests failed: identical and racing
  duplicates resolved despite a rejecting verifier, and funded historical replay never
  invoked its verifier.
- After implementation, the focused command inbox suite passed: 19 tests, 54 assertions,
  zero failures.
- The full domain package suite passed: 166 tests, 559 assertions, zero failures across
  20 files.
- The actual `DurableExecutionAcceptanceService` passed both duplicate paths with a
  rejecting verifier: two tests, ten assertions, zero workflow submissions, unchanged
  command status/version, and one retained owner. These tests use an in-memory repository
  and a counting dispatcher, not authenticated transport or a live runtime.
- The domain TypeScript build, changed-file formatting, strict changed-file lint, and
  `git diff --check` passed.

These are actual domain service tests with an in-memory repository verifier, not proof of
authenticated SQLite/PostgreSQL acceptance, durable funding, or runtime denial.

## Transaction-bound adapter checkpoint

Both concrete stores now expose `withTransaction(existingTransaction, workspaceId, operation)`.
The callback receives a workspace-bound store over the supplied transaction, without opening
another persistence transaction. PostgreSQL also exposes `acquireTransactionLocks` so admission
can acquire the execution-retention mutex and workspace lock before command/plan/owner locks.

The capability has private backing fields and a six-method transaction facade. Outer and
per-operation leases reject escaped references and overlapping/reentrant bound operations.
Pending operations are drained before scope exit rejects. A failed bound callback poisons the
enclosing scope even if its caller catches the error, preventing partial acceptance commits.
Already-started operations have rejection observers without changing caller-visible rejection.

Luna implemented the bounded adapter/test delta; root reviewed it, integrated it and executed
the actual PostgreSQL fixtures. Review corrected backing-transaction exposure, pending-operation
lifetime and caught-failure rollback. Root strict lint also found throws in cleanup that could
mask the original operation error. A native regression failed on that masking before the fix;
cleanup now drains/revokes without overwriting the original rejection. PostgreSQL asserts the
same error-preservation and rollback behavior.

Final checks for this adapter checkpoint:

- SQLite focused store suite: 16 passed, 95 assertions, zero failures.
- Full SQLite package: 174 passed, 1,113 assertions, zero failures across 27 files.
- PostgreSQL durable suite with actual canonical migration and separate application,
  migration and administration roles: 10 passed, 66 assertions, zero failures in 30.53 seconds.
- Both persistence package TypeScript builds, changed-file strict lint, formatting and
  whitespace checks passed. No lint suppression was added.

An earlier PostgreSQL rerun at the default five-second per-case deadline timed out during
child funding under concurrent native test load and reported a connection-cleanup error.
Each PostgreSQL case now has an explicit 30-second fixture deadline: cold isolated database
creation/migration and physical connection/lock checks are included. Runtime deadlines and
performance requirements are unchanged. The final complete rerun passed, including a separate
corruption case taking over five seconds. The isolated database count was zero before shutdown.

These are component proofs. Native tests demonstrate owner mutation and budget rollback in a
shared transaction; PostgreSQL binding tests exercise budget rollback and scope lifetime over
pre-existing owners. New-owner creation plus authenticated admission, immutable allocation
authorization, denial before actual runtime delivery, and supported composition activation
still require their own integrated acceptance tests.

## Remaining activation work

Source tracing identified the concrete composition sites, not just persistence adapters:

- Local accepts through `LocalControlApiComposition` in
  `apps/local-control-plane/src/local-api-composition.ts`, which constructs the SQLite
  command repository and inbox service. The separate SQLite repository in Local's
  `composition.ts` retention setup is not the acceptance instance.
- Managed Cloud accepts through `apps/control-api/src/cloud-composition.ts`.
- Hosted accepts through `apps/hosted-control-plane/src/composition.ts`; its lifecycle
  activities also construct a separate PostgreSQL inbox service.
- Managed Cloud lifecycle activities construct another inbox service in
  `apps/workflow-worker/src/cloud-composition.ts`. These worker services use an unavailable
  execution-ID factory and are not themselves the root admission route.

Wiring only the retention repository or the Managed Cloud HTTP composition would leave
other supported execution paths unactivated.

Install a concrete verifier in both durable command repositories and supported production
compositions. Join owner creation and budget opening in their existing transactions; derive
ceilings from the trusted persisted plan and record actual spending authorization. PostgreSQL
must acquire execution-retention and workspace usage locks before command/plan/owner locks.
Prove native and PostgreSQL atomic rollback, restart replay, parent capacity, and no dispatch
on denial. Per-attempt reservations, measured cost provenance, terminal reconciliation,
authorized extensions, raw-usage retention, capacity, deployed profiles, and the original
independent/manual milestone acceptance gates remain outstanding.
