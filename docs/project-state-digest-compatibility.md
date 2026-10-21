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
   digest is a code-point digest.
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

The versioned writer is explicitly opt-in:

```ts
await service.applyMutation(input, { digestVersion: 2 })
```

Only that path records `inputDigestVersion`. The published `project_state.updated` event carries the
version when the writer recorded one, and is byte-identical to the previous payload when it did not.

## Storage

- **SQLite.** The mutation record is a JSON document, so the version travels with the record. No
  schema change is required.
- **PostgreSQL.** `project_state_mutations.input_digest_version` is a nullable `integer` column.
  `NULL` means untagged. The additive migration that creates the column is **not part of this
  change**: migration `0074` and the shared migration journal are owned by another writer, and
  migration `0075` is held until that sequencing is agreed. Until it lands, the PostgreSQL
  integration suite applies the identical additive statement to its own disposable database.

## Rollback bounds

- Rolling back the _binary_ is safe. The version column is nullable, and the older reader ignores
  the column and the extra JSON field, treating a versioned record as untagged. Its digest is the
  code-point form, which the untagged compatibility path accepts.
- Rolling back the _migration_ is safe in the same way: dropping the column removes the version
  metadata from versioned rows, and those rows revert to the untagged interpretation, which still
  verifies against the code-point digest they carry.
- A rollback never needs to rewrite a retained row, and never needs to recompute a digest.

## Retained-data limits

- No history is backfilled or rewritten. Rows written before this change keep their original bytes
  and stay untagged.
- No retained user data is mutated. The only new data is the version tag on rows written by the
  opt-in writer path.
- The compatibility window for untagged records is bounded by the retention of pre-cutover rows.
  Once no untagged rows remain, the legacy form can be dropped from the reader; the versioned
  records do not need it.

## Out of scope

This change does not backfill or rewrite history, does not deploy a migration, does not activate
anything in production, and does not change the default writer's output.

## Prerequisites that are still missing

- **Migration sequencing.** `packages/database/drizzle/0075_*` and the shared `_journal.json` are
  owned by the migration writer that also owns `0074`. The additive column statement has to be
  sequenced with that work before the PostgreSQL schema can carry the version outside a disposable
  database.
- **A dirty journal owner.** A separate detached worktree modifies the shared migration journal.
  It has to be reconciled before any journal edit.
- **Live PostgreSQL evidence.** The integration suite in
  `packages/database/src/project-state-digest-postgres.integration.test.mjs` is written against the
  repository's disposable-database harness and is skipped unless `RUN_DATABASE_INTEGRATION=true`.
  Whether it has been executed against a disposable PostgreSQL is recorded in the delivery report,
  not here.
