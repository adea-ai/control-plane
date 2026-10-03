# M11 memory approval atomicity — 2026-10-03

## Scope

This increment fixes the approval-before-proposal persistence boundary identified after #884.
It builds on main `c9aede640ce47f684efb4ee0145277a184dc59e6`. The executable proof covers the
memory-writeback library and its PostgreSQL and SQLite persistence adapters. It does not certify
application composition, real provider transport, process kill, full deployment profiles or M11.

## Behavior

Approval creation requires the repository's atomic `insertWithApproval` capability. Unsupported
adapters fail closed before creating a record. Both durable adapters create the proposal, dedupe
identity and linked approval inside one database transaction. A duplicate proposal creates no second
approval. A conflicting approval, source workspace mismatch or failed commit leaves neither new
record. Existing interactions retain their execution/attempt ownership checks and response CAS.
The in-memory test adapter publishes its pair in one event-loop turn.

SQLite now has a durable memory proposal adapter, including workspace dedupe and optimistic version
transitions. Reopening a persisted `committing` record uses provider status and never repeats the
write. The provider result in this test is an explicit fixture, not evidence of a live provider effect.

## Validation

The initial concurrency regression reproduced two pending approvals for one deduplicated proposal.
A separate regression reproduced briefly observing an approval without its proposal. Both are
retained as meaningful tests. Unsupported atomic persistence creates neither record.

The Docker substrate is Linux/arm64, Bun 1.4.2, unprivileged user `bun`, 2 CPU / 2 GiB for tests,
with PostgreSQL 18.6 Alpine pinned to digest
`sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873`.
No database port is published. Test roles are separate application, migration and administration
roles; fixture credentials are temporary and excluded from the evidence and repository.

Commands for the bounded durable proof:

```sh
bun test ./packages/memory-writeback/src/index.test.mjs \
  ./packages/sqlite-persistence/src/memory-write-proposal-repository.test.mjs \
  ./packages/sqlite-persistence/src/interaction-repository.test.mjs
RUN_DATABASE_INTEGRATION=true bun test --timeout 90000 \
  ./packages/database/src/integration.test.mjs -t 'atomically persists one proposal approval'
RUN_DATABASE_INTEGRATION=true bun test --timeout 90000 \
  ./packages/database/src/integration.test.mjs -t 'authorized interaction response|memory proposals'
```

The initial Docker run passed 30 tests / 174 assertions, the new PostgreSQL atomic case passed
1 test / 15 assertions, and the existing PostgreSQL interaction/proposal regressions passed
2 tests / 9 assertions. Unrelated PostgreSQL cases were explicitly filtered (64 and 63 respectively).
The final in-memory visibility correction passed this separate command on the host:

```sh
bun test ./packages/memory-writeback/src/index.test.mjs ./packages/domain/src/interactions.test.mjs
```

Result: 29 tests / 149 assertions passed, including the concurrent-reader regression that failed
before the synchronous insertion fix. The durable adapter source files remain unchanged. A missing test-image workspace alias was a setup failure, then corrected;
no assertion or runtime permission was weakened.

The final Linux Docker image rechecked the synchronous visibility correction and deterministic
SQLite ordering with networking disabled:

```sh
bun test ./packages/memory-writeback/src/index.test.mjs \
  ./packages/domain/src/interactions.test.mjs \
  ./packages/sqlite-persistence/src/memory-write-proposal-repository.test.mjs \
  ./packages/sqlite-persistence/src/interaction-repository.test.mjs
```

Result: **38 tests / 198 assertions / 0 failures**, with the same unprivileged user and 2 CPU / 2 GiB
limits. The PostgreSQL adapters are unchanged from their successful durable proof. The temporary
PostgreSQL container, its anonymous volume and network, and all fixture credential files were removed.
The proof image is retained for reproducibility; no task-owned service or listener remains.

## Broader validation qualification

`bun run build`, `bun run type-check`, `bun run lint` and `bun run format:check` passed.
`bun run test:group:e2e` passed 185 tests / 1,090 assertions.
The sequential `bun run test:group:unit` run passed 2,166 tests / 9,684 assertions but failed
one unchanged graph recovery test on its existing 30-second timeout. Isolated native and Linux
Docker diagnostics reproduced that timeout; no timeout or assertion was weakened. Timing
instrumentation showed increasing persistence work across approvals, but does not establish that
this patch caused the failure. The same test passed in 5.394 seconds in the previous candidate's
CI run `37146381079` (2,159 unit tests passed). The current candidate still requires its own full
CI validation; the previous result is context, not proof of this candidate. Host diagnostics
observed load averages around 150 and approximately 27 GiB of swap use during validation.
This qualifies local timing results; it does not waive the current candidate’s required checks.

## Remaining acceptance

CP-CONS-026 remains partially verified. Wire a supported application composition with its exact
provider authority and same-backend interaction repository. Exercise actual process-loss and provider
recovery across required profiles; complete proposal/interaction retention and reference protection.
Current fixtures and repository transactions do not supply those gates. Docker is the owner-selected
fresh environment; no VPS is required. Independent human acceptance remains separate.
