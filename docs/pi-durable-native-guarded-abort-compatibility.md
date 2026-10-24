# Downstream Pi Durable guarded-abort compatibility

This source/test extension is an additive downstream patch to the unchanged
`@earendil-works/pi-durable` 1.1.0 package. It is not a new upstream release or
production activation. The normal engine omits the guarded cancellation
capability. Only the disposable live qualification fixture explicitly supplies
`nativeCancellationQualification` through its existing engine factory.

## Source, installation and attribution

The root `patchedDependencies` entry and Bun lock register
`patches/@earendil-works%2Fpi-durable@1.1.0.patch`. The existing PostgreSQL patch,
external dependency versions and overrides are retained. Bun preparation also
reconciled already changed workspace manifest versions/dependency metadata; this
is recorded lock maintenance, not an external version upgrade.

The official package integrity and all 67 embedded TypeScript source files match
attested upstream commit `abe508e1b89912adde45528136c3221eb69acdd7`.
[The notice](../patches/pi-durable-1.1.0-NOTICE.md) preserves the exact upstream MIT
copyright and permission text. The published package contains JavaScript,
declarations and maps rather than TypeScript sources. The patch changes those
published runtime/declaration sources. Stale map directives on changed files are
removed; original maps remain, without a claim that they describe the new code.

A real frozen-lockfile installation with the repository's Bun 1.4.4 reproduced
all 272 SDK payload hashes. Root package/lock and both dependency patches remained
unchanged during that verification. No shared upstream checkout was edited.

## Additive public capability

`Conversation.commitAbort(request, context)` commits native abort marks, queued
input withdrawals and an immutable receipt together. Its exact persisted scope
snapshot includes selected task records, queued submission records and ownership
conversations. The host preparation callback returns a synchronous final guard.
The SDK validates unsupported/missing capabilities instead of silently falling
back to ordinary abort.

Preparation receives a frozen capability facet with only `doc` and `replaceDoc`, rather than a
native transaction. A request explicitly admits each required host document,
its address and read/write mode through `hostDocuments`. SDK-reserved `pi.*`
addresses are refused, including forged aliases admitted by the caller. The CP
bridge admits only its qualification fence in read mode. Native task, input,
conversation and entry mutation methods are unavailable during preparation.

Document reads return detached, deeply frozen JSON snapshots. Read mode requires
an existing document at the declared version and never initializes or migrates it.
`replaceDoc`
requires write admission and immediately copies a replacement candidate; staged
replacements are applied only after successful preparation. The facet is revoked
when preparation settles, including rejection, so retained references cannot
change committed state. Native scope and receipt values remain
detached and frozen. This boundary prevents preparation from adding an input
that the SDK would withdraw without including it in the captured receipt.

The Node SQLite implementation runs every asynchronous preparation and SQL write
inside its transaction, then executes the final guard immediately before
synchronous `COMMIT`, without an intervening await or callback. Guard rejection
is reported as a proven storage rejection only after successful rollback. A
rollback failure or ambiguous commit retains the existing poisoned-session
behavior. Thenable/non-void guards are rejected; draft document references must
be converted to detached values before returning the guard.

`readAbortReceipt` observes historical evidence without authorization or scheduler
activation. Exact replay returns the retained receipt without preparing another
abort; changed request bindings are a conflict. `drainAbortReceipt` waits only
for the receipt's selected task IDs, without selecting a successor scope or
holding the mutation line. Successful native commit and subsequent drain are
separate facts. Ordinary `Conversation.abort` retains its existing behavior.

Only a single owning Session over the supported Node SQLite backend is qualified
by these tests. Other storage implementations remain unavailable unless they
implement and prove the explicit guarded capability. This is not a distributed
CAS or a multi-Session/all-writer fence.

## CP qualification bridge

The engine's explicit qualification capability prepares an identity-bound target
before final asynchronous authorization. It pins the current turn, exact live
task records, queued native submission records and local fence revision. At N it
compares the actual SDK scope and rejects changed queued input or successor work.
The final synchronous storage guard also rechecks current turn and trusted time.

The lead service returns the existing, validated receipt deadline from its fenced
authorization. `assertFencedBinding` already proves that exact deadline against the
current product, execution, attempt and optional preparation minimum. The adapter
carries the minimum of that pin and admission expiry into the native guard. This
transports existing authority evidence rather than adding another asynchronous
sample after the final guard.

The live fixture's product/deadline writers commit actual native F and await its
acknowledgment before publishing their canonical R. Product assignments queue
publication; reads and armed race hooks flush that queue. This is participation
by the explicitly registered fixture owners, not a claim about unseen writers.

