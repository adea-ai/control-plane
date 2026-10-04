# M11 approved memory intent preservation

Status: source repair with bounded Local SQLite/in-memory evidence. Full candidate CI and
PostgreSQL execution remain pending. Issues #188, #194 and #195 remain open. This is a
follow-up to [source provenance retention](./m11-memory-provenance-retention-2026-10-04.md),
not whole-milestone or provider transport acceptance.

## Behavior and source

Base: `2203507cfef2c6e7397938103425b4a93827ba95` (main after PR #889).
`assertMemoryWriteProposalIdentity` is shared by the in-memory, SQLite and PostgreSQL
compare-and-set adapters. It now compares the entire schema-defined proposal input plus
creation time and approval interaction identity, before either durable adapter updates.
The approved effect cannot change its provider/connection/scope, content/digest, memory
kind, retention, provenance, dedupe identity or approval link. Lifecycle fields remain
mutable through the existing version check; stale callers still return false.

The PostgreSQL suite extends its existing transition case, keeps its seven-case inventory
and existing shard assignment/deadlines, and checks rejection without changing the stored
record. In-memory tests cover the same fields. The new SQLite case obtains an actual durable
InteractionService approval, tries 19 individually schema-valid mutations, verifies the
record is unchanged, closes/reopens schema-v2 SQLite, and commits once through a recording
fake provider with the exact original payload. No migration or new dependency is required.

## Bounded verification

Bun 1.4.2 (`744846f84`), Node 24.21.0, own-source workspace aliases, existing shared external
dependencies; no install, build, Docker or server. Each command had an outer 20-second
process limit. SQLite fixtures close providers and remove their temporary directories in
finally blocks. Source aliases and dependency links are restored/removed after each run.

Command:

```sh
bun test ./packages/sqlite-persistence/src/memory-write-proposal-repository.test.mjs ./packages/memory-writeback/src/index.test.mjs
```

- RED, 2026-10-04T01:48:46.868658Z–01:48:47.272760Z: 27 pass, 2 fail,
  156 assertions, native 381 ms, process 404 ms. The first newly allowed provider mutation
  persisted rather than rejecting in both adapters.
- Initial GREEN attempt at 01:48:58Z: SQLite passed; in-memory failed because its fixture
  tried attaching an approval to the schema's `proposed` state. Corrected the fixture to
  create an actual awaiting-approval pair, and the PostgreSQL fixture to use an approved
  proposal before testing link mutation. The production guard was unchanged.
- GREEN, 2026-10-04T01:49:25.760346Z–01:49:26.056909Z: 29 pass, 0 fail,
  228 assertions, native 263 ms, process 296 ms.

Full format/lint/type/build/unit/security/integration gates are CI acceptance, pending
publication. No local PostgreSQL runtime was started. Source fingerprints below bind the
prepared candidate source/tests; documentation is excluded to avoid self-reference.

## Limits and remaining acceptance

The repositories are persistence boundaries, not provider authorization ports. Existing
stored intent is treated as the immutable baseline; the change cannot detect or repair
previously altered records. Application composition, provider transport/current write
authority, real profile process-loss recovery, provider corpus deletion and complete
proposal/interaction retention remain unverified. The current Railway deployment runs
`a8e18adcfee468b584133319335fe85186d0cfb6`, not this candidate. Release publication remains
blocked by the existing PAT release permission failure. No requirement-ledger classification
is promoted on this evidence. Owner: Control Plane maintainers / current M11 root lane;
review date: 2026-10-04. Merge gate: independent review and exact-head required gates plus
PostgreSQL suite. Cleanup is a separate completion gate; Docker storage reclamation remains
unverified.

## Prepared source identity

| Source/test                                                                 | SHA-256                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/memory-writeback/src/index.ts`                                    | `a9c726485b8c82675483dead91951f86c982a64a0b74504ef365fb39e17fbabc` |
| `packages/memory-writeback/src/index.test.mjs`                              | `a015a267891e17ccf1d6886df0772c865d044a6ddd56434bfd2932dc93395953` |
| `packages/sqlite-persistence/src/memory-write-proposal-repository.test.mjs` | `5805abe08a7eec883eb0bcf6e0f59a7cf78936c4df29fde7711eeaed8998a0fd` |
| `packages/database/src/memory-provenance-retention.integration.test.mjs`    | `15bf583739cb68c36f8bbdb101106cb0373d246e3358e37e9cc4ba5b715d1a43` |
