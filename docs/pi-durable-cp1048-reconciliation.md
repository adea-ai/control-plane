# Pi Durable recovery reconciliation against draft #1048

This acceptance map compares complete draft #1048 at
`e635101384587b6d9e66dd6d1dbfb0eec8666883` with main
`f4f17194e04bcf8af65e8b5ff7aed7926b51ca88` and #1204
`d451879b55fba2508b186217494491cef3bc0f46`, whose production source is
unchanged from the tested `4f71c840f802b13b4aa05ea5c39d5a3de4023e9f`. The old PR body still names
`b145de3697e8ae41d3bc7935bd01c7eb534ac959`; that body is not a current
acceptance receipt. Historical base `8d11aa7c850e755bdd5b1a223cc6e03e0e250e80`
to old head contains 100 paths, 515 hunks, 19,363 added and 1,507 removed lines.
Neither PR nor the aggregate issues are complete.

## Ownership and preservation

Root explicitly transferred sole reconciliation ownership for both PRs after
attesting the earlier #1048 owner stopped/ineligible. Read-only custody inspection
found three preserved checkouts at `43ad930b7334eb925c8f8421b2a863b44295e9d7`,
`d78c95a96f627ea52fbf470439b2ed35b1e8d0f6`, and the published `e6351013`.
Each had empty tracked status, no nonignored untracked files, and a HEAD that is
an ancestor of the published old head. Source archives, binary staged/unstaged
patches, refs inventories, custody metadata and a SHA-256 manifest were retained
separately before integration. Ignored dependencies and local credentials were
not inspected or archived; the old checkouts were not modified or deleted.

The separate Lane C W1 transfer receipt records MiniMax turn
`642b66c4-6626-4584-a0dc-81deb76c1998` stopped at
2026-10-20 06:47:05 UTC, exit 130, cleanup confirmed, with no tests or publication
and clean workspaces. Current Fleet Pi tasks are cancelled. No process cwd
references to the three old checkouts were found. Process absence alone does not
establish ownership; the root transfer and durable task state supply that
boundary. The non-Pi F followup remains queued/held. No archived session or Claude
UI session was contacted or revived.

Integration uses a new branch based on the exact published old head, merging the
current tested #1204 head (which contains current main). The old branch history
and source archives preserve all unique work. An isolated merge candidate is not
a passing build, a published conflict resolution, or migration acceptance.

## Twenty-four overlapping paths (frozen extraction snapshot)

The old 100-path inventory intersected the Pi 59-path snapshot at `4f71c840`
in 21 paths. The qualified cleanup extraction adds three old fixture paths, so
the frozen Pi65-path extraction snapshot intersects in **24 paths**, replacing the earlier
eleven-path map. The old claim that later adapter slices did not change the intersection was stale. The disposition below
is a source reconciliation instruction; pending entries do not assert successful
integration or acceptance.

