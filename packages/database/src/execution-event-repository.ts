import { ExecutionSchema, type Execution } from '@control-plane/domain'
import {
  ExecutionEventSchema,
  hashExecutionEventPayload,
  sanitizeExecutionEventDraft,
  type ExecutionEvent,
  type ExecutionEventDraft,
  type ExecutionEventRepository,
} from '@control-plane/events'
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { toExecutionUpdate } from './execution-repository.js'
import { executionEvents } from './schema/events.js'
import { executions } from './schema/executions.js'

export class PostgresExecutionEventRepository implements ExecutionEventRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

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
  const [latest] = await transaction
    .select({ sequence: executionEvents.sequence })
    .from(executionEvents)
    .where(eq(executionEvents.executionId, sanitized.executionId))
    .orderBy(sql`${executionEvents.sequence} desc`)
    .limit(1)
  const event = ExecutionEventSchema.parse({
    ...sanitized,
    sequence: (latest?.sequence ?? 0) + 1,
    payloadBytes: Buffer.byteLength(JSON.stringify(sanitized.payload)),
    payloadHash: hashExecutionEventPayload(sanitized.payload),
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
