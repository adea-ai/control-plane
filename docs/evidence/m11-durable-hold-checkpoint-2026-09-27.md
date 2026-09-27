# M11 durable-hold implementation checkpoint

Decision: **not accepted**. This is a partial implementation checkpoint for
#194, based on released `main` at
`622f90cecd4c2923abccc8b68a6b540f0ea78bf9`, not whole-milestone signoff.

## Implemented scope

- Durable hold identity, explicit owner/session authorization port, supported
  class/workspace/project scope, immutable provenance, release revision and
  idempotent replay are defined in the domain foundation.
- SQLite retention's ten assessment/deletion sites consult holds inside the
  same serialized transaction, before eligibility, journaling or deletion.
  Scope comes from validated stored owners, not caller-supplied identifiers.
  An omitted policy permits legacy behavior only with an empty hold namespace;
  any stored hold without policy fails closed. Holds do not reset reference
  retention clocks.
- Canonical PostgreSQL migration `0050_woozy_zarek` installs the hold table,
  scope and release-shape checks, and index. Its integration fixture creates
  only a test target table: the actual hold table now comes from migration.

The receipt hold scope's initial plain-string annotation failed the fresh
TypeScript build. It was corrected to the domain's `RetentionHoldScope`,
preserving schema-validated identifiers without casts or weakened validation.

## Observed checks

- Fresh domain and SQLite dependency-closure builds passed after the type fix.
- Domain hold tests: **9 passed, 34 assertions**.
- Initial focused SQLite storage/activation checks: **11 passed, 61 assertions**.
- The full SQLite package run subsequently **failed**: 151 passed, four failed,
  two errors, 944 assertions across 155 tests/25 files. Failures were catalog
  approval CLI (5 seconds), context operator CLI (30 seconds), post-commit
  recovery child process (10 seconds), and hold-contention fixture (5 seconds).
  No deadlines or assertions were relaxed.
- Focused diagnostic reruns reproduced both CLI failures. Post-commit recovery
  passed alone (one test, ten assertions), which does not replace the failed
  whole-package result.
- The contention diagnostic exposed `database is locked` when reopening its
  verification provider. Both worker threads are now awaited to termination
  before that reopen. This change preserves native `BEGIN IMMEDIATE` busy
  observation, committed-hold/sweep ordering and readback assertions. It is
  **not yet a verified resolution**: the subsequent focused run still timed
  out, and temporary tracing placed a later failure before worker initialization
  completed. Initialization/cleanup diagnosis remains open; tracing was removed.
- Migration generation and `db:check` passed. A real isolated PostgreSQL test
  database migrated through canonical `0050`; application-role hold integration
  passed **four tests, 20 assertions**, including actual advisory-lock wait
  observation. The test database was disposed, the owned container stopped,
  and its loopback listener closed. This verifies the storage foundation and
  shared-mutex primitive, not PostgreSQL physical deletion enforcement.
- Independent bounded source, migration and fixture reviews found no further
  actionable issue. These are not the final independent human/security audits.

## Remaining gates

PostgreSQL's 13 hold facts still require transactional activation, canonical
owner joins and actual physical-deletion contention tests. Owner authorization
must be composed, not inferred from role labels or OS/database attribution
alone. Operator policy wiring, released-hold disposition, independently durable
hold/deletion-outcome reconciliation before restore exposure, remaining durable
classes and external provider deletion/hold coordination are incomplete.

Current-head whole-package/workspace validation, CI, deployment and all original
profile/runtime/provider/evaluation/native-document/independent-human gates
remain required. Neither this checkpoint nor successful foundation tests close
#194 or Milestone 11. No production or staging mutation was performed for this
hold batch.
