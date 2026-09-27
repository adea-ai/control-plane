# M11 PostgreSQL hold activation checkpoint

Decision: **not accepted**. This is partial implementation and regression
evidence for #194, not operational or whole-milestone signoff. The source base
is released main `622f90cecd4c2923abccc8b68a6b540f0ea78bf9` plus the durable-hold
foundation and canonical PostgreSQL migration `0050_woozy_zarek`.

## Implementation

The thirteen PostgreSQL assessment/deletion hold facts now read validated
durable holds. Physical deletion acquires the shared class advisory mutex
before target/owner row locks and reads holds inside that transaction before
journaling or deletion. Scope comes from canonical stored owners and validated
context/plan identities. Raw database identifiers are schema-validated before
matching; receipt request identifiers are used only after exact owner equality.
An omitted hold policy is permitted only with an empty hold namespace.

Holds do not reset reference-observation clocks. Plans and context packages
continue observing reference release while held, so releasing a hold does not
manufacture a new retention window.

Review found an inbox lock inversion and candidate-budget accounting defects.
Command retirement now discovers ownership without locking the command, locks
the execution, then re-reads and claims the command and checks owner identity.
Candidate admission is separate from eligibility accounting: vanished/raced
rows consume the shared scan budget without an invented retention reason.
Messaging and receipt subpasses share the remaining candidate budget. Existing
assessment callers retain the combined `add(verdict)` operation.

## Observed checks and limits

- The initial fresh dependency-closure build failed on a partial context row
  passed to the full integrity decoder and raw IDs assigned to a branded
  receipt scope. Both were traced and corrected without casts or weaker
  validation; subsequent database builds passed.
- After integration with the draft's SQLite guards, fresh domain, database and
  SQLite package builds all passed. The sixteen PostgreSQL/domain source,
  fixture and checkpoint files were verified byte-identical to the tested
  implementation commit `21fbe4b8f6606e0603df1e0cd4133c0b4fdc64e5`.
- Domain hold/reference/eligibility tests: **35 passed, 90 assertions**. Two new
  candidate-accounting tests failed before the new counter API was implemented.
- Canonical-migration PostgreSQL hold foundation, reference-window and ancestry
  integration: **16 passed, 113 assertions** before the accounting fixes.
- Existing physical retention/reapplication regressions: **18 passed, 148
  assertions** both before and after the accounting/retirement fixes. These are
  selected regressions (43 other shared integration cases filtered), not the
  complete database or workspace suite.
- New physical hold, lock-order and budget integration: **7 passed, 48
  assertions**. The lock/budget regression run first failed all three cases:
  PostgreSQL `55P03` while retirement held a command and waited for its owner;
  a second outbox deletion after a raced first candidate despite bound one;
  and two class-mutex queries with bound zero. All three pass after the fixes.
  Both contention cases passed again after cleanup was changed to await every
  transaction and preserve assertion and cleanup failures together (two tests,
  ten assertions). No deadline or assertion was relaxed.
- Physical hold coverage includes plans, context packages, evaluations, release
  audit records and messaging, exact journal operations after release,
  cross-project isolation and missing-policy/malformed-record fail-closed checks.
  A real hold repository writes in a parent transaction, the actual context
  deletion path waits on its advisory mutex, and after commit deletion reads the
  newly committed hold and retains the target. This is not a test-only target.
- Scoped formatting, lint and diff checks pass; lint retains one pre-existing
  caught-error warning in execution-plan reference retry handling. Bounded
  independent source review found the two production defects above and found
  no additional blocker in their fixes. This is not the final security or human
  acceptance review.

Tests use isolated databases migrated through the canonical chain and the
application role. No production or staging mutation is part of this checkpoint.
Local tests do not prove deployment or host/operator authorization.

## Remaining gates

Physical hold activation tests for events, command inbox, runtime ledgers,
executions and interaction/cancellation receipts remain required. Current-head
whole-package/workspace validation, CI and released activation remain required;
the prior full SQLite package failures are not superseded by these PostgreSQL
results. Host owner/session authorization and operator policy composition,
released-hold disposition, independently durable hold/delete-outcome restore
reconciliation, all remaining durable classes and provider deletion coordination
are incomplete. Original supported-profile/runtime/provider, security/evaluation,
native-document and independent-human acceptance gates remain unchanged.
