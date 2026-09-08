# M11 recovered native Pi terminal cancellation

Two process-backed regressions reproduced `MANAGED_PI_EXECUTION_MISSING` when
cancelling a retained succeeded or cancelled attempt after cleanup and client
recreation. Status and cleanup could already recover terminal records, but
cancellation required an in-memory execution.

Cancellation now reads the validated retained terminal snapshot when no live
execution exists. It preserves success, cancellation or normalized failure;
it does not launch a process, send another abort or rewrite the outcome. Missing,
corrupt or identity-mismatched evidence remains reconciliation-required rather
than being fabricated as cancelled. The live-execution cancellation path is
unchanged. This addresses terminal precedence/replay, not in-flight attachment.

Process-backed tests cover retained success, cancellation and failure, plus
forged start identity and corrupt storage. Root lint, type-check, format-check
and the full suite pass: 995 unit, 105 E2E and 67 smoke tests, with 41 workspace
builds.

The real native certification runner also passes with Pi 0.84.2, Node 24.18.0
and Bun 1.4.0, isolated configuration and a deterministic local model endpoint.
After cleanup and client recreation, eight cancellation calls return the exact
original succeeded snapshot including output/usage, and cancellation of the
retained cancelled attempt remains cancelled. Original event history still
matches. The complete runner retains exactly three model requests, including
its real Local SQLite/Restate composition scenario. The report records
`terminalCancellationAfterCleanup: original-terminal-state-no-new-request`.

The disposable installation was moved to Trash; task-owned runtime/model/Restate
processes completed cleanup and checked ports were closed. No global Pi install,
user credentials or provider configuration was changed. Native tools and ambient
context remained disabled. Native approval and in-flight restart reconciliation,
managed-cloud hosting and full milestone acceptance remain unverified.
