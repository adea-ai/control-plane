# M11.9 durable-data retention coverage

Status: incomplete. Source audit at `f5c9aceb313e111c36d2af897f33a3702c90c409`;
this is not deployed acceptance or permission to delete production data.
The [implementation plan](./m11-retention-implementation-plan-2026-09-08.md)
remains authoritative for eligibility, replay identity, references, holds, and
restore-time deletion reapplication. Issue #194 requires every class below.

| Durable class                      | Current source evidence                                                                                                      | Remaining acceptance                                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ProjectState/history               | `packages/database/src/schema/project-state.ts` stores current and historical revisions.                                     | Reference-aware history and project deletion; never delete live revision or mutation replay identity.                                                                                        |
| ContextPackages                    | `packages/database/src/schema/context-packages.ts` stores immutable packages.                                                | Configured policy and eligibility across plans, executions, evaluations and proposals; physical deletion tests.                                                                              |
| State/memory proposals             | Proposal expiry state exists in `packages/database/src/schema/project-state.ts`.                                             | Physical lifecycle; retain unresolved proposals; distinguish metadata from provider-owned corpus deletion.                                                                                   |
| Plans/validation receipts          | `docs/execution-plans.md` explicitly retains validation receipts indefinitely.                                               | Approved policy, reference handling and durable replay/rejection identity; indefinite retention is not full deletion acceptance.                                                             |
| Executions/attempts                | `packages/database/src/schema/executions.ts` records lifecycle states.                                                       | Terminal outcome, settled children, runtime cleanup and reconciliation eligibility; cleanup worker.                                                                                          |
| Execution events                   | PostgreSQL and SQLite repositories have expiry deletion methods; SQLite tests cover expired/live records and repeated sweep. | Existing age-only deletion does not establish terminal ownership, settled publication/replay consumers, or deduplication safety. Retain unsafe candidates; certify safe compaction/recovery. |
| Command inbox                      | PostgreSQL/SQLite deletion methods and separate `retireExpiredCommand` rejection-key primitives exist.                       | Age-only deletion bypasses the rejection-key prerequisite and terminal-state guards. Wire safe compaction without allowing retries to resurrect deleted keys; preserve holds/references.     |
| Messaging inbox/outbox             | `packages/database/src/schema/messaging.ts` has soft-delete/publication metadata.                                            | Never delete pending, failed, unreconciled or in-flight deliveries; preserve deduplication and prove actual profile wiring.                                                                  |
| Interaction/cancellation receipts  | Durable repositories retain signal identities.                                                                               | Configured lifecycle after confirmation, terminal reconciliation and replay-window expiry.                                                                                                   |
| Runtime ledgers/event receipts     | Runtime commands have indexed expiry; event receipts retain identity.                                                        | Terminal acknowledgement and settled execution checks; ambiguous expiry must trigger reconciliation, not deletion.                                                                           |
| Native Pi admission fences/results | Runtime files retain admission fences and terminal results; existing implementation plan describes their distinct roles.     | Keep admission fences until durable replacement rejection identity exists; terminal-result deletion needs explicit policy and settlement/reference proof.                                    |
| Workflow references                | Restate storage is external; embedded job store persists Local jobs.                                                         | Provider journal retention and completed-work eligibility; embedded cleanup and recovery evidence.                                                                                           |
| Checkpoints                        | `packages/database/src/schema/reconciliation.ts` stores resolution state.                                                    | Protect active recovery cursors/pins; compaction followed by restart/recovery.                                                                                                               |
| Usage/evaluations                  | Evaluation repositories expose cutoff deletion; usage ledger has no deletion lifecycle.                                      | Scheduling, billing/release-reference protection, aggregate preservation and all-profile evidence.                                                                                           |
| Logs/traces                        | `docs/telemetry.md` defines exporter-managed, non-authoritative telemetry.                                                   | Actual sink expiry/redaction policy and evidence, independent of database deletion.                                                                                                          |
| Artifacts                          | ObjectStore exposes exact-object deletion; operational config has a 90-day baseline.                                         | Per-class policy, authoritative eligibility/holds/references, durable external-delete retries, and real provider evidence. The baseline alone does not authorize arbitrary object deletion.  |
| Backups                            | SQLite backup and PostgreSQL/Neon recovery procedures exist; post-retirement snapshots preserve rejection records.           | Provider expiry and restore-time reapplication from a durable source when snapshots predate deletion.                                                                                        |
| Audit records                      | `release_audit_records` retains release evidence.                                                                            | Separately configured audit retention and payload-free deletion evidence.                                                                                                                    |

## Immediate priorities

Merged PR #636 contains a safety mitigation after this source audit: inbox/event deletion
methods now reject before storage access with explicit eligibility-required errors.
The scheduler reports a fixed diagnostic, and operators must monitor retained-data
growth. This removes unsafe age-only behavior but intentionally does not claim that
retention is implemented. The full eligibility and deletion work below remains open.

The follow-up SQLite schema v2 migration adds partial expiry indexes for canonical
UTC-millisecond inbox/event values and upgrades valid v1 backups on the staged restore
copy. Tests cover both indexed query paths, retained legacy rows, malformed-date
filtering and rejection of tampered backup indexes. It does not supply deletion policy,
holds/reference decisions, a production candidate reader or external cleanup; other
timestamp representations still require explicit normalization. This is a storage
prerequisite, not completion of the indexed eligibility/deletion work below.

1. Safety containment is merged in #636 at `7d1703e076224ef466086b515ea0c6190cb7ba96`:
   expiry-only inbox/event deletion is disabled. Keep that fail-closed behavior until
   authoritative eligibility is implemented; scheduler overlap/drain tests do not
   prove deletion eligibility.
2. Introduce indexed, bounded candidates and explicit eligibility/hold/reference
   checks without inventing destructive defaults. Existing 30-day inbox/event,
   7-day terminal-ledger, and 90-day artifact baselines are not sufficient alone.
3. Configure missing class policies with the owning product/operator; retain and
   report blocked candidates while policy is absent. Do not silently waive any
   class or relabel M11 acceptance as M12 work without an owner decision.
4. Run file-backed SQLite and real PostgreSQL parity, concurrent retry/deletion,
   crash/restart, actual provider deletion, backup restore and frozen-candidate
   deployed profile checks. Record each environment separately.

This audit corrects stale inventory, not the historical candidate header. A new
frozen release candidate and independent/manual acceptance remain separate gates.
