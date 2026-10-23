# ProjectState mutation digest compatibility

`ProjectState` mutations are identified by their `inputDigest`, the digest of the canonical mutation
input. The digest is what makes a retry idempotent: the same mutation ID with the same digest is a
replay, and the same mutation ID with a different digest is `MUTATION_ID_REUSED`.

This document describes how the digest's canonicalization is versioned, which records a reader may
accept, and what the change deliberately does not do.

## Why the digest needs a version

Two canonicalizations exist for the same mutation input:

| Form      | Canonicalization                                                                | Where it comes from                 |
| --------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| legacy    | object keys sorted with `String.prototype.localeCompare`, then `JSON.stringify` | the writer before the #659 cutover  |
| version 2 | object keys sorted in code-point order (`canonicalJsonStringify`)               | every writer since the #659 cutover |

The legacy form depends on the reader's ICU collation, so its output is a property of the _host_
rather than of the input. A record written by a legacy writer therefore does not say which
canonicalization produced its digest, and a reader has to try more than one form to verify it.

The versioned record removes that ambiguity for new records. The reader reads the version the record
carries and verifies against exactly that canonicalization.

## Reader-first order

The reader always follows the record, never the writer that is replaying it.

1. **Read the record's own version.** `AppliedStateMutation.inputDigestVersion` is the canonicalization
   the writer used.
2. **Versioned record (`inputDigestVersion = 2`).** Verify the digest against the code-point form
   only. A legacy digest stored under a versioned record is refused, because the record says the
   digest is a code-point digest. The version and the bytes it stands for come from one table:
   the writer derives the digest from the version it records, and the reader verifies against the
   version the record carries, so a record can never claim a canonicalization its bytes were not
   produced with. A version this release has no canonicalization for has no digest at all: the
   writer refuses to record it and the reader fails closed.
3. **Untagged record (no version).** The record predates explicit versioning. Verify against the
   code-point form first, and then against the legacy locale-dependent form. This is the
   compatibility window; it is exactly the dual-accept behaviour that shipped with #659.
4. **Unsupported version.** A well-formed version this release does not know is refused with
   `MUTATION_DIGEST_VERSION_UNSUPPORTED`. The reader does not fall back to the untagged path, because
   a record that names an unknown canonicalization must not be reinterpreted as an older one.
5. **Malformed version.** A version that is not an integer is rejected by the record schema before
   any verification happens. The reader fails closed.

An altered input is refused in every case: the digest of the altered input does not match the
recorded digest, so the replay is `MUTATION_ID_REUSED` rather than a silent acceptance.

The ordinary replay (the record already existed when the mutation arrived) and the compare-and-set
loser (the record was written by a concurrent writer while this attempt was in flight) resolve
through the same verification, so they accept exactly the same records.

## Supported profiles

The code-point form is profile independent: any runtime that implements `canonicalJsonStringify`
produces the same bytes, and a versioned record verifies identically everywhere.

The legacy compatibility form is not. It reproduces the historical bytes only where the reader's
locale collation matches the writer's. The frozen fixtures in
`packages/domain/src/project-state-digest-history-fixtures.mjs` were produced by the verbatim
pre-change writer at base commit `6f56fca3581b8799e496fe575d7dca72a1dfcbaf` under this profile:

| Runtime    | bun   | ICU  | resolved default locale |
| ---------- | ----- | ---- | ----------------------- |
| generation | 1.4.2 | 78.1 | `en-US`                 |

Those fixtures are frozen witness bytes. `sha256(canonicalBytes)` equals the recorded digest
independently of any host, so the bytes authenticate each other without a same-host regeneration; a
host that re-derives the legacy digest with the current code is a consistency check, not independent
historical proof.

Readers whose collation differs from the generation profile may not reproduce the legacy digest from
the mutation input. That is the bounded cost of the compatibility window, and it is the reason the
versioned record exists.

## Writer paths

The default writer is unchanged. It writes the code-point digest and records no version, so the
stored bytes of an existing deployment do not change and no retained record is rewritten.

