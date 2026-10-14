# SQLite child admission and terminal receipts

`SqliteDelegationRepository` stores CP child jobs under their canonical
`childExecutionId`. Allocation retains the authorization request and receipt,
the initial attempt mapping, the execution/attempt, the delegation, and the
budget reservation in the same existing SQLite transaction. Duplicate allocation
keeps its existing `false` result; `getAdmissionReceipt(delegationId)` retrieves
the first committed receipt. Reading this historical evidence does not authorize
another dispatch, model selection, or budget allocation.

## Native session mapping

`getChildMapping(childAttemptId)` resolves the admitted CP job and attempt.
After an authorized runtime start, a trusted dispatch caller can complete the
mapping with `bindChildSession(expectedDelegationRevision, mapping)`, including
the returned handle's `externalSessionId`. The write verifies the current
canonical child execution, attempt, plan, workspace, and runtime connection in
one transaction. One runtime-qualified native session cannot map to two child
attempts; an attempt's retained native session cannot be reassigned.

`findChildBySession(runtimeConnectionId, externalSessionId)` performs the reverse
lookup and verifies the matching attempt index. Mappings retain historical
attempts; callers must revalidate current authority before runtime effects.
Legacy admission rows without retained authorization receipts are not upgraded
into invented grants. Session binding can retain an existing legacy attempt's
mapping after checking its canonical records.

## Terminal recovery

The repository's existing `compareAndSet` atomically commits the terminal
outcome and its complete publication receipt. The outcome, occurrence time,
child attempt, result/failure, resolution, and cancellation reason cannot be
rewritten once the intent is retained. A failed CAS creates no receipt.

`recoverTerminalPublication(delegationId, publisher)` reads and verifies the
committed intent before invoking the supplied durable, idempotent publisher,
then CAS-acknowledges the record and receipt together. A crash before publishing
leaves a pending receipt. A crash after inbox retention but before acknowledgement
replays the same key and payload; the inbox deduplicates it. Publication failure
leaves the intent pending. Existing pending intents can acquire the complete
receipt; legacy terminal rows without an intent are never published by inference.

The ordinary `DelegationService` terminal replay continues to work through the
same repository CAS seam. `CanonicalDelegationRuntimeBridge` can opt in with
`childReceipts: repository` and a durable `terminalPublisher`. Its `startChild`
binds the parsed returned native handle to the current canonical attempt; its
`recoverTerminalPublication(identity)` verifies the retained parent/attempt
binding and delivers the receipt without starting a runtime or requesting new
budget/dispatch authority. The two-sibling host fixture exercises these ports
with real Pi sessions and a fresh canonical SQLite connection after a failed
terminal publication. Hosted/Local composition and automatic lifecycle recovery scheduling remain
owned by #1048; sibling dispatch remains owned by #1019. Repository receipt
operations and the bridge terminal-recovery entry point do not start a runtime,
create an engine session, or deliver a product timeline event.

The added namespaces use the existing generic record table, with no schema
migration or credential changes.

## Receipt retention (#1022)

`delegation-admission-receipts`, `delegation-child-mappings`,
`delegation-native-sessions`, `delegation-runtime-lookups` and
`delegation-terminal-receipts` are reference-governed evidence. They carry no
age clock and no deletion path, and no retention period is added for them. Each
row names the parent and child executions it was written for (admission and
lookup receipts also name the plans), and the existing `executions` and
`execution-plans` retention classes refuse to delete an owner while any of these
rows still names it, whether or not the `delegations` row is still present
(`delegation-retention.ts`). The receipt writers record those owners in the same
transaction in `delegation-receipt-owner-pins`, together with the namespace that
named each owner, so a retention candidate costs one exact-key read per owner
instead of a scan of every retained receipt, and a writer that skips its pin
cannot hide behind another writer naming the same owner. Rows retained before the
index existed are indexed by the first applying sweep, outside the candidate loop,
one page of 64 rows per transaction with the cursor persisted in the same
transaction, so no transaction holds the write lock for more than a page and an
interrupted backfill resumes where it stopped. A page writes at most 257 records
for well-formed admission rows (two executions and two plans each) and at most
`RECEIPT_PIN_BACKFILL_MAX_WRITES` (385) for the widest row a damaged legacy
admission row can be. A dry run writes nothing and reads the same rows in
bounded pages, but it is not lock-free: every SQLite provider transaction begins
as `BEGIN IMMEDIATE`, so each page still takes the write lock for the length of
one bounded read, and so does the marker read and every candidate's exact-key
reads. The bounds shorten each hold; they do not remove it. The index is append-only like the receipts it
mirrors. A pending terminal publication intent and a native-start lookup receipt
are therefore never swept away before their repair path has read them, and a
published receipt is retained as well.

The owner decided which existing class governs their eventual deletion (#1022)
(`delegationReceiptRetentionClass`): admission, mapping, native-session and
lookup rows belong to `native-admission-fences` (unbounded), terminal receipts to
`native-terminal-snapshots` (30 days from eligibility). That records ownership
only. Until a deletion path with settlement and reference proof is built and
registered in `scripts/retention-classes.mjs`, they outlive every sweep. A test
fails when a new `delegation-*` namespace is written without being classified.
PostgreSQL does not hold these namespaces.
