# Pi durable committed cancellation authority

`PiDurableRuntimeAdapter.cancel()` and `cancelFenced()` require the server-owned
`committedCancellationAuthority` port. Without it, cancellation returns
`PI_CANCELLATION_AUTHORITY_UNAVAILABLE` before running a caller authorization
callback, changing the journal, or touching the engine. The adapter omits
`execution.cancel` from inspected capabilities while the port is absent. Reads,
status, and recovery remain available.

The port's `commit(proposal)` operation is the cancellation linearization point.
Its owner must check the current product fence, retained admission digest, CP
execution and attempt identities and versions, and deadline/expiry in the same
serializable transaction or under one shared fencing lease. It must write an
immutable cancellation intent and durable outbox row as part of that commit.
The proposal comes from the adapter's retained journal binding; a request
receipt, caller-supplied boolean, or the adapter's preflight callback is not an
authority grant.

The owner must make commit idempotent by handle and request identity. Repeating
the same idempotency key and request digest returns the same intent. Reusing the
key with a different digest conflicts. If product revocation or a CP deadline,
attempt, or owner-version update commits first, cancellation is denied with no
journal mutation or engine abort. If the cancellation intent commits first,
later revocation or deadline changes do not erase that intent.

After commit, the adapter validates the returned intent's handle, execution,
attempt, workspace, admission, request key, and digest. It durably applies the
intent to the journal, aborts a matching locally owned engine, then acknowledges
the outbox row. If abort or acknowledgement fails, the outbox remains pending;
same-process retry and startup recovery repeat the idempotent journal and abort
steps before acknowledging. The owner must make acknowledgement idempotent
because its response can be lost after it records the acknowledgement. Startup
enumerates handles with pending intents, then reads and drains each handle
independently before ordinary reconciliation. A corrupt payload or temporary
read, delivery, or acknowledgement failure blocks recovery for that handle while
other handles continue. If the owner cannot enumerate pending handles, recovery
remains globally unavailable. A crash
after the owner commit but before the response is safe: retry or startup returns
the same immutable intent. A crash after journal application but before
acknowledgement is also safe: replay recognizes the same intent id. Recovery
does not send the model request again.

Each intent is pinned to the exact inference generation present in its proposal.
If a lost commit response is retried after the journal has advanced from
generation G1 to G2, the owner still returns the immutable G1 intent. The
adapter records a durable `target_generation_superseded` resolution and
acknowledges it without changing G2's journal state or aborting G2. The same
resolution applies when a receipt proves G1 settled before G2 became active.
If the journal cannot prove that G1 is no longer active, recovery leaves the
outbox pending and reports an unresolved generation. To cancel G2, issue a new
request with a new idempotency key so the owner can commit an intent bound to
G2. This exact-generation rule prevents an ambiguous old response from aborting
a newer physical inference.

## Required owner integration

The production product fence store and Control Plane execution store are
separate from the adapter journal and from each other. A production owner must
therefore coordinate both current authority records with the outbox write. It
can use a shared transactional authority store or a fencing lease that all
product and CP revocation/deadline writers also honor. A sequence of independent
reads followed by an outbox insert does not close the race.

`createNodePiDurableLeadComposition()` currently does not inject this port. The
SQLite coordinator in `src/committed-cancellation-authority.test-fixture.mjs`
is disposable test infrastructure proving transaction ordering, idempotency,
restart replay, and unknown commit outcomes. It is not a production owner and
does not make the current separate product and CP stores atomic. Until an owner
implements and injects the port, production cancellation stays unavailable by
design. The published PR 1048 head still needs this change; this local patch
does not change or validate the published branch.

## Smallest remaining compare-and-effect contract

The remaining boundary is visible across three call sites. `PiDurableLeadService.cancel()`
in `apps/control-api/src/pi-durable/pi-durable-lead.service.ts` invokes
`cancelFenced()` with a recheck callback. `PiDurableNodeAdmission.assertFencedBinding()`
in `apps/control-api/src/pi-durable/node-admission.ts` rereads product authority,
the ready marker and binding, then samples CP execution and attempt records twice.
That method currently returns `void`; its double sample detects some overlapping
changes but does not reserve the observed versions. In
`packages/pi-durable-adapter/src/adapter.ts`, `cancelFenced()` runs the callback
before claim and after an awaited scope lookup, then `#cancel()` commits the
intent, `#deliverCommittedCancellation()` applies the journal transition, and
`#abortForCancellation()` calls the engine. A revocation or deadline update can
still land after the last callback and before those effects.

The minimum safe contract is one compare-and-authorize decision bound to the
effect's exact target. It must compare the product fence and admission marker /
binding revisions, CP execution and attempt owner versions and deadlines, and
the adapter handle, attempt, turn and generation. The same serialized authority
must include all writers that can revoke or advance those values. Its successful
decision must be durable and idempotent by cancellation request identity, and
the journal/outbox delivery and engine abort must either be part of that
serialized operation or consume a monotonic authorization token at the effect
linearization point. A read-only snapshot, a signed token that remains valid
after revocation, or another callback immediately before `cancel()` is not
sufficient. If the participating stores cannot share a transaction, every
revocation writer and the effect owner must honor the same fencing lease through
the effect; otherwise the system must keep cancellation unavailable.

This is a contract for the existing owner boundary and adapter ports, not a
cross-store implementation. In particular, it does not make the independent
product database, CP execution store, adapter journal, and engine atomic by
itself.

The lead service performs a final authorization check after either adapter
cancellation path returns. Both ordinary and fenced cancellation return after
the adapter's durable intent/delivery boundary. If this final check fails, the
service returns `PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN` (HTTP 503) without a
cancellation status payload. The caller must not interpret that response as
proof the abort was rejected or completed. The durable intent and
`cancelling`/`unknown` journal state remain authoritative until engine settlement
or recovery resolves the generation. This response rule preserves uncertainty;
it does not close the earlier cross-store window. With no production owner wired,
cancellation remains unavailable before authorization or effect.
