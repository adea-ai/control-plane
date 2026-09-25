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

## Increment: executions deletion with reference safety (2026-09-25)

`deleteEligibleExecutions(now, { policyRetainMs, bound, dryRun })` on both
execution repositories removes terminal executions and their settled attempts.
The ordering proof for this class is the opposite of the inbox's: an execution
is the **last** class to become eligible, because everything that carries its
identity has to go first.

- The class has no stored retention deadline, so eligibility derives one from
  the terminal instant and the configured duration (90 days by decision); a null
  duration yields no deadline, which the shared predicate reads as an unbounded
  class.
- A surviving acceptance record, execution event, reconciliation checkpoint or
  non-terminal attempt retains the execution as `reference_pending`. A
  bottom-up pass therefore deletes the acceptance record and events first, then
  the execution — observed in the integration test, where the same fixture is
  retained until its acceptance record goes and eligible immediately after.
- Attempts are removed with the execution, terminal ones only, and the row's
  state and version guard the delete so a concurrent transition is reported as
  `raced` rather than forced. The journal records both deletes.

Storage note for the next class that needs reference checks: PostgreSQL
reference checks are plain set queries over the referencing tables, not
correlated `exists` subqueries — the driver's boolean representation is not JS
truthiness, and the boolean form silently reported every candidate as retained.

## Increment: restore-time reapplication (2026-09-25)

The release gate this plan named — "reapplying deletion records from an
independent durable source before exposing an older restored snapshot" — is now
implemented for both deleted classes.

Every deletion pass writes a **journal** before it changes storage: each entry
carries the effects for one candidate, and reapply applies them by explicit
per-backend branches (never by building SQL from journal content, so a tampered
journal cannot widen its own authority). Ordering is at-least-once: an entry for
an effect that never happened — the process died between the append and the
storage change — replays as a no-op, because inserts are insert-if-absent and
deletes are by identity.

The journal therefore also **restates the rejection identity**, not just the
delete. That distinction matters for commands: retirement is a precondition of
eligibility and normally happened long before the deletion, so a snapshot old
enough to predate the retirement would otherwise come back with neither the
payload's rejection key nor a way to recover it.

- `retention-apply` writes the journal (default
  `<database>.retention-journal.jsonl` for SQLite, `retention-journal.jsonl`
  otherwise; `--journal` overrides) and reports its path. Dry runs write
  nothing.
- `retention-reapply` applies a journal to a restored copy, idempotently, with
  validated targets and one sanitized failure code. Run it after restoring a
  snapshot and before exposing the copy.

Evidence: a SQLite test takes a snapshot, deletes, restores the older snapshot,
reapplies (the payload disappears again and replays fail closed), then removes
the rejection key from the restored copy to simulate an even older snapshot —
where a replay would previously be accepted silently — and shows reapply
restating it so replays fail closed again, with a third reapply a no-op. A
PostgreSQL integration test drives the same CLI against a real restored copy
with both identity rows removed and asserts the rejection identity returns for
commands and events.

Remaining here: retiring is still not an operator surface of its own, so the
journal cannot yet record a retirement performed outside a deletion pass (add
that when a retirement command exists), and the journal lives next to the
database rather than in object storage — moving it there, with the same
at-least-once ordering, is the next durability step.

## Increment: execution-events deletion with preserved identity (2026-09-25)

`deleteEligibleEvents(now, { policyRetainMs, bound, dryRun })` on both event
repositories deletes expired events whose owner is terminal and whose
publication is **published** (pending, failed and quarantined deliveries stay as
reconciliation work), after revalidating each candidate inside the deleting
transaction. `dryRun` defaults to true; a candidate that moved is reported as
`raced`.

The ordering proof for this class is deduplication identity, and it is enforced
in both directions:

- Before a row is removed, the event id and its sequence are recorded as
  retired (`retired_execution_event_ids` in PostgreSQL, the
  `retired-execution-event-ids` namespace in SQLite) in the same transaction as
  the delete.
