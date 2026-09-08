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
} from '@control-plane/domain'
import { and, eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { fromExecutionRow, toExecutionRow } from './execution-repository.js'
import { commandInbox } from './schema/commands.js'
import { executions } from './schema/executions.js'
import { retiredCommandKeys } from './schema/retired-command-keys.js'

export class PostgresCommandAcceptanceRepository implements CommandAcceptanceRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

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

function retirementKey(scope: CommandInboxScope): string {
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
