# M11 native plan-budget admission checkpoint — 2026-09-27

This is partial M11.3 implementation evidence, not milestone completion or
production deployment proof. The original seven open issues and all profile,
security, evaluation, operations, documentation and independent acceptance gates
remain in force.

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
