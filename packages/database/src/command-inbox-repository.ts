import { createHash } from 'node:crypto'
import {
  CommandInboxError,
  CommandInboxRecordSchema,
  CommandInboxScopeSchema,
  ExecutionSchema,
  type CommandAcceptanceRepository,
  type CommandAcceptanceResult,
  type CommandInboxRecord,
  type CommandInboxScope,
  type Execution,
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type RetentionAssessment,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { fromExecutionRow, toExecutionRow } from './execution-repository.js'
import { commandInbox } from './schema/commands.js'
import { executions } from './schema/executions.js'
import { retiredCommandKeys } from './schema/retired-command-keys.js'
import { lockExecutionPlanReference } from './execution-plan-repository.js'

const terminalExecutionStates = new Set<string>(['completed', 'failed', 'cancelled', 'timed_out'])

export class PostgresCommandAcceptanceRepository implements CommandAcceptanceRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  /**
   * Read-only eligibility assessment for the command-inbox class (#194).
   * Bounded by `bound` expired candidates, ordered oldest-deadline first, and
   * evaluated with the shared predicate. Never deletes: eligibility is
   * revalidated per candidate at claim time.
   */
  async assessExpiredInbox(
    now: Date,
    options: { readonly policyRetainMs: number | null; readonly bound?: number }
  ): Promise<RetentionAssessment> {
    if (Number.isNaN(now.getTime())) throw new Error('COMMAND_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const counter = new RetentionAssessmentCounter(
      'command-inbox',
      assessedAt,
      options.bound ?? 256
    )
    const candidates = await this.database
      .select({
        status: commandInbox.status,
        retentionExpiresAt: commandInbox.retentionExpiresAt,
        reconciliationRequiredAt: commandInbox.reconciliationRequiredAt,
        executionState: executions.state,
        callerPrincipalId: commandInbox.callerPrincipalId,
        operation: commandInbox.operation,
        workspaceId: commandInbox.workspaceId,
        projectId: commandInbox.projectId,
        idempotencyKey: commandInbox.idempotencyKey,
      })
      .from(commandInbox)
      .innerJoin(executions, eq(executions.executionId, commandInbox.executionId))
      .where(lt(commandInbox.retentionExpiresAt, now))
      .orderBy(asc(commandInbox.retentionExpiresAt))
      .limit(counter.bound + 1)
    const retiredKeys =
      candidates.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.database
                .select({ scopeKey: retiredCommandKeys.scopeKey })
                .from(retiredCommandKeys)
                .where(
                  inArray(
                    retiredCommandKeys.scopeKey,
                    candidates.map((candidate) => retirementKey(candidate))
                  )
                )
            ).map((row) => row.scopeKey)
          )
    for (const candidate of candidates) {
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt: candidate.retentionExpiresAt.toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal:
          ['completed', 'failed'].includes(candidate.status) &&
          terminalExecutionStates.has(candidate.executionState),
        publicationSettled: true,
        rejectionKeyReserved: retiredKeys.has(retirementKey(candidate)),
        pendingReferences: candidate.reconciliationRequiredAt === null ? 0 : 1,
        holds: 0,
      })
      if (!counter.add(verdict)) break
    }
    return counter.result()
  }

  /**
   * Deletes expired, eligible command-inbox rows (#194) while keeping the
   * reserved rejection key, so a replay of the same scoped idempotency key
   * still fails closed with COMMAND_RETENTION_EXPIRED.
   *
   * Each candidate is revalidated immediately before deletion: the delete is
   * guarded by the candidate's status and deadline, so a row that changed
   * between selection and deletion is reported as `raced` (affected rows 0)
   * rather than removed on stale evidence. `dryRun` defaults to true.
   */
  async deleteEligibleInbox(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('COMMAND_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter('command-inbox', assessedAt, options.bound ?? 64)
    let deleted = 0
    let raced = 0
    const candidates = await this.database
      .select({
        commandId: commandInbox.commandId,
        executionId: commandInbox.executionId,
        status: commandInbox.status,
        retentionExpiresAt: commandInbox.retentionExpiresAt,
        reconciliationRequiredAt: commandInbox.reconciliationRequiredAt,
        executionState: executions.state,
        callerPrincipalId: commandInbox.callerPrincipalId,
        operation: commandInbox.operation,
        workspaceId: commandInbox.workspaceId,
        projectId: commandInbox.projectId,
        idempotencyKey: commandInbox.idempotencyKey,
      })
      .from(commandInbox)
      .innerJoin(executions, eq(executions.executionId, commandInbox.executionId))
      .where(lt(commandInbox.retentionExpiresAt, now))
      .orderBy(asc(commandInbox.retentionExpiresAt))
      .limit(counter.bound + 1)
    const retiredKeys =
      candidates.length === 0
        ? new Map<string, { executionId: string; retiredAt: Date }>()
        : new Map(
            (
              await this.database
                .select({
                  scopeKey: retiredCommandKeys.scopeKey,
                  executionId: retiredCommandKeys.executionId,
                  retiredAt: retiredCommandKeys.retiredAt,
                })
                .from(retiredCommandKeys)
                .where(
                  inArray(
                    retiredCommandKeys.scopeKey,
                    candidates.map((candidate) => retirementKey(candidate))
                  )
                )
            ).map((row) => [
              row.scopeKey,
              { executionId: row.executionId, retiredAt: row.retiredAt },
            ])
          )
    for (const candidate of candidates) {
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt: candidate.retentionExpiresAt.toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal:
          ['completed', 'failed'].includes(candidate.status) &&
          terminalExecutionStates.has(candidate.executionState),
        publicationSettled: true,
        rejectionKeyReserved: retiredKeys.has(retirementKey(candidate)),
        pendingReferences: candidate.reconciliationRequiredAt === null ? 0 : 1,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun) continue
      // The rejection key is a precondition of eligibility, so the journal
      // restates it as well as the delete: a snapshot that predates the
      // retirement must regain its rejection identity during reapply.
      if (options.journal !== undefined) {
        const retirement = retiredKeys.get(retirementKey(candidate))
        await options.journal([
          ...(retirement === undefined
            ? []
            : [
                {
                  kind: 'postgres.retireCommandKey' as const,
                  scopeKey: retirementKey(candidate),
                  commandId: candidate.commandId,
                  executionId: retirement.executionId,
                  retiredAt: retirement.retiredAt.toISOString(),
                },
              ]),
          { kind: 'postgres.deleteCommand', commandId: candidate.commandId },
        ])
      }
      const removed = await this.database
        .delete(commandInbox)
        .where(
          and(
            eq(commandInbox.commandId, candidate.commandId),
            eq(commandInbox.status, candidate.status),
            lt(commandInbox.retentionExpiresAt, now)
          )
        )
        .returning({ commandId: commandInbox.commandId })
      if (removed.length === 1) deleted += 1
      else raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  /** Temporary safety containment until atomic full eligibility is implemented. */
  async deleteExpiredInbox(now: Date): Promise<number> {
    if (Number.isNaN(now.getTime())) throw new Error('COMMAND_RETENTION_INVALID_TIMESTAMP')
    throw new Error('COMMAND_RETENTION_ELIGIBILITY_REQUIRED')
  }

  async accept(
    command: CommandInboxRecord,
    execution: Execution
  ): Promise<CommandAcceptanceResult> {
    const parsedCommand = CommandInboxRecordSchema.parse(command)
    const parsedExecution = ExecutionSchema.parse(execution)
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${retirementKey(parsedCommand)}, 0))`
      )
      await assertNotRetired(transaction, parsedCommand)
      const [existingScope] = await transaction
        .select({ commandId: commandInbox.commandId })
        .from(commandInbox)
        .where(scopeWhere(parsedCommand))
        .limit(1)
      if (!existingScope) {
        if (
          parsedCommand.executionPlan.executionPlanId !==
            parsedExecution.executionPlan.executionPlanId ||
          parsedCommand.executionPlan.contentDigest !==
            parsedExecution.executionPlan.contentDigest ||
          !(await lockExecutionPlanReference(transaction, parsedExecution.executionPlan))
        ) {
          throw new CommandInboxError('INVALID_EXECUTION_PLAN_REFERENCE')
        }
      }
      const insertedCommand = await transaction
        .insert(commandInbox)
        .values(toCommandRow(parsedCommand))
        .onConflictDoNothing()
        .returning({ commandId: commandInbox.commandId })
      if (insertedCommand.length === 1) {
        await transaction.insert(executions).values(toExecutionRow(parsedExecution))
        return { outcome: 'accepted', command: parsedCommand, execution: parsedExecution }
      }

      const [existingRow] = await transaction
        .select()
        .from(commandInbox)
        .where(scopeWhere(parsedCommand))
        .limit(1)
      if (!existingRow) throw new Error('COMMAND_ID_CONFLICT')
      const existing = fromCommandRow(existingRow)
      const [executionRow] = await transaction
        .select()
        .from(executions)
        .where(eq(executions.executionId, existing.executionId))
        .limit(1)
      if (!executionRow) throw new Error('COMMAND_EXECUTION_INVARIANT_VIOLATION')
      const existingExecution = fromExecutionRow(executionRow)
      if (existing.payloadHash === parsedCommand.payloadHash) {
        return { outcome: 'duplicate', command: existing, execution: existingExecution }
      }

      const [conflictedRow] = await transaction
        .update(commandInbox)
        .set({
          conflictCount: sql`${commandInbox.conflictCount} + 1`,
          lastConflictAt: new Date(parsedCommand.lastSeenAt),
          lastSeenAt: new Date(parsedCommand.lastSeenAt),
          version: sql`${commandInbox.version} + 1`,
        })
        .where(eq(commandInbox.commandId, existing.commandId))
        .returning()
      if (!conflictedRow) throw new Error('COMMAND_CONFLICT_AUDIT_FAILED')
      return {
        outcome: 'conflict',
        command: fromCommandRow(conflictedRow),
        execution: existingExecution,
      }
    })
  }

  async get(scope: CommandInboxScope): Promise<CommandInboxRecord | undefined> {
    const parsed = CommandInboxScopeSchema.parse(scope)
    await assertNotRetired(this.database, parsed)
    const [row] = await this.database.select().from(commandInbox).where(scopeWhere(parsed)).limit(1)
    return row ? fromCommandRow(row) : undefined
  }

  /** Reserve a rejection key; domain payload deletion remains a separate operation. */
  async retireExpiredCommand(scopeInput: CommandInboxScope, retiredAt: string): Promise<boolean> {
    const scope = CommandInboxScopeSchema.parse(scopeInput)
    const timestamp = new Date(retiredAt)
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== retiredAt)
      throw new Error('COMMAND_RETIREMENT_INVALID_TIMESTAMP')
    const key = retirementKey(scope)
    return this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
      const [retired] = await transaction
        .select()
        .from(retiredCommandKeys)
        .where(eq(retiredCommandKeys.scopeKey, key))
        .limit(1)
      if (retired) return true
      const [row] = await transaction
        .select()
        .from(commandInbox)
        .where(scopeWhere(scope))
        .limit(1)
        .for('update')
      if (!row) return false
      const command = fromCommandRow(row)
      const [executionRow] = await transaction
        .select()
        .from(executions)
        .where(eq(executions.executionId, command.executionId))
        .limit(1)
        .for('update')
      if (!executionRow) throw new Error('COMMAND_EXECUTION_INVARIANT_VIOLATION')
      const execution = fromExecutionRow(executionRow)
      if (
        !['completed', 'failed'].includes(command.status) ||
        !['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state) ||
        timestamp.getTime() <= Date.parse(command.retentionExpiresAt)
      )
        return false
      await transaction.insert(retiredCommandKeys).values({
        scopeKey: key,
        commandId: command.commandId,
        executionId: command.executionId,
        retiredAt: timestamp,
      })
      return true
    })
  }

  async getByExecutionId(executionId: string): Promise<CommandInboxRecord | undefined> {
    const parsedId = ExecutionSchema.shape.executionId.parse(executionId)
    const [row] = await this.database
      .select()
      .from(commandInbox)
      .where(eq(commandInbox.executionId, parsedId))
      .limit(1)
    return row ? fromCommandRow(row) : undefined
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    const parsedId = ExecutionSchema.shape.executionId.parse(executionId)
    const [row] = await this.database
      .select()
      .from(executions)
      .where(eq(executions.executionId, parsedId))
      .limit(1)
    return row ? fromExecutionRow(row) : undefined
  }

  async compareAndSet(expectedVersion: number, command: CommandInboxRecord): Promise<boolean> {
    const parsed = CommandInboxRecordSchema.parse(command)
    const updated = await this.database
      .update(commandInbox)
      .set(toCommandUpdate(parsed))
      .where(
        and(
          eq(commandInbox.commandId, parsed.commandId),
          eq(commandInbox.version, expectedVersion),
          scopeWhere(parsed)
        )
      )
      .returning({ commandId: commandInbox.commandId })
    return updated.length === 1
  }
}

type CommandRow = typeof commandInbox.$inferSelect

type CommandTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]

async function assertNotRetired(
  database: ControlPlaneDatabase | CommandTransaction,
  scope: CommandInboxScope
): Promise<void> {
  const [row] = await database
    .select()
    .from(retiredCommandKeys)
    .where(eq(retiredCommandKeys.scopeKey, retirementKey(scope)))
    .limit(1)
  if (row) throw new CommandInboxError('COMMAND_RETENTION_EXPIRED')
}

// Structural input: retirement only joins the scoped identity strings, so the
// assessment can reuse it for selected projection rows.
function retirementKey(scope: {
  readonly callerPrincipalId: string
  readonly operation: string
  readonly workspaceId: string
  readonly projectId: string
  readonly idempotencyKey: string
}): string {
  return createHash('sha256')
    .update(
      [
        scope.callerPrincipalId,
        scope.operation,
        scope.workspaceId,
        scope.projectId,
        scope.idempotencyKey,
      ].join('\u001f')
    )
    .digest('hex')
}

function toCommandRow(command: CommandInboxRecord): typeof commandInbox.$inferInsert {
  return {
    commandId: command.commandId,
    callerPrincipalId: command.callerPrincipalId,
    operation: command.operation,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    taskId: command.taskId,
    agentId: command.agentId,
    requestId: command.requestId,
    idempotencyKey: command.idempotencyKey,
    payloadHash: command.payloadHash,
    status: command.status,
    executionId: command.executionId,
    executionPlanId: command.executionPlan.executionPlanId,
    executionPlanDigest: command.executionPlan.contentDigest,
    executionPlanSchemaVersion: command.executionPlan.schemaVersion,
    version: command.version,
    conflictCount: command.conflictCount,
    receivedAt: new Date(command.receivedAt),
    lastSeenAt: new Date(command.lastSeenAt),
    retentionExpiresAt: new Date(command.retentionExpiresAt),
    lastConflictAt: optionalDate(command.lastConflictAt),
    processingAt: optionalDate(command.processingAt),
    reconciliationRequiredAt: optionalDate(command.reconciliationRequiredAt),
    terminalAt: optionalDate(command.terminalAt),
    resultReference: command.resultReference ?? null,
    errorReference: command.errorReference ?? null,
  }
}

function toCommandUpdate(command: CommandInboxRecord): Partial<typeof commandInbox.$inferInsert> {
  return {
    status: command.status,
    version: command.version,
    conflictCount: command.conflictCount,
    lastSeenAt: new Date(command.lastSeenAt),
    lastConflictAt: optionalDate(command.lastConflictAt),
    processingAt: optionalDate(command.processingAt),
    reconciliationRequiredAt: optionalDate(command.reconciliationRequiredAt),
    terminalAt: optionalDate(command.terminalAt),
    resultReference: command.resultReference ?? null,
    errorReference: command.errorReference ?? null,
  }
}

function fromCommandRow(row: CommandRow): CommandInboxRecord {
  return CommandInboxRecordSchema.parse({
    commandId: row.commandId,
    callerPrincipalId: row.callerPrincipalId,
    operation: row.operation,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    taskId: row.taskId,
    agentId: row.agentId,
    requestId: row.requestId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    status: row.status,
    executionId: row.executionId,
    executionPlan: {
      executionPlanId: row.executionPlanId,
      contentDigest: row.executionPlanDigest,
      schemaVersion: row.executionPlanSchemaVersion,
    },
    version: row.version,
    conflictCount: row.conflictCount,
    receivedAt: row.receivedAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    retentionExpiresAt: row.retentionExpiresAt.toISOString(),
    ...(row.lastConflictAt ? { lastConflictAt: row.lastConflictAt.toISOString() } : {}),
    ...(row.processingAt ? { processingAt: row.processingAt.toISOString() } : {}),
    ...(row.reconciliationRequiredAt
      ? { reconciliationRequiredAt: row.reconciliationRequiredAt.toISOString() }
      : {}),
    ...(row.terminalAt ? { terminalAt: row.terminalAt.toISOString() } : {}),
    ...(row.resultReference ? { resultReference: row.resultReference } : {}),
    ...(row.errorReference ? { errorReference: row.errorReference } : {}),
  })
}

function scopeWhere(scope: CommandInboxScope) {
  return and(
    eq(commandInbox.callerPrincipalId, scope.callerPrincipalId),
    eq(commandInbox.operation, scope.operation),
    eq(commandInbox.workspaceId, scope.workspaceId),
    eq(commandInbox.projectId, scope.projectId),
    eq(commandInbox.idempotencyKey, scope.idempotencyKey)
  )
}

function optionalDate(value: string | undefined): Date | null {
  return value ? new Date(value) : null
}
