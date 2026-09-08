# M11 direct-runtime dispatch recovery

A SQLite-reopen regression demonstrated that a lost native start acknowledgment
caused `DirectRuntimeActivityPort` to call `runtime.start` again. The old durable
effect record was written only after the entire operation completed, while the
packaged Pi client kept start deduplication only in memory.

Dispatch now commits an intent in the existing `workflow-effects` namespace
before calling the runtime. Repeated callers within one composition share the
same pending promise. Stored completed outcomes still replay normally. An
unresolved intent or a previously saved handle for the same attempt returns
`LOCAL_RUNTIME_DISPATCH_AMBIGUOUS`, with `retryable: false`, without starting
native work again. An ambiguous observation does not overwrite a concurrent
owner's eventual completed effect record.

Four focused tests passed with 20 assertions: lost start ACK after SQLite reopen,
lost result after reopen, an older saved handle without an intent, and concurrent
dispatch with completed-outcome replay. The original lost-ACK regression failed
before the guard was added. Local lint, type checks, formatting, and the full root
test command also passed before the final legacy-handle test was added; that
additional focused test passed separately.

This is ambiguity containment, not native runtime reattachment or full M11
recovery acceptance. A runtime may still be executing, and cleanup may require
operator reconciliation. Older lost-ACK work with no durable intent or handle
cannot be detected retroactively. The operations runbook requires preserving
evidence and reconciling work, Artifacts, and usage before authorizing a retry.