| Old #1048 path                                                        | Disposition                                                                                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/control-api/src/index.ts`                                       | Preserve distinct graph export and current child publication exports; graph export is not Pi recovery proof.                                                                        |
| `apps/control-api/src/models/production-model-composition.ts`         | Retain current child reader/delivery composition. Old committed-cancellation injection is blocked by the authority conflict below.                                                  |
| `apps/control-api/src/pi-durable/lead-fence-consumer.test.mjs`        | Retain current revision/scope/original actor and child fence negatives; do not replace them with the old smaller assertion block.                                                   |
| `apps/control-api/src/pi-durable/lead-fenced-observation.test.mjs`    | Preserve current tests; the old deletion is not evidence that their behavior is obsolete.                                                                                           |
| `apps/control-api/src/pi-durable/node-admission.ts`                   | Reconcile exact attempt and retained binding checks with old retained-admission lookup; no double read is an atomic cancellation fence.                                             |
| `apps/control-api/src/pi-durable/node-composition-lifecycle.test.mjs` | Preserve current child-reader test and both versions' accepted recovery/drain/close assertions.                                                                                     |
| `apps/control-api/src/pi-durable/node-composition.ts`                 | Preserve current child delivery and recovery close. Do not activate old committed cancellation recovery.                                                                            |
| `apps/control-api/src/pi-durable/pi-durable-lead.service.ts`          | Preserve current child route and post-effect unknown. Old retained-admission fenced path requires authority reconciliation; no child cancel policy expansion.                       |
| `apps/control-api/src/pi-durable/pi-durable-lead.test.mjs`            | Retain current ordinary/fenced unknown and child tests plus compatible old negative binding tests.                                                                                  |
| `docs/architecture/control-plane-architecture.md`                     | Regenerate from final combined supported source, preserving graph/profile additions only where still applicable.                                                                    |
| `docs/architecture/control-plane-architecture.v1.json`                | Same generated-source qualification; copying either artifact wholesale is insufficient.                                                                                             |
| `docs/pi-durable-runtime.md`                                          | Retain current disclosure, recovery, prepared/armed and child documentation; old profile/cancellation claims remain limited as below.                                               |
| `packages/pi-durable-adapter/src/adapter.ts`                          | Preserve prepared/armed monotonic receipts and current no-resend; old claimed recovery and retained-cancel delivery need separate authority-safe reconciliation.                    |
| `packages/pi-durable-adapter/src/composition.ts`                      | Preserve task drain/handoff manifest and current recovery; old startup outbox delivery cannot activate from intent alone.                                                           |
| `packages/pi-durable-adapter/src/contracts.ts`                        | Current exact-target retained intent, revocable permit and barrier supersede an irrevocable commit grant; preserve unique old contract history, not its active authority semantics. |
| `packages/pi-durable-adapter/src/index.ts`                            | Preserve current exports; old authority outcome helpers are separate source candidates, not a qualified coordinator.                                                                |
| `packages/pi-durable-adapter/src/reconcile-owner-fence.test.mjs`      | Preserve independent owner/revocation tests and actual current semantics.                                                                                                           |
| `packages/pi-durable-adapter/src/recovery-races.test.mjs`             | Combine unique ownership/crash tests with both prepared and armed restored-marker negatives; never authorize recovery from a test-only log.                                         |
| `packages/pi-durable-adapter/src/resume-permit.ts`                    | Both use private object identity; preserve that invariant and no public minting export.                                                                                             |
| `packages/pi-durable-adapter/src/usage-authority.test.mjs`            | Preserve forged/frozen/cloned permit refusal, exact-key reuse and unchanged ledger/replay fence assertions.                                                                         |
| `packages/pi-durable-adapter/src/usage-authority.ts`                  | Retain identity validation; error specificity does not confer permission or justify widening no-send.                                                                               |

The additional three overlaps are `tests/fixtures/profile-recovery-cleanup.mjs`,
`tests/fixtures/runner-cleanup.mjs`, and
`tests/fixtures/runner-cleanup-signal.child.mjs`. Their standalone portable
qualification is described below; they are not native Pi recovery acceptance.

## Concrete authority conflict requiring source replacement

At the old exact head, adapter `#cancel` looks for a matching pending committed
intent **before fresh authorization**, expressly to allow recovery after
revocation/expiry. `#deliverCommittedCancellation` applies that intent and calls
`#abortForCancellation` without a new product-authority verdict. The old
`PiDurableCommittedCancellationAuthority.commit` contract calls its serializable
owner commit the cancellation linearization point. The test SQLite coordinator
cannot establish a transaction spanning Adea authority, PostgreSQL CP state and
native Pi abort. Integrating that path unchanged contradicts the current approved
semantics: retained request evidence is not an irrevocable grant, and authority
must remain revocable. Adding another outer read would still not supply a native
commit-time effect hook.

Current #1204 exports strict intent/permit/barrier contracts and an unavailable
owner port. Its PostgreSQL request repository atomically retains intent and retry
outbox, but does not deliver, issue a permit, mutate lifecycle, or abort native Pi.
Preserve this separation. Unique old claim/recovery and fence tests must be
adapted to the current authority contract rather than enabling the old coordinator
to make those tests pass. The all-writer revocation protocol and a supported native
effect guard remain substantive blockers.

## Verified unique work and supersession

