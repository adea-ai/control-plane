# M11 standard-runtime attempt reservation

## Requirement and candidate

This implements the existing usage activation audit's decision 5: reserve a
deterministic money/token envelope before external dispatch. It is a prerequisite
for #187 portable usage activation and #194 safe settlement/retention, not their
full acceptance. The base is `0c07f3fa168b67b7b778bebddec94f7afcde9278`.
The earlier seven-file source trace found read-only standard-runtime preflight
and retained terminal usage without reservation or terminal accounting.

## Behavior and composition

`DurableRuntimeBudgetAdmission.authorize()` stays read-only. Its new `reserve()`
validates the accepted command and immutable plan against the execution snapshot
supplied by the lifecycle activity. Opening entry, receipt, budget and full ledger
history are validated inside one usage-store transaction, which then reserves the
remaining funded money/token authority. The activity checks the latest attempt
and actual attempt owner before entering that transaction; these are separate
repository reads, not one cross-store atomic claim. A child's actual allowance can be
clamped below the requested plan ceiling. Replay uses the original reservation
amounts and effect identity, not the now-reduced available balance. An exhausted
nonzero dimension, changed/corrupt identity, or settled reservation fails closed.
Budget, reservation entry and replay receipt commit or roll back together.

The native and PostgreSQL attempt writers now treat an open `runtime-attempt`
reservation as a durable dispatch fence. Attempt creation checks the validated
ledger in its existing transaction; PostgreSQL acquires the execution-retention
mutex, then workspace usage lock before owner/budget rows, matching reservation.
The usage-store entry writer checks the current latest attempt for new runtime
reservations under that same serialization. If reservation wins, supersession is
rejected until explicit settlement; if attempt creation wins, the older attempt
cannot reserve. Execution compare-and-set and PostgreSQL event transitions cannot
change the latest-attempt pointer through an alternate writer. No database
transaction is held across the RuntimeAdapter call. Missing budget state with
remaining ledger entries or the runtime receipt fails closed into reconciliation.
A surviving runtime receipt also fences a schema-valid budget restored without
its reservation; a partial restore cannot establish that dispatch never occurred.

Standard dispatch and interaction resume select the reservation operation before
calling the RuntimeAdapter activity port. Graph preflight stays read-only because
graph operations own their funding. Cancellation and cleanup remain available
without spend admission. Existing authorizer-only injected ports retain their
preflight compatibility; these fixtures are not reservation certification.

Local, Simple, hosted PostgreSQL and Cloud worker composition roots already
install this adapter, so the class operation is reachable without adding an
unused service or changing configuration. Actual profile regressions inspect the
committed reservation inside the runtime callback and compare replay state.
PostgreSQL also uses independent rebuilt compositions concurrently against the
same isolated execution owner.

## Executed focused evidence

- Six new behavioral checks failed against the original code: the reservation
  method was absent, dispatch proceeded without it, and reservation denial did
  not prevent work. After implementation, both focused files passed: 27 tests,
  112 assertions, 0.259 seconds of helper elapsed time. After the supersession
  repair below, the final focused run passed 29 tests/118 assertions in 0.253s.
- Two additional regressions created a newer lifecycle attempt while reservation
  waited. Dispatch and interaction reached the runtime on the older snapshot
  before the repair; a fresh owner read after reservation now rejects both. The
  reservation remains retained for reconciliation. The later shared durable fence
  addresses supersession after that read for supported native/PostgreSQL writers.
- The remaining-authority regression failed when the code attempted to reserve
  the whole original budget after another consumer; it passed with the actual
  remaining envelope. Full original allowance remains checked at preflight.
- A real native SQLite store, command/plan/context/attempt records and durable
  ledger prove concurrent reservation and reopen converge on one reservation.
  This is store/component evidence, not whole deployed-profile acceptance.
- Three real native-store fence cases failed before the shared fence: reservation
  first still permitted supersession, attempt first still permitted the stale
  reservation, and concurrent calls both succeeded. They now pass, including
  reopen, no orphan attempt, alternate compare-and-set rejection, exact replay,
  and explicit synthetic known-no-effect settlement. A fourth missing-budget
  corruption case reproduced accidental fence release and now fails closed.
- The receipt-without-reservation regression reproduced supersession after a
  partial native restore: the budget and initial entries remained valid, while
  the dispatch receipt survived. It now rejects attempt creation after reopen,
  preserving the old owner and leaving no orphan attempt.
- The final current-source focused run passed 65 tests/301 assertions across five
  runtime admission, lifecycle activity, durable ledger and native usage-store
  files in 0.527s helper elapsed time. Native fence tests live in the SQLite
  package and use its declared dependencies. A 67KB usage source bundle and cached
  dependency overlay were removed in `finally`; native fixtures were sequential.
- PostgreSQL contention, both orderings, alternate event/CAS writer rejection and
  explicit settlement are covered by a new case using the existing isolated
  fixture. This case has not executed locally; actual current-head CI is required.
- Local/Simple composition execution was attempted with fresh small source
  bundles and cached dependencies, but stale cached memory/SQLite exports stopped
  module loading before cases ran. Those attempts are not passes. Source
  bundles, links and fixture roots were removed. No further local composition
  attempts or dependency installs are used; current-head remote CI must execute
  the updated composition tests after a complete current build.

Scoped formatting, lint and cached Code Foundry doctor checks passed. Independent
Standards review identified the cross-store claim above; this evidence now states
the actual boundary. A normal commit hook hit its 20-second guard during the
dependency build and was stopped with all owned outputs and links removed. No
commit or pull request was created by that attempt. A second normal hook, guarded at 40 seconds and 60MiB, completed all 44 build
tasks (33.647s), migration-schema and compatibility checks, then timed out during
GitHub-backed requirements validation. Its peak checkout was 47,476KiB; outputs
and links were removed. The full type-check/hook is not a pass, and no commit was
created. Those reviews identified the post-read/pre-dispatch gap and prompted the shared
fence above. Fresh source reviews of the expanded candidate found the surviving
receipt gap; its repair and native test relocation are under final review. No
commit/PR exists yet. PostgreSQL/profile execution, full hook/type-check and broad
acceptance remain unverified; local Docker remains untouched.

## Remaining gates

Reservation represents allocation, not a provider charge, purchased/prepaid funds
or a measured cost saving. Exact trusted terminal pricing/funding attribution,
runtime enforcement of the allocated envelope, terminal reconciliation and
settlement, acknowledged recovery-reference release, 400-day history compaction,
aggregate/sequence preservation, payload-free replay fences, hold/restore
coordination, actual provider/deployment evidence and independent acceptance
remain required. The shared fence needs actual PostgreSQL contention and profile
acceptance before its cross-substrate dispatch guarantee is accepted. Its
protection ends after explicit settlement, so safe trusted reconciliation remains
a required terminal-accounting gate. Unknown usage/cost must
never be fabricated as zero. No retained
payload is removed, and no retention window or deletion authority is created.

All 12 milestone issues and 114 original acceptance items remain in scope.
