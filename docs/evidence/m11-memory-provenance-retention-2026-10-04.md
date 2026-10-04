# M11 memory proposal provenance retention

This bounded repair addresses #194 and CP-CONS-026. A durable memory proposal references its source
Execution and ExecutionAttempt. Expiry of the execution window must not remove that source while
the proposal coordination record still exists, including denied, expired, revoked, failed and
reconciliation-required proposal states.

## Change

SQLite and PostgreSQL execution eligibility now count positive memory proposal source references.
A damaged proposal that still identifies a source execution or one of its existing attempts
retains that owner. An unrelated execution and attempt do not retain it. This does not introduce proposal deletion policy.

Ordinary and approval-required proposal insertion validate the source execution's workspace and
the source attempt's execution membership inside the same transaction as the proposal insertion.
A failed scope check rolls back the proposal and dedupe reservation. PostgreSQL holds source owner
and attempt `KEY SHARE` locks through commit; retention claims the owner and attempts `FOR UPDATE`
before checking references. SQLite serializes the same operations through its existing transaction
port. A shared identity assertion makes compare-and-set preserve workspace, dedupe hint, source
execution and source attempt in SQLite, PostgreSQL and the in-memory test repository.

The PostgreSQL fixture seeds a valid owner for existing proposal persistence coverage. The new
seven-case provenance suite is assigned to the existing third Neon shard, with isolated databases,
serial file execution and existing per-case budgets. The foundation's 65 names and 37/28 split
remain unchanged.

## Observed validation

Using Bun 1.4.2, the added SQLite regressions failed against the unchanged implementation: 14
failures in 719 ms. They reproduced deletion of referenced sources in all ten proposal states,
acceptance of absent/mismatched ownership, a proposal created after retention deleted its owner,
and source/dedupe identity mutation.

After the repair, the affected execution-retention file and existing atomic proposal file passed
28 tests and 166 assertions in 894 ms. The test used source aliases for this checkout's workspace
packages and reused existing external dependencies. The temporary aliases were restored afterward.
Formatting, denied-warning lint and Node 24 syntax checks passed for the affected source/tests.
An initial malformed test invocation selected the workspace script and stopped after 2.859 seconds
on a missing dependency; that attempt is not regression evidence and was not repeated.

No local Docker command or dependency installation was used. Independent standards and spec
source reviews completed; their attempt-reference, identity-parity, query-result alignment and
full-state coverage findings were addressed before the ready-for-review transition.

