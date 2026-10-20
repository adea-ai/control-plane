# Pi cancellation owner proposal

Status: proposed for root review; no implementation or activation is authorized
by this document. The source baseline is Control Plane
`65acc91ddaf7f6161318d3383582d9847f3d3688` and Adea
`a4a5059b115530b0002ada9400a24770e430294a`.

## Existing requirements and source

The existing cancellation authority belongs to the original product actor.
A normal lead stop does not cascade to children. The v2 rollback fence permits
the existing original-actor cancellation operation; it does not grant inference,
child reads, or a new child cancellation policy. Unknown physical effects remain
unknown until trusted reconciliation resolves the exact generation.

These rules are represented by `docs/pi-durable-runtime.md`,
`docs/pi-durable-cp1048-reconciliation.md`, the current source below, and the
published old #1048 `docs/pi-durable-committed-cancellation-authority.md`.
That old document requires a production owner to coordinate product authority,
CP versions, and immutable intent/outbox delivery; its SQLite test coordinator
does not implement the production owner. The following proposal changes the
coordination contract and therefore requires review. It is not a claim that the
approved PRD/TDD has already authorized the proposed ordering.

| Source                                                                                              | Current behavior and required change                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adea `packages/db/src/lead-turns.ts`, `withHistoricalLeadTurn` and `lockHistoricalChannel`          | Canonical original-actor cancellation boundary; active group cancellation requires its original claim holder and current authority. Archived group access is denied. Archived direct cancellation uses the existing historical checks. Reuse this boundary rather than the active-only product reader. |
| Adea `packages/db/src/lead-turn-rollback.ts`                                                        | Fence takes channel, intent, then runtime locks. Cancellation must serialize against these rows while preserving the existing v2 policy. A rollback fence is not automatically a cancellation revocation.                                                                                              |
| Adea `packages/db/src/lead-turn-runtime.ts`, `requestLeadTurnCancellation`                          | Writes `cancelRequestedAt` in a product transaction but creates no CP/generation-bound authority.                                                                                                                                                                                                      |
| Adea `apps/web/src/server/lead-turn-runtime.ts`, `cancel`                                           | Commits that timestamp before invoking CP. A timestamp is insufficient evidence of CP acceptance or abort.                                                                                                                                                                                             |
| CP `apps/control-api/src/pi-durable/pi-durable-lead.service.ts`, `cancel` and `#fencedCancel`       | Current checks surround adapter cancellation; post-effect denial reports `PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN`. These checks are not a transaction around authorization and effect.                                                                                                                   |
| CP `packages/pi-durable-adapter/src/canonical-authority.ts`                                         | Rechecks execution/attempt state and product evidence after awaited reads. The reads reserve neither product authority nor CP versions.                                                                                                                                                                |
| CP `packages/database/src/execution-cancellation-repository.ts`                                     | Generic command reservation holds `FOR KEY SHARE` on the execution. It neither blocks non-key version/state updates nor binds a Pi generation. Do not reuse its receipt as a Pi authority grant.                                                                                                       |
| CP `packages/database/src/execution-repository.ts` and `packages/domain/src/execution-lifecycle.ts` | Existing version CAS and `cancelling` lifecycle semantics are the CP state contract to preserve.                                                                                                                                                                                                       |
| CP `packages/database/src/schema/messaging.ts`                                                      | Existing outbox supplies retained delivery/retry metadata. The proposed intent and its outbox insertion must share the CP transaction.                                                                                                                                                                 |
| CP `packages/pi-durable-adapter/src/adapter.ts`, `cancel`                                           | Current local intent precedes engine abort but lacks a committed product/CP owner. Delivery must instead consume an exact-generation committed intent.                                                                                                                                                 |

## Smallest proposed coordination contract

The proposal introduces a durable product grant followed by a CP commit. It
does not make the separate databases atomic. It requires root to accept the
product ordering rule described below before implementation.

1. The adapter produces a server-owned proposal from its retained journal. Bind
   handle, runtime session, execution, attempt, turn, generation or explicit
   no-active-generation state, owner epoch, admission digest, request key and
   request digest. Caller payloads cannot supply these as authority.
2. CP opens a PostgreSQL transaction, serializes the idempotency key, then locks
   the execution and exact latest attempt in deterministic order. Compare scope,
   accepting principal, plan/admission binding, expected versions, latest attempt,
   state and deadlines. Existing immutable intents replay without a new effect;
   changed payloads under a reused key conflict.
3. While those CP locks are held, CP requests an authenticated product grant.
   Adea invokes `withHistoricalLeadTurn(..., 'cancel')`, holds the canonical
   authority locks, locks the intent and runtime binding in compatible order,
   validates current authority and the exact CP/adapter proposal, and inserts an
   immutable idempotent grant. The grant binds both expected CP versions and the
   complete proposal digest. It grants no artifact access or child operation.
