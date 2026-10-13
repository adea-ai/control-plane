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
same repository CAS seam. Dispatch calls and automatic lifecycle recovery
scheduling are separate composition work (#1019 and #1048). These APIs do not
start a runtime, create an engine session, or deliver a product timeline event.

The added namespaces use the existing generic record table, with no schema
migration or credential changes. Receipt retention/deletion scheduling is not
added here; the lifecycle/retention owners must account for these namespaces
when wiring automatic recovery and cleanup.
