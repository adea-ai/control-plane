# M11.9 retention and deletion implementation plan

Status: incomplete. This inventory is implementation input, not evidence of a
working retention service. Scope is every durable data class in issue #194,
across PostgreSQL, SQLite, workflow storage, object storage, and backups.

## Decided policy and decisions (2026-09-24)

The owner accepted the recommendations that were blocking implementation. The
machine-readable form is `packages/config/src/retention-policy.ts`
(`decidedRetentionPolicy`); the decisions are:

- **Durations.** Accepted baselines are reused, not re-invented: command inbox
  30 days, execution events 30 days, artifacts 90 days, backups 7 days (the
  Neon PITR window), maximum command lifetime 24 hours. New decisions: context
  packages and execution plans 90 days after their last reference is released,
  executions 90 days after a terminal and reconciled outcome, messaging and
  interaction receipts 30 days after settled delivery or terminal
  reconciliation, runtime ledgers 30 days after terminal acknowledgement,
  native terminal snapshots 30 days after settlement, workflow references 30
  days after workflow completion, evaluation runs 180 days, usage ledger and
  release audit records 400 days, logs and traces 30 days at the sink.
- **Unbounded classes.** ProjectState (live revision and referenced history),
  unresolved state proposals, checkpoints (active and pinned), and native Pi
  admission fences are retained while a reference or lifecycle state requires
  them. These are never age-swept; a duration would be a false authorization.
- **Hold owners.** `workspace-owner` (project state, context packages,
  proposals), `platform-operator` (plans, executions, events, inbox, messaging,
  receipts, workflow references, checkpoints, telemetry, backups),
  `runtime-owner` (runtime ledgers, native fences and snapshots),
  `billing-owner` (usage), `release-owner` (evaluation runs, artifacts, audit
  records). A hold is recorded by its owner and blocks eligibility regardless
  of age.
- **Bounded rejection-key epoch.** A retired scoped idempotency key may be
  forgotten only after the longest possible replay of the original command
  becomes invalid: inbox retention plus the maximum accepted command lifetime
  (30 days + 24 hours). Encoded as `rejectionKeyEpochMs`.
- **Restore-time reapplication.** A snapshot predating a deletion cannot
  contain the later rejection record. The plan: write a payload-free deletion
  journal (scoped key hashes and deletion outcomes only) to object storage as
  part of every deletion batch, and reapply it before exposing any restored
  snapshot; the acceptance test restores an older snapshot plus the journal and
  asserts the retired key stays rejected. Unimplemented, still a release gate.
- **Milestone disposition.** Retention stays in M11 (#194 remains the owning
  issue); it is not relabelled M12 work. The remaining increments are
  code-shaped and independent of the M12 decision layer.
- **Monitoring while deletion stays fail-closed.** `scripts/retention-report.mjs`
  is a read-only report of expired-but-retained candidates and rejection
  records for both storage backends; it prints a payload-free JSON record,
  never deletes, and reports one sanitized failure code. It replaces the
  "monitor retained-data growth" instruction with a tool.

Still required before any physical deletion: indexed eligibility queries with
terminal-state/reference/hold checks revalidated at deletion time, bounded
transactional claims, tombstone reservation before payload removal, durable
external deletion jobs, and per-profile wiring with observable counts. The
fail-closed guards stay in place until those exist.

## Increment: SQLite command rejection keys

`SqliteCommandAcceptanceRepository.retireExpiredCommand` now reserves a minimal
rejection record in `retired-command-keys`. It requires an expired command with
terminal command and execution states. It intentionally retains all original
domain records: reference checks, holds, external cleanup, and deletion workers
are not implemented by this method. No scheduler or public endpoint invokes it.

Both scoped lookup and transactional acceptance reject a retired key with
`COMMAND_RETENTION_EXPIRED`. Reservation uses the same SQLite write transaction
serialization as acceptance. The record contains original command/execution IDs
and retirement time, not request payload or the raw scoped idempotency key.
The key uses the existing repository scope hash. There is no expiry of these
rejection records until an admission-epoch policy can make forgetting safe.

The file-backed repository test verifies active command/execution refusal,
the existing inclusive replay-deadline boundary, eight concurrent retirements,
payload removal simulated in a disposable test database, full close/reopen,
direct repository admission and service replay rejection despite altered request
metadata, and caller/project isolation. This is SQLite-only prerequisite
coverage; it does not prove PostgreSQL parity or full retention acceptance.

## Increment: PostgreSQL command rejection keys

Migration `0036_retired_command_keys.sql` adds the four-column rejection table
with a hashed scoped key and no foreign keys or request payload. PostgreSQL
admission and `retireExpiredCommand` share a transaction advisory lock for that
key. Retirement also locks the command and execution rows while checking the
same terminal-state and expiry conditions used by SQLite. Scoped reads reject
retired keys; transactional admission rechecks before inserting any command or
execution. No production deletion or scheduler is enabled.

