import {
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
  type RetentionHoldPolicy,
} from '@control-plane/domain'
import { and, asc, eq, isNotNull, isNull, lt } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { inboxMessages, outboxEvents } from './schema/messaging.js'
import {
  acquirePostgresRetentionHoldClassMutex,
  countPostgresMatchingActiveRetentionHolds,
  validatePostgresRetentionHoldPolicy,
} from './retention-hold-repository.js'

interface MessagingRetentionOptions {
  readonly policyRetainMs: number | null
  readonly bound?: number
  readonly dryRun?: boolean
  readonly journal?: RetentionJournalSink
  readonly retentionHoldPolicy?: RetentionHoldPolicy
}

function createCounter(now: Date, options: MessagingRetentionOptions): RetentionAssessmentCounter {
  if (Number.isNaN(now.getTime())) throw new Error('MESSAGING_RETENTION_INVALID_TIMESTAMP')
  return new RetentionAssessmentCounter('messaging', now.toISOString(), options.bound ?? 64)
}

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

  /**
   * Sweeps the whole messaging class: settled outbox rows are deleted and the
   * consumer inbox is compacted. One entry point because the class is one
   * policy decision; the individual passes stay callable for tests.
   */
  async sweepEligibleMessaging(
    now: Date,
    options: MessagingRetentionOptions
  ): Promise<RetentionDeletionResult> {
    const counter = createCounter(now, options)
    const outbox = await this.#deleteEligibleOutboxEvents(now, options, counter)
    const inbox = await this.#compactEligibleInboxMessages(now, options, counter)
    return {
      dryRun: options.dryRun ?? true,
      deleted: outbox.deleted + inbox.deleted,
      raced: outbox.raced + inbox.raced,
      compacted: inbox.compacted,
      ...counter.result(),
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
    options: MessagingRetentionOptions
  ): Promise<RetentionDeletionResult> {
    return this.#compactEligibleInboxMessages(now, options, createCounter(now, options))
  }

  async #compactEligibleInboxMessages(
    now: Date,
    options: MessagingRetentionOptions,
    counter: RetentionAssessmentCounter
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('MESSAGING_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
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
      .limit(counter.remaining + 1)
    await this.database.transaction((transaction) =>
      validatePostgresRetentionHoldPolicy(transaction, options.retentionHoldPolicy)
    )
    for (const candidate of candidates) {
      if (!counter.admitCandidate()) break
      const outcome = await this.database.transaction(async (transaction) => {
        await acquirePostgresRetentionHoldClassMutex(transaction, 'messaging')
        const [stored] = await transaction
          .select({ revision: inboxMessages.revision, createdAt: inboxMessages.createdAt })
          .from(inboxMessages)
          .where(and(eq(inboxMessages.id, candidate.id), isNull(inboxMessages.deletedAt)))
          .limit(1)
          .for('update')
        if (stored === undefined) return { bound: false, compacted: false, raced: true }
        const holds = await countPostgresMatchingActiveRetentionHolds(
          transaction,
          { classId: 'messaging', scope: { kind: 'class' } },
          options.retentionHoldPolicy
        )
        const verdict = evaluateRetentionEligibility({
          retentionExpiresAt:
            options.policyRetainMs === null
              ? undefined
              : new Date(stored.createdAt.getTime() + options.policyRetainMs).toISOString(),
          now: assessedAt,
          policyRetainMs: options.policyRetainMs,
          ownerTerminal: true,
          publicationSettled: true,
          rejectionKeyReserved: true,
          pendingReferences: 0,
          holds,
        })
        counter.recordVerdict(verdict)
        if (verdict.verdict !== 'eligible' || dryRun)
          return { bound: false, compacted: false, raced: false }
        if (options.journal !== undefined) {
          await options.journal([
            { kind: 'postgres.compactInboxMessage', id: candidate.id, compactedAt: assessedAt },
          ])
        }
        const updated = await transaction
          .update(inboxMessages)
          .set({
            payload: { compacted: true, version: 1 },
            deletedAt: now,
            revision: stored.revision + 1n,
            updatedAt: now,
          })
          .where(
            and(
              eq(inboxMessages.id, candidate.id),
              eq(inboxMessages.revision, stored.revision),
              isNull(inboxMessages.deletedAt)
            )
          )
          .returning({ id: inboxMessages.id })
        return { bound: false, compacted: updated.length === 1, raced: updated.length !== 1 }
      })
      if (outcome.bound) break
      if (outcome.compacted) compacted += 1
      if (outcome.raced) raced += 1
    }
    return { dryRun, deleted: 0, compacted, raced, ...counter.result() }
  }

  async deleteEligibleOutboxEvents(
    now: Date,
    options: MessagingRetentionOptions
  ): Promise<RetentionDeletionResult> {
    return this.#deleteEligibleOutboxEvents(now, options, createCounter(now, options))
  }

  async #deleteEligibleOutboxEvents(
    now: Date,
    options: MessagingRetentionOptions,
    counter: RetentionAssessmentCounter
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('MESSAGING_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
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
      .limit(counter.remaining + 1)
    await this.database.transaction((transaction) =>
      validatePostgresRetentionHoldPolicy(transaction, options.retentionHoldPolicy)
    )
    for (const candidate of candidates) {
      if (!counter.admitCandidate()) break
      if (candidate.publishedAt === null) continue
      const outcome = await this.database.transaction(async (transaction) => {
        await acquirePostgresRetentionHoldClassMutex(transaction, 'messaging')
        const [stored] = await transaction
          .select({
            status: outboxEvents.status,
            revision: outboxEvents.revision,
            publishedAt: outboxEvents.publishedAt,
            quarantinedAt: outboxEvents.quarantinedAt,
          })
          .from(outboxEvents)
          .where(eq(outboxEvents.id, candidate.id))
          .limit(1)
          .for('update')
        if (stored === undefined || stored.publishedAt === null)
          return { bound: false, deleted: false, raced: true }
        const holds = await countPostgresMatchingActiveRetentionHolds(
          transaction,
          { classId: 'messaging', scope: { kind: 'class' } },
          options.retentionHoldPolicy
        )
        const verdict = evaluateRetentionEligibility({
          retentionExpiresAt:
            options.policyRetainMs === null
              ? undefined
              : new Date(stored.publishedAt.getTime() + options.policyRetainMs).toISOString(),
          now: assessedAt,
          policyRetainMs: options.policyRetainMs,
          ownerTerminal: true,
          publicationSettled: stored.status === 'published' && stored.quarantinedAt === null,
          rejectionKeyReserved: true,
          pendingReferences: 0,
          holds,
        })
        counter.recordVerdict(verdict)
        if (verdict.verdict !== 'eligible' || dryRun)
          return { bound: false, deleted: false, raced: false }
        if (options.journal !== undefined) {
          await options.journal([{ kind: 'postgres.deleteOutboxEvent', id: candidate.id }])
        }
        const removed = await transaction
          .delete(outboxEvents)
          .where(
            and(
              eq(outboxEvents.id, candidate.id),
              eq(outboxEvents.status, 'published'),
              eq(outboxEvents.revision, stored.revision)
            )
          )
          .returning({ id: outboxEvents.id })
        return { bound: false, deleted: removed.length === 1, raced: removed.length !== 1 }
      })
      if (outcome.bound) break
      if (outcome.deleted) deleted += 1
      if (outcome.raced) raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }
}