| Old scope                                          | Source decision and qualification limit                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi restart test and fixture                        | Preserve the current #1200 fixture boundary: advisory process logs leave pre-dispatch restart unknown with zero provider requests and no second inference authorization. Authority evidence is `[]`; recovery never reaches a second admission, so no ledger rejection event is invented. Old #1048 completed/one-send behavior remains unaccepted. |
| Hosted composition and profile-adapter wake binder | Unique retained identity, zero-attempt wake, startup/drain and cleanup work remains to integrate. Actor/current grant, residency and independently current topology sources are not qualified. JSON restart ingress is not a PostgreSQL production recovery proof.                                                                                  |
| Graph workflow input reconstruction                | Unique retained-plan graph reconstruction remains historical graph scope; not supported native Pi execution evidence.                                                                                                                                                                                                                               |
| Embedded crash/rollback tests                      | Preserve queue ownership and exact input/checkpoint negatives. `graphCheckpointId` and graph recovery keys are legacy continuation; do not claim native Pi rollback.                                                                                                                                                                                |
| Rebind/reconnect tests                             | Preserve current-authority negatives and fresh same-target retained-handle binding. Mocked guards do not prove concurrent revocation, a new generation, or production reconnect.                                                                                                                                                                    |
| PostgreSQL portable restore test                   | Preserves a seeded evaluation export/import/replay regression and cleanup cases. It does not restore a retained Pi attempt, native journal or outbox, or prove a cross-store generation fence. Database-owner path reconciliation still applies.                                                                                                    |
| `packages/database/src/integration.test.mjs`       | Unique two-physical-owner and stale generation tests share database ownership; qualification must be coordinated with the database owner rather than editing that scope concurrently.                                                                                                                                                               |
| Legacy self-hosted-simple tests                    | Preserve historical semantic requirements and evidence. They execute LangGraph/SQLite/pinned Restate, including manual orphan reaping; do not rebuild those dependencies or count them as Railway Pi acceptance.                                                                                                                                    |
| Process cleanup fixtures                           | The portable runner and real-signal fixture are extracted unchanged in behavior into a standalone suite: 10 tests / 56 assertions pass on macOS arm64. Original historical tests remain preserved. All-close/error aggregation and Linux identity-pinned termination still need separate qualification; no bare-PID fallback.                       |
| Test registration/generated artifacts              | Preserve current measured E2E sharding, fresh-schema bootstrap and pool teardown registrations. Reconcile shared runner paths with their existing owners before editing; do not overwrite current main with old scripts.                                                                                                                            |

The portable composition cleanup helper is also extracted without legacy imports.
Four focused tests cover all-close-before-delete ordering, preserving unconfirmed
shared state, continuing independent cleanup and retaining every failure. These
tests do not claim application or database shutdown acceptance.

Complete path inventory is retained in
[the per-path reconciliation ledger](pi-durable-cp1048-path-ledger.md).

## Supported-profile acceptance still required

The approved #1025/#942 criteria include crash/recovery, upgrade, drain,
rollback, backup/restore, reconnect grant and generation revalidation, exact
input, and one attempt owner. Current Node Pi source proves retained unknown/no
resend and SIGKILL adoption. The retained v1 pre-run marker now safely resumes
an engine that never entered `run` without guessing from an absent ledger hold.
An exact-key resume permit lets a trusted
no-send verdict reuse a retained ledger hold after reopen or failed engine
creation; an ordinary retry still hits the dispatch replay fence. A test-only
no-send log is not production reconciliation evidence. The source now records
`prepared` then `armed` before the physical provider fetch, bound to the exact
inference generation, attempt, request fingerprint, provider binding, and owner
epoch. An ambiguous arm result prevents fetch; an armed marker cannot be reset
to prepared. Both retained stages remain unresolved after reopen because a
copied journal alone cannot prove the current restore generation, even if a
callback guesses safe. A qualified server-owned restore-generation/no-send
authority is still needed before resuming a prepared generation. The final
spending await is followed by a journal owner and authority recheck immediately
before fetch. That check and the provider fetch are separate operations, so
cross-process revocation in their physical gap is not an atomic authorization
claim. Reconnect source rechecks current
authority after awaited observations; the live gateway handshake remains open.
The Node composition close has an active-task drain proof and now offers an
opt-in local handoff manifest after fenced close. It fingerprints the authority
SQLite main/WAL/SHM files and native Pi session files, validates exact retained
version and bytes before reopen, and rejects drift. This is local store integrity
only. It does not prove installed build compatibility, cross-version conversion,
one-owner live upgrade, downgrade, rollback, or a copied Railway restore. No
supported release-pair upgrade/rollback executor is qualified.

Current ordinary and fenced cancellation preserve current authority checks and unknown-on-drift
reporting. The old grant-survives-revocation policy, production owner injection and startup
abort delivery are explicitly superseded. Historical target/identity/retry coverage is ported
to disconnected effect-free history reconciliation and current ordinary cancellation tests;
see `docs/pi-durable-committed-cancellation-authority.md` for the complete old-assertion map.
This does not prove a native commit-time effect guard or atomic cross-store cancellation.
The all-writer revocation protocol and independently qualified restore-generation fence
remain open. Retained request/outbox persistence grants no permission. PostgreSQL restore
qualification stays with the database owner; combined installed desktop/Railway acceptance
remains separate.

