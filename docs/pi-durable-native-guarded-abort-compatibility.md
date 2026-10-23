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
