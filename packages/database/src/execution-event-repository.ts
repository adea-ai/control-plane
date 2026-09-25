import {
  ExecutionSchema,
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type Execution,
  type RetentionAssessment,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import {
  ExecutionEventSchema,
  hashExecutionEventPayloadV2,
  sanitizeExecutionEventDraft,
  type ExecutionEvent,
  type ExecutionEventDraft,
  type ExecutionEventRepository,
} from '@control-plane/events'
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { toExecutionUpdate } from './execution-repository.js'
import { executionEvents, retiredExecutionEventIds } from './schema/events.js'
import { executions } from './schema/executions.js'

const terminalExecutionStates = new Set<string>(['completed', 'failed', 'cancelled', 'timed_out'])

export class PostgresExecutionEventRepository implements ExecutionEventRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  /**
   * Read-only eligibility assessment for the execution-events class (#194).
   * Bounded and oldest-deadline first: the owning execution must be terminal
   * and the publication settled, because pending, failed and quarantined
   * deliveries are reconciliation work rather than garbage. Never deletes.
   */
  async assessExpiredEvents(
    now: Date,
    options: { readonly policyRetainMs: number | null; readonly bound?: number }
  ): Promise<RetentionAssessment> {
    if (Number.isNaN(now.getTime())) throw new Error('EVENT_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const counter = new RetentionAssessmentCounter(
      'execution-events',
      assessedAt,
      options.bound ?? 256
    )
    const candidates = await this.database
      .select({
        retentionExpiresAt: executionEvents.retentionExpiresAt,
        publicationStatus: executionEvents.publicationStatus,
        executionState: executions.state,
      })
      .from(executionEvents)
      .innerJoin(executions, eq(executions.executionId, executionEvents.executionId))
      .where(lt(executionEvents.retentionExpiresAt, now))
      .orderBy(asc(executionEvents.retentionExpiresAt))
      .limit(counter.bound + 1)
    for (const candidate of candidates) {
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt: candidate.retentionExpiresAt.toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal: terminalExecutionStates.has(candidate.executionState),
        publicationSettled: candidate.publicationStatus === 'published',
        rejectionKeyReserved: true,
        pendingReferences: 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
    }
    return counter.result()
  }

  /**
   * Deletes expired, eligible execution events (#194) while preserving their
   * deduplication identity: the event id and its sequence are recorded as
   * retired before the row is removed, so a retry of that event id cannot
   * resurrect it and the sequence number is never reused.
   *
   * Eligibility is revalidated per candidate at deletion time: the delete is
   * guarded by the publication status and deadline, and a candidate that moved
   * is reported as `raced`. `dryRun` defaults to true.
   */
  async deleteEligibleEvents(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('EVENT_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'execution-events',
      assessedAt,
      options.bound ?? 64
    )
    let deleted = 0
    let raced = 0
    const candidates = await this.database
      .select({
        eventId: executionEvents.eventId,
        executionId: executionEvents.executionId,
        sequence: executionEvents.sequence,
        retentionExpiresAt: executionEvents.retentionExpiresAt,
        publicationStatus: executionEvents.publicationStatus,
        executionState: executions.state,
      })
      .from(executionEvents)
      .innerJoin(executions, eq(executions.executionId, executionEvents.executionId))
      .where(lt(executionEvents.retentionExpiresAt, now))
      .orderBy(asc(executionEvents.retentionExpiresAt))
      .limit(counter.bound + 1)
    for (const candidate of candidates) {
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt: candidate.retentionExpiresAt.toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal: terminalExecutionStates.has(candidate.executionState),
        publicationSettled: candidate.publicationStatus === 'published',
        rejectionKeyReserved: true,
        pendingReferences: 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun) continue
      // Journal the retirement identity and the delete before applying them.
      if (options.journal !== undefined) {
        await options.journal([
          {
            kind: 'postgres.retireEventId',
            eventId: candidate.eventId,
            executionId: candidate.executionId,
            sequence: candidate.sequence,
            retiredAt: now.toISOString(),
          },
          { kind: 'postgres.deleteEvent', eventId: candidate.eventId },
        ])
      }
      const outcome = await this.database.transaction(async (transaction) => {
        await transaction
          .insert(retiredExecutionEventIds)
          .values({
            eventId: candidate.eventId,
            executionId: candidate.executionId,
            sequence: candidate.sequence,
            retiredAt: now,
          })
          .onConflictDoNothing()
        const removed = await transaction
          .delete(executionEvents)
          .where(
            and(
              eq(executionEvents.eventId, candidate.eventId),
              eq(executionEvents.publicationStatus, 'published'),
              lt(executionEvents.retentionExpiresAt, now)
            )
          )
          .returning({ eventId: executionEvents.eventId })
        return removed.length === 1
      })
      if (outcome) deleted += 1
      else raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  /** Temporary safety containment until atomic full eligibility is implemented. */
  async deleteExpiredEvents(now: Date): Promise<number> {
    if (Number.isNaN(now.getTime())) throw new Error('EVENT_RETENTION_INVALID_TIMESTAMP')
    throw new Error('EVENT_RETENTION_ELIGIBILITY_REQUIRED')
  }

  append(draft: ExecutionEventDraft): Promise<ExecutionEvent | undefined> {
    return this.database.transaction((transaction) =>
      appendExecutionEventInTransaction(transaction, draft)
    )
  }

  async transitionExecution(
    expectedVersion: number,
    execution: Execution,
    draft: ExecutionEventDraft
  ): Promise<ExecutionEvent | undefined> {
    const parsed = ExecutionSchema.parse(execution)
    return this.database
      .transaction(async (transaction) => {
        const updated = await transaction
          .update(executions)
          .set(toExecutionUpdate(parsed))
          .where(
            and(
              eq(executions.executionId, parsed.executionId),
              eq(executions.version, expectedVersion)
            )
          )
          .returning({ executionId: executions.executionId })
        if (updated.length !== 1) return undefined
        const event = await appendExecutionEventInTransaction(transaction, draft)
        if (!event) throw new EventInsertConflict()
        return event
      })
      .catch((error: unknown) => {
        if (error instanceof EventInsertConflict) return undefined
        throw error
      })
  }

  async get(eventId: string): Promise<ExecutionEvent | undefined> {
    const [row] = await this.database
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.eventId, eventId))
      .limit(1)
    return row ? fromExecutionEventRow(row) : undefined
  }

  async queryAfter(executionId: string, afterSequence: number, limit: number) {
    const rows = await this.database
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.executionId, executionId),
          gt(executionEvents.sequence, afterSequence),
          isNull(executionEvents.archivedAt)
        )
      )
      .orderBy(asc(executionEvents.sequence))
      .limit(limit)
    return rows.map(fromExecutionEventRow)
  }

  async latestInteraction(
    executionId: string,
    attemptId: string
  ): Promise<ExecutionEvent | undefined> {
    const [row] = await this.database
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.executionId, executionId),
          eq(executionEvents.attemptId, attemptId),
          eq(executionEvents.eventType, 'interaction.requested'),
          isNull(executionEvents.archivedAt)
        )
      )
      .orderBy(desc(executionEvents.sequence))
      .limit(1)
    return row ? fromExecutionEventRow(row) : undefined
  }

  async queryPending(limit: number, dueAt?: string) {
    const rows = await this.database
      .select()
      .from(executionEvents)
      .where(
        and(
          inArray(executionEvents.publicationStatus, ['pending', 'failed']),
          isNull(executionEvents.archivedAt),
          ...(dueAt
            ? [
                or(
                  isNull(executionEvents.nextAttemptAt),
                  lte(executionEvents.nextAttemptAt, new Date(dueAt))
                ),
              ]
            : [])
        )
      )
      .orderBy(asc(executionEvents.recordedAt))
      .limit(limit)
    return rows.map(fromExecutionEventRow)
  }

  async compareAndSetPublication(expectedVersion: number, event: ExecutionEvent): Promise<boolean> {
    const parsed = ExecutionEventSchema.parse(event)
    const updated = await this.database
      .update(executionEvents)
      .set({
        publicationStatus: parsed.publication.status,
        publicationAttempts: parsed.publication.attempts,
        publicationVersion: parsed.publication.version,
        lastAttemptAt: optionalDate(parsed.publication.lastAttemptAt),
        nextAttemptAt: optionalDate(parsed.publication.nextAttemptAt),
        publishedAt: optionalDate(parsed.publication.publishedAt),
        quarantinedAt: optionalDate(parsed.publication.quarantinedAt),
        publicationErrorReference: parsed.publication.errorReference ?? null,
      })
      .where(
        and(
          eq(executionEvents.eventId, parsed.eventId),
          eq(executionEvents.publicationVersion, expectedVersion)
        )
      )
      .returning({ eventId: executionEvents.eventId })
    return updated.length === 1
  }

  async archive(eventId: string, archivedAt: string): Promise<ExecutionEvent | undefined> {
    const [row] = await this.database
      .update(executionEvents)
      .set({ archivedAt: new Date(archivedAt) })
      .where(eq(executionEvents.eventId, eventId))
      .returning()
    return row ? fromExecutionEventRow(row) : undefined
  }

  /**
   * Bounded maintenance read for reconciliation: how many undelivered
   * (unarchived, pending or failed) events an execution still owes, capped at
   * `limit`. The count is a lower bound when the cap is reached, which is
   * enough for reconciliation: any positive count means delivery is owed.
   */
  async summarizePendingDelivery(
    executionId: string,
    limit: number
  ): Promise<PendingDeliverySummary> {
    ExecutionEventSchema.shape.executionId.parse(executionId)
    validScanLimit(limit)
    const rows = await this.database
      .select({ recordedAt: executionEvents.recordedAt })
      .from(executionEvents)
      .where(pendingDeliveryCondition(executionId))
      .orderBy(asc(executionEvents.recordedAt))
      .limit(limit)
    if (rows.length === 0) return { pendingCount: 0 }
    const oldest = rows[0]
    return {
      pendingCount: rows.length,
      ...(oldest === undefined ? {} : { oldestPendingAt: oldest.recordedAt.toISOString() }),
    }
  }

  /**
   * Re-arms delivery for an execution's undelivered events that are not yet
   * due, without attempting delivery itself: publication versions move
   * forward via compare-and-set so a concurrent dispatcher never races.
   * Returns how many events were re-armed.
   */
  async rearmPendingDelivery(executionId: string, dueAt: string, limit: number): Promise<number> {
    ExecutionEventSchema.shape.executionId.parse(executionId)
    if (Number.isNaN(Date.parse(dueAt))) throw new Error('INVALID_TIMESTAMP')
    validScanLimit(limit)
    const rows = await this.database
      .select()
      .from(executionEvents)
      .where(
        and(
          pendingDeliveryCondition(executionId),
          or(
            isNull(executionEvents.nextAttemptAt),
            gt(executionEvents.nextAttemptAt, new Date(dueAt))
          )
        )
      )
      .orderBy(asc(executionEvents.recordedAt))
      .limit(limit)
    let rearmed = 0
    for (const row of rows) {
      const event = fromExecutionEventRow(row)
      const nextAttemptAt = ExecutionEventSchema.parse({
        ...event,
        publication: {
          ...event.publication,
          version: event.publication.version + 1,
          nextAttemptAt: dueAt,
        },
      })
      if (await this.compareAndSetPublication(event.publication.version, nextAttemptAt)) {
        rearmed += 1
      }
    }
    return rearmed
  }
}