The [PostgreSQL CI run 37168042195](https://github.com/adea-ai/control-plane/actions/runs/37168042195)
passed on exact head `48f6980a79505a66cc2c39396f72f0340f1dde01`. All seven new provenance cases
passed on 2026-10-04 at 01:28:03–01:28:06 UTC, including both transaction orderings, all ten proposal
states through fresh connections, damaged attempt provenance and mixed usage/delegation references.
The database package passed 184 tests with zero failures; the PostgreSQL conformance lane also
passed 11 cases. This is ephemeral PostgreSQL CI proof, not real-provider or deployed-profile
acceptance.

The first full validation and Foundation Core runs failed because `tests/repository.test.mjs`
still expected the integration inventory without the new file. Actual discovery included the file
correctly. On 2026-10-04 at 01:30:45 UTC the focused native inventory test reproduced that failure;
after adding the filename to the exact expected integration list and explicitly excluding it from
unit discovery, the same command passed one case in 544 ms:

```sh
bun test ./tests/repository.test.mjs --test-name-pattern 'discovers disjoint Bun test groups'
```

The inventory repair changes no PostgreSQL production code or case body. The final publishing head
still requires full CI after this repair; the failed earlier aggregates are not passing evidence.

## Review repairs and reproducible candidate

The read-only spec review found that a surviving attempt identity also needs to pin its owner
when the proposal's execution identity is absent or incorrect. The standards review found that
the in-memory compare-and-set allowed identity mutations rejected by the durable adapters.
Both new regressions failed before these fixes (two failures, 2026-10-04 00:42:34 UTC).
The updated PostgreSQL damaged-provenance case covers both surviving-attempt forms as well.
The independent standards review then caught a missing result slot in the new PostgreSQL reference
query fanout. The repaired mapping retains the separate memory-attempt result and preserves the
usage/delegation slots. A seventh PostgreSQL case checks memory, usage funding parent and both
delegation endpoint references together; its runtime result passed in the CI run above. The final spec
follow-up expanded the PostgreSQL lifecycle loop to all ten proposal states within its existing
case budgets; no per-case deadline or product behavior was changed.

Fresh source validation ran on 2026-10-04 01:15:39 UTC, from baseline
`3d066a32ebfa56f5ab04675ae7e2484cde99ab68`. Bun 1.4.2 and Node 24.21.0 were selected.
The profile was an embedded Local SQLite fixture plus the in-memory proposal repository;
no workflow runtime, transport protocol, provider service or deployed environment was involved.
SQLite fixtures migrated using this candidate's source migration implementation (schema version 2). Temporary
workspace source aliases and shared existing external dependencies were used, with no install;
the aliases and per-package dependency links were removed immediately afterward.

Commands and observed results:

```sh
bun test ./packages/sqlite-persistence/src/retention-executions-deletion.test.mjs ./packages/sqlite-persistence/src/memory-write-proposal-repository.test.mjs ./packages/memory-writeback/src/index.test.mjs
# 52 pass, 0 fail, 310 assertions; 509 ms native runner, 568 ms process wall time
bun test ./tests/integration-shards.test.mjs
# 5 pass, 0 fail, 129 assertions; 75 ms native runner, 129 ms process wall time
```

Each process had a 20-second outer ceiling. The second command also proves the unchanged
65-case foundation inventory, disjoint 37/28 slices, and one shard owner for the new seven-case
PostgreSQL file. Shared local Acorn is 8.18.0; exact-head CI will use locked Acorn 8.16.0.

The source/test working candidate (documentation excluded) is identified by the SHA-256
`421d3dec8f597d440935afd799e0af2e520d5826b456c5de1423be15f07dd8d6` over the following sorted filename-to-SHA-256 map;
the publishing commit and its exact-head CI are separate evidence gates.

| Source or test                                                           | SHA-256                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `packages/database/src/execution-repository.ts`                          | `480d26dd8e1c05bcd56f1c4644156aac956412c6ac88fd5157ee1f6246c2a758` |
| `packages/database/src/integration.test.mjs`                             | `db76323f8761ad28e9bf7fa99c681bce489c56188ee8c10a14c1c73a1f2bad8c` |
| `packages/database/src/memory-provenance-retention.integration.test.mjs` | `bd366990b646f4cea27e1fe74a6e7ba19a3d87251a3de4f41b157992605b14fe` |
| `packages/database/src/memory-write-proposal-repository.ts`              | `7662a9051a30ea82fcdadf2158336bace41fa60d6e61440f9e27a4235fbc0d5d` |
| `packages/memory-writeback/src/index.test.mjs`                           | `f9e2a140d9cd31a5f00c4c9b0dfe08d204bae480d26036654d80b28133cef313` |
| `packages/memory-writeback/src/index.ts`                                 | `04aa8a85670b3a0b016788e48185a53cba3371ce8dbdeedc2669adfe18bb544f` |
| `packages/sqlite-persistence/src/memory-write-proposal-repository.ts`    | `5e8ee82c4a26316b55554d649d0fc913c6dcc3708c349bf128bb453b8b3c8702` |
| `packages/sqlite-persistence/src/repositories.ts`                        | `aeca851c0cf60d8a90865cc5b078ea3b0bd7dff2d535492f5c37b7a72e567d01` |
| `packages/sqlite-persistence/src/retention-executions-deletion.test.mjs` | `187ccd7fecafaf95f9c2d47d89dfc895e53b689139fea9698ae0d20e75917b3f` |
| `scripts/integration-shards.mjs`                                         | `c5459028489f0966bb464b8149df9327af797a0711e541a8d0c300324d722e9f` |
| `tests/repository.test.mjs`                                              | `49404aed1d4f23052848d4541c3aa44670c8f2f3380df697663ba8a34ee96fe3` |

## Remaining acceptance

CP-CONS-026 remains partially verified. MemoryWriteService has no non-test application-composition
consumer. Actual provider authority, process-loss recovery across the supported profiles, provider
memory retention/deletion, and proposal/Interaction cleanup policy still need acceptance evidence.
This repair neither certifies those gates nor changes their ownership under #194.
