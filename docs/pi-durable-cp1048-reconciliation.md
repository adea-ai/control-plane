# Pi Durable recovery reconciliation against draft #1048

This is an acceptance map for the Pi-owned source paths. It does not merge, close, or
replace draft #1048. Its preserved published head is
`e635101384587b6d9e66dd6d1dbfb0eec8666883`; the PR remains draft and
conflicted. Its body still names `b145de3697e8ae41d3bc7935bd01c7eb534ac959`
as current, so the body is not an exact-head acceptance receipt. The complete
`8d11aa7..e6351013` patch contains 100 paths and 515 hunks. Retain that branch
and any separate unpublished work; no checkout, reset, cherry-pick, or branch
deletion is part of this reconciliation.

Root's handoff says the prior #1048 owner is stopped and ineligible; the preserved
draft itself last changed on 2026-10-17. The separate Lane C W1 custody receipt at
`/tmp/opencode-three-fleet-20261020-fresh/data/operator-handoffs/20261020-pi-durable-w1-transfer-receipt.json`
records the later MiniMax turn `642b66c4-6626-4584-a0dc-81deb76c1998`
stopped at 2026-10-20 06:47:05 UTC with exit 130, cleanup confirmed, no tests or
publication, and clean preserved workspaces. That receipt proves W1's release of
Lane C; it is not an archive receipt for #1048's earlier Claude thread. The earlier
thread's archived status and any unpublished checkout diff still require a
separate custody receipt before anyone changes or disposes of that checkout.

## Eleven overlapping paths

The intersection of the old 100-file patch with the Pi draft's 35 changed
paths at this reconciliation snapshot is eleven. Later adapter-only source slices
do not change those eleven decisions. “Open” means the old behavior has not been proved superseded;
it must be integrated on the current branch only after its authority contract is
qualified. Non-Pi workflow and generated architecture coordination belongs to
the assigned CI/conflict owner.

| Old #1048 path                                                        | Current decision                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/control-api/src/index.ts`                                       | Old `graphWorkflowInput` export is non-Pi workflow scope. Current export changes serve child publication; **not a supersession**. CI/conflict owner reconciles the old export.                                                                                                                                                            |
| `apps/control-api/src/models/production-model-composition.ts`         | Current child authority, `childDelegations`, and timeline wake composition supersede the old missing-children integration for Pi. Old irreversible-intent injection/startup delivery is superseded by current revocable semantics; no production coordinator is activated. Exact native effect/all-writer qualification remains **open**. |
| `apps/control-api/src/pi-durable/lead-fence-consumer.test.mjs`        | Current fence tests cover children and existing read denial. Old fenced status/cancel race cases remain **open**, especially effect authorization after an awaited recheck.                                                                                                                                                               |
| `apps/control-api/src/pi-durable/node-admission.ts`                   | Current pinned v2 read fence and child-read refusal are retained. Old `assertFencedBinding` compare-and-effect behavior remains **open** for cancellation; a double read is not a lock.                                                                                                                                                   |
| `apps/control-api/src/pi-durable/node-composition-lifecycle.test.mjs` | Current close tests supersede old accepted-public/periodic recovery drain cases. A separate supported Node Pi task-drain test covers an active run; workflow/transport and upgrade drain remain open.                                                                                                                                     |
| `apps/control-api/src/pi-durable/node-composition.ts`                 | Current startup, explicit and periodic child scanning, retained timeline wake, blocked health, and recovery-close drain supersede the old child recovery wiring. Committed-cancellation owner injection remains **open**.                                                                                                                 |
| `apps/control-api/src/pi-durable/pi-durable-lead.service.ts`          | Current `children` route supersedes the old `PI_LEAD_NOT_CONFIGURED` gap when approved composition exists. Ordinary and fenced post-effect denial now reports `PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN`; committed cross-store cancellation authority remains **open**. No child approval/cancel policy is inferred.                         |
| `apps/control-api/src/pi-durable/pi-durable-lead.test.mjs`            | Current children page and fence coverage supersede child-read tests; post-effect ordinary denial reports unknown. Committed cancellation race/replay tests remain **open**.                                                                                                                                                               |
| `docs/architecture/control-plane-architecture.md`                     | Current Pi publication boundary is documented. Old non-Pi graph edge and generated topology changes require CI/conflict owner reconciliation; **not a supersession**.                                                                                                                                                                     |
| `docs/architecture/control-plane-architecture.v1.json`                | Current generated Pi operation map is retained. Old profile dependency/digest changes require generated-source requalification by CI/conflict owner; **not a supersession**.                                                                                                                                                              |
| `docs/pi-durable-runtime.md`                                          | Current recovery-close and child publication text supersedes the old close paragraph. The old cancellation and profile claims are retained here as unresolved acceptance, not silently promoted.                                                                                                                                          |

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