4. After receiving the product grant, CP checks its binding and trusted current
   time, then commits the immutable Pi cancellation intent, outbox event and
   existing `cancelling` lifecycle/version transitions in one PostgreSQL
   transaction. Do not mark either execution or adapter terminal before actual
   settlement. CP intent commit authorizes delivery; a product grant alone is inert.
5. A retained worker delivers only that committed intent. The adapter verifies
   the full binding and durably applies it before attempting abort. Exact
   generation replay is idempotent. A proven superseded target is resolved
   without aborting its successor. An unresolved target remains pending.
6. Acknowledge only after durable application/resolution. Lost acknowledgements
   replay the same intent. Startup must enumerate retained pending intents before
   ordinary continuation, without a new model dispatch.

The grant operation must not recursively call CP while CP holds its row locks.
Use bounded transaction and transport timeouts, but never infer a denial or a
successful effect solely from a timeout. The transport uses already approved
service authentication; new credentials or access grants require separate authority.

## Required ordering decision

Under this proposal, the Adea grant commit establishes product-side ordering.
A product revocation committed first denies grant creation. A later revocation
does not erase an immutable grant already issued for that exact request and
generation. CP changes or expiry before CP finalization can still deny the
request, leaving an inert product grant. This may conservatively deny a request
that was eligible when the product grant committed.

This is a consequential contract choice: a grant may survive product revocation
between the product commit and CP finalization. Root must review that rule
against the approved requirements. It is not equivalent to the old requirement
that both stores participate in one transaction or shared fencing lease.

If revocation must remain effective until CP intent commit, retain cancellation
as unqualified until a shared transaction or shared fencing mechanism exists.
Every relevant product revocation writer, CP version/deadline writer, and effect
owner must honor that mechanism. Independent reads, signed snapshots and holding
a product transaction across HTTP do not provide it: the product transaction can
end while a delayed remote request continues. A new transport or a test-only
coordinator cannot repair that authority gap.

## Crash and retry outcomes

| Boundary                                                         | Required result                                                                                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revocation before product grant                                  | No grant, CP intent, journal change or abort.                                                                                                        |
| Product grant commits but response is lost                       | Resolve by exact key/digest. CP may roll back; grant remains inert. No guessed success or new request identity.                                      |
| CP transaction aborts or times out after product grant           | No delivery without a confirmed CP intent. Retry can finalize only against the same pinned CP versions and eligible deadline.                        |
| CP version advances before retry                                 | Deny finalization. The old grant cannot attach to the new version or generation.                                                                     |
| CP intent commit response is lost                                | Look up the immutable CP intent; never issue an unrelated cancel or infer absence from missing logs.                                                 |
| Crash after CP commit, before adapter delivery                   | Durable outbox/startup recovery delivers the same intent.                                                                                            |
| Crash after journal application, before abort or acknowledgement | Retry the matching local abort/resolution and acknowledgement idempotently. Outstanding physical send remains unresolved.                            |
| G1 grant replayed when G2 is retained                            | Never retarget to G2. Resolve proven supersession or retain unresolved G1.                                                                           |
| Copied/restored journal or authority store                       | Block delivery/continuation until the independent restore-generation authority qualifies the binding. Local byte manifests do not supply this proof. |

## Bounded implementation and qualification plan

After root approves the ordering contract, coordinate database paths and restore
generation with the database owner through root before edits. Preserve the old
#1048 checkout until its unpublished work has a verified custody transfer.

1. Add strict proposal/grant/intent contracts and an unavailable default owner;
   inject the owner through current Node composition. Preserve existing response
   uncertainty and ordinary lead-stop scope.
2. Add the product transaction and immutable grant repository using the canonical
   historical cancellation boundary. Keep `cancelRequestedAt` as a projection;
   distinguish requested, authorized, delivered and settled evidence.
3. Add the CP transaction repository and outbox consumer using existing lifecycle
   derivation and version CAS semantics. Do not combine independent repository
   commits and call them atomic.
4. Wire adapter delivery/recovery against committed intents and exact generation.
   Retain no-resend behavior and fail closed when the owner or generation evidence
   is absent.
5. On disposable PostgreSQL 18 databases, race revocation and grant creation,
   concurrent first delivery, attempt/version/deadline changes, key conflicts and
   competing owners. Inject failures at each grant/intent/outbox/journal/ack
   boundary. Assert the losing path has no forbidden intent or engine abort.
6. Run paired-source integration with fresh processes, current and revoked
   original actors, existing allowed v2 fenced cancellation, forbidden archived
   groups, G1/G2 supersession and pending outbox restart. Installed SDK, Railway
   restore generation and native desktop acceptance remain separately required.

No database concurrency test, installed runtime acceptance or new behavior is
claimed by this proposal. Existing CP #1025/#942 and Adea #1173 remain open.
