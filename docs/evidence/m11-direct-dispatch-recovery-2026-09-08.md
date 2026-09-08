# M11 direct-runtime dispatch recovery

A SQLite-reopen regression demonstrated that a lost native start acknowledgment
caused `DirectRuntimeActivityPort` to call `runtime.start` again. The old durable
effect record was written only after the entire operation completed, while the
packaged Pi client kept start deduplication only in memory.

Dispatch now commits an intent in the existing `workflow-effects` namespace
before calling the runtime. Repeated callers within one composition share the
same pending promise. Stored completed outcomes still replay normally. An
unresolved intent without a handle returns `LOCAL_RUNTIME_DISPATCH_AMBIGUOUS`,
with `retryable: false`, without starting native work again. A saved handle may
recover a schema-valid terminal result through runtime reconciliation, but only
when every handle identity field matches. Nonterminal, missing, or mismatched
native state remains ambiguous. An ambiguous observation does not overwrite a
concurrent owner's eventual completed effect record.

Four focused tests passed with 20 assertions: lost start ACK after SQLite reopen,
lost result after reopen, an older saved handle without an intent, and concurrent
dispatch with completed-outcome replay. The original lost-ACK regression failed
before the guard was added. After merging current main, local lint, type checks,
formatting, and the full root test command passed with all four regressions,
including 101 E2E tests and 571 assertions.

A follow-up artifact-storage failure regression failed before terminal-state
reconciliation was added, then passed with one native start. It verifies that the
recovered result and usage are persisted and subsequently replay without another
native query. Negative cases keep still-running work and a wrong-handle terminal
response ambiguous, with no result Artifact written.
The expanded focused suite passed seven tests with 40 assertions; the full local
checks also passed, including 101 E2E tests with 571 assertions.

This is ambiguity containment, not native runtime reattachment or full M11
recovery acceptance. A runtime may still be executing, and cleanup may require
operator reconciliation. Older lost-ACK work with no durable intent or handle
cannot be detected retroactively. The operations runbook requires preserving
evidence and reconciling work, Artifacts, and usage before authorizing a retry.
