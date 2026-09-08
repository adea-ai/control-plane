# M11.9 retention and deletion implementation plan

Status: incomplete. This inventory is implementation input, not evidence of a
working retention service. Scope is every durable data class in issue #194,
across PostgreSQL, SQLite, workflow storage, object storage, and backups.

## Current evidence

- `packages/config/src/operational.ts` specifies 30-day command-inbox and
  execution-event retention, 7-day terminal-command-ledger retention, and a
  24-hour maximum command lifetime. These values alone do not implement cleanup.
- `packages/database/src/schema/commands.ts` and `events.ts` index expiry;
  `messaging.ts` supplies inbox soft deletion and outbox publication state.
  Schema metadata is not proof of safe deletion or a scheduled worker.
- SQLite `control_plane_records` has namespace, ID, revision, JSON value, and
  update time only. `PersistenceTransaction.delete` supports revision checking,
  but does not evaluate expiry, terminal state, scope, references, or holds.
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

| Durable class                           | Current storage / boundary                                                    | Required eligibility and proof                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ProjectState and history                | PostgreSQL project-state tables; SQLite project-states/history/mutations      | Never expire the live revision; preserve referenced revisions and mutation replay identity; verify project deletion separately.                     |
| ContextPackages                         | PostgreSQL context_packages; SQLite context-packages and authoring receipts   | Preserve pins from plans, executions, evaluations, and proposals; delete content only after references and retention permit it.                     |
| State and memory proposals              | PostgreSQL proposal tables; SQLite state-promotion-proposals                  | Retain unresolved proposals; distinguish Control Plane metadata deletion from optional provider-owned corpus deletion.                              |
| Execution plans and validation receipts | PostgreSQL execution_plans/validation commands; SQLite matching namespaces    | Resolve plan references before deletion; preserve rejection/replay identity after receipt compaction.                                               |
| Executions and attempts                 | PostgreSQL executions/attempts; SQLite executions/execution-attempts          | Require durable terminal outcome, settled children, runtime cleanup, and completed reconciliation.                                                  |
| Execution events                        | PostgreSQL execution_events; SQLite execution-events                          | Require expiry, terminal owner, settled publication and replay consumers; preserve deduplication identity. Archival alone is not payload deletion.  |
| Command inbox                           | PostgreSQL command_inbox; SQLite command-inbox/command-by-execution           | Atomically compact payload and preserve scoped idempotency rejection before removing lookup dependencies.                                           |
| Messaging inbox/outbox                  | PostgreSQL inbox_messages/outbox_events                                       | Preserve delivery deduplication; never sweep pending, failed/unreconciled, or in-flight delivery. Verify actual profile use before claiming parity. |
| Interaction and cancellation receipts   | PostgreSQL interaction/cancellation command tables; SQLite receipt namespaces | Never delete unconfirmed signals; preserve original command identity through terminal reconciliation and replay-window expiry.                      |
| Runtime ledgers and event receipts      | PostgreSQL runtime tables; SQLite runtime-commands/runtime-event-receipts     | Require terminal acknowledgement and settled execution; expired ambiguous commands remain reconciliation work, not deletion candidates.             |
| Workflow references                     | Restate lifecycle plus persisted execution references                         | Verify workflow completion and provider retention; removing a database reference does not purge workflow journals.                                  |
| Checkpoints                             | Reconciliation and inventory repositories; graph checkpoint boundary          | Protect active recovery cursors and pinned checkpoints; test compaction followed by restart/recovery.                                               |
| Usage and evaluations                   | PostgreSQL usage_ledger_entries/evaluation_runs; SQLite evaluation-runs       | Preserve billing/release references and required aggregates; verify all profile implementations instead of inferring parity from interfaces.        |
| Logs and traces                         | Deployment telemetry sinks                                                    | Configure and verify sink expiry and redaction; database deletion does not delete telemetry.                                                        |
| Artifacts                               | Profile-specific object/filesystem providers                                  | Delete exact scoped object/version only after metadata eligibility; persist retries for object-store failures and prevent dangling live references. |
| Backups                                 | PostgreSQL/Neon and SQLite backup boundaries                                  | Verify provider expiry, snapshot ownership, and restore-time reapplication of deletion records; no production reset as a test.                      |
| Audit records                           | PostgreSQL release_audit_records and deployment evidence                      | Use separately configured audit retention; retain evidence of deletion without retaining deleted payloads or credentials.                           |

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
