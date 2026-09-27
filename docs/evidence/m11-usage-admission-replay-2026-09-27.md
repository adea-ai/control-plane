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
- The domain TypeScript build, changed-file formatting, strict changed-file lint, and
  `git diff --check` passed.

These are actual domain service tests with an in-memory repository verifier, not proof of
authenticated SQLite/PostgreSQL acceptance, durable funding, or runtime denial.

## Remaining activation work

Install a concrete verifier in both durable command repositories and supported production
compositions. Join owner creation and budget opening in their existing transactions; derive
ceilings from the trusted persisted plan and record actual spending authorization. PostgreSQL
must acquire execution-retention and workspace usage locks before command/plan/owner locks.
Prove native and PostgreSQL atomic rollback, restart replay, parent capacity, and no dispatch
on denial. Per-attempt reservations, measured cost provenance, terminal reconciliation,
authorized extensions, raw-usage retention, capacity, deployed profiles, and the original
independent/manual milestone acceptance gates remain outstanding.
