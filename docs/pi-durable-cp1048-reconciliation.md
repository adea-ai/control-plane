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

The intersection of the old 100-file patch with the current Pi draft's 35 changed
paths is eleven. “Open” means the old behavior has not been proved superseded;
it must be integrated on the current branch only after its authority contract is
qualified. Non-Pi workflow and generated architecture coordination belongs to
the assigned CI/conflict owner.

| Old #1048 path                                                        | Current decision                                                                                                                                                                                                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/control-api/src/index.ts`                                       | Old `graphWorkflowInput` export is non-Pi workflow scope. Current export changes serve child publication; **not a supersession**. CI/conflict owner reconciles the old export.                                                                 |
| `apps/control-api/src/models/production-model-composition.ts`         | Current child authority, `childDelegations`, and timeline wake composition supersede the old missing-children integration for Pi. Old optional committed-cancellation injection remains **open**: the current production owner port is absent. |
| `apps/control-api/src/pi-durable/lead-fence-consumer.test.mjs`        | Current fence tests cover children and existing read denial. Old fenced status/cancel race cases remain **open**, especially effect authorization after an awaited recheck.                                                                    |
| `apps/control-api/src/pi-durable/node-admission.ts`                   | Current pinned v2 read fence and child-read refusal are retained. Old `assertFencedBinding` compare-and-effect behavior remains **open** for cancellation; a double read is not a lock.                                                        |
| `apps/control-api/src/pi-durable/node-composition-lifecycle.test.mjs` | Current close tests supersede old accepted-public/periodic recovery drain cases. A separate supported Node Pi task-drain test covers an active run; workflow/transport and upgrade drain remain open.                                          |
| `apps/control-api/src/pi-durable/node-composition.ts`                 | Current startup, explicit and periodic child scanning, retained timeline wake, blocked health, and recovery-close drain supersede the old child recovery wiring. Committed-cancellation owner injection remains **open**.                      |
| `apps/control-api/src/pi-durable/pi-durable-lead.service.ts`          | Current `children` route supersedes the old `PI_LEAD_NOT_CONFIGURED` gap when approved composition exists. Old fenced cancel and post-effect unknown-result handling remain **open**. No child approval/cancel policy is inferred.             |
| `apps/control-api/src/pi-durable/pi-durable-lead.test.mjs`            | Current children page and fence coverage supersede child-read tests; cancellation race/replay tests remain **open**.                                                                                                                           |
| `docs/architecture/control-plane-architecture.md`                     | Current Pi publication boundary is documented. Old non-Pi graph edge and generated topology changes require CI/conflict owner reconciliation; **not a supersession**.                                                                          |
| `docs/architecture/control-plane-architecture.v1.json`                | Current generated Pi operation map is retained. Old profile dependency/digest changes require generated-source requalification by CI/conflict owner; **not a supersession**.                                                                   |
| `docs/pi-durable-runtime.md`                                          | Current recovery-close and child publication text supersedes the old close paragraph. The old cancellation and profile claims are retained here as unresolved acceptance, not silently promoted.                                               |

## Supported-profile acceptance still required

The approved #1025/#942 criteria include crash/recovery, upgrade, drain,
rollback, backup/restore, reconnect grant and generation revalidation, exact
input, and one attempt owner. Current Node Pi source proves retained unknown/no
resend and SIGKILL adoption. An exact-key resume permit now lets a trusted
no-send verdict reuse a retained ledger hold after reopen or failed engine
creation; an ordinary retry still hits the dispatch replay fence. A test-only
no-send log is not production reconciliation evidence. Its `safe_to_resume` callback needs an accountable
server-owned evidence source before live use. Reconnect source rechecks current
authority after awaited observations; the live gateway handshake remains open.
The Node composition close now has an active-task drain proof. No supported Pi
upgrade executor or compatible-version handoff entry point exists, so an
upgrade/rollback test cannot be made valid by renaming a close/reopen test.

Current ordinary and fenced cancellation can reach the adapter without a
committed cross-store owner. #1048's optional outbox port and test-only SQLite
coordinator are useful source candidates, but its own acceptance map and
`docs/pi-durable-committed-cancellation-authority.md` state that no production
owner coordinates product revocation, CP attempt versions, and the adapter
effect in one serializable transaction or shared fencing lease. Existing
approved cancellation authority must be enforced; no new child policy follows.
Until that owner is supplied and qualified, cancellation cannot be declared
production-safe. PostgreSQL generation/restore qualification is assigned to the
database owner, and combined installed desktop/Railway acceptance remains
separate.

The old map's SQLite+Restate `hosted-simple` and LangGraph/legacy graph paths are
historical profile evidence. They do not define a fallback for the approved
Railway-only Pi migration. Supersession must name the supported replacement
composition and run its acceptance matrix; historical tests must not be counted
as current hosted Pi recovery, upgrade, or rollback proof. Keep #1025, #942,
and Adea #1173 open until their full original criteria pass.
