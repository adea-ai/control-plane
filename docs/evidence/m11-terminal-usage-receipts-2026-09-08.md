# Local unsuccessful-terminal usage receipts

The direct Local runtime now persists authoritative `terminalUsage` observations
in SQLite namespace `runtime-terminal-usage`, keyed by execution and attempt.
The record contains schema version, execution/attempt identity, runtime handle,
terminal state and usage. It is written before the cancellation effect is marked
complete, so normal workflow cleanup follows durable receipt storage.

Completed execution results are unchanged. Cancelled work stays cancelled; this
does not manufacture a completed result. Missing native usage does not create a
zero-valued receipt. A mismatched cancellation handle is rejected. A different
receipt for the same execution/attempt fails with `RUNTIME_TERMINAL_USAGE_CONFLICT`
instead of overwriting the original observation.

Regression coverage reopens SQLite after cancellation and after an injected loss
of the cancellation-effect commit. It verifies receipt survival, rejection of a
changed usage value, and reuse of the same cancellation idempotency key. A lost
effect commit can resubmit that key to the adapter; adapter-side idempotency is
still required. No test claims that all runtime implementations provide it.

This receipt is recovery evidence, not a posted billing entry, a cost estimate,
or proof of aggregate native usage. The namespace must remain in whole-directory
checkpoints and must not be purged before settlement/recovery references and
applicable holds are resolved. No independent retention timer is introduced.
Hosted server, Gateway delivery and billing-ledger integration remain separate
M11 obligations. A missing or ambiguous native usage result remains unresolved,
not free execution.

Local validation passed 41 builds, type checking, lint, formatting, and 1,248
unit/E2E/smoke tests (1,053/126/69). The SQLite fault/replay scenarios are in
`apps/local-control-plane/src/terminal-usage.test.mjs`.
The repository integration runner also passed, including PostgreSQL service-loss,
restart and backup/restore drills. Its scripted remote-node scenario is not native
cancellation or billing proof. The task-owned database container and volume were
removed after validation.
