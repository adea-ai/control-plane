# M11 runtime allowance preflight — 2026-09-27

This checkpoint is partial M11.3/M11.9 progress, not milestone completion,
provider spend enforcement or deployment certification. Original issues #188,
#190, #191, #194, #195, #196 and #197 remain open.

## Implemented boundary

`DurableRuntimeBudgetAdmission` verifies the recorded acceptance against the
immutable execution plan, current execution/attempt identity, open durable
budget tree, canonical opening credit and original opening receipt fingerprint.
Ledger tree, entries, budget and receipt reads share one underlying workspace
transaction. This preflight writes nothing: it does not create another budget,
reserve capacity, charge a provider or settle an execution.

Root allowance maxima must match the plan. Child maxima may be legitimately
clamped by available parent capacity; the original receipt fingerprint still
binds the requested plan allowance. Neither the allowance credit nor its receipt
means payment was received.

The shared lifecycle gates dispatch, interaction continuation and graph
run/resume/continue before their delegated effects. It reloads the current
execution and immutable plan and checks the actual durable attempt owner.
Cancellation and cleanup do not require spend admission. The injectable seam
remains optional for standalone component fixtures, but the actual Local,
Hosted-simple, Hosted-server and Cloud worker composition roots supply the
concrete guard using their own SQLite/PostgreSQL stores and command repositories
on their default activity paths. Local's explicit custom-activities injection
replaces those defaults; the caller then owns admission enforcement.

Missing historical allowance state fails closed; this is not an automatic
backfill or permission to re-fund an already-running execution. Operators must
reconcile historical ownership, usage and unresolved effects before activation.

## Verification

Source candidate: `1904df5fa611089915050011454bbe54154f449f`, including shared
implementation `6fcec5ba` integrated from bounded Luna commit `88e5b9f3`.

- Before the guard, the actual Local and Hosted-simple constructor paths allowed
  runtime starts with missing command, missing budget or settled budget:
  behavioral RED was 2 passed / 6 failed / 10 assertions. This used real SQLite
  and filesystem storage with a controlled runtime callback, not a live provider.
- After integration, the native composition regression passed 14 tests / 38
  assertions. Missing/mismatched opening evidence is rejected with zero runtime
  starts; valid dispatch and close/reopen replay preserve one start.
- Shared focused tests passed 13 tests / 66 assertions, covering one read-only
  transaction, parent-clamped child allowance, damaged opening evidence,
  attempt identity, interaction and all three graph hooks, and available
  cancellation/cleanup despite denial.
- Fresh affected dependency closure build: 36 successful / 36 total, 0 cached.
- Combined Local, Hosted and workflow-worker suites: 216 passed / 0 failed /
  13 skipped / 924 assertions across 36 files. The skipped PostgreSQL-backed
  Hosted integration cases are explicitly unverified, not acceptance passes.
- Changed-code strict lint, formatting and whitespace checks pass. SDK
  compatibility, architecture (41 packages / 16 operations / 4 profiles), live
  GitHub-backed requirements (200 requirements / 103 issue audits), boundaries
  (1,506 files / 41 packages) and canonical ordering checks pass.
- Independent bounded Luna review of `9dbc9005` through `1904df5` found no
  actionable introduced defect in admission, identity binding or composition.
  The reviewer ran no tests; this is not the independent final milestone audit.

Reproduce the affected verification from the repository root:

```sh
bun run build --filter=@control-plane/local-control-plane... --filter=@control-plane/hosted-control-plane... --filter=@control-plane/workflow-worker...
bun test ./apps/local-control-plane/src/runtime-budget-admission.test.mjs
RUN_DATABASE_INTEGRATION=false bun test ./apps/local-control-plane/src/*.test.mjs ./apps/workflow-worker/src/*.test.mjs ./apps/hosted-control-plane/src/*.test.mjs
bun run compatibility:check
bun run architecture:check
bun run requirements:check
bun run check:boundaries
bun run check:canonical-ordering
```

The first worker build encountered stale workflow-runtime declarations; rebuilding
that dependency resolved it. One premature root test attempt encountered an
unbuilt export before integration; it was not behavioral RED. Both are separate
from the recorded before/after runtime regression.

## Remaining acceptance

Admission is a read-only check, not a serialized reservation held across a
runtime effect. Per-attempt/provider-effect reservations, parent/child capacity
allocation, trusted provider/funding provenance, exact charges, unknown-cost
holds, terminal settlement and approved extensions remain unfinished. Raw
runtime accounting metadata must not authorize HQ charges or zero-cost settlement.

This checkpoint does not certify live PostgreSQL runtime admission, Railway,
Restate, a real model/provider, E2B, whole-process recovery, deployed ACP/graph
execution, capacity/retention/restore or independent human acceptance. No issue
closure, staging wake, production deployment or merge is implied.