The versioned writer is explicitly opt-in, on every write path that can persist a mutation record:

```ts
await service.applyMutation(input, { digestVersion: 2 })
await service.mergePromotion(input, { digestVersion: 2 })
```

Only those paths record `inputDigestVersion`. The published `project_state.updated` event carries the
version when the writer recorded one, and is byte-identical to the previous payload when it did not.
The digest a versioned writer stores is derived from the version it records, so the tag and the
bytes cannot disagree.

## Storage

- **SQLite.** The mutation record is a JSON document, so the version travels with the record. No
  schema change is required.
- **PostgreSQL.** `project_state_mutations.input_digest_version` is a nullable `integer` column.
  `NULL` means untagged. Migration `0075_project_state_digest_version` adds the column; it is a
  single additive `ALTER TABLE ... ADD COLUMN` that moves no data. It is sequenced after migration
  `0074_dear_talisman` (`executions.model_id`, CP #678), whose files this branch carries
  byte-for-byte from CP #1210 so that either branch can land first. The PostgreSQL integration
  suite runs against the migrated schema.

## Rollback bounds

- Rolling back the _binary_ is safe. The version column is nullable, and the older reader ignores
  the column and the extra JSON field, treating a versioned record as untagged. Its digest is the
  code-point form, which the untagged compatibility path accepts. The PostgreSQL integration suite
  proves this by reading a versioned row with only the digest column and verifying it with the
  untagged reader.
- Rolling back the _migration alone_, with this release still deployed, is **not** safe: this
  release's projection selects `input_digest_version`, so the column has to exist. The migration has
  to be rolled back together with the binary.
- Rolling back the _binary and the migration together_ is safe, for the same reason as the binary
  rollback: the rows lose the version metadata, revert to the untagged interpretation, and still
  verify against the code-point digest they carry.
- A rollback never needs to rewrite a retained row, and never needs to recompute a digest.

## Retained-data limits

- No history is backfilled or rewritten. Rows written before this change keep their original bytes
  and stay untagged.
- No retained user data is mutated. The only new data is the version tag on rows written by the
  opt-in writer path.
- The compatibility window for untagged records is bounded by the retention of pre-cutover rows.
  Once no untagged rows remain, the legacy form can be dropped from the reader; the versioned
  records do not need it.

## Historical limitations that this change does not remove

These are pre-existing behaviours of the mutation path. They are recorded because the compatibility
window is where they are observed; this change does not alter any of them.

- The legacy canonicalization is locale-dependent, so an untagged record written by a legacy writer
  is only verifiable where the reader's collation reproduces the writer's. The frozen fixtures pin
  one profile; a reader outside it may not reproduce the legacy digest.
- A concurrent duplicate of the same mutation can be refused with `STALE_REVISION` instead of
  resolving as an idempotent replay, depending on the interleaving: the loser can observe the
  winner's revision before the winner's mutation record is visible to it. The write is still never
  duplicated — exactly one revision, one mutation record, and one event exist afterwards — and the
  deterministic compare-and-set loser path resolves the winner's record as an idempotent replay.
  Both outcomes are asserted by the PostgreSQL integration suite.

## Out of scope

This change does not backfill or rewrite history, does not deploy a migration, does not activate
anything in production, and does not change the default writer's output.

## Prerequisites that are still missing

- **Migration sequencing.** `0074_dear_talisman` and `0075_project_state_digest_version` are
  authored in this change and are the only migrations in the journal after `0073`. CP #1048 and
  CP #1210 each carry the identical `0074` files. Whichever branch merges second takes main's
  journal and snapshots; no `0074` content differs between them.
- **The deployed schema.** The migrations are source only. Nothing here applies them to a
  production or deployed database, and no activation has happened. Applying `0075` is the
  deployment owner's step, after `0074`.

The integration suite in `packages/database/src/project-state-digest-postgres.integration.test.mjs`
runs against the repository's disposable-database harness and is skipped unless
`RUN_DATABASE_INTEGRATION=true`. It has been executed against a disposable PostgreSQL; the exact
run is recorded in the delivery report.
