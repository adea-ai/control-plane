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

| Severity | Finding                                                                                                                                      | Owner and acceptance condition                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| High     | Hosted validation does not receive its configured catalog approval gate.                                                                     | M11 implementation agent, #188/#190: prove validation denies an unapproved pin when enabled.                                                         |
| High     | A historical stored plan can authorize a new execution without current version eligibility checks.                                           | M11 implementation agent, #188/#190: revalidate current pinned lifecycle/digest/approval at new acceptance while preserving already-accepted replay. |
| High     | Receipt deletion treats the owner as terminal without reading it; removing an unresolved cancellation permits reconciliation to resume work. | M11 implementation agent, #194: retain unresolved intent, use terminal reconciliation plus the replay window, prove both backends.                   |
| High     | No durable owner hold state is consulted; deletion supplies `holds: 0`.                                                                      | M11 implementation agent, #194: durable scoped holds and atomic hold checks at physical deletion, including concurrent hold creation.                |
| High     | Restore journal operations are not bound to their declared class/backend.                                                                    | M11 implementation agent, #194: reject mismatched operations before any restored data is mutated.                                                    |
| Medium   | SQLite checks sweep bounds after journalling/deletion; compound receipt and messaging sweeps reset the bound per half.                       | M11 implementation agent, #194: admit before mutation and enforce one total class bound; assert remaining rows and journal count.                    |
| Medium   | Approval CLI accepts an input principal/authority as if authenticated.                                                                       | M11 implementation agent, #188/#190: record actual operator-session provenance, not a caller's claimed product principal.                            |

The journal and attribution findings concern trusted privileged operator input;
they are not evidence of an unauthenticated remote exploit. The approval
bypasses concern real new-execution authorization paths. Fixes need current-head
regression evidence before these findings can be closed.

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