The real PostgreSQL integration test covers active-state refusal, the exact
deadline, eight concurrent retirements, simulated receipt deletion in an
isolated test database, repository reconstruction, eight rejected readmissions,
changed request metadata, and caller/project isolation. The rejection record
retains its original identity and timestamp. This verifies the PostgreSQL
prerequisite, not an end-to-end cleanup worker or provider retention policy.

The integration suite passes all 27 database tests plus Cloud HTTP, portability,
graph, and testing integration lanes, authenticated remote delivery, and the
PostgreSQL outage, restart, and backup/restore drills. The latter are existing
recovery drills, not proof that deletion survives backup restoration; that
specific acceptance test remains outstanding below.

## Increment: post-retirement snapshot recovery

The SQLite repository test now creates a real provider backup after reserving
the rejection key and simulating receipt removal, restores it into a different
database file, and verifies both receipt absence and readmission rejection.
The PostgreSQL restore drill seeds a terminal command through the real services,
reserves its rejection key, removes only that fixture receipt, and uses its
existing `pg_dump`/`pg_restore` flow into a separate database. After application
grants are reapplied, the fixture checks exact rejection-record identity,
receipt absence, and rejected lookup/direct admission with a changed hash.

These tests concern snapshots **taken after retirement**. A snapshot predating
retirement cannot contain a later rejection record. Reapplying deletion records
from an independent durable source before exposing an older restored snapshot
remains unimplemented and is still a release gate. Neither test authorizes
deleting live command data or expiring backups.

## Current evidence

- `packages/config/src/operational.ts` specifies 30-day command-inbox and
  execution-event retention, 7-day terminal-command-ledger retention, and a
  24-hour maximum command lifetime. These values alone do not implement cleanup.
- `packages/database/src/schema/commands.ts` and `events.ts` index expiry;
  `messaging.ts` supplies inbox soft deletion and outbox publication state.
  Schema metadata is not proof of safe deletion or a scheduled worker.
- SQLite v2 adds partial expression indexes for canonical UTC-millisecond expiry
  strings in command-inbox and execution-events records. These are coarse
  candidate access paths, not calendar validation or deletion authority.
  `PersistenceTransaction.delete` supports revision checking, but does not
  evaluate expiry, terminal state, scope, references, or holds. Both SQLite and
  PostgreSQL age-only inbox/event deletion entry points now fail closed with
  `*_RETENTION_ELIGIBILITY_REQUIRED` before storage access; safe cleanup is still
  unimplemented. See the current
  [per-class coverage matrix](m11-retention-coverage-2026-09-22.md).
- `CommandInboxService.acceptExecution` first looks up the scoped idempotency
  key. An absent record enters new admission. Requested retention can be extended
  in a new submission; it is not a permanent rejection marker for a deleted key.
- `docs/execution-plans.md` explicitly says validation receipts are retained
  indefinitely. Cancellation and interaction receipts also preserve identity
  needed to reconcile a signal whose acknowledgement was lost.
- Project-state mutations reference historical revisions in PostgreSQL.
  Reconciliation checkpoints reference command/execution records. Deletion must
  respect these dependencies rather than disable foreign keys.

## Required ownership and coverage

Durations not already specified above require an explicit configured policy;
this plan does not invent destructive defaults. Until policy and eligibility
are available, retain the data and report the reason.

