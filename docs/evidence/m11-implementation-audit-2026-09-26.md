# M11 implementation audit checkpoint — 2026-09-26

Decision: **not accepted**. This is an implementation audit checkpoint, not the
independent frozen-candidate release report required by #197.

## Scope and baseline

The reviewed baseline is `b3fe4b6af7eca85a6720be54cfa4b7b158cf26ab`
(1.58.1). The substantial merged catalog-approval and retention increments are
present. Approval policy is ratified in #188: execution-time gating, default
off, with the production cutover `2026-09-25T00:00:00.000Z`. That decision is
resolved; this audit does not ask the owner to ratify it again.

Live GitHub milestone 11 has nine closed and seven open issues: #188, #190,
#191, #194, #195, #196, #197. The requirement inventory contains 200 rows and
103 linked issue audits. Neither issue counts nor component tests establish
completion. The unrelated marketplace edits in the primary checkout were
preserved; this audit uses isolated worktrees.

## Confirmed defects

All findings are owned by the M11 implementation agent and are due before M11
release approval; no calendar release date is ratified. Regressions and repair
status are recorded below and in draft PR #740. Outstanding high-severity
findings are release blockers, not accepted deferrals.

| Severity | Finding                                                                                                                                      | Owner and acceptance condition                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Hosted validation does not receive its configured catalog approval gate.                                                                     | M11 implementation agent, #188/#190: prove validation denies an unapproved pin when enabled.                                                         |
| High     | A historical stored plan can authorize a new execution without current version eligibility checks.                                           | M11 implementation agent, #188/#190: revalidate current pinned lifecycle/digest/approval at new acceptance while preserving already-accepted replay. |
| High     | Receipt deletion treats the owner as terminal without reading it; removing an unresolved cancellation permits reconciliation to resume work. | M11 implementation agent, #194: retain unresolved intent, use terminal reconciliation plus the replay window, prove both backends.                   |
| High     | Plan/package retention and PostgreSQL execution deletion use stale reference snapshots; concurrent writers can create dangling references.   | M11 implementation agent, #194: coordinate all reference writers and deletion claims atomically, with deterministic interleaving regressions.        |
| High     | Plan/package expiry uses compilation time instead of the ratified 90-day interval after the last reference is released.                      | M11 implementation agent, #194: persist a conservative release-time anchor and prove renewed references reset the interval.                          |
| High     | No durable owner hold state is consulted; deletion supplies `holds: 0`.                                                                      | M11 implementation agent, #194: durable scoped holds and atomic hold checks at physical deletion, including concurrent hold creation.                |
| High     | Restore journal operations are not bound to their declared class/backend.                                                                    | M11 implementation agent, #194: reject mismatched operations before any restored data is mutated.                                                    |
| Medium   | SQLite checks sweep bounds after journalling/deletion; compound receipt and messaging sweeps reset the bound per half.                       | M11 implementation agent, #194: admit before mutation and enforce one total class bound; assert remaining rows and journal count.                    |
| Medium   | Approval CLI accepts an input principal/authority as if authenticated.                                                                       | M11 implementation agent, #188/#190: record actual operator-session provenance, not a caller's claimed product principal.                            |

The journal and attribution findings concern trusted privileged operator input;
they are not evidence of an unauthenticated remote exploit. The approval
bypasses concern real new-execution authorization paths. Fixes need current-head
regression evidence before these findings can be closed.

## Repair checkpoint

