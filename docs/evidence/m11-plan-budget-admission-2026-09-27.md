# M11 plan-budget admission checkpoints — 2026-09-27

This is partial M11.3 implementation evidence, not milestone completion or
production deployment proof. The original seven open issues and all profile,
security, evaluation, operations, documentation and independent acceptance gates
remain in force.

## PostgreSQL and supported composition activation

The later PostgreSQL implementation acquires execution-retention and workspace
locks before command/plan/owner locks, uses READ COMMITTED, and hydrates the
canonical stored plan inside the acceptance transaction. Command, owner and
allowance commit together. Duplicate and public verification validate the
recorded owner, accounting and original opening receipt without re-funding or
reloading a retired plan. Cloud API, Hosted acceptance/lifecycle and Cloud worker
command compositions now enable admission; compatibility repositories remain
opt-in. Accepted historical owners with missing accounting fail closed, not an
automatic backfill. Operators must reconcile those owners before activation.

The API maps exhausted capacity to 422, settled allowance to 409, and internal
accounting failures to a generic 503 while retaining the internal error cause.
The new test is included in the existing Control API integration command.

Fresh verification against the owned local PostgreSQL fixture, with separate
application, migration and administration roles and canonical migrations:

- PostgreSQL admission and signed Cloud-composition HTTP: 6 passed, 0 failed,
  44 assertions across two files. This covers one allocation, concurrent
  acceptance over separate connections, exhausted-child rollback, parent-project
  isolation, missing/corrupt accounting, authenticated scope denial, stored-plan
  ceilings despite request-supplied limits, no submission after denied admission,
  cold API replay after plan deletion and damaged opening-receipt rejection.
- The HTTP fixture uses the real Cloud composition and in-process Fastify HTTP
  injection with a mock Restate ingress, not a deployed workflow runtime.
- New native admission tests: 9 passed, 0 failed, 30 assertions. Independent-file
  connections exercise SQLite BUSY handling and retry; other cases cover atomic
  rollback after receipt-write failure, missing/corrupt replay, settled-active
  owner rejection, child scope/exhaustion and positively clipped child allowance.
- Full SQLite and Local package test commands pass; full Local records 77 passed,
  0 failed, 442 assertions. Control API, Hosted and worker package test commands
  pass; database-gated tests skipped by those ungated commands are not acceptance
  proof. Worker records 66 passed, 0 failed, 249 assertions.
- Database, Control API, Hosted and worker TypeScript builds pass. Changed-code
  strict lint, formatting, whitespace and frozen-lockfile installation pass.

The first signed HTTP run exposed an incorrect fixture assertion: empty credential
scopes are malformed (401), whereas a valid token with another scope is forbidden
(403). The next run exposed a mock Restate response missing its required status
and invocation ID. Both fixtures were corrected; production verification was not
weakened. A diagnostic rerun retained that second failure before correction.

No deployed Hosted/Cloud runtime, funding/charge provenance, per-attempt capacity
reservation, terminal settlement, extension policy, usage-retention/aggregate
fences, restore/capacity certification or independent human acceptance is proven
by this checkpoint. No staging/production deployment, issue closure or merge.

## Prior native checkpoint (historical)

## Policy and implementation

`accepted-plan-budget-allocation.v1` authorizes an execution allowance through
trusted recorded acceptance. It does not establish prepaid funds or provider
charges. The integrity-checked stored plan supplies money/token ceilings;
request JSON cannot increase them. Source identity binds actor, command, payload,
owner, plan pin and parent, independently of mutable lifecycle metadata.

SQLite admission opens the allowance after inserting command, owner and command
index within the same provider transaction. Parent linkage requires the same
workspace/project and matching parent plan pin. Ledger failure rolls back that
transaction. Duplicate and public replay verification read canonical stored
records, validated accounting and the original opening credit/receipt; missing
accounting fails closed rather than silently re-funding a historical owner.

The actual Local API composition enables admission. PostgreSQL repository
activation and Cloud/Hosted composition verification are not implemented in this
published native checkpoint. Uncommitted app integration experiments are not
deployment evidence.

## Verification

- Execution-plan package: 28 passed, 0 failed, 113 assertions; build and strict lint pass.
- Usage-ledger package: 23 passed, 0 failed, 99 assertions; build and strict lint pass.
- Bounded Luna native regression: 1 passed, 4 assertions; SQLite build passes.
- Root full SQLite package: 175 passed, 0 failed, 1,117 assertions across 27 files, 18.26s.
- Root actual Local composition regression: 1 passed, 0 failed, 43 assertions.
  It checks approval denial leaves no command/owner/budget, accepted plan ceilings,
  one opening entry, replay after close/reopen without duplicate allocation,
  and missing-budget rejection.
- Root SQLite and Local package TypeScript builds and strict changed-code lint pass.
- Root full Local package: 77 passed, 0 failed, 442 assertions across 16 files, 4.08s.

The Local regression first reproduced accepted ownership with zero budget records
on the old repository. After integration, an incorrectly placed cold-replay block
failed before the fixture initialized its reopened composition. Moving that
block after actual close/reopen corrected the test; production schema, policy
and accounting behavior were not weakened.

## Remaining gates

Native child exhaustion/cross-project rollback, duplicate races, receipt damage
and settled-owner coverage need broader admission-specific tests. PostgreSQL
admission needs retention-first prelocks, canonical plan hydration and real
database integration proof. Authenticated dispatch denial, per-attempt money and
token reservation, all terminal outcomes with explicit funding/cost provenance,
retention/aggregate replay fences, capacity and all supported live profiles remain
required. Missing usage/cost must not be settled as zero.

No staging or production deployment, issue closure or merge occurred. Owned local
PostgreSQL stayed stopped. The bounded worker and all recorded test runners must
be settled before handoff; unfinished worktrees and the local database volume are
preserved for the continuing milestone.