The old map's SQLite+Restate `hosted-simple` and LangGraph/legacy graph paths are
historical profile evidence. They do not define a fallback for the approved
Railway-only Pi migration. Supersession must name the supported replacement
composition and run its acceptance matrix; historical tests must not be counted
as current hosted Pi recovery, upgrade, or rollback proof. Keep #1025, #942,
and Adea #1173 open until their full original criteria pass.

## Isolated candidate continuation (not published acceptance)

All nine original textual conflicts now have source candidates. The adapter combines the
old unique durable process-claim identity/recovery cleanup with current physical prepared/armed
markers, conservative restored-marker unknown behavior and exact generation recovery.
The current ordinary cancellation path is retained, including fresh target selection after
awaited authorization. The rejected old irreversible owner is not forwarded or invoked by
production/Node construction or startup. Current authority still gates ordinary/fenced calls.

The first isolated workspace build passed47/47 tasks. Initial current cancellation/production
composition tests passed7 cases/51 assertions; revised historical retention/classification
suite passed23 cases/119 assertions. Broader qualification and integration of the later
#1204 registration/confinement delta are in progress. These are candidate receipts only;
#1048 published e635 remains unchanged until a checked draft update is pushed. No legacy
Restate/graph proof is counted as native Pi acceptance.

### Candidate live-boundary evidence

Broader Pi adapter plus seven lead/fence/composition suites ran412 cases:410 pass,
2 fail,2,543 assertions. The two former “missing committed owner disables cancellation”
checks are explicitly superseded as policy. Their underlying final-callback revocation
and deadline races remain executed zero-effect requirements (not skipped or weakened).
Current behavior returns `PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN` after the unguarded
native boundary; this does not qualify rejection before effect. A new finite sequence
of asynchronous reads would not establish atomicity. The independently reviewed
native commit-time/all-writer fence remains required and unactivated. These two
source acceptance failures are not a request to restore the rejected irrevocable grant.

The source merge can be preserved in a draft with this explicit failing gate; it does
not satisfy ready/merge or complete migration acceptance. Normal build hooks remain.

## Integration of latest reviewed #1204 source

The isolated source merge commit `845ef15cc31151a3f2a554b5d4a7b196d8f6d9fb`
preserves old published e635 ancestry and current main through #1204 at4f71c840.
The subsequent merge imports #1204 exact `df78ae61591c8e24b595203cf8acd1851971a300`,
including the full inventory/shard registration repair, portable cleanup qualification,
and PostgreSQL URL/identity confinement. Only this map needed textual reconciliation;
no earlier source, old checkout or test gate was discarded. The24-path ledger above
is a frozen historical extraction snapshot, not a claim about the final combined diff.

The first merge's unchanged normal hooks passed47/47 build and97/97 aggregate tasks,
plus schema, compatibility,200 requirements/103 issue audits,45 packages/55 operations/
4 profiles, and208 infrastructure files. Final latest-head combined checks remain
pending below; neither those hooks nor a conflict-free source merge clear the two
executed native effect gates or installed/product/runtime acceptance.

### Latest combined qualification and integration repair

After importing df78, discovery caught an automatic-merge duplicate of the restart
suite. The primary lane and exact expected list each now register it once; no measured
shard schedule or inventory enforcement was reduced. Repository/shard/architecture,
confinement negatives and portable cleanup:73 pass/486 assertions across6 files.
Actual PostgreSQL18.6 private and normal confined modes:9 pass/42 assertions each;
zero owned databases remain and the disposable cluster is stopped. The normal Mac
proof uses the existing peer identity, not Docker TCP or distinct-role topology.

The real child integration run then exposed a conclusion persistence defect:
`terminalConclusion` was omitted from SQLite's mutable-field classification and its
complete terminal receipt. Completion CAS failed with `DELEGATION_STATE_CONFLICT`.
Two new regressions failed before repair; the two-line source repair now atomically
retains the bounded canonical conclusion with the exact event and preserves conflict
checks against changing/removing/injecting historical text. The existing rollback
case includes the new field. Persistence/orchestration qualification:66 pass/805
assertions. Four combined child/canonical/workspace suites:60 pass/423 assertions.
The production child test fixture now explicitly supplies its required advisory
notify port; captured wakes are not authenticated Adea timeline acceptance.

Old ignored irreversible-owner fixtures are removed from runtime harness options;
ordinary intent tests assert exact attempt/digest evidence and no manufactured grant.
Historical standalone retention coverage remains preserved. Broader native effect
and smoke gates stated above remain failing/pending; these passing slices do not
close them or the aggregate issues.
