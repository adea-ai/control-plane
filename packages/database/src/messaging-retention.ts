import {
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import { and, asc, eq, isNotNull, isNull, lt } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { inboxMessages, outboxEvents } from './schema/messaging.js'

/**
 * Retention deletion for the messaging class (#194). This class is
 * PostgreSQL-only: the supported SQLite profiles carry no inbox/outbox tables,
 * so there is nothing to sweep there.
 *
 * The ordering proof is settled delivery. An outbox row is a single delivery:
 * ingestion inserts a new row per availability change with its own identity,
 * and the consumer deduplicates by a delivery key derived from that row, so a
 * delivered row is never re-sent and removing it cannot duplicate an effect.
 * Pending, failed and quarantined rows are therefore the only ones that matter
 * and none of them are candidates — pending and failed are retry work, and
 * quarantined rows are unresolved and need an operator or consumer, not a
 * sweep.
 */
/** Adds two per-reason retained counts, keeping the largest scanned bound. */
function mergeReasons(
  left: Readonly<Record<string, number | undefined>>,
  right: Readonly<Record<string, number | undefined>>
): Record<string, number> {
  const merged: Record<string, number> = {}
  for (const [reason, count] of Object.entries(left)) {
    if (count !== undefined) merged[reason] = count
  }
  for (const [reason, count] of Object.entries(right)) {
    if (count === undefined) continue
    merged[reason] = (merged[reason] ?? 0) + count
  }
  return merged
}

export class PostgresMessagingRetention {
  constructor(readonly database: ControlPlaneDatabase) {}

  /**
   * Sweeps the whole messaging class: settled outbox rows are deleted and the
   * consumer inbox is compacted. One entry point because the class is one
   * policy decision; the individual passes stay callable for tests.
   */
  async sweepEligibleMessaging(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    const outbox = await this.deleteEligibleOutboxEvents(now, options)
    const inbox = await this.compactEligibleInboxMessages(now, options)
    return {
      ...outbox,
      deleted: outbox.deleted + inbox.deleted,
      raced: outbox.raced + inbox.raced,
      compacted: inbox.compacted,
      scanned: outbox.scanned + inbox.scanned,
      eligible: outbox.eligible + inbox.eligible,
      truncated: outbox.truncated || inbox.truncated,
      retainedByReason: mergeReasons(outbox.retainedByReason, inbox.retainedByReason),
    }
  }

  /**
   * Compacts delivered consumer-inbox payloads past the window. The row is the
   * delivery's deduplication identity — a redelivery is recognised by
   * `(consumer, messageId)` — so it is never removed: the payload is replaced
   * with a tombstone (the column is NOT NULL) and `deletedAt` marks the
   * compaction, which is also what keeps a second pass idempotent. Dry run by
   * default, revision-guarded per row.
   */
  async compactEligibleInboxMessages(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('MESSAGING_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter('messaging', assessedAt, options.bound ?? 64)
    let compacted = 0
    let raced = 0
    const candidates = await this.database
      .select({
        id: inboxMessages.id,
        revision: inboxMessages.revision,
        createdAt: inboxMessages.createdAt,
      })
      .from(inboxMessages)
      .where(
        and(
          isNull(inboxMessages.deletedAt),
          ...(options.policyRetainMs === null
            ? []
            : [lt(inboxMessages.createdAt, new Date(now.getTime() - options.policyRetainMs))])
        )
      )
      .orderBy(asc(inboxMessages.createdAt))
      .limit(counter.bound + 1)
    for (const candidate of candidates) {
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt:
          options.policyRetainMs === null
            ? undefined
            : new Date(candidate.createdAt.getTime() + options.policyRetainMs).toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal: true,
        publicationSettled: true,
        rejectionKeyReserved: true,
        pendingReferences: 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun) continue
      if (options.journal !== undefined) {
        await options.journal([
          { kind: 'postgres.compactInboxMessage', id: candidate.id, compactedAt: assessedAt },
        ])
      }
      const updated = await this.database
        .update(inboxMessages)
        .set({
          payload: { compacted: true, version: 1 },
          deletedAt: now,
          revision: candidate.revision + 1n,
          updatedAt: now,
        })
        .where(
          and(
            eq(inboxMessages.id, candidate.id),
            eq(inboxMessages.revision, candidate.revision),
            isNull(inboxMessages.deletedAt)
          )
        )
        .returning({ id: inboxMessages.id })
      if (updated.length === 1) compacted += 1
      else raced += 1
    }
    return { dryRun, deleted: 0, compacted, raced, ...counter.result() }
  }

  async deleteEligibleOutboxEvents(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('MESSAGING_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter('messaging', assessedAt, options.bound ?? 64)
    let deleted = 0
    let raced = 0
    const candidates = await this.database
      .select({
        id: outboxEvents.id,
        status: outboxEvents.status,
        revision: outboxEvents.revision,
        publishedAt: outboxEvents.publishedAt,
        quarantinedAt: outboxEvents.quarantinedAt,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.status, 'published'),
          isNotNull(outboxEvents.publishedAt),
          isNull(outboxEvents.quarantinedAt),
          ...(options.policyRetainMs === null
            ? []
            : [lt(outboxEvents.publishedAt, new Date(now.getTime() - options.policyRetainMs))])
        )
      )
      .orderBy(asc(outboxEvents.publishedAt))
      .limit(counter.bound + 1)
    for (const candidate of candidates) {
      if (candidate.publishedAt === null) continue
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt:
          options.policyRetainMs === null
            ? undefined
            : new Date(candidate.publishedAt.getTime() + options.policyRetainMs).toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal: true,
        publicationSettled: candidate.status === 'published' && candidate.quarantinedAt === null,
        rejectionKeyReserved: true,
        pendingReferences: 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun) continue
      if (options.journal !== undefined) {
        await options.journal([{ kind: 'postgres.deleteOutboxEvent', id: candidate.id }])
      }
      const removed = await this.database
        .delete(outboxEvents)
        .where(
          and(
            eq(outboxEvents.id, candidate.id),
            eq(outboxEvents.status, 'published'),
            eq(outboxEvents.revision, candidate.revision)
          )
        )
        .returning({ id: outboxEvents.id })
      if (removed.length === 1) deleted += 1
      else raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }
}