Draft implementation PR [#740](https://github.com/adea-ai/control-plane/pull/740)
includes current main `e70f279dc2b63e2507cd14db781d42cfe849123e`
(release 1.58.2 and marketplace PR #738). Its approval increment rechecks current catalog
pins and configured approval at new acceptance in the API, Hosted and Local
compositions. Historical accepted-command and validation replay remain exempt
from recompilation. The Local and Hosted validation services now receive the
configured gate. The increment passed 94 focused tests across seven files and
31 scoped build tasks; independent agent review found no current production
acceptance bypass. Its requested composed acceptance-before-persistence regression
was subsequently added and passed after 35 parent dependency build tasks: one
test, 34 assertions. It proves missing approval leaves zero command/execution
records, matching approval permits admission, and approval removal preserves the
original accepted replay with exactly one durable command/execution. This later
run is separate from the earlier 94-test increment count. These are
implementation checks, not independent human release acceptance.

The journal increment rejects class/backend/namespace mismatches before replay
mutation. Its scoped checks passed 16 root tests and 141 domain tests. Operator
administration now records the actual OS/database session identity; nine focused
tests and a real PostgreSQL session-authority check passed. Shared OS/database
accounts still share operator attribution; no product-user authentication is
claimed.

Bound admission now precedes journal/mutation and receipt/messaging sweeps use
one shared counter. After rebuilding dependencies, the parent integration
passed 38 focused retention tests (141 assertions). The receipt lifecycle repair
is integrated: exact owner/interaction/attempt linkage, terminal settlement and
latest attempt/checkpoint/event times are checked inside the deletion
transaction. Parent validation passed 18 SQLite tests (66 assertions) and four
focused PostgreSQL tests (32 assertions, including the metadata probe below).
Independent review found cross-execution attempt linkage and SQLite JSON/key
identity gaps; targeted red regressions reproduced them and the corrected cases
now retain those receipts. Atomic plan/package claims and the separate
PostgreSQL execution-deletion/new-receipt writer race remain in progress. A full
integrated candidate suite, current-head CI and deployment verification have not
yet been completed.

Post-reference window storage foundation: nullable PostgreSQL clocks and a pure
conservative clock helper are prepared. Six helper tests (14 assertions), the
domain build and migration/schema check passed. One real isolated PostgreSQL
probe (seven assertions) verified migration/defaults and that metadata updates
leave immutable plan/package JSON and digests unchanged. This is not yet a
completed retention path: deletion claims and every reference writer still need
to maintain and consult those clocks under their lifetime transaction/lock.

Restore invalidation is prepared alongside that foundation: SQLite restore
clears only the two auxiliary clock namespaces on its validated staged copy,
and both backend reapplication commands reset clocks even for an empty valid
journal. Ordinary migration/reopen preserves them. Focused checks passed 11
SQLite provider tests (47 assertions), six restore-wrapper tests (42 assertions)
and one real PostgreSQL metadata/reset probe (nine assertions). Seventeen
dependency/backend build tasks and scoped lint/format checks passed. This
prevents an older snapshot's clock from ignoring a later reference cycle; it
does not establish completed sweep/writer wiring or external journal durability.

Validation receipts are an additional retention coverage gap: they indefinitely
pin plans, have no registered age/deletion path, and current plan-deletion tests
remove them through raw fixture writes. Such fixture cleanup is not evidence of
a supported operational retention path. Their disposition must be reconciled
with the ratified retention policy before plan retention is accepted in full.

## Baseline evidence

- Frozen install and build: all 41 packages built successfully.
- Focused approval/retention tests: 83 passed, 401 assertions.
- Existing API/Local input tests: 47 passed, 257 assertions across three actual
  files. Two requested paths did not exist and are not counted as evidence.
- Real isolated PostgreSQL checks: seven passed, 62 assertions, covering
  approval persistence, receipt/runtime-ledger deletion, rejection identity,
  receipt concurrency and journal restoration. Other tests were deliberately
  filtered, not represented as a full integration pass.
- Requirements/architecture checks: 200 requirements, 103 issue audits;
  architecture inventory 41 packages, 16 operations, four profiles.

Passing baseline checks did not detect the defects above. Targeted red tests
reproduced journal class mismatch, caller-controlled attribution, and bounded
sweep over-deletion. Regression results belong with each fix, not with this
baseline snapshot.

## Remaining original gates

#194 still requires all durable classes, durable holds, and externally retained
restore journals/reapplication before a restored copy becomes available. Its
registry reports ten implemented, four reference-governed and six bounded
classes without paths; metadata is not implementation or profile acceptance.
The remaining bounded classes are native terminal snapshots, workflow
references, usage, logs/traces, artifacts and backups. Full operational fault,
recovery, rotation, rollback and measured RPO/RTO evidence remains separate.

#188/#190/#191 still require full runtime/profile and adversarial acceptance;
#195 requires full canonical-source/diagram reconciliation; #196/#197 require
their original independent/human evidence and an exact frozen candidate.
Human calibration, independent review and fresh VPS evidence must be supplied
or genuinely performed. Agent review is useful implementation evidence but is
not a substitute for those evidence classes. Production readiness is not
claimed from the local PostgreSQL environment.

No original acceptance criterion is waived, relabelled as M12, or marked
verified by this checkpoint. Implementation follow-up is tracked in the owning
open issues; final release approval remains blocked by their original gates.
