import {
  ExecutionAttemptSchema,
  ExecutionSchema,
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type Execution,
  type ExecutionAttempt,
  type ExecutionRepository,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import { and, asc, eq, gt, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { commandInbox } from './schema/commands.js'
import { executionEvents } from './schema/events.js'
import { executionAttempts, executions } from './schema/executions.js'
import { reconciliationCheckpoints } from './schema/reconciliation.js'

const MAXIMUM_SCAN_LIMIT = 1_000

/**
 * The class has no stored retention deadline, so eligibility derives one from
 * the terminal instant and the configured duration. A null duration yields no
 * deadline, which the shared predicate reads as an unbounded class.
 */
function effectiveDeadline(
  terminalAt: Date | null,
  policyRetainMs: number | null
): string | undefined {
  if (terminalAt === null) return undefined
  if (policyRetainMs === null) return undefined
  return new Date(terminalAt.getTime() + policyRetainMs).toISOString()
}

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
   * Deletes terminal executions and their settled attempts (#194) once the
   * retention duration has passed since the terminal instant, and only when
   * nothing that must outlive them still references them.
   *
   * The ordering proof for this class is reference safety, so it is the last
   * class to become eligible: an execution stays retained while its acceptance
   * record, its events, its reconciliation checkpoint or a non-terminal attempt
   * still exists. Attempts are removed with the execution, terminal ones only,
   * and every delete is guarded by the row version so a concurrent transition
   * is reported as `raced` rather than forced. `dryRun` defaults to true.
   */
  async deleteEligibleExecutions(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('EXECUTION_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter('executions', assessedAt, options.bound ?? 64)
    let deleted = 0
    let raced = 0
    const candidates = await this.database
      .select({
        executionId: executions.executionId,
        state: executions.state,
        version: executions.version,
        terminalAt: executions.terminalAt,
      })
      .from(executions)
      .where(
        and(
          sql`${executions.state} in ('completed', 'failed', 'cancelled', 'timed_out')`,
          isNotNull(executions.terminalAt),
          ...(options.policyRetainMs === null
            ? []
            : [lt(executions.terminalAt, new Date(now.getTime() - options.policyRetainMs))])
        )
      )
      .orderBy(asc(executions.terminalAt))
      .limit(counter.bound + 1)
    const candidateIds = candidates.map((candidate) => candidate.executionId)
    const attemptsByExecution = await this.#terminalAttempts(candidateIds)
    const references = await this.#referenceSets(candidateIds)
    for (const candidate of candidates) {
      const attempts = attemptsByExecution.get(candidate.executionId) ?? []
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt: effectiveDeadline(candidate.terminalAt, options.policyRetainMs),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal: true,
        publicationSettled: true,
        rejectionKeyReserved: true,
        pendingReferences:
          references.commands.has(candidate.executionId) ||
          references.events.has(candidate.executionId) ||
          references.checkpoints.has(candidate.executionId) ||
          references.activeAttempts.has(candidate.executionId)
            ? 1
            : 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun) continue
      if (options.journal !== undefined) {
        await options.journal([
          ...attempts.map((attempt) => ({
            kind: 'postgres.deleteAttempt' as const,
            attemptId: attempt.attemptId,
          })),
          { kind: 'postgres.deleteExecution' as const, executionId: candidate.executionId },
        ])
      }
      const removed = await this.database.transaction(async (transaction) => {
        if (attempts.length > 0) {
          await transaction.delete(executionAttempts).where(
            inArray(
              executionAttempts.attemptId,
              attempts.map((attempt) => attempt.attemptId)
            )
          )
        }
        return transaction
          .delete(executions)
          .where(
            and(
              eq(executions.executionId, candidate.executionId),
              eq(executions.state, candidate.state),
              eq(executions.version, candidate.version)
            )
          )
          .returning({ executionId: executions.executionId })
      })
      if (removed.length === 1) deleted += 1
      else raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  /**
   * Every namespace that carries execution identity, as sets of execution ids
   * among `executionIds`. Plain selects rather than correlated subqueries: the
   * driver's boolean representation is not JS truthiness.
   */
  async #referenceSets(executionIds: readonly string[]): Promise<{
    commands: Set<string>
    events: Set<string>
    checkpoints: Set<string>
    activeAttempts: Set<string>
  }> {
    if (executionIds.length === 0) {
      return {
        commands: new Set(),
        events: new Set(),
        checkpoints: new Set(),
        activeAttempts: new Set(),
      }
    }
    const ids = [...executionIds]
    const [commands, events, checkpoints, activeAttempts] = await Promise.all([
      this.database
        .select({ executionId: commandInbox.executionId })
        .from(commandInbox)
        .where(inArray(commandInbox.executionId, ids)),
      this.database
        .select({ executionId: executionEvents.executionId })
        .from(executionEvents)
        .where(inArray(executionEvents.executionId, ids)),
      this.database
        .select({ executionId: reconciliationCheckpoints.executionId })
        .from(reconciliationCheckpoints)
        .where(inArray(reconciliationCheckpoints.executionId, ids)),
      this.database
        .select({ executionId: executionAttempts.executionId })
        .from(executionAttempts)
        .where(
          and(
            inArray(executionAttempts.executionId, ids),
            sql`${executionAttempts.state} not in ('completed', 'failed', 'cancelled', 'timed_out')`
          )
        ),
    ])
    return {
      commands: new Set(commands.map((row) => row.executionId)),
      events: new Set(events.map((row) => row.executionId)),
      checkpoints: new Set(checkpoints.map((row) => row.executionId)),
      activeAttempts: new Set(activeAttempts.map((row) => row.executionId)),
    }
  }

  async #terminalAttempts(
    executionIds: readonly string[]
  ): Promise<Map<string, readonly { attemptId: string }[]>> {
    const grouped = new Map<string, { attemptId: string }[]>()
    if (executionIds.length === 0) return grouped
    const rows = await this.database
      .select({
        attemptId: executionAttempts.attemptId,
        executionId: executionAttempts.executionId,
      })
      .from(executionAttempts)
      .where(
        and(
          inArray(executionAttempts.executionId, [...executionIds]),
          sql`${executionAttempts.state} in ('completed', 'failed', 'cancelled', 'timed_out')`
        )
      )
    for (const row of rows) {
      const bucket = grouped.get(row.executionId)
      if (bucket === undefined) grouped.set(row.executionId, [{ attemptId: row.attemptId }])
      else bucket.push({ attemptId: row.attemptId })
    }
    return grouped
  }

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