| Durable class                           | Current storage / boundary                                                    | Required eligibility and proof                                                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ProjectState and history                | PostgreSQL project-state tables; SQLite project-states/history/mutations      | Never expire the live revision; preserve referenced revisions and mutation replay identity; verify project deletion separately.                                                   |
| ContextPackages                         | PostgreSQL context_packages; SQLite context-packages and authoring receipts   | Preserve pins from plans, executions, evaluations, and proposals; delete content only after references and retention permit it.                                                   |
| State and memory proposals              | PostgreSQL proposal tables; SQLite state-promotion-proposals                  | Retain unresolved proposals; distinguish Control Plane metadata deletion from optional provider-owned corpus deletion.                                                            |
| Execution plans and validation receipts | PostgreSQL execution_plans/validation commands; SQLite matching namespaces    | Resolve plan references before deletion; preserve rejection/replay identity after receipt compaction.                                                                             |
| Executions and attempts                 | PostgreSQL executions/attempts; SQLite executions/execution-attempts          | Require durable terminal outcome, settled children, runtime cleanup, and completed reconciliation.                                                                                |
| Execution events                        | PostgreSQL execution_events; SQLite execution-events                          | Require expiry, terminal owner, settled publication and replay consumers; preserve deduplication identity. Archival alone is not payload deletion.                                |
| Command inbox                           | PostgreSQL command_inbox; SQLite command-inbox/command-by-execution           | Atomically compact payload and preserve scoped idempotency rejection before removing lookup dependencies.                                                                         |
| Messaging inbox/outbox                  | PostgreSQL inbox_messages/outbox_events                                       | Preserve delivery deduplication; never sweep pending, failed/unreconciled, or in-flight delivery. Verify actual profile use before claiming parity.                               |
| Interaction and cancellation receipts   | PostgreSQL interaction/cancellation command tables; SQLite receipt namespaces | Never delete unconfirmed signals; preserve original command identity through terminal reconciliation and replay-window expiry.                                                    |
| Runtime ledgers and event receipts      | PostgreSQL runtime tables; SQLite runtime-commands/runtime-event-receipts     | Require terminal acknowledgement and settled execution; expired ambiguous commands remain reconciliation work, not deletion candidates.                                           |
| Native Pi admission fences              | Private runtime data directory: admissions/<attemptId>.json                   | Preserve across execution cleanup and restore; deletion can re-enable native work. Require explicit reconciliation and a durable replacement rejection record before removal.     |
| Native Pi terminal snapshots            | Private runtime data directory: terminal-results/<attemptId>.json             | Contains output and usage; preserve until authoritative settlement/recovery no longer references it. Delete only under explicit class policy while retaining the admission fence. |
| Workflow references                     | Restate lifecycle plus persisted execution references                         | Verify workflow completion and provider retention; removing a database reference does not purge workflow journals.                                                                |
| Checkpoints                             | Reconciliation and inventory repositories; graph checkpoint boundary          | Protect active recovery cursors and pinned checkpoints; test compaction followed by restart/recovery.                                                                             |
| Usage and evaluations                   | PostgreSQL usage_ledger_entries/evaluation_runs; SQLite evaluation-runs       | Preserve billing/release references and required aggregates; verify all profile implementations instead of inferring parity from interfaces.                                      |
| Logs and traces                         | Deployment telemetry sinks                                                    | Configure and verify sink expiry and redaction; database deletion does not delete telemetry.                                                                                      |
| Artifacts                               | Profile-specific object/filesystem providers                                  | Delete exact scoped object/version only after metadata eligibility; persist retries for object-store failures and prevent dangling live references.                               |
| Backups                                 | PostgreSQL/Neon and SQLite backup boundaries                                  | Verify provider expiry, snapshot ownership, and restore-time reapplication of deletion records; no production reset as a test.                                                    |
| Audit records                           | PostgreSQL release_audit_records and deployment evidence                      | Use separately configured audit retention; retain evidence of deletion without retaining deleted payloads or credentials.                                                         |

## Implementation sequence

1. Define versioned, scoped policy with configured duration, effective time,
   holds, and provenance. Separate retention duration from command validity.
2. Add durable rejection tombstones for idempotent commands and mutations.
   Lookup and admission must consult them atomically with reservation. A retry
   with a changed command ID, timestamp, payload hash, or future retention must
   not resurrect a deleted key. Tombstone expiry itself needs a bounded command
   acceptance epoch/window; an unbounded key namespace cannot safely forget keys.
3. Add indexed SQLite expiry/deletion metadata through an appended migration;
   preserve the shipped migration checksum and test old backups and migration
   rollback. PostgreSQL needs matching eligibility queries, not merely indexes.
4. Implement bounded transactional candidate claims with scope, revision,
   terminal/reconciliation state, reference checks, and holds revalidated at
   deletion time. Use durable jobs for external object/workflow/sink deletion.
5. Compact dependent data before parents, preserving minimal replay/rejection
   identity. Record payload-free audit outcomes and retry external failures.
6. Wire scheduled execution and observable dry-run/blocked/deleted/error counts
   into all profiles; document operator inspection, retries, and shutdown drain.

## Acceptance tests still required

- Exact expiry boundary, clock skew policy, future expiry, missing policy, and
  legal hold; workspace/project isolation and malformed stored metadata.
- Active, unresolved, quarantined, ambiguous, and referenced records survive.
- Concurrent admission versus deletion; duplicate replay after compaction;
  changed request metadata cannot create a second execution or signal.
- Crash before/after claim, tombstone write, payload deletion, external delete,
  and audit acknowledgement; restart yields one recoverable outcome.
- Real PostgreSQL and file-backed SQLite parity, migration from released schema,
  indexed bounded sweeps under backlog, concurrent writers, and backup restore.
- Actual filesystem/object-store deletion, workflow/sink retention, backup expiry,
  and a restored snapshot that does not resurrect erased data.
- Per-class evidence and all-profile operational wiring before closing #194.
