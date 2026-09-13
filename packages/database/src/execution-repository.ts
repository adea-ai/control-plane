import {
  ExecutionAttemptSchema,
  ExecutionSchema,
  type Execution,
  type ExecutionAttempt,
  type ExecutionRepository,
} from '@control-plane/domain'
import { and, asc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { executionEvents } from './schema/events.js'
import { executionAttempts, executions } from './schema/executions.js'

const MAXIMUM_SCAN_LIMIT = 1_000

export interface ReconciliationCandidateScan {
  /** ISO timestamp; executions updated before it are stale enough to reconcile. */
  readonly staleBefore: string
  readonly limit: number
  /** Keyset cursor from the previous page; keeps repeated scans bounded. */
  readonly afterExecutionId?: string
}

export class PostgresExecutionRepository implements ExecutionRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  /**
   * Bounded maintenance scan for reconciliation candidates: non-terminal
   * executions that went stale, plus terminal executions that still hold
   * undelivered (unarchived, pending or failed) events. Keyset-ordered by
   * execution id so repeated pages never revisit rows.
   */
  async listReconciliationCandidates(
    input: ReconciliationCandidateScan
  ): Promise<readonly string[]> {
    if (Number.isNaN(Date.parse(input.staleBefore))) throw new Error('INVALID_STALE_BEFORE')
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAXIMUM_SCAN_LIMIT) {
      throw new Error('INVALID_LIMIT')
    }
    const staleBefore = new Date(input.staleBefore)
    const rows = await this.database
      .select({ executionId: executions.executionId })
      .from(executions)
      .where(
        and(
          input.afterExecutionId === undefined
            ? undefined
            : gt(executions.executionId, input.afterExecutionId),
          or(
            and(
              inArray(executions.state, [
                'accepted',
                'queued',
                'starting',
                'running',
                'awaiting_input',
                'cancelling',
                'reconciliation_required',
              ]),
              lt(executions.updatedAt, staleBefore)
            ),
            and(
              inArray(executions.state, ['completed', 'failed', 'cancelled', 'timed_out']),
              sql`exists (select 1 from ${executionEvents} where ${executionEvents.executionId} = ${executions.executionId} and ${executionEvents.publicationStatus} in ('pending', 'failed') and ${executionEvents.archivedAt} is null)`
            )
          )
        )
      )
      .orderBy(asc(executions.executionId))
      .limit(input.limit)
    return rows.map(({ executionId }) => executionId)
  }

  async insertExecution(execution: Execution): Promise<boolean> {
    const inserted = await this.database
      .insert(executions)
      .values(toExecutionRow(ExecutionSchema.parse(execution)))
      .onConflictDoNothing()
      .returning({ executionId: executions.executionId })
    return inserted.length === 1
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    const [row] = await this.database
      .select()
      .from(executions)
      .where(eq(executions.executionId, executionId))
      .limit(1)
    return row ? fromExecutionRow(row) : undefined
  }

  async compareAndSetExecution(expectedVersion: number, execution: Execution): Promise<boolean> {
    const parsed = ExecutionSchema.parse(execution)
    const current = await this.getExecution(parsed.executionId)
    if (!current || !hasSameImmutableExecutionIdentity(current, parsed)) return false
    const updated = await this.database
      .update(executions)
      .set(toExecutionUpdate(parsed))
      .where(
        and(eq(executions.executionId, parsed.executionId), eq(executions.version, expectedVersion))
      )
      .returning({ executionId: executions.executionId })
    return updated.length === 1
  }

  async insertAttempt(
    expectedExecutionVersion: number,
    execution: Execution,
    attempt: ExecutionAttempt
  ): Promise<boolean> {
    const parsedExecution = ExecutionSchema.parse(execution)
    const parsedAttempt = ExecutionAttemptSchema.parse(attempt)
    return this.database
      .transaction(async (transaction) => {
        const [currentRow] = await transaction
          .select()
          .from(executions)
          .where(eq(executions.executionId, parsedExecution.executionId))
          .limit(1)
        if (
          !currentRow ||
          !hasSameImmutableExecutionIdentity(fromExecutionRow(currentRow), parsedExecution)
        ) {
          return false
        }
        const updated = await transaction
          .update(executions)
          .set(toExecutionUpdate(parsedExecution))
          .where(
            and(
              eq(executions.executionId, parsedExecution.executionId),
              eq(executions.version, expectedExecutionVersion)
            )
          )
          .returning({ executionId: executions.executionId })
        if (updated.length !== 1) return false
        const inserted = await transaction
          .insert(executionAttempts)
          .values(toAttemptRow(parsedAttempt))
          .onConflictDoNothing()
          .returning({ attemptId: executionAttempts.attemptId })
        if (inserted.length !== 1) throw new AttemptInsertConflict()
        return true
      })
      .catch((error: unknown) => {
        if (error instanceof AttemptInsertConflict) return false
        throw error
      })
  }

  async getAttempt(attemptId: string): Promise<ExecutionAttempt | undefined> {
    const [row] = await this.database
      .select()
      .from(executionAttempts)
      .where(eq(executionAttempts.attemptId, attemptId))
      .limit(1)
    return row ? fromAttemptRow(row) : undefined
  }

  async listAttempts(executionId: string): Promise<readonly ExecutionAttempt[]> {
    const rows = await this.database
      .select()
      .from(executionAttempts)
      .where(eq(executionAttempts.executionId, executionId))
      .orderBy(asc(executionAttempts.sequence))
    return rows.map(fromAttemptRow)
  }

  async compareAndSetAttempt(expectedVersion: number, attempt: ExecutionAttempt): Promise<boolean> {
    const parsed = ExecutionAttemptSchema.parse(attempt)
    const current = await this.getAttempt(parsed.attemptId)
    if (!current || !hasSameImmutableAttemptIdentity(current, parsed)) return false
    const updated = await this.database
      .update(executionAttempts)
      .set(toAttemptUpdate(parsed))
      .where(
        and(
          eq(executionAttempts.attemptId, parsed.attemptId),
          eq(executionAttempts.version, expectedVersion)
        )
      )
      .returning({ attemptId: executionAttempts.attemptId })
    return updated.length === 1
  }
}

