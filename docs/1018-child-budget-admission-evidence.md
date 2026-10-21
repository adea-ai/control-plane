# #1018 — child budget admission: retry and compaction evidence

Refs adea-ai/control-plane#1018 (M13.04.1, part of #937). The candidate
implementation is merged: PR #1041 landed as `c5387139f`, with the follow-ups
`ba0846d5f` (#1111), `dff15411b` (#1123) and `1500ebb9c` (#1127).

This page records **which admission-budget invariant is proved by which exact
deterministic test, and with what result**. It is the evidence the issue asked
for; it is not an acceptance claim.

## 1. The limits, and the states they must hold in

A child admission is refused unless the canonical parent is running, the
parent attempt matches, the parent's current authority holds, and the parent's
stated limits admit the child. The five bounded limits are:

| Limit               | Where it is enforced                                                  | Denial code                             |
| ------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| total children      | `packages/{sqlite-persistence,database}/src/delegation-repository.ts` | `DELEGATION_LIMIT_EXCEEDED`             |
| parallel children   | same                                                                  | `DELEGATION_CONCURRENCY_LIMIT_EXCEEDED` |
| depth               | same                                                                  | `DELEGATION_DEPTH_EXCEEDED`             |
| parent/child budget | `DurableUsageLedger.openBudget`                                       | `BUDGET_EXHAUSTED`                      |
| current authority   | the allocation transaction's reader                                   | `CHILD_ADMISSION_DENIED`                |

The three states the acceptance names are **initial admission**, **retry** and
**compaction**. A retry returns the _same_ child to an active state, so it
keeps its slot; a compaction reopens the store, so the fences must survive
the reopen.

## 2. The evidence, by exact test name and result

Every command below was run on this branch's working tree with the pinned
toolchain (bun 1.4.3, node 24.21.0).

### 2.1 SQLite — deterministic, offline

`bun test src/child-budget-admission.test.mjs` in `packages/sqlite-persistence`
→ **29 passed, 0 failed, 189 assertions**.

| State                    | Exact test name                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| retry (total)            | `retrying child remains counted against the total limit when retry commits first`                    |
| retry (total)            | `sibling admission sees the active child during a paused total retry commit`                         |
| retry (parallel)         | `retrying child remains counted against the parallel limit when retry commits first`                 |
| retry (parallel)         | `sibling admission sees the active child during a paused parallel retry commit`                      |
| retry (idempotence)      | `a retried child cannot mint a second allocation, budget, or parent reservation`                     |
| retry (ceiling)          | `retry keeps the identical sibling cap and budget ceiling for the next admission`                    |
| concurrent               | `concurrent child admissions serialize parallel limits without loser allocation`                     |
| total / parallel / depth | `SQLite child admission fences preserve the parent budget across total, parallel, and depth denials` |
| total                    | `total child limit denial creates no execution, delegation, or child budget`                         |
| budget                   | `child budget exhaustion rolls back the child execution and delegation in the same transaction`      |
| authority                | `child admission transaction rolls back execution and budget when current authority denies`          |
| authority                | `child authority reads go through the allocation transaction reader and match the repositories`      |
| authority                | `an unrelated reader stays outside an open child allocation fence until it commits`                  |
| receipt                  | `child admission retains one mapping and receipt across duplicate allocation and reopen`             |
| restart                  | `an admission interrupted before the budget reservation leaves no allocation after a store restart`  |
| restart                  | `a restarted store still denies a duplicate admission request and keeps exactly one allocation`      |
| restart                  | `a refused child fence leaves no canonical rows after restart`                                       |
| restart                  | `a committed child allocation and its transaction-bound reads survive restart`                       |
| compaction (summary)     | `manual Pi compaction persists its explicit summary in SQLite`                                       |

### 2.2 Native Pi compaction — deterministic, offline

`bun test src/compaction-child-admission.test.mjs` in
`packages/pi-durable-adapter` → **1 passed, 0 failed, 37 assertions**.

| State      | Exact test name                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| compaction | `native Pi compaction preserves one canonical parent's child budget, depth, total, and parallel fences across reopen` |

### 2.3 Admission receipt, dispatch authority and recovery — deterministic, offline

| Suite                                                                    | Command (from the package root)                                  | Result                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/orchestration/src/child-admission.test.mjs`                    | `bun test src/child-admission.test.mjs`                          | **11 passed, 0 failed, 12 assertions** — the receipt pins the actor, the parent attempt, both plans, the request digest and the expiry, and rejects every changed pin                     |
| `packages/pi-durable-adapter/src/usage-authority.test.mjs`               | `bun test src/usage-authority.test.mjs`                          | **7 passed, 0 failed, 26 assertions** — dispatch reserves the full input and fences a duplicate across reopen; a second process cannot redispatch an admitted native generation           |
| `packages/pi-durable-adapter/src/recovery-races.test.mjs`                | `bun test src/recovery-races.test.mjs`                           | **23 passed, 0 failed, 193 assertions** — the recovery, cancellation and compaction-adjacent fences of the native adapter                                                                 |
| `apps/control-api/src/models/production-child-budget-admission.test.mjs` | `bun test src/models/production-child-budget-admission.test.mjs` | **4 passed, 0 failed, 33 assertions** — the production preflight pins the current actor, the parent product selection and the ready child model, and fails closed when any is unavailable |

### 2.4 PostgreSQL — a NATIVE gate

`bun test src/child-budget-admission.integration.test.mjs` in
`packages/database`, with `RUN_DATABASE_INTEGRATION=true` and the three
credential roles, against a disposable isolated database →
**4 passed, 0 failed, 52 assertions**.

| State                  | Exact test name                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| authority + concurrent | `denials leave no allocation and concurrent requests serialize the parallel limit`          |
| total                  | `the total child limit denies the admission and leaves no allocation on PostgreSQL`         |
| depth                  | `the depth limit denies the admission and leaves no allocation on PostgreSQL`               |
| retry                  | `a retried child keeps its parallel slot and cannot mint a second allocation on PostgreSQL` |

Without `RUN_DATABASE_INTEGRATION=true` this suite is **skipped**, not passed:
`0 passed, 1 skipped, 0 failed`. A green run of the offline suites never
qualifies this gate.

## 3. What was missing, and what this pass adds

The SQLite and native-compaction surfaces already proved the retry and
compaction invariants, including the paused-commit races. The **PostgreSQL
store did not**: it proved only the authority denial and the concurrent
parallel limit, so three limit dimensions were unproved on the production
(hosted) store even though the implementation enforces all of them
(`packages/database/src/delegation-repository.ts`).

This pass adds the three missing focused regressions to
`packages/database/src/child-budget-admission.integration.test.mjs` — the
**total** limit denial, the **depth** limit denial, and the **retry** that
keeps the parallel slot without minting a second allocation. The retained
native test is unchanged: its assertion block is byte-identical, and only the
setup moved into the shared `withAdmissionFixture` helper, which still
disposes the isolated database on every path.

Each new regression was **mutation-verified** against the real implementation:
removing the total-limit denial fails only the total regression, removing the
depth-limit denial fails only the depth regression, and dropping the retried
child from the active states fails the retry regression (and the concurrent
one). The implementation file was restored after each check and is not part
of this change.

## 4. Qualification boundary

- These are **offline and native-local** results. They qualify the
  admission-budget invariants on the SQLite store, the PostgreSQL store and
  the native Pi compaction path. They do **not** qualify hosted deployment,
  a live provider, a live device, a migration or a release.
- The compaction qualification uses the **faux** provider and synthetic
  authority, inference and settlement callbacks: it covers the retained
  production adapter mapping and the separate control-plane persistence, and
  it does not qualify production child-tool dispatch or the current-grant
  reader (PR #1127's stated boundary, unchanged here).
- The PostgreSQL run uses a disposable isolated database created by
  `createIsolatedTestDatabase`; no operator database is touched and no
  production data is read or written.
- The issue's own acceptance checkboxes stay **open**. Root reviews the
  published head; this page is evidence for that review, not a claim that
  #1018 is complete.
