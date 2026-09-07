# M11 Local checkpoint recovery — 2026-09-07

## Candidate and scope

Based on merged main `293ad418469ee356f7dbe4523c8bd6896f958f4f`, the repository E2E
`tests/m11-standalone-e2e.test.mjs` now runs both same-directory restart and separate-directory
filesystem-checkpoint restoration of a suspended graph approval. This uses the real
`LocalControlPlaneComposition`, bundled Local Restate, SQLite persistence/checkpointer, filesystem
object storage, and repository checkpoint create/verify/restore functions.

The graph and runtime are deterministic fixtures. This is not live managed Pi, supported ACP
launcher, packaged desktop, sleep/wake, fresh-VPS, or cloud recovery certification. Local loopback
Restate accepts unsigned requests in this harness; staging request-signature evidence is separate.

## Exercised recovery boundary

1. Start the Local composition and persist the execution plan and accepted command.
2. Submit the graph workflow to real Restate and wait for durable `awaiting_input` state.
3. Confirm the graph preparation operation ran once and persist a pre-existing artifact.
4. Close the composition and its Restate child before taking the checkpoint.
5. Create and verify a complete data-directory checkpoint, then restore into a distinct, previously
   nonexistent directory. Preserve the original until test cleanup.
6. Start a new composition against the restored directory; check the suspended execution state
   and the exact pre-existing artifact digest.
7. Reject an invalid interaction response, accept the valid approval, and attach to the completed
   Restate workflow. Verify terminal execution/artifact references and result body.
8. Confirm the observed operation sequence is exactly `prepare`, `finalize`, with no preparation
   repeated after recovery. Close the composition and remove the task-owned directory tree.

Focused validation passed both recovery variants: 2 tests, 25 assertions. Workspace lint, type-check,
format verification, and the full test command passed; the E2E group passed 101 tests and 569
assertions. The checkpoint variant
took approximately 6.4 seconds end to end in this sample, including initial startup and execution;
that duration is not a measured recovery-time objective. Full loss scenarios, independently measured
RPO/RTO, production versions and platform-specific operational certification remain open under
M11.3 and M11.9.

Reproduce after `bun run build`:

```sh
bun test tests/m11-standalone-e2e.test.mjs --test-name-pattern 'real Local Restate'
```

The test is also part of the canonical `bun run test` E2E group; it requires no external credentials
or Docker PostgreSQL. It uses the existing Local test ports and runs its two cases sequentially.