class AttemptInsertConflict extends Error {}

type ExecutionRow = typeof executions.$inferSelect
type AttemptRow = typeof executionAttempts.$inferSelect

export function toExecutionRow(execution: Execution): typeof executions.$inferInsert {
  return {
    executionId: execution.executionId,
    state: execution.state,
    version: execution.version,
    workspaceId: execution.correlation.workspaceId,
    projectId: execution.correlation.projectId,
    taskId: execution.correlation.taskId,
    agentId: execution.correlation.agentId,
    requestId: execution.correlation.requestId,
    executionPlanId: execution.executionPlan.executionPlanId,
    executionPlanDigest: execution.executionPlan.contentDigest,
    executionPlanSchemaVersion: execution.executionPlan.schemaVersion,
    marketplacePluginReferences: execution.marketplacePluginReferences ?? null,
    parentExecutionId: execution.parentExecutionId ?? null,
    attemptCount: execution.attemptCount,
    latestAttemptId: execution.latestAttemptId ?? null,
    failureClassification: execution.failure?.classification ?? null,
    failureCode: execution.failure?.code ?? null,
    terminalResultRef: execution.terminalResultRef ?? null,
    ...toTimestampRow(execution),
  }
}

export function toExecutionUpdate(execution: Execution): Partial<typeof executions.$inferInsert> {
  return {
    state: execution.state,
    version: execution.version,
    attemptCount: execution.attemptCount,
    latestAttemptId: execution.latestAttemptId ?? null,
    failureClassification: execution.failure?.classification ?? null,
    failureCode: execution.failure?.code ?? null,
    terminalResultRef: execution.terminalResultRef ?? null,
    ...toMutableTimestampRow(execution),
  }
}

export function fromExecutionRow(row: ExecutionRow): Execution {
  return ExecutionSchema.parse({
    executionId: row.executionId,
    state: row.state,
    version: row.version,
    correlation: {
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      taskId: row.taskId,
      agentId: row.agentId,
      requestId: row.requestId,
    },
    executionPlan: {
      executionPlanId: row.executionPlanId,
      contentDigest: row.executionPlanDigest,
      schemaVersion: row.executionPlanSchemaVersion,
    },
    ...(row.marketplacePluginReferences === null || row.marketplacePluginReferences === undefined
      ? {}
      : { marketplacePluginReferences: row.marketplacePluginReferences }),
    ...(row.parentExecutionId ? { parentExecutionId: row.parentExecutionId } : {}),
    attemptCount: row.attemptCount,
    ...(row.latestAttemptId ? { latestAttemptId: row.latestAttemptId } : {}),
    ...fromFailure(row),
    ...(row.terminalResultRef ? { terminalResultRef: row.terminalResultRef } : {}),
    ...fromTimestampRow(row),
  })
}

function toAttemptRow(attempt: ExecutionAttempt): typeof executionAttempts.$inferInsert {
  return {
    attemptId: attempt.attemptId,
    executionId: attempt.executionId,
    sequence: attempt.sequence,
    state: attempt.state,
    version: attempt.version,
    runtimeDefinitionId: attempt.runtime?.runtimeDefinitionId ?? null,
    runtimeNodeRefId: attempt.runtime?.runtimeNodeRefId ?? null,
    runtimeConnectionId: attempt.runtime?.runtimeConnectionId ?? null,
    externalSessionId: attempt.runtime?.externalSessionId ?? null,
    routingDecision: attempt.runtime?.routingDecision ?? null,
    failureClassification: attempt.failure?.classification ?? null,
    failureCode: attempt.failure?.code ?? null,
    terminalResultRef: attempt.terminalResultRef ?? null,
    ...toTimestampRow(attempt),
  }
}

