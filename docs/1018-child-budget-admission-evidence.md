# #1018 — child budget admission: retry and compaction evidence

Refs adea-ai/control-plane#1018 (M13.04.1, part of #937). The candidate
implementation is merged: PR #1041 landed as `c5387139f`, with the follow-ups
`ba0846d5f` (#1111), `dff15411b` (#1123) and `1500ebb9c` (#1127).

This page records **which admission-budget invariant is proved by which exact
deterministic test, and with what result**. It is the evidence the issue asked
for; it is not an acceptance claim.

The issue names two acceptance items, and both are covered here:

- _transactionally reserve child/descendant budgets with depth, concurrency and
  authority limits_ — §1 lists the five bounded limits, §2.1 and §2.4 give the
  per-store proofs, and §2.5 gives the transactional production reservation and
  the worker-side allowance;
- _prove concurrent admission, retry and compaction behaviour with deterministic
  race tests_ — §2.1 (SQLite, including the paused-commit races), §2.2 (native
  compaction) and §2.4 (PostgreSQL) give the three named states.

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

Every one of the five limits is now proved on the SQLite store **and** on the
PostgreSQL store; §2.1 and §2.4 state the exact per-store coverage, and §2.2
covers the compaction state on the native path.

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
**5 passed, 0 failed, 60 assertions**.

| State                  | Exact test name                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| authority + concurrent | `denials leave no allocation and concurrent requests serialize the parallel limit`          |
| total                  | `the total child limit denies the admission and leaves no allocation on PostgreSQL`         |
| depth                  | `the depth limit denies the admission and leaves no allocation on PostgreSQL`               |
| budget                 | `the child budget limit denies the admission and leaves no allocation on PostgreSQL`        |
| retry                  | `a retried child keeps its parallel slot and cannot mint a second allocation on PostgreSQL` |

All five bounded limits are now proved on the production (hosted) store as
well as on SQLite: the authority fence (case 1) rolls the admission back and
leaves no allocation, the parallel limit serializes concurrent requests (case
1), and the total, depth and budget limits each deny the admission and leave
no allocation (cases 2–4). The retry state is proved by case 5. The
authority case proves the **rollback and the absence of an allocation**; the
denial code it surfaces is the caller's own authority error, which the
repository propagates unchanged.

Without `RUN_DATABASE_INTEGRATION=true` this suite is **skipped**, not passed:
`0 passed, 5 skipped, 0 failed`. A green run of the offline suites never
qualifies this gate.

### 2.5 The production reservation and the worker-side allowance

The issue's first acceptance item — _transactionally reserve child/descendant
budgets with depth, concurrency and authority limits_ — is carried by two
further proofs, both measured on this branch:

| Proof                                                                                                   | Command                                                                                      | Result                                 | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/control-api/src/pi-durable/production-child-bridge.ts`                                            | `bun test src/pi-durable/production-child-bridge.test.mjs` in `apps/control-api`             | **38 passed, 0 failed, 57 assertions** | the production bridge **reserves, derives the binding, then funds that reservation, in that order**, and **records the estimate and the reservation as cost state before the binding and the funding**; cost state that cannot be recorded derives no binding and funds nothing; a refused reservation derives no binding and funds nothing; a binding that cannot be derived funds nothing; a refused funding record fails the reservation step, so nothing starts; and the composition authority is re-read for the exact child execution and attempt |
| `tests/pi-durable-production-child-bridge-recovery.test.mjs`                                            | `bun test tests/pi-durable-production-child-bridge-recovery.test.mjs`                        | **13 passed, 0 failed, 19 assertions** | the production builder **recovers a lost session mapping without start, reservation or funding**, records progress and replays terminal publication exactly once, and refuses a revoked receipt read authority on recovery and starts nothing                                                                                                                                                                                                                                                                                                           |
| `apps/workflow-worker/src/child-runtime-budget-admission.integration.test.mjs` (PostgreSQL, disposable) | `bun test src/child-runtime-budget-admission.integration.test.mjs` in `apps/workflow-worker` | **4 passed, 0 failed, 30 assertions**  | the worker-side allowance against the real store: an omitted allowance can fund from a settled lead reservation while its attempt is still running; after the lead reservation settles while its attempt remains running, funding and spend stay bounded for siblings; the child admission binds the parent plan statement the allocator funded under; and once the lead is cancelled the allocator refuses before any funding is considered                                                                                                            |

Together with §2.1–§2.4, both acceptance items of #1018 are covered on this
branch: the five bounded limits and the three named states on the durable
stores, and the transactional production reservation with the worker-side
allowance. The native and hosted-deployment gates in §4 stay open.

### 2.6 Where the transaction is

The issue's first acceptance item asks for the reservation to be
**transactional**, so the page records the two transactions that carry it.

**On the admission side**, the child's budget is opened **inside the
delegation allocation transaction**, together with the limit checks and the
child execution, attempt and delegation rows. In
`packages/database/src/delegation-repository.ts` the total limit is refused at
line 176, the parallel limit at line 188 and the depth limit at line 211, and
the budget is opened at lines 250-251 through
`PostgresDurableUsageStore.withTransaction(transaction, …)` before the
delegation row is written at line 266 — one transaction, so a refused limit
leaves no execution, attempt, budget or delegation row. The SQLite store has
the same shape (`packages/sqlite-persistence/src/delegation-repository.ts`:
lines 372, 384, 407 and the budget open at line 433).

**On the production reserve side**, `DurableChildRuntimeBudgetAdmission.#reserve`
(`apps/workflow-worker/src/child-runtime-budget-admission.ts:58`) runs its
whole body inside one durable-usage transaction
(`this.#store.transaction(workspaceId, …)`, line 111). Inside that single
transaction it re-reads the facts its reservation depends on and denies —
without writing — if any of them does not hold:

1. the stored parent plan is missing, or its workspace or digest does not match
   the child's parent binding (lines 91-97);
2. the child budget, the opening effect or the parent budget cannot be read
   (line 126);
3. the child budget is not open, is not in the plan's currency, exceeds the
   plan's ceilings, or is not parented by the recorded parent execution
   (line 140);
4. the parent's funding reservation for this child does not exist exactly
   once, is not open, or does not match the funded amount exactly (line 152);
5. the opening credit entry does not exist exactly once, or does not match the
   opening expectation (line 162);
6. the opening effect's fingerprint does not match the recomputed
   `openingFingerprint` (line 100), or its result does not match the opening
   summary (line 187).

Only then, still inside the same transaction, is the attempt envelope
reserved (`reserveAttemptEnvelope`, line 189). The reservation and every fact
that justifies it therefore commit together, and a mismatch commits nothing.

`apps/workflow-worker/src/child-runtime-budget-admission.integration.test.mjs`
drives this path against the real store: an omitted allowance can fund from a
settled lead reservation while its attempt is still running; after the lead
reservation settles while its attempt remains running, funding and spend stay
bounded for siblings; the child admission binds the parent plan statement the
allocator funded under; and once the lead is cancelled the allocator refuses
before any funding is considered.

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

A later increment closes the one dimension that was still unproved on the
hosted store: the **parent/child budget** limit. It adds a fourth focused
regression, `the child budget limit denies the admission and leaves no
allocation on PostgreSQL`, and the fixture takes the parent's own budget as a
parameter so the case can open a parent that cannot fund a child. The denial
is `BUDGET_EXHAUSTED` from `DurableUsageLedger.openBudget`, and it is raised
**inside the allocation transaction, after the child execution and attempt
rows are written** — so the case also proves that the budget fence rolls
those rows back, leaves no delegation and no child budget, and leaves the
parent's reservation list empty.

Each new regression was **mutation-verified** against the real implementation:
removing the total-limit denial fails only the total regression, removing the
depth-limit denial fails only the depth regression, and dropping the retried
child from the active states fails the retry regression (and the concurrent
one). The budget regression was verified the same way: with the budget
refusal in `packages/database/src/delegation-repository.ts` no longer refusing
the admission, **only the budget regression fails** (4 passed, 1 failed) and
the other four cases still pass, so the case is load-bearing and duplicates
none of them. The implementation file was restored after each check and is not
part of this change.

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