export interface PendingDeliverySummary {
  /** Lower bound of undelivered events, capped at the requested scan limit. */
  readonly pendingCount: number
  readonly oldestPendingAt?: string
}

function pendingDeliveryCondition(executionId: string) {
  return and(
    eq(executionEvents.executionId, executionId),
    inArray(executionEvents.publicationStatus, ['pending', 'failed']),
    isNull(executionEvents.archivedAt)
  )
}

function validScanLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('INVALID_LIMIT')
}

class EventInsertConflict extends Error {}

export type DatabaseTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]
type EventRow = typeof executionEvents.$inferSelect

export async function appendExecutionEventInTransaction(
  transaction: DatabaseTransaction,
  draft: ExecutionEventDraft
) {
  const sanitized = sanitizeExecutionEventDraft(draft)
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${sanitized.executionId}))`)
  // Deleted events keep their deduplication identity here: a retry of a retired
  // event id must not resurrect the event it replaced.
  const [retired] = await transaction
    .select({ eventId: retiredExecutionEventIds.eventId })
    .from(retiredExecutionEventIds)
    .where(eq(retiredExecutionEventIds.eventId, sanitized.eventId))
    .limit(1)
  if (retired !== undefined) return undefined
  const [latest] = await transaction
    .select({ sequence: executionEvents.sequence })
    .from(executionEvents)
    .where(eq(executionEvents.executionId, sanitized.executionId))
    .orderBy(sql`${executionEvents.sequence} desc`)
    .limit(1)
  // Sequences are never reused: retention deletion records the retired
  // sequence, so the next append continues above the historical maximum.
  const [retiredLatest] = await transaction
    .select({ sequence: retiredExecutionEventIds.sequence })
    .from(retiredExecutionEventIds)
    .where(eq(retiredExecutionEventIds.executionId, sanitized.executionId))
    .orderBy(desc(retiredExecutionEventIds.sequence))
    .limit(1)
  const nextSequence = Math.max(latest?.sequence ?? 0, retiredLatest?.sequence ?? 0) + 1
  const event = ExecutionEventSchema.parse({
    ...sanitized,
    sequence: nextSequence,
    payloadBytes: Buffer.byteLength(JSON.stringify(sanitized.payload)),
    payloadHash: hashExecutionEventPayloadV2(sanitized.payload),
    publication: { status: 'pending', attempts: 0, version: 1 },
  })
  const [inserted] = await transaction
    .insert(executionEvents)
    .values(toRow(event))
    .onConflictDoNothing()
    .returning()
  return inserted ? fromExecutionEventRow(inserted) : undefined
}

function toRow(event: ExecutionEvent): typeof executionEvents.$inferInsert {
  return {
    eventId: event.eventId,
    executionId: event.executionId,
    attemptId: event.attemptId ?? null,
    workflowId: event.workflowId ?? null,
    sequence: event.sequence,
    eventType: event.type,
    schemaVersion: event.schemaVersion,
    requestId: event.correlation.requestId,
    workspaceId: event.correlation.workspaceId,
    projectId: event.correlation.projectId,
    taskId: event.correlation.taskId,
    agentId: event.correlation.agentId,
    commandId: event.correlation.commandId ?? null,
    traceId: event.correlation.traceId,
    sensitivity: event.sensitivity ?? null,
    redaction: event.redaction ?? null,
    payload: event.payload,
    payloadBytes: event.payloadBytes,
    payloadHash: event.payloadHash,
    occurredAt: new Date(event.occurredAt),
    recordedAt: new Date(event.recordedAt),
    retentionExpiresAt: new Date(event.retentionExpiresAt),
    archivedAt: optionalDate(event.archivedAt),
    publicationStatus: event.publication.status,
    publicationAttempts: event.publication.attempts,
    publicationVersion: event.publication.version,
    lastAttemptAt: optionalDate(event.publication.lastAttemptAt),
    nextAttemptAt: optionalDate(event.publication.nextAttemptAt),
    publishedAt: optionalDate(event.publication.publishedAt),
    quarantinedAt: optionalDate(event.publication.quarantinedAt),
    publicationErrorReference: event.publication.errorReference ?? null,
  }
}

export function fromExecutionEventRow(row: EventRow): ExecutionEvent {
  return ExecutionEventSchema.parse({
    eventId: row.eventId,
    executionId: row.executionId,
    ...(row.attemptId ? { attemptId: row.attemptId } : {}),
    ...(row.workflowId ? { workflowId: row.workflowId } : {}),
    sequence: row.sequence,
    type: row.eventType,
    schemaVersion: row.schemaVersion,
    correlation: {
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      taskId: row.taskId,
      agentId: row.agentId,
      requestId: row.requestId,
      ...(row.commandId ? { commandId: row.commandId } : {}),
      traceId: row.traceId,
    },
    ...(row.sensitivity ? { sensitivity: row.sensitivity } : {}),
    ...(row.redaction ? { redaction: row.redaction } : {}),
    payload: row.payload,
    payloadBytes: row.payloadBytes,
    payloadHash: row.payloadHash,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    retentionExpiresAt: row.retentionExpiresAt.toISOString(),
    ...(row.archivedAt ? { archivedAt: row.archivedAt.toISOString() } : {}),
    publication: {
      status: row.publicationStatus,
      attempts: row.publicationAttempts,
      version: row.publicationVersion,
      ...(row.lastAttemptAt ? { lastAttemptAt: row.lastAttemptAt.toISOString() } : {}),
      ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt.toISOString() } : {}),
      ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
      ...(row.quarantinedAt ? { quarantinedAt: row.quarantinedAt.toISOString() } : {}),
      ...(row.publicationErrorReference ? { errorReference: row.publicationErrorReference } : {}),
    },
  })
}
function optionalDate(value: string | undefined): Date | null {
  return value ? new Date(value) : null
}
