import {
  CommandInboxError,
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
import { delegations } from './schema/delegations.js'
import { executionEvents } from './schema/events.js'
import { executionCancellations } from './schema/execution-cancellations.js'
import { executionAttempts, executions } from './schema/executions.js'
import { interactionCommands } from './schema/interaction-commands.js'
import { interactionRequests } from './schema/interactions.js'
import { runtimeCommands } from './schema/runtime-commands.js'
import { reconciliationCheckpoints } from './schema/reconciliation.js'
import { lockExecutionPlanReference } from './execution-plan-repository.js'
import { usageLedgerEntries } from './schema/usage-ledger.js'

const MAXIMUM_SCAN_LIMIT = 1_000
type ExecutionReferenceReader = Pick<ControlPlaneDatabase, 'select'>

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

function hasCompleteAttemptHistory(
  attemptCount: number,
  latestAttemptId: string | null | undefined,
  attempts: readonly { attemptId: string; sequence: number }[]
): boolean {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 0 || attempts.length !== attemptCount)
    return false
  if (attemptCount === 0) return latestAttemptId == null
  if (latestAttemptId == null) return false

  const ordered = [...attempts].toSorted((left, right) => left.sequence - right.sequence)
  return (
    new Set(ordered.map((attempt) => attempt.attemptId)).size === attemptCount &&
    ordered.every((attempt, index) => attempt.sequence === index + 1) &&
    ordered.at(-1)?.attemptId === latestAttemptId
  )
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
   * record, either command receipt, an interaction request, its events,
   * reconciliation checkpoint, non-terminal attempt, runtime command, usage
   * ledger entry, or delegation endpoint still exists.
   * Attempts are removed with the execution, terminal ones only,
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
    for (const candidate of candidates) {
      const outcome = await this.database.transaction(async (transaction) => {
        const [owner] = await transaction
          .select({
            executionId: executions.executionId,
            state: executions.state,
            version: executions.version,
            terminalAt: executions.terminalAt,
            attemptCount: executions.attemptCount,
            latestAttemptId: executions.latestAttemptId,
          })
          .from(executions)
          .where(eq(executions.executionId, candidate.executionId))
          .for('update')
          .limit(1)
        if (owner === undefined) return { kind: 'missing' as const }

        // The owner lock serializes new FK-backed rows and reserve writers. Lock
        // attempts next, then take every reference snapshot inside this claim.
        const attempts = await transaction
          .select({
            attemptId: executionAttempts.attemptId,
            sequence: executionAttempts.sequence,
            state: executionAttempts.state,
          })
          .from(executionAttempts)
          .where(eq(executionAttempts.executionId, owner.executionId))
          .for('update')
        const attemptsComplete = hasCompleteAttemptHistory(
          owner.attemptCount,
          owner.latestAttemptId,
          attempts
        )
        const references = await this.#referenceSets([owner.executionId], transaction)
        const verdict = evaluateRetentionEligibility({
          retentionExpiresAt: effectiveDeadline(owner.terminalAt, options.policyRetainMs),
          now: assessedAt,
          policyRetainMs: options.policyRetainMs,
          ownerTerminal:
            owner.terminalAt !== null &&
            ['completed', 'failed', 'cancelled', 'timed_out'].includes(owner.state),
          publicationSettled: true,
          rejectionKeyReserved: true,
          pendingReferences:
            references.commands.has(owner.executionId) ||
            references.events.has(owner.executionId) ||
            references.checkpoints.has(owner.executionId) ||
            references.activeAttempts.has(owner.executionId) ||
            references.runtimeCommands.has(owner.executionId) ||
            references.cancellationReceipts.has(owner.executionId) ||
            references.interactionReceipts.has(owner.executionId) ||
            references.interactionRequests.has(owner.executionId) ||
            references.usageLedger.has(owner.executionId) ||
            references.delegations.has(owner.executionId) ||
            !attemptsComplete
              ? 1
              : 0,
          holds: 0,
        })
        if (!counter.add(verdict)) return { kind: 'bound' as const }
        if (verdict.verdict !== 'eligible' || dryRun) return { kind: 'assessed' as const }

        if (options.journal !== undefined) {
          await options.journal([
            ...attempts.map((attempt) => ({
              kind: 'postgres.deleteAttempt' as const,
              attemptId: attempt.attemptId,
            })),
            { kind: 'postgres.deleteExecution' as const, executionId: owner.executionId },
          ])
        }
        if (attempts.length > 0) {
          await transaction.delete(executionAttempts).where(
            inArray(
              executionAttempts.attemptId,
              attempts.map((attempt) => attempt.attemptId)
            )
          )
        }
        const removed = await transaction
          .delete(executions)
          .where(
            and(
              eq(executions.executionId, owner.executionId),
              eq(executions.state, owner.state),
              eq(executions.version, owner.version)
            )
          )
          .returning({ executionId: executions.executionId })
        return { kind: removed.length === 1 ? ('deleted' as const) : ('raced' as const) }
      })
      if (outcome.kind === 'bound') {
        break
      }
      if (outcome.kind === 'missing' || outcome.kind === 'raced') raced += 1
      if (outcome.kind === 'deleted') deleted += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  /**
   * Every namespace that carries execution identity, as sets of execution ids
   * among `executionIds`. Receipt references are read from their JSON identity
   * fields; interaction requests and usage entries have FKs, while delegations
   * carry parent/child identity without FKs.
   */
  async #referenceSets(
    executionIds: readonly string[],
    database: ExecutionReferenceReader = this.database
  ): Promise<{
    commands: Set<string>
    events: Set<string>
    checkpoints: Set<string>
    activeAttempts: Set<string>
    runtimeCommands: Set<string>
    cancellationReceipts: Set<string>
    interactionReceipts: Set<string>
    interactionRequests: Set<string>
    usageLedger: Set<string>
    delegations: Set<string>
  }> {
    if (executionIds.length === 0) {
      return {
        commands: new Set(),
        events: new Set(),
        checkpoints: new Set(),
        activeAttempts: new Set(),
        runtimeCommands: new Set(),
        cancellationReceipts: new Set(),
        interactionReceipts: new Set(),
        interactionRequests: new Set(),
        usageLedger: new Set(),
        delegations: new Set(),
      }
    }
    const ids = [...executionIds]
    const [
      commands,
      events,
      checkpoints,
      activeAttempts,
      runtimeCommandRefs,
      cancellationReceiptRefs,
      interactionPayloadRefs,
      interactionRequestRefs,
      directInteractionRequests,
      usageLedgerRefs,
      delegationRefs,
    ] = await Promise.all([
      database
        .select({ executionId: commandInbox.executionId })
        .from(commandInbox)
        .where(inArray(commandInbox.executionId, ids)),
      database
        .select({ executionId: executionEvents.executionId })
        .from(executionEvents)
        .where(inArray(executionEvents.executionId, ids)),
      database
        .select({ executionId: reconciliationCheckpoints.executionId })
        .from(reconciliationCheckpoints)
        .where(inArray(reconciliationCheckpoints.executionId, ids)),
      database
        .select({ executionId: executionAttempts.executionId })
        .from(executionAttempts)
        .where(
          and(
            inArray(executionAttempts.executionId, ids),
            sql`${executionAttempts.state} not in ('completed', 'failed', 'cancelled', 'timed_out')`
          )
        ),
      // Runtime commands and their receipts are deleted by their own class, so
      // an execution that still has them is not eligible — the foreign key
      // would refuse the delete anyway, and one class must never depend on
      // another's ordering to avoid a failed pass.
      database
        .select({ executionId: runtimeCommands.executionId })
        .from(runtimeCommands)
        .where(inArray(runtimeCommands.executionId, ids)),
      database
        .select({
          executionId: sql<string>`${executionCancellations.receipt}->'request'->'payload'->>'executionId'`,
        })
        .from(executionCancellations)
        .where(
          inArray(
            sql<string>`${executionCancellations.receipt}->'request'->'payload'->>'executionId'`,
            ids
          )
        ),
      database
        .select({
          executionId: sql<string>`${interactionCommands.receipt}->'request'->'payload'->>'executionId'`,
        })
        .from(interactionCommands)
        .where(
          inArray(
            sql<string>`${interactionCommands.receipt}->'request'->'payload'->>'executionId'`,
            ids
          )
        ),
      database
        .select({ executionId: interactionRequests.executionId })
        .from(interactionRequests)
        .innerJoin(
          interactionCommands,
          sql`${interactionCommands.receipt}->'request'->'payload'->>'interactionId' = ${interactionRequests.interactionId}`
        )
        .where(inArray(interactionRequests.executionId, ids)),
      database
        .select({ executionId: interactionRequests.executionId })
        .from(interactionRequests)
        .where(inArray(interactionRequests.executionId, ids)),
      database
        .select({ executionId: usageLedgerEntries.executionId })
        .from(usageLedgerEntries)
        .where(inArray(usageLedgerEntries.executionId, ids)),
      database
        .select({
          parentExecutionId: delegations.parentExecutionId,
          childExecutionId: delegations.childExecutionId,
        })
        .from(delegations)
        .where(
          or(
            inArray(delegations.parentExecutionId, ids),
            inArray(delegations.childExecutionId, ids)
          )
        ),
    ])
    return {
      commands: new Set(commands.map((row) => row.executionId)),
      events: new Set(events.map((row) => row.executionId)),
      checkpoints: new Set(checkpoints.map((row) => row.executionId)),
      activeAttempts: new Set(activeAttempts.map((row) => row.executionId)),
      runtimeCommands: new Set(runtimeCommandRefs.map((row) => row.executionId)),
      cancellationReceipts: new Set(cancellationReceiptRefs.map((row) => row.executionId)),
      interactionReceipts: new Set([
        ...interactionPayloadRefs.map((row) => row.executionId),
        ...interactionRequestRefs.map((row) => row.executionId),
      ]),
      interactionRequests: new Set(directInteractionRequests.map((row) => row.executionId)),
      usageLedger: new Set(usageLedgerRefs.map((row) => row.executionId)),
      delegations: new Set(
        delegationRefs.flatMap((row) => [row.parentExecutionId, row.childExecutionId])
      ),
    }
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
    const parsed = ExecutionSchema.parse(execution)
    return this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ executionId: executions.executionId })
        .from(executions)
        .where(eq(executions.executionId, parsed.executionId))
        .limit(1)
      if (existing) return false
      if (!(await lockExecutionPlanReference(transaction, parsed.executionPlan))) {
        throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
      }
      const inserted = await transaction
        .insert(executions)
        .values(toExecutionRow(parsed))
        .onConflictDoNothing()
        .returning({ executionId: executions.executionId })
      return inserted.length === 1
    })
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