- The append path consults that record: an append of a retired event id is
  treated as a duplicate (`undefined`) instead of resurrecting the event, and
  the next sequence is computed above the historical maximum of live **and**
  retired events, so a sequence number is never reused. Without this, deleting
  the newest event of an execution would let a later append reissue its
  sequence and a consumer holding a cursor would drop the new event as a
  duplicate.

What remains: the other durable classes, durable external deletion for object
storage and workflow references, restore-time reapplication of deletion
records, per-profile scheduled wiring, and deployed-profile evidence for the
deletion paths.

## Increment: operator-invoked deletion for the command inbox (2026-09-25)

The first physical deletion path exists, and only through an explicit operator
command. `deleteEligibleInbox(now, { policyRetainMs, bound, dryRun })` on both
the SQLite and PostgreSQL command-inbox repositories:

- re-reads each candidate and re-derives every fact inside the deleting
  transaction (the earlier scan is not evidence),
- evaluates the shared predicate against those fresh facts,
- deletes the record with its expected revision and then its by-execution index
  entry, keeping the reserved rejection key so a later replay of the same
  scoped idempotency key still fails closed with `COMMAND_RETENTION_EXPIRED`,
- reports `deleted`, `raced` (a candidate whose state changed between selection
  and deletion is never forced) and the per-reason retained counts.

`dryRun` defaults to true. `scripts/retention-apply.mjs` is the operator
surface: dry-run by default, `--apply` requires `--confirm command-inbox`, the
target is validated like the other operator CLIs (absolute non-symlink SQLite
path; PostgreSQL host and database must match the credentialed target), the
result is payload-free JSON, and failures are one sanitized code
(`RETENTION_APPLY_FAILED`). The scheduled sweeps in both profiles deliberately
still only assess and report; enabling scheduled deletion is a separate
decision once dry-run evidence exists.

Not yet done: deletion for the execution-events class (publication settlement
and deduplication identity need their own ordering proof), the remaining
classes, durable external deletion for object storage and workflow references,
restore-time reapplication of deletion records, and deployed-profile evidence
for the deletion path itself.

## Increment: authoritative eligibility predicate and assessment (2026-09-24)

`packages/domain/src/retention-eligibility.ts` is the authoritative predicate the
fail-closed guards name: given one candidate's facts it returns `eligible` or the
single reason that retains it — `unbounded_class`, `missing_expiry`,
`malformed_expiry`, `not_expired`, `non_terminal_owner`, `unsettled_publication`,
`rejection_key_absent`, `reference_pending`, `hold_recorded`. The order is
deliberate: the owner has to reach a terminal, settled state before a rejection
identity can even be reserved, and holds/references outrank age last. The module
also provides the bounded `RetentionAssessmentCounter` (scanned/eligible counts,
per-reason retained counts, truncation flag).

Storage-side read-only assessment is implemented for the **command-inbox** and
**execution-events** classes in both stores. Command inbox: `SqliteCommandAcceptanceRepository.assessExpiredInbox` pages expired
candidates within a bound and resolves owner state plus rejection-key presence;
`PostgresCommandAcceptanceRepository.assessExpiredInbox` orders by deadline,
joins the owning execution, and batch-resolves retired keys. Neither deletes, and
neither becomes deletion authority: eligibility is revalidated per candidate at
claim time.

Execution events: `assessExpiredEvents` on the SQLite and PostgreSQL event
repositories evaluates the owning execution's terminal state and the stored
publication status — pending, failed and quarantined deliveries stay retained as
reconciliation work — with the same bounded, oldest-first discipline.

`RetentionSweep` now accepts optional assessment ports, records one
payload-free `RetentionSweepReport` per pass (counts, per-reason retained debt,
and which class guards refused deletion), and treats a fail-closed refusal as a
blocked class rather than a failed pass — a storage failure still propagates to
`onError`. Both compositions wire it: control-api logs `retention.sweep` with the
metadata through the structured logger, local-control-plane writes one JSON line to
stderr.

Not yet done, and required before any physical deletion: indexed eligibility
queries (the SQLite scan is bounded paging over the namespace, not the expiry
index), transactional claims with revision/CAS revalidation, tombstone
reservation tied to payload compaction, durable external deletion, and the
restore-reapplication test.

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
