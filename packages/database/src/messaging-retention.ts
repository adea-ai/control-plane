import {
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import { and, asc, eq, isNotNull, isNull, lt } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { outboxEvents } from './schema/messaging.js'

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
export class PostgresMessagingRetention {
  constructor(readonly database: ControlPlaneDatabase) {}

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