For this opted-in fenced path, a refused N leaves the journal running with no
cancellation intent and no native abort. A successful native receipt precedes
journal cancellation publication; a racing or lost publication is reported as
unknown, never as proof of zero effect, and does not rewrite a successor. The
ordinary production path remains unchanged and unqualified by this fixture.

## Historical observation by an existing owner

The opt-in engine exposes `readReceipt` and `drainReceipt` only for an already
initialized, explicitly owned qualification harness. They do not open a session,
resolve models, authorize an inference, submit input, resume scheduling or commit
another abort. An unopened, still-opening or closed owner is unavailable.

Observation binds the native conversation, request ID/digest and retained target,
expiry, turn and inference metadata. Retained fence revision and scope digest
must have the expected format; the input does not supply independent expected
values for them. Drain first validates the historical receipt, then waits only
its selected task IDs and verifies the returned receipt has not changed. Expired
pins can identify historical evidence; they do not grant permission for a new
effect. Neither operation settles a journal or supplies current authority.

A discarded native reply can therefore be observed through its existing owner.
The publication regression also commits actual native cancellation, then faults
journal record lookup, claim or update, or races a successor. A validated native
receipt followed by publication failure remains a non-retryable
`PI_NATIVE_CANCELLATION_PUBLICATION_UNKNOWN`; an existing owner's repeated receipt
reads and drains cause no second abort, provider request or journal settlement.
The same four cases run against compiled output in pinned Node 24 SQLite.

An actual Node 24 subprocess regression also parks after committed N and exact
receipt verification, before returning to the adapter's journal publication.
After a confirmed SIGKILL, two fresh authorized adapter processes retain
`unknown` with the same pending inference and no second inference authorization,
engine, provider request or usage settlement. They invent no cancellation intent,
native receipt or terminal result. The receipt is observed only before the crash;
this is negative no-repeat evidence, not unopened receipt recovery or positive
cancellation settlement.

This does not implement an adapter recovery consumer, complete a lost-journal
publication recovery journey or provide read-only reopening. The ordinary engine opener
checks authority/models, initializes host state and registers an owner. SDK
`Harness.open` also reconciles surviving tasks. Calling those openers cannot be
described as mutation-free historical observation.

## Proposed read-only SDK reader — not implemented

The proposed public SDK contract is a one-shot
`readNodeSqliteAbortReceipt(existingPath, { conversationId, requestId }, context)`
returning `Promise<AbortCommitReceipt | undefined>`. It exposes no open/read/close
handle. The SDK would own its supported receipt format; CP would not inspect
private document addresses or SQL. Each call must open an existing supported
store read-only, observe one consistent committed snapshot, and close on success,
failure or cancellation. It must not create a Harness, Session, scheduler, model,
registry, owner, root, store or document; run migrations; reconcile tasks; configure
journal mode; checkpoint a WAL; or repair corruption. The existing Node opener
configures WAL and its close path checkpoints, so those lifecycle paths cannot be
reused as evidence of a mutation-free reader. Missing, incompatible or corrupt
stores fail unavailable rather than looking like an absent receipt. Drain remains
an existing-owner operation.

Before implementation or qualification, actual SQLite proofs must establish:

- Existing running tasks, queued inputs, documents, receipts and logical database
  contents remain unchanged through repeated successful, failed and cancelled
  one-shot reads, including their internal closure.
- No scheduler, abort, provider, model or host-authority callback runs; an absent
  path remains absent, and reading creates no database/schema artifacts.
- Conversation/request bindings are exact; a committed receipt survives a lost
  reply and reopen, while missing evidence remains missing.
- Supported committed-WAL snapshots and any concurrent-owner mode have explicit
  mutation-free evidence; unsupported combinations fail unavailable.

This is a proposed source/API contract requiring further review, not an available
upstream API or an implemented compatibility extension. Historical store evidence
also cannot establish an independent restore generation or current authorization.

## Qualification and remaining obligations

Actual disposable SQLite regressions cover rollback after late SQL preparation,
paused-scheduler rejection, missing/unsupported guards, N/F ordering, replay,
reopen and separate drain. The two original final-authorization revocation and
deadline tests are unchanged. Additional CP regressions cover natural earlier
expiry without a canonical mutation and newly queued input after preparation.
Executed results and exact published heads are recorded in the PR receipts;
this document does not turn a focused pass into a complete suite result.

Independent restore-generation authority outside every restored store, old-writer
quiescence, full product/CP writer registration and acknowledgment, production
composition activation, installed/profile/live qualification and the aggregate
acceptance issues remain open. The earlier dormant coordinator still returns
`qualifiedAuthorization: false`; its default native and generation ports remain
unavailable. No credentials, service provisioning or deployment is introduced.
