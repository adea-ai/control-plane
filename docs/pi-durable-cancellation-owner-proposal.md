# Pi cancellation owner proposal

Status: **proposed source design, not implemented or qualified**. The next bounded
cut is [Minimal next source-design cut](#minimal-next-source-design-cut-proposed-2026-10-23).
The existing reference contract is in
[Native commit/fence qualification and dormant boundary](#native-commitfence-qualification-and-dormant-boundary).
The earlier drain-before-ACK protocol below is preserved as superseded history,
not the approved ordering. The earlier product-grant ordering proposal is
rejected: neither `cancelRequestedAt` nor a retained cancellation intent is an
irrevocable permission to execute after authority is revoked. No coordination
protocol in this document is implemented or activated.

Initial historical baseline: CP `65acc91ddaf7f6161318d3383582d9847f3d3688`, Adea
`a4a5059b115530b0002ada9400a24770e430294a`. The source-design update below is
documentation only; it does not add or change executable tests.

## Minimal next source-design cut (proposed, 2026-10-23)

**Status:** proposed for root review. Checked against CP
`b17d32ab0fcd0ea86c60d47cda24534f96e86e6d` and the installed, unchanged
`@earendil-works/pi-durable` 1.1.0 artifact. Its three checksums still match
[Pinned native capability evidence](#pinned-native-capability-evidence).
This cut specifies obligations, not an available SDK operation, activated port,
completed writer integration or permission to provision an authority service.
It preserves ordinary stop semantics, no child cascade and both failing
zero-effect tests. It does not disable ordinary cancellation or change its
unknown-outcome response while the proposed atomic path remains unqualified.

### Required boundaries and their concrete source locations

| Required boundary                                              | Existing code or verified API                                                                                                                                            | Smallest missing source primitive/integration                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact cancellation target                                      | `cancellation-owner.ts` target/request/permit schemas; `adapter.ts` fresh journal and process claim                                                                      | A real owner deriving the exact current attempt, turn, inference, admission and owner/restore generation; retained request, parsed permit and preparation remain evidence only.                                                                                   |
| Native admission and abort **N**                               | `pi-engine.ts` calls public `Conversation.abort`; 1.1.0 `harness/types.d.ts` exposes only `background`; `Harness.abortTask` returns marked/terminal, not a bound receipt | An explicitly identified guarded abort operation in the native mutation line, with persisted target revalidation, final trusted-time/fence check, abort/input writes and immutable receipt in one transaction. This API is absent from the pinned public surface. |
| Selective execution/publication                                | 1.1.0 `harness/harness.js` resumes scheduling before `abortConversation`; scheduler uses internal `session.commitWith`                                                   | The guarded operation must not resume tasks or publish effects on rejection. It must record a no-effect receipt for an empty/already-terminal scope. A generic Context/Storage wrapper and public `Tx` scans do not establish these properties.                   |
| Native restriction installation **F** and acknowledgment **A** | Dormant `PiNativeCancellationBoundaryPort.installFence`, fence request/receipt schemas                                                                                   | Persist the union of mutation-owned restrictions in the same native write domain as N; acknowledge only the exact committed installation. These schemas/default-unavailable methods are not an implementation.                                                    |
| Canonical authority mutation **R**                             | Adea product writers and CP repositories listed below; `node-admission.ts` current read/observe checks                                                                   | Close admission and registration for the complete affected scope, obtain every required A, then conditionally commit R under the same closure/mutation identity. No product DB lock is held across network waits.                                                 |
| Completion observation **D**                                   | Ordinary abort waits for idle; dormant `readReceipt`/`drain` reference ports                                                                                             | Resolve only the exact historical N receipt and generation, without repeating abort, admitting inference or targeting a successor. An installation A does not prove D.                                                                                            |
| Independent restore generation **G**                           | `cancellation-owner.ts` and `native-cancellation-boundary.ts` bind caller-supplied generation; `journal.ts`/`lease.ts` hold local identities                             | A monotonic generation and writer-registration authority outside every restorable snapshot, with a transition protocol that fences old writers before advancing/reopening. No such qualified source is implemented.                                               |

The required native addition is an operation with these semantics, not a proposed
name that already exists. It must preserve Pi 1.1.0 ownership traversal and queued
input withdrawal, bind the exact selected scope/task/input revision, and avoid
`background` expansion or product-child cancellation. Calling internal `setTask`
or reconstructing private scheduler behavior is not the supported next cut.
Public facade composition is not ruled out, but must prove all these obligations;
none of the partial probes above establishes it.

### Cancellation and mutation ordering

N is native admission/abort commit; F is native fence installation; A acknowledges
that installation; R commits the canonical invalidating mutation; D observes the
already admitted operation drain. Required ordering is **F < A < R**. The permitted
race **N < F < A < R < D** retains a cancellation admitted before revocation even
when it drains later. N/F serialization ends at transaction commit/rollback, not D.

1. The CP owner retains the exact idempotent request, then obtains current actor,
   audience, scope, execution/attempt and earliest relevant deadline evidence.
   Preparation creates no grant. Retention uses the request owner, not the adapter
   journal effect flags. A denied N must leave the running journal unchanged, with
   no `cancellationIntent`; current `adapter.ts` writes those flags before calling
   native cancel, so moving that publication behind a bound N receipt is a required
   future integration, not a property of the present implementation. Before R, the
   mutation coordinator durably closes
   the affected admission/registration scope and fixes its closure generation.
   Discovery includes pending creation, replacement, rebind, recovery and reopen;
   a new owner cannot publish a handle using an older open generation.
2. Each affected native owner commits F for that mutation and closure. Restrictions
   from concurrent mutations form a union; one mutation cannot erase another's
   restriction. A binds mutation ID, scope-set digest, closure generation, process
   claim, restore generation and owner/fence epochs. The coordinator needs matching
   A from every required write domain, not a majority or one currently visible task.
3. N reloads persisted native scope/task/input facts and compares the exact target,
   current owner/restore generation, permit and restriction union inside its native
   transaction. Its final trusted-time admission point must precede the minimum
   applicable authority/permit/execution/attempt expiry. No awaited external check
   may follow the final guard before the abort/receipt write. The backend must
   define and enforce that admission point; an outer timestamp or timer is no proof.
   The minimum must enumerate all applicable canonical expiries, not merely trust
   the retained target timestamp. Missing expiry evidence prevents admission.
   A rejected N writes no abort/input mutation and causes no scheduler admission.
4. If F wins, the old N is rejected. If N wins, F may acknowledge after N commits
   without waiting for D. Only after all matching A may R commit conditionally on
   the unchanged closure. Lost or unknown A keeps revocation pending/unconfirmed
   and new admission closed; it cannot be reported as successful R or a drained D.
   R failure/lost response is resolved by its durable mutation ID before reopening;
   reopening requires fresh authority and an advancing epoch, never replaying an
   old permit. Natural expiry is enforced at N even without a mutation event.
5. A lost N response is resolved through its exact immutable native receipt.
   CP journal/outbox/result publication may retry bookkeeping against that receipt,
   not issue another abort. Publication compares the exact still-current target and
   process claim; if a successor won, preserve historical evidence instead of
   rewriting its state or inferring a new cancellation. Historical receipt observation after expiry adds no
   present permission. Unknown receipt or D stays unresolved; no successor target,
   inference resend or new spend is inferred.

### Every relevant writer must participate

The [current writer inventory](#current-owners-and-authority-writers) supplies the
concrete source families; the source-derived inventory in
[complete writer coverage](pi-durable-complete-writer-coverage.md) remains the
check against omissions. The following is a required integration map, not a
statement that any writer already performs this handshake.

| Writer/fact family                                              | Existing source owner                                                                                                                 | Required fence and missing participation                                                                                                                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original actor, membership, identity and workspace lifecycle    | Adea `lead-turns.ts`, `workspaces.ts`, `identity.ts`                                                                                  | Close the complete affected authority scope before discovery; F/A must cover every live/pending owner before membership/identity/deletion R. External identity revocation ingress remains an explicit coverage dependency. |
| Channel roster, grant revision/expiry, archive and visibility   | Adea `conversations.ts`, `group-channels.ts`, `project-state-policy.ts`                                                               | Fence the affected group/direct scopes and original-message predicates before R; preserve archived/direct/group semantics. Expiry also needs the native trusted-time check, not just a grant-writer event.                 |
| Profile/project binding, rollback and dispatch/recovery binding | Adea `agents.ts`, `lead-turn-rollback.ts`, `lead-turn-runtime.ts`                                                                     | Fence the operation-specific target set and register new/rebound owners under the closing epoch. Preserve the existing rollback decision and lock order; no child-policy expansion.                                        |
| Execution/attempt version, latest pointer and deadlines         | CP `execution-repository.ts`, `execution-event-repository.ts`, `runtime-event-effect-sink.ts` and their lifecycle callers             | Enforce the handshake at persistent mutation ingress, not only in the HTTP stop controller. The two deadline/revocation tests must exercise these real writer paths.                                                       |
| Authentication and explicit execution scope                     | CP service/private authentication and `node-admission.ts` injected scope authority                                                    | Map credential/scope invalidation to the same closure and F/A/R protocol; request-time authentication or a later asynchronous read is insufficient. No credential change is part of this proposal.                         |
| Local native/journal and process ownership                      | `adapter.ts`, `journal.ts`, `effect-gate.ts`, `lease.ts`, `cancellation-history.ts` and Node composition                              | Bind mutation admission to current G/owner/claim and native N/F. Local revisions, history metadata and process liveness alone cannot establish restore authority.                                                          |
| Cloudflare owner/session and CP retained lead/product rows      | `pi-cloudflare-host` owner/sessions; CP lead preparation/running/call-gate/receipt stores and production product/role/source bindings | Add the same registration/generation rejection to every durable mutation ingress in the existing coverage list. Host-local ownership is not an acknowledgment from other owners.                                           |
| Import, restore, cutover/raw SQL and capability readers         | Adea import/maintenance owner; CP restore path; `resume-permit.ts`/`upgrade-manifest.ts`                                              | Reopen only through the G protocol below. Read-only manifests and in-process permits cannot mint G or authorize effects. An unclassified/offline writer keeps full-writer qualification open.                              |

Adea changes require that owner's root-coordinated scope; none is made here.
The inventory includes components that read or bind authority without writing it;
keep those distinctions. Do not narrow coverage to the two cancellation contracts
or describe the other eighteen classified components as all having native fences.

### Independent restore-generation admission

The source-design requirement is a compare-and-advance authority keyed to the
restore lineage, outside both the restored CP/product stores and native snapshots.
Its implementation/provider is deliberately undecided; this document provisions
nothing. Returning G from a restored row, manifest hash, permit, journal epoch or
process claim would preserve the existing rollback-with-matching-digest gap.

1. Close mutation/owner registration for the lineage. Before advancing G or
   restoring bytes, prove every old-G writer quiescent or fenced in a write domain
   the restore cannot rewind. A fence stored only in the snapshot being restored
   is insufficient. An unreachable owner with unconfirmed fencing keeps reopening
   unavailable; lease expiry alone does not prove it cannot later write.
2. The independent authority conditionally advances G for one restore ID and
   records the transition durably. A retry resolves that transition; it cannot
   choose the rolled-back snapshot's generation as current or decrement G.
3. Every restored/restarted/rebound owner registers against the externally current
   G and closure before becoming writable. Every effect/durable mutation entry
   must reject stale-G admission through the same non-rewindable registration and
   fence protocol. A lone asynchronous read of G before a later write recreates
   the race and is not qualification.
4. Preserve old-G receipts as historical observations only. Reopen under the new
   G/owner epoch only after required registrations and fences acknowledge the
   exact transition. Test a whole-snapshot rollback with matching hashes, not just
   a changed generation field with an old digest.

### Reviewable implementation sequence and qualification

The next implementation cut is a reviewed capability/transaction contract and
source prototype for N/F, plus the closure/G authority contracts; it must not wire
a fake success default into production. First resolve the native API extension
with the SDK owner and the independent-generation storage boundary with root.
Then prove a disposable native-backed implementation, CP repository writers and
Adea writers in their assigned scopes before considering composition activation.

Keep the two current final-asynchronous-authority zero-effect tests unchanged.
Add qualification for both N/F orderings; exact empty/terminal receipts; no task
resume on rejected N; earlier expiry at the final guard; overlapping mutations;
creation/rebind during closure; lost N/F/A/R responses; owner restart and stale
receipts; D after R without a new abort; and snapshot rollback with matching
digests rejected across the entire classified writer set. Unknown/missing API,
writer acknowledgment or external G must remain unavailable/unconfirmed.

Passing dormant-schema or in-memory tests does not satisfy these native checks.
Installed paired SDK/product/desktop, PostgreSQL/profile and live acceptance remain
separate. This proposal changes no tests, dependencies, ports, runtime wiring,
infrastructure or credentials, and closes no aggregate Pi issue.

## Semantics to preserve

Adea owns the product actor, audience, message, channel, grant and rollback
facts. CP owns the accepted execution, current attempt, versions, deadline and
runtime binding. The adapter owns its exact native inference generation and
journal epoch. The original actor must still be authorized at the cancellation
effect boundary. An intent records what was requested; it does not freeze those
facts or bypass a later revocation. Each retry and recovery delivery needs
current permission for its exact target.

Ordinary lead stop never cascades to children. The existing v2 rollback fence
allows original-actor cancellation under its existing checks; it is not itself
a universal cancellation revocation. Archived direct cancellation preserves the
historical authority checks. Archived group access remains denied. No new child
approval or cancellation policy follows.

Current source enforces checks around the adapter effect and returns
`PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN` on post-effect drift. This preserves
uncertainty but does not provide atomic cross-store authorization. Existing
requirements are represented in `docs/pi-durable-runtime.md`,
`docs/pi-durable-cp1048-reconciliation.md` and the old published #1048
`docs/pi-durable-committed-cancellation-authority.md`. The original PRD/TDD is
not reproduced in this checkout; this proposal cannot replace its acceptance
criteria or claim an unreviewed interpretation is approved.

## Current owners and authority writers

A shared fence must cover every mutation of the facts actually used by the
canonical authority predicate. The following inventory identifies concrete
writer families; it is not a claim that they already participate in a common
protocol. Pure presentation, workspace ordering and unrelated model defaults do
not become new cancellation authority solely because they share a table.

| Facts                                                             | Existing source owners and writers                                                                                                                                                                                                                                                                                                  | Required participation                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original actor and current workspace audience                     | Adea `packages/db/src/lead-turns.ts` (`lockAuthority`, `lockArchivedAccess`, `withHistoricalLeadTurn`); `workspaces.ts` (membership removal, ownership/deletion lifecycle); `identity.ts` (temporary-identity claims and membership transfer)                                                                                       | Membership removal, role/identity changes and workspace deletion must fence affected live intents before committing a change used by the authority predicate. Identity/auth revocation ingress also needs a verified mapping; an unchanged browser identity is not authority. |
| Channel, participants, group admissions and grants                | Adea `conversations.ts` (`setChannelParticipants`, channel archive/update and group admission replacement); `group-channels.ts` (`setGroupChannelParticipantsWithGrants`, `setGroupChannelParticipantsInTransaction`, `revokeGroupGrant`, grant revision persistence); `project-state-policy.ts` (channel archive/restore cascades) | Cover roster/grant/lead/version changes, group grant revocation and expiry. Grant expiry is checked against trusted time at the effect boundary; it cannot rely only on a writer event. Preserve current direct/group and archived semantics.                                 |
| Agent/profile binding and original message visibility             | Adea `agents.ts` (`changeAgentProfile`, `assignAgentToProject`, `archiveAgent`); `conversations.ts` (`editMessage`, `deleteMessage` and visibility mutations)                                                                                                                                                                       | Fence only changes that alter the canonical pinned lead/profile, scope or visible original-message predicate. Reuse existing historical cancellation semantics.                                                                                                               |
| Rollback, dispatch/attempt binding and retained request           | Adea `lead-turn-rollback.ts` (`fenceLeadTurnForRollback`); `lead-turn-runtime.ts` (prepare, pending, bind recovery, observation and cancellation recording); `lead-turns.ts` (immutable admission)                                                                                                                                  | Preserve channel → intent → runtime lock order. Apply the operation-specific v2 fence decision; never turn a rollback fence into permission to infer or a new child policy.                                                                                                   |
| Imported/restored identities and authority rows                   | Adea `portable-import.ts`, migration/cutover tooling and database restore owner                                                                                                                                                                                                                                                     | Import, restore or raw SQL cannot silently bypass the fence. Offline maintenance requires all affected owners drained and a new qualified restore generation before reopen. This belongs in database-owner reconciliation through root.                                       |
| CP execution/attempt state, version, latest attempt and deadlines | CP `packages/database/src/execution-repository.ts` (`compareAndSetExecution`, `insertAttempt`, `compareAndSetAttempt`); `execution-event-repository.ts`; `runtime-event-effect-sink.ts`                                                                                                                                             | Enforce fencing in persistent repositories, covering lifecycle callers in runtime ingestion, reconciliation, delegation, workflow activities, Pi running lifecycle and unused-allocation release. Do not rely only on the cancellation controller.                            |
| CP authentication and explicit scope                              | CP `apps/control-api/src/auth/service-authentication.ts`, `private-api-authentication.ts`; `pi-durable/node-admission.ts` and its injected `CurrentExecutionScopeAuthority`                                                                                                                                                         | Revalidate the authenticated principal and current operation/scope. Credential revocation and external scope writers need an explicit fence integration; request-time claims alone cannot qualify recovered delivery. No new credential or grant is proposed.                 |
| Adapter generation, process owner and local effects               | CP `packages/pi-durable-adapter/src/adapter.ts`, `journal.ts`, native engine cancel path and Node composition                                                                                                                                                                                                                       | Fence old process epochs and exact generations at the local effect boundary. A stale retained command must never be retargeted to a newer generation.                                                                                                                         |

`withHistoricalLeadTurn(..., 'cancel')` already uses current product authority
under PostgreSQL row locks. `requestLeadTurnCancellation` writes a timestamp in
that transaction. The web runtime currently commits the timestamp before CP is
called. It is request evidence only. CP's generic
`PostgresExecutionCancellationRepository.reserve` uses `FOR KEY SHARE` on an
execution and does not reserve attempt versions or Pi generation; it is not the
missing authority owner. The generic `outbox_events` can carry retry evidence,
not independent permission.

## Superseded shared-fence drain protocol (historical)

The protocol and crash/outcome table through the next source-work section retain
the earlier design for custody. Their requirement to hold the native gate through
drain and delay fence ACK/canonical revocation until drain is superseded. Current
ordering is `F < A < R`, with approved `N < F < R < D`: N/F serialization ends at
native commit/rollback; installation ACK A does not certify drain D. See the
current native-boundary section below. This historical prose must not guide
implementation or qualify native capability.

The proposed owner is a CP-hosted cancellation coordinator backed by the existing
CP PostgreSQL persistence boundary, with a durable monotonic fence per affected
intent/attempt and qualified restore generation. This is a new source integration
requiring root review and database-owner coordination, not a new deployed
service. Adea retains its product authority checks. All listed writers must use
the coordinator before changing relevant facts. Until every ingress is covered,
this protocol cannot qualify production cancellation.

1. Retain an idempotent request and outbox entry bound to workspace, original
   actor, dispatch, execution, attempt, admission/request digests, generation and
   owner epoch. This is a retry obligation, not an authorization grant. A reused
   key with a different digest conflicts.
2. The coordinator durably admits at most one effect permit against an open
   fence epoch and exact CP execution/attempt versions. It performs fresh
   canonical product checks for that operation. This permit can be invalidated;
   it does not survive a completed revocation.
3. Before a relevant product or CP writer commits, it durably closes the fence
   to new permits, records the pending mutation identity, and requests a runtime
   barrier. Multi-intent writers cover the complete affected set in deterministic
   order; a workspace deletion cannot fence only the currently visible browser
   session. No product database lock is held while waiting over HTTP.
4. The runtime serializes effect delivery and barriers through a gate bound to
   its process/journal ownership epoch. Persist monotonic fence epochs and verify
   the exact permit, generation and expiry before admission. The gate must remain
   occupied throughout the asynchronous native cancellation operation, including
   session open, root lookup, native abort transaction and its idle wait. Never
   release it merely because an outer request times out. If native cancellation
   fails ambiguously, retain an unresolved operation until native reconciliation
   or proven process stop establishes that no delayed side effect can still run.
5. A barrier either wins before local consumption, denying the old permit, or
   waits for the admitted operation and any delayed native work to drain. The
   runtime durably acknowledges the barrier and rejects all earlier epochs.
   Only after that acknowledgement may the authority writer commit its product
   or CP mutation. Thus an effect that wins occurs before the revocation commit;
   an effect after that commit cannot consume the old permit.
6. After the writer commits, the coordinator records its outcome and permits
   future fresh checks under a new epoch. A failed writer can reopen only after
   current authority is rederived; fence epochs never decrease. Ordinary retry
   or outbox recovery cannot reopen a fence or revive an old permit.

The native effect linearization point is the Pi session transaction that marks
its reached tasks `abortRequested` and withdraws queued input. The installed Pi
1.1.0 implementation exposes this through
`dist/harness/scheduler.js:abortConversation`, using `session.commitWith`, then
waiting for the conversation to become idle. Current `pi-engine.ts:cancel`
awaits session open and root lookup before calling that operation. Therefore an
adapter journal update or the call to `engine.cancel` is not proof that the
native effect has committed. The proposed runtime gate must cover that entire
asynchronous lifetime; its barrier acknowledgement cannot precede drain.

The authority mutation linearization point remains its canonical database
commit, ordered after the confirmed runtime barrier. The coordinator's CP row
transactions serialize permit admission, barrier state and CP version changes;
no CP transaction is claimed to include an Adea HTTP transaction. Absolute
expiry must additionally be enforced at native effect commit. The current public
Pi abort API has no authority/deadline callback inside `commitWith`; an external
time check cannot prove this final expiry boundary. A compatible native commit
guard, or a source-proven existing hook, must be reviewed before this protocol
can claim expiry correctness. The current source does not supply that guard.

This protocol preserves authorization ordering at an availability cost. An
unreachable owner with an unacknowledged effect cannot simply have its permit
expire and be assumed stopped. Revoke admission to new effects immediately, but
keep the mutation incomplete/unknown until the old owner is proven fenced or
stopped. If existing revocation contracts require immediate canonical commit
without waiting for that barrier, this protocol is incompatible. Root must
review that concrete constraint; the alternative is a shared transactional
execution/authority boundary. A signed snapshot, two reads, or a product grant
that survives revocation is not an alternative that preserves current semantics.

## Superseded drain-protocol crash/retry outcomes (historical)

| Failure or ordering                                                      | Required result                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revocation/barrier wins before effect consumption                        | No journal cancellation application or abort under the old permit. Retained request may remain denied/pending.                                    |
| Effect wins before barrier                                               | Record effect evidence, finish the barrier, then allow revocation commit. Abort invocation is not proof the physical send settled.                |
| Crash after intent/outbox commit, before permit                          | Retry with fresh current authority. Intent alone cannot execute.                                                                                  |
| Crash after permit or lost runtime response                              | Keep the permit unresolved. Inspect retained exact-generation evidence; never infer effect or no-effect from timeout or missing logs.             |
| Writer crashes after closing fence, before database mutation             | Fence remains closed. Recovery rederives current authority and completes or explicitly resolves the recorded mutation.                            |
| Database mutation commits but coordinator response is lost               | Confirm the canonical mutation identity/version and barrier before reopening; do not replay an old permit.                                        |
| Crash after journal application, before abort outcome or acknowledgement | Preserve unknown/cancelling. Retry only under current authority and exact-generation evidence; do not turn an intent into permission.             |
| G1 request retried with G2 current                                       | Deny retargeting. Resolve proven G1 supersession or leave G1 unresolved; cancelling G2 requires its own authorized request.                       |
| Owner replacement or restore                                             | Old owner must be fenced/proven stopped. A copied journal, elapsed lease or matching file manifest does not establish current restore generation. |
| Existing allowed v2 rollback cancellation                                | Apply the current original-actor policy at every boundary; a blanket fence rejection would incorrectly change existing semantics.                 |

## Bounded next source and test work

Root review must cover the shared-fence owner, affected-writer completeness,
barrier availability behavior and the native commit guard for absolute expiry.
Database path/generation dependencies go through root to the database owner.
Root has transferred #1048 reconciliation ownership. Three old checkout heads
were clean and already ancestors of its published head; custody archives and
hashes are preserved. Integration uses an isolated checkout, leaving those old
checkouts unchanged. See [the reconciliation map](pi-durable-cp1048-reconciliation.md).

Source-only service tests can independently prove current pre-effect revocation
and generation mismatch cause zero adapter calls, and a retry after unknown
outcome must pass current authority again. They cannot prove atomicity.

After approval, implement strict intent/permit/barrier contracts, a fail-closed
owner port and persistent coordinator; integrate the writer repositories before
wiring effect delivery. Test permit-versus-barrier races on actual PostgreSQL 18,
faults at every persistence/ack boundary, process death, late old-owner commands,
generation supersession, group/archived/v2 policy and qualified restore generation.
Paired-source and installed runtime acceptance remain required. No infrastructure,
new authentication, UI, child policy or release is authorized here. CP #1025/#942
and Adea #1173 remain open.

## Approved bounded contract slice

The adapter package exports `cancellation-owner.ts` as a source-only contract seam.
It defines strict retained-intent, exact-target, revocable-permit, current-fence,
barrier and unresolved-effect observation shapes. Request digests cover the full
bound target, key and requested instant. Snapshot comparison rejects changed
request/target, stale or future fence epochs, revoked/unknown permits, closed
fences, untracked generations and expired authority. Barrier comparison checks
exact target and process owner; monotonic barrier epochs and explicit drain
receipt fields cannot establish actual drain by themselves.

All timestamps in these owner contracts require UTC with exactly three fractional
digits, including the nested runtime handle. This matches the precision retained
by `Date.parse`; finer precision is rejected rather than rounded. Intent digest
refinement hashes the parsed body directly, so continuable nested target errors
remain ordinary `safeParse` failures instead of throwing from a recursive parse.

`UnavailablePiCancellationOwner` rejects every operation with
`PI_CANCELLATION_AUTHORITY_UNAVAILABLE`, including intent retention, permit and
current-fence reads, barrier reads and effect observation. It is not injected
into the existing adapter or production composition. Existing live checks and
cancellation behavior are unchanged. None of these parsers or pure snapshot
helpers supplies a transaction, lease, current permission or native effect.

## Pinned native capability evidence

Inspected the installed `@earendil-works/pi-durable` **1.1.0** artifact, without
changing dependencies or accessing live infrastructure. Paths below are relative
to that installed package's `dist/` directory:

| Source                                                   | Capability and limitation                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness/types.d.ts:58-77`                               | `ConversationAbortOptions` exposes `background` only. `abort(context, options)` has no expected-generation, authority-revision or compare/guard callback.                                                                                                                       |
| `harness/harness.js:65-67`                               | Public conversation abort resumes the task scheduler then invokes `abortConversation`; it does not add an authority guard.                                                                                                                                                      |
| `harness/scheduler.js:186-211`                           | `abortConversation` uses an internal `session.commitWith` callback to mark reached tasks and withdraw inputs, then waits for idle. The callback is hardcoded; no caller guard runs inside it.                                                                                   |
| `session/session.js:250-270`                             | Checks `context.abortSignal` at transaction entry, then awaits callback and write preparation. Storage settlement deliberately receives `withoutAbortSignal(context)`. An abortable Context therefore does not establish a deadline or revocation comparison at storage commit. |
| `session/session.d.ts:17-23`, `session/transaction.d.ts` | `commitWith` and `setTask` are documented internal APIs. Public `Tx` lacks `setTask`; reconstructing scheduler abort through internal APIs would require a separately reviewed compatibility change and preservation of scope/queue/idle semantics.                             |
| `storage/sqlite/storage.js:103-123`                      | Commits native writes inside its SQLite transaction but has no product/CP/permit comparison. Generic storage decoration is a possible extension point, not a proven cancellation-specific hook or cross-store authority mechanism.                                              |

Artifact SHA-256 checksums for reproducibility:

- `harness/scheduler.js`: `9d473431d18a0bf11e37b4e491213adc82d66b3698e45bdfeba155ba9a13b609`
- `session/session.js`: `cc999b5b03bb1c7aed1d5d48e170928a9daa0a6a82f47a538dfef7ed9e50b32a`
- `harness/types.d.ts`: `df01cf73d080c3d280a065369025ab4d82a209832ba42754abd4c7ec9295bb9f`

Conclusion: the current public abort API has no source-proven compare-and-cancel
or commit-time authority hook. An outer check, Context cancellation, journal
intent or parsed permit cannot be described as that hook. Native guarded abort,
all-writer coordination and production acceptance remain gated.

## PostgreSQL request retention slice

`apps/control-api/src/pi-durable/postgres-cancellation-requests.ts` adds a
standalone repository operation, with no production composition or delivery wiring.
It uses the existing `persistence_records` namespace
`pi.cancellation.requests.v1` and `outbox_events`; no schema, migration journal,
credential or grant changes are needed. The published old #1048 diff contains
memory/SQLite cancellation-owner fixtures but no overlapping PostgreSQL request
repository. Its unpublished checkout is untouched. This slice does not replace
its missing production authorization owner.

First retention takes an advisory transaction lock for the scoped request key,
then `FOR SHARE` locks on the accepting command, execution and exact attempt.
It validates deterministic Pi intent IDs, accepting service principal, workspace,
command/request/plan/scope bindings, latest attempt and sequence, exact execution
and attempt versions, and any already-retained canonical external session ID.
The immutable request and its pending retry outbox row are inserted in that same
PostgreSQL transaction. An outbox insertion failure rolls both writes back.
Same-key/same-digest replay returns the existing pair; changed content conflicts.
The key includes workspace, product intent, accepting service principal and
request idempotency key, so changing target generation cannot create a second
record under the same scoped key.

The native handle, admission digest, original actor, product scope and restore
generation in the intent remain retained request data. Their current provenance
and permission are not proved by these PostgreSQL rows. In particular, current
Pi running receipts retain the exact native handle in SQLite while canonical
attempt runtime metadata stays immutable. An absent CP external session ID is
not manufactured into a mapping. No request record or outbox payload is a
permit, and the repository neither advances lifecycle state nor aborts an engine.
Historical retrieval/replay after a CP version change is request evidence only;
any eventual effect still needs the separately qualified current authority and
native fence. Missing or corrupted paired rows fail closed rather than silently
recreating an outbox entry.

The existing generic record namespace has no request-specific pruning policy.
This source slice creates only pending outbox records and neither publishes nor
marks them delivered. Retention/cleanup and any execution-reference pinning must
be reviewed with the future delivery owner before activation; existing generic
messaging retention must not be mistaken for that authority.

The integration suite uses the real existing migration chain on an owned,
disposable PostgreSQL 18 cluster. It covers duplicate and conflicting requests,
stale versions and wrong bindings, a real failing outbox trigger with rollback,
competing writers, both orders of lifecycle-write versus retention lock admission,
and fresh OS-process retrieval. The private UNIX socket uses OS peer
identity, no TCP listener and no new credential or persistent access grant.
Run with `PI_CANCELLATION_TEST_PG_SOCKET` pointing to an owned
`/tmp/pi-cancellation-pg.<suffix>/socket` and:

```sh
bun test ./apps/control-api/src/pi-durable/postgres-cancellation-requests.integration.test.mjs
```

The normal integration lane also selects this suite through the Control API package
command and its existing integration shard. With `RUN_DATABASE_INTEGRATION=true`,
the harness uses the explicitly supplied existing local administration/migration
roles, creates one randomly named owned database, runs migrations, and closes and
drops that database after the suite. It creates no roles or credential/access
grants. Remote hosts, unmatched clusters, unowned database names and ambient
credentials outside that explicit lane fail closed. The restart reader receives
the same owned database identity. A failed cleanup remains failed on repeat calls
and retains all errors and the exact owned database name.

Connection confinement rejects every URL query key except one validated private
`host` path. In particular `database`, `user`, encoded identity keys, startup
`options`/`role` and duplicate hosts are refused before creating a client. The
harness constructs explicit driver host/port/database/username/password options;
it never forwards URL query options into the PostgreSQL startup message. Before
creating an owned database it verifies the administration connection's
`current_database()` and `current_user`. Before migrations, and again in the
fresh-process reader before repository access, it verifies the exact owned
database and configured migration role. The private-socket mode similarly checks
its fixed database and existing OS identity. A mismatch closes the connection
and fails qualification without admitting migrations or repository operations.

Both harness modes have exercised all nine cases on disposable PostgreSQL 18.6,
42 assertions per mode. The normal-mode Mac proof used the same private peer
transport and existing OS role while creating a separate owned database; this is
not Docker TCP/role-topology qualification. Fourteen pure negative harness tests cover enablement, socket identity,
remote/mismatched targets, restart-name refusal, URL startup overrides and server
identity mismatch. These parser/guard negatives do not connect using rejected
parameters. Actual PostgreSQL cases qualify the positive guarded path.

This is request durability/concurrency qualification, not restore, live authority,
installed desktop or committed cancellation-effect acceptance.

The aggregate digest-writer gate also identified locale-dependent header ordering
in the existing physical-request fingerprint. That writer now uses the shared
code-point comparator. The real Request-valued POST regression includes hyphen,
underscore and plain header names and checks the literal expected fingerprint at
both prepared and armed stages. No retained fingerprint is rewritten, and no
old prepared/armed record gains resend permission from this ordering repair.

## Native commit/fence qualification and dormant boundary

The native-boundary interfaces in `native-cancellation-boundary.ts` are exported
source contracts only. The default port rejects preparation, commit, fence
installation, receipt retrieval and drain as unavailable. It is not injected into
the adapter, engine or composition. No SDK, authority writer or production
capability has changed. Existing final-callback revocation and deadline
zero-effect gates remain unsatisfied and unchanged.

Andrew accepted unavailable/not-confirmed revocation when a runtime safety fence
cannot be confirmed, and post-revocation drain of cancellation actually committed
before revocation. The required ordering remains `F < A < R`; `N < F < R < D` is
permitted. N and F share the native transaction serialization boundary, released
at commit/rollback rather than drain D. Installation ACK A is neither drain
evidence nor proof of canonical R. Handshake budget B does not bound the complete
canonical operation or its response.

The dormant preparation carries candidate scope/task/input revisions and exact
product/generation/process bindings. It is not a frozen in-memory cut: a future
qualified N must reread and compare persisted facts within its transaction.
Retained intent and preparation cannot be parsed as commit evidence. Receipt
comparisons bind the exact request, native target, process, owner and restore
generation but do not attest provenance or authority. Native admission uses the
earliest relevant existing authority expiry; timestamp shapes preserve
milliseconds. A historical receipt may be observed after expiry without becoming
a newly executable permit. Lost-response publication/drain must resolve the exact
persisted generation and must never issue an abort against a successor.

Independent disposable Node SQLite probes using the installed Pi 1.1.0 public
interfaces established these narrow facts:

- The unmodified public `abort()` has no storage commit for empty scope. A
  rejected tagged abort batch still resumes the scheduler; a paused task ran,
  while its abort handler did not run.
- A host-owned `SqliteDatabase` can reject every native transaction and prevent
  pending-task admission. This also rejects cancellation itself, so it does not
  establish selective guarded abort.
- A separate public `Conversation.commit` using public `Tx` scans and a host
  document can retain a conservative empty-root no-effect receipt without
  resuming scheduling. An uncached final database guard rejected owner/fence
  drift and rolled back receipt creation. This is not `Conversation.abort()` or
  recursive scope/native-effect qualification.
- An ambient cancellation token propagated to four native transactions: abort
  marking, reservation, completion and terminalization. It cannot by itself
  identify exactly the cancellation transaction. No Context/Storage proxy was
  wired and no private SDK internals were used.

Three isolated reference contract tests intentionally remain red against the
pinned API: guarded empty-abort receipt, no cancellation-induced scheduling on
rejection, and selective ambient operation identity. They are retained with the
executable probes in Library design revision 5, not represented as passing
repository qualification. Normal source tests cover only dormant contracts and
unavailability.

The reference additive API needs an explicit guarded operation, exact persisted
scope selection/revalidation, zero-write receipt path, and selective scheduler
admission/publication. Its N must atomically validate current local restriction
union, process claim, restore generation and trusted earliest deadline, then
commit native abort/input mutations with the immutable receipt. F must use the
same write domain, with restrictions owned by each canonical mutation. No
asynchronous authority check after the final guard and no wait for D may sit in
that transaction boundary. Public facade composition is not declared impossible;
these partial probes do not establish the whole operation.

All invalidating product/CP writers, pending admission/creation, replacement,
rebind and reopen registration still require complete per-mutation scope closure
before discovery through canonical commit outcome. Shared Adea database writer
paths await root-mediated ownership reconciliation; W8 owns restore-proof
qualification. Native primitive, all-writer coverage, independent restore
generation and installed product acceptance remain pending. No live activation
or dependency installation follows from this source slice.