export function toAttemptUpdate(
  attempt: ExecutionAttempt
): Partial<typeof executionAttempts.$inferInsert> {
  return {
    state: attempt.state,
    version: attempt.version,
    failureClassification: attempt.failure?.classification ?? null,
    failureCode: attempt.failure?.code ?? null,
    terminalResultRef: attempt.terminalResultRef ?? null,
    ...toMutableTimestampRow(attempt),
  }
}

export function fromAttemptRow(row: AttemptRow): ExecutionAttempt {
  const runtime = {
    ...(row.runtimeDefinitionId ? { runtimeDefinitionId: row.runtimeDefinitionId } : {}),
    ...(row.runtimeNodeRefId ? { runtimeNodeRefId: row.runtimeNodeRefId } : {}),
    ...(row.runtimeConnectionId ? { runtimeConnectionId: row.runtimeConnectionId } : {}),
    ...(row.externalSessionId ? { externalSessionId: row.externalSessionId } : {}),
    ...(row.routingDecision ? { routingDecision: row.routingDecision } : {}),
  }
  return ExecutionAttemptSchema.parse({
    attemptId: row.attemptId,
    executionId: row.executionId,
    sequence: row.sequence,
    state: row.state,
    version: row.version,
    ...(Object.keys(runtime).length > 0 ? { runtime } : {}),
    ...fromFailure(row),
    ...(row.terminalResultRef ? { terminalResultRef: row.terminalResultRef } : {}),
    ...fromTimestampRow(row),
  })
}

function toTimestampRow(lifecycle: Execution | ExecutionAttempt) {
  return {
    acceptedAt: new Date(lifecycle.acceptedAt),
    queuedAt: optionalDate(lifecycle.queuedAt),
    startingAt: optionalDate(lifecycle.startingAt),
    runningAt: optionalDate(lifecycle.runningAt),
    awaitingInputAt: optionalDate(lifecycle.awaitingInputAt),
    cancellingAt: optionalDate(lifecycle.cancellingAt),
    reconciliationRequiredAt: optionalDate(lifecycle.reconciliationRequiredAt),
    terminalAt: optionalDate(lifecycle.terminalAt),
    deadlineAt: optionalDate(lifecycle.deadlineAt),
    createdAt: new Date(lifecycle.createdAt),
    updatedAt: new Date(lifecycle.updatedAt),
  }
}

function toMutableTimestampRow(lifecycle: Execution | ExecutionAttempt) {
  const timestamps = toTimestampRow(lifecycle)
  return {
    queuedAt: timestamps.queuedAt,
    startingAt: timestamps.startingAt,
    runningAt: timestamps.runningAt,
    awaitingInputAt: timestamps.awaitingInputAt,
    cancellingAt: timestamps.cancellingAt,
    reconciliationRequiredAt: timestamps.reconciliationRequiredAt,
    terminalAt: timestamps.terminalAt,
    deadlineAt: timestamps.deadlineAt,
    updatedAt: timestamps.updatedAt,
  }
}

function fromTimestampRow(row: ExecutionRow | AttemptRow) {
  return {
    acceptedAt: row.acceptedAt.toISOString(),
    ...(row.queuedAt ? { queuedAt: row.queuedAt.toISOString() } : {}),
    ...(row.startingAt ? { startingAt: row.startingAt.toISOString() } : {}),
    ...(row.runningAt ? { runningAt: row.runningAt.toISOString() } : {}),
    ...(row.awaitingInputAt ? { awaitingInputAt: row.awaitingInputAt.toISOString() } : {}),
    ...(row.cancellingAt ? { cancellingAt: row.cancellingAt.toISOString() } : {}),
    ...(row.reconciliationRequiredAt
      ? { reconciliationRequiredAt: row.reconciliationRequiredAt.toISOString() }
      : {}),
    ...(row.terminalAt ? { terminalAt: row.terminalAt.toISOString() } : {}),
    ...(row.deadlineAt ? { deadlineAt: row.deadlineAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function fromFailure(row: {
  failureClassification: ExecutionRow['failureClassification']
  failureCode: string | null
}) {
  return row.failureClassification && row.failureCode
    ? { failure: { classification: row.failureClassification, code: row.failureCode } }
    : {}
}

function hasSameImmutableExecutionIdentity(left: Execution, right: Execution): boolean {
  return (
    left.executionId === right.executionId &&
    left.parentExecutionId === right.parentExecutionId &&
    JSON.stringify(left.correlation) === JSON.stringify(right.correlation) &&
    JSON.stringify(left.executionPlan) === JSON.stringify(right.executionPlan) &&
    left.acceptedAt === right.acceptedAt &&
    left.createdAt === right.createdAt
  )
}

function hasSameImmutableAttemptIdentity(left: ExecutionAttempt, right: ExecutionAttempt): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.executionId === right.executionId &&
    left.sequence === right.sequence &&
    JSON.stringify(left.runtime) === JSON.stringify(right.runtime) &&
    left.acceptedAt === right.acceptedAt &&
    left.createdAt === right.createdAt
  )
}

function optionalDate(value: string | undefined): Date | null {
  return value ? new Date(value) : null
}
