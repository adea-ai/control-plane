# Pi cancellation: retained requests and current permission

## Reconciliation of published #1048

The source at `e635101384587b6d9e66dd6d1dbfb0eec8666883` treated committed intent
as permission surviving later product revocation and replayed aborts during startup.
That policy is explicitly superseded. Its complete published source and tests remain
in Git and in the preserved custody receipt; no unpublished checkout was overwritten.

Ordinary cancellation keeps #1204's current actor, audience, scope, expiry and lineage
checks and capability. Fenced cancellation rereads the current fence before claiming
the journal. The target is taken from the fresh journal after awaited authorization.
Retained intent does not bypass either check. A post-effect authority failure returns
`PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN`, without claiming success or atomic rejection.
There is still an asynchronous cross-store race: these checks do not constitute an
atomic effect authorization protocol.

The old owner option and automatic startup delivery are removed from production and
Node composition. The historical request schemas are used for history tests only.
The SQLite test owner is retention infrastructure, not an implemented product/CP
coordinator. `cancellation-history.ts` is an internal, disconnected, effect-free
classifier: current or ambiguous targets remain unresolved. An exact superseded
target may add immutable history metadata under `transitionCurrent`; it cannot abort,
change execution state/epoch/actions, settle usage, or acknowledge an outbox. Its
transaction rereads the current row so a competing G2 write is preserved.

Current PostgreSQL request/outbox persistence is separate, source-only and unwired.
It retains an exact target atomically; it grants no permission or terminal outcome.
The separately exported cancellation-owner port stays fail closed and unavailable.

## Explicit replacement of old assertions

These rows identify original test names/subjects in
`packages/pi-durable-adapter/src/committed-cancellation-authority.test.mjs` at e635.
The revised suite tests actual adapter denial, disposable SQLite request retention,
and transactional history; it makes no production cross-store atomicity claim.

| Old assertion or subject                        | Retained coverage and supersession                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory old-key replay and new key               | Immutable identity, digest conflict, distinct G1/G2 keys and independent pending/ACK bookkeeping retained.                                                          |
| Product revocation first                        | Actual fixture binding admission denies retention; ordinary/fenced current authority denies with zero journal/abort effect.                                         |
| Deadline update first                           | Deadline and separate execution/attempt version changes deny admission and current cancellation.                                                                    |
| Revocation during commit                        | Pending fenced read raced with revocation denies before effect. The hypothetical shared SQLite transaction is not a production proof.                               |
| Committed cancellation wins later revocation    | **Superseded:** retained same key survives as evidence; both public paths deny after revocation, zero new aborts.                                                   |
| Lost commit response on reopen                  | Exact pending request persists across reopen; no startup delivery, state advancement or inference resend.                                                           |
| Same-process retry after revocation             | **Superseded:** failed authorization is never bypassed by pending intent. Immutable replay and changed-digest conflict remain.                                      |
| ACK failure repeats live abort                  | **Superseded:** bookkeeping failure never grants a repeated effect; request remains unresolved/pending without abort.                                               |
| Startup ACK after applied cancellation          | Effect-free saved resolution and idempotent ACK retry retain history; no implicit effect delivery.                                                                  |
| Historical resolution across next run           | Old turn and generation stay immutable; newer current cancellation/result/usage are preserved. Corrupt attempt/turn rejected.                                       |
| Lost null-generation response after revocation  | **Superseded successful public replay:** public revocation denies; effect-free history may classify an old target without acting.                                   |
| Untracked cancel followed by tracked generation | Null target never adopts a later tracked generation, even in the same turn.                                                                                         |
| G1 retry and new key for G2                     | Distinct keys retain distinct request identity; old generation cannot replace the new generation/cancellation.                                                      |
| Startup ACK G1 after G2 cancellation            | No automatic startup effect. History preserves G2 metadata and exact saved G1 resolution.                                                                           |
| Saved G1 resolution after ACK failure/G2        | Resolution persists through reopen and ACK retry; G2 state remains byte-equivalent apart from history.                                                              |
| Same-epoch G2 metadata race                     | Real second journal connection interleaves metadata before transactional classification; G2 owner/inference/cancellation preserved.                                 |
| Corrupt outbox handle isolation                 | Malformed target rejects without mutation; distinct valid handle in same journal remains independently readable/unresolved.                                         |
| Startup old generation/new active generation    | No startup effect delivery; all three old target kinds classify against the exact current generation without adopting it.                                           |
| Same-epoch G2 completion race                   | Second journal connection commits completion/result/settled usage at same epoch; classification preserves all fields.                                               |
| Legacy action without intent ID                 | Legacy history is not a permission. Ordinary cancellation does not acquire a fictional committed grant ID; unavailable new owner tests retain zero-effect contract. |
| Missing owner removes ordinary capability       | **Superseded:** ordinary capability remains. An injected obsolete object is uncalled during production construction; the new owner port remains unavailable.        |

`cancellation-generation.test.mjs` retains exact attempt/inference cancellation,
pre-authorization no-generation fencing, late result isolation, terminal failure
preservation, and fresh target selection after awaited authorization. Only its
requirement for an irreversible coordinator intent ID is superseded.

## Pending effect protocol and production acceptance

A future coordinator must bind current original actor and audience, admission/fence,
CP execution and attempt versions/deadlines, exact generation, process owner epoch,
and independently qualified restore generation. Retained request is distinct from a
revocable permit. Every relevant authority writer must honor the same effect fence;
locks held while HTTP runs and two current reads do not establish atomicity.

The installed pinned native Pi1.1.0 public abort API has no qualified compare-and-cancel
or commit-time guard. The native hook, all-writer protocol, restore generation and
production acceptance remain gated and fail closed. No new coordinator or native
effect integration is activated by this source reconciliation. Cross-version upgrade,
rollback and installed paired runtime/product/desktop acceptance remain pending.
