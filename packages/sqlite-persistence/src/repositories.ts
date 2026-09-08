import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  CommandInboxRecordSchema,
  CommandInboxScopeSchema,
  CommandInboxError,
  ExecutionAttemptSchema,
  ExecutionSchema,
  type CommandAcceptanceRepository,
  type CommandAcceptanceResult,
  type CommandInboxRecord,
  type CommandInboxScope,
  type Execution,
  type ExecutionAttempt,
  type ExecutionRepository,
} from '@control-plane/domain'
import {
  ExecutionPlanReferenceSchema,
  ExecutionValidationCommandScopeSchema,
  ExecutionValidationCommandRecordSchema,
  executionValidationCommandKey,
  assertExecutionValidationCommandPlan,
  type ExecutionValidationCommandScope,
  type ExecutionValidationCommandRecord,
  type ExecutionValidationCommandRepository,
  assertExecutionPlanIntegrity,
  type ExecutionPlan,
  type ExecutionPlanReference,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'

const namespaces = {
  commands: 'command-inbox',
  retiredCommands: 'retired-command-keys',
  commandByExecution: 'command-by-execution',
  executions: 'executions',
  attempts: 'execution-attempts',
  plans: 'execution-plans',
} as const

export class SqliteCommandAcceptanceRepository implements CommandAcceptanceRepository {
  constructor(readonly provider: PersistenceProvider) {}

  accept(
    commandInput: CommandInboxRecord,
    executionInput: Execution
  ): Promise<CommandAcceptanceResult> {
    const command = CommandInboxRecordSchema.parse(commandInput)
    const execution = ExecutionSchema.parse(executionInput)
    return this.provider.transaction(async (transaction) => {
      const commandId = recordId(scopeKey(command))
      await this.#assertNotRetired(transaction, commandId)
      const existingRecord = await transaction.get(namespaces.commands, commandId)
      if (existingRecord === undefined) {
        if (
          (await transaction.get(namespaces.executions, recordId(execution.executionId))) !==
          undefined
        ) {
          throw new Error('EXECUTION_ID_CONFLICT')
        }
        await transaction.put({
          namespace: namespaces.commands,
          id: commandId,
          value: json(command),
        })
        await transaction.put({
          namespace: namespaces.executions,
          id: recordId(execution.executionId),
          value: json(execution),
        })
        await transaction.put({
          namespace: namespaces.commandByExecution,
          id: recordId(execution.executionId),
          value: commandId,
        })
        return { outcome: 'accepted', command, execution }
      }
      const existing = CommandInboxRecordSchema.parse(existingRecord.value)
      const existingExecution = await this.#execution(transaction, existing.executionId)
      if (existing.payloadHash === command.payloadHash) {
        return { outcome: 'duplicate', command: existing, execution: existingExecution }
      }
      const conflicted = CommandInboxRecordSchema.parse({
        ...existing,
        version: existing.version + 1,
        conflictCount: existing.conflictCount + 1,
        lastConflictAt: command.lastSeenAt,
        lastSeenAt: command.lastSeenAt,
      })
      await transaction.put({
        namespace: namespaces.commands,
        id: commandId,
        expectedRevision: existingRecord.revision,
        value: json(conflicted),
      })
      return { outcome: 'conflict', command: conflicted, execution: existingExecution }
    })
  }

  async get(scopeInput: CommandInboxScope): Promise<CommandInboxRecord | undefined> {
    const scope = CommandInboxScopeSchema.parse(scopeInput)
    return this.provider.transaction(async (transaction) => {
      await this.#assertNotRetired(transaction, recordId(scopeKey(scope)))
      const record = await transaction.get(namespaces.commands, recordId(scopeKey(scope)))
      return record === undefined ? undefined : CommandInboxRecordSchema.parse(record.value)
    })
  }

  /** Reserve a rejection key before a future retention worker removes payloads.
   * This does not delete domain records or authorize external cleanup.
   */
  retireExpiredCommand(scopeInput: CommandInboxScope, retiredAt: string): Promise<boolean> {
    const scope = CommandInboxScopeSchema.parse(scopeInput)
    const timestamp = new Date(retiredAt)
    if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== retiredAt)
      throw new Error('COMMAND_RETIREMENT_INVALID_TIMESTAMP')
    return this.provider.transaction(async (transaction) => {
      const id = recordId(scopeKey(scope))
      if (await transaction.get(namespaces.retiredCommands, id)) return true
      const stored = await transaction.get(namespaces.commands, id)
      if (!stored) return false
      const command = CommandInboxRecordSchema.parse(stored.value)
      if (scopeKey(command) !== scopeKey(scope))
        throw new Error('COMMAND_RETIREMENT_SCOPE_MISMATCH')
      const execution = await this.#execution(transaction, command.executionId)
      if (
        !['completed', 'failed'].includes(command.status) ||
        !['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state) ||
        timestamp.getTime() <= Date.parse(command.retentionExpiresAt)
      )
        return false
      await transaction.put({
        namespace: namespaces.retiredCommands,
        id,
        value: { retiredAt, commandId: command.commandId, executionId: command.executionId },
      })
      return true
    })
  }

  async #assertNotRetired(transaction: PersistenceTransaction, id: string): Promise<void> {
    if (await transaction.get(namespaces.retiredCommands, id))
      throw new CommandInboxError('COMMAND_RETENTION_EXPIRED')
  }

  async getByExecutionId(executionId: string): Promise<CommandInboxRecord | undefined> {
    ExecutionSchema.shape.executionId.parse(executionId)
    return this.provider.transaction(async (transaction) => {
      const index = await transaction.get(namespaces.commandByExecution, recordId(executionId))
      if (index === undefined || typeof index.value !== 'string') return undefined
      const record = await transaction.get(namespaces.commands, index.value)
      return record === undefined ? undefined : CommandInboxRecordSchema.parse(record.value)
    })
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    ExecutionSchema.shape.executionId.parse(executionId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.executions, recordId(executionId))
      return record === undefined ? undefined : ExecutionSchema.parse(record.value)
    })
  }

  compareAndSet(expectedVersion: number, commandInput: CommandInboxRecord): Promise<boolean> {
    const command = CommandInboxRecordSchema.parse(commandInput)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(scopeKey(command))
      const record = await transaction.get(namespaces.commands, id)
      if (record === undefined) return false
      const current = CommandInboxRecordSchema.parse(record.value)
      if (current.version !== expectedVersion || !sameImmutableCommand(current, command))
        return false
      await transaction.put({
        namespace: namespaces.commands,
        id,
        expectedRevision: record.revision,
        value: json(command),
      })
      return true
    })
  }

  async #execution(
    transaction: Parameters<Parameters<PersistenceProvider['transaction']>[0]>[0],
    executionId: string
  ): Promise<Execution> {
    const record = await transaction.get(namespaces.executions, recordId(executionId))
    if (record === undefined) throw new Error('COMMAND_EXECUTION_INVARIANT_VIOLATION')
    return ExecutionSchema.parse(record.value)
  }
}

export class SqliteExecutionRepository implements ExecutionRepository {
  constructor(readonly provider: PersistenceProvider) {}

  insertExecution(executionInput: Execution): Promise<boolean> {
    const execution = ExecutionSchema.parse(executionInput)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(execution.executionId)
      if ((await transaction.get(namespaces.executions, id)) !== undefined) return false
      await transaction.put({ namespace: namespaces.executions, id, value: json(execution) })
      return true
    })
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    ExecutionSchema.shape.executionId.parse(executionId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.executions, recordId(executionId))
      return record === undefined ? undefined : ExecutionSchema.parse(record.value)
    })
  }

  compareAndSetExecution(expectedVersion: number, executionInput: Execution): Promise<boolean> {
    const execution = ExecutionSchema.parse(executionInput)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(execution.executionId)
      const record = await transaction.get(namespaces.executions, id)
      if (record === undefined) return false
      const current = ExecutionSchema.parse(record.value)
      if (current.version !== expectedVersion || !sameImmutableExecution(current, execution))
        return false
      await transaction.put({
        namespace: namespaces.executions,
        id,
        expectedRevision: record.revision,
        value: json(execution),
      })
      return true
    })
  }

  insertAttempt(
    expectedExecutionVersion: number,
    executionInput: Execution,
    attemptInput: ExecutionAttempt
  ): Promise<boolean> {
    const execution = ExecutionSchema.parse(executionInput)
    const attempt = ExecutionAttemptSchema.parse(attemptInput)
    return this.provider.transaction(async (transaction) => {
      const executionId = recordId(execution.executionId)
      const currentRecord = await transaction.get(namespaces.executions, executionId)
      if (currentRecord === undefined) return false
      const current = ExecutionSchema.parse(currentRecord.value)
      if (
        current.version !== expectedExecutionVersion ||
        !sameImmutableExecution(current, execution) ||
        attempt.executionId !== execution.executionId ||
        (await transaction.get(namespaces.attempts, recordId(attempt.attemptId))) !== undefined
      ) {
        return false
      }
      await transaction.put({
        namespace: namespaces.executions,
        id: executionId,
        expectedRevision: currentRecord.revision,
        value: json(execution),
      })
      await transaction.put({
        namespace: namespaces.attempts,
        id: recordId(attempt.attemptId),
        value: json(attempt),
      })
      return true
    })
  }

  async getAttempt(attemptId: string): Promise<ExecutionAttempt | undefined> {
    ExecutionAttemptSchema.shape.attemptId.parse(attemptId)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.attempts, recordId(attemptId))
      return record === undefined ? undefined : ExecutionAttemptSchema.parse(record.value)
    })
  }

  listAttempts(executionId: string): Promise<readonly ExecutionAttempt[]> {
    ExecutionSchema.shape.executionId.parse(executionId)
    return this.provider.transaction(async (transaction) =>
      (await transaction.list(namespaces.attempts))
        .map((record) => ExecutionAttemptSchema.parse(record.value))
        .filter((attempt) => attempt.executionId === executionId)
        .sort((left, right) => left.sequence - right.sequence)
    )
  }

  compareAndSetAttempt(expectedVersion: number, attemptInput: ExecutionAttempt): Promise<boolean> {
    const attempt = ExecutionAttemptSchema.parse(attemptInput)
    return this.provider.transaction(async (transaction) => {
      const id = recordId(attempt.attemptId)
      const record = await transaction.get(namespaces.attempts, id)
      if (record === undefined) return false
      const current = ExecutionAttemptSchema.parse(record.value)
      if (current.version !== expectedVersion || !sameImmutableAttempt(current, attempt))
        return false
      await transaction.put({
        namespace: namespaces.attempts,
        id,
        expectedRevision: record.revision,
        value: json(attempt),
      })
      return true
    })
  }
}

export class SqliteExecutionPlanRepository implements ExecutionPlanRepository {
  constructor(readonly provider: PersistenceProvider) {}

  put(input: ExecutionPlan): Promise<ExecutionPlanReference> {
    const plan = assertExecutionPlanIntegrity(input)
    const reference = {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
    }
    return this.provider.transaction(async (transaction) => {
      const id = recordId(plan.executionPlanId)
      const record = await transaction.get(namespaces.plans, id)
      if (record === undefined) {
        await transaction.put({ namespace: namespaces.plans, id, value: json(plan) })
        return reference
      }
      const existing = assertExecutionPlanIntegrity(record.value)
      if (!isDeepStrictEqual(existing, plan)) throw new Error('EXECUTION_PLAN_ID_CONFLICT')
      return reference
    })
  }

  async get(input: ExecutionPlanReference): Promise<ExecutionPlan | undefined> {
    const reference = ExecutionPlanReferenceSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const record = await transaction.get(namespaces.plans, recordId(reference.executionPlanId))
      if (record === undefined) return undefined
      const plan = assertExecutionPlanIntegrity(record.value)
      return plan.contentDigest === reference.contentDigest ? plan : undefined
    })
  }
}

export class SqliteExecutionValidationCommandRepository implements ExecutionValidationCommandRepository {
  constructor(readonly provider: PersistenceProvider) {}

  get(
    input: ExecutionValidationCommandScope
  ): Promise<ExecutionValidationCommandRecord | undefined> {
    const scope = ExecutionValidationCommandScopeSchema.parse(input)
    return this.provider.transaction((transaction) => this.#read(transaction, scope))
  }

  commit(
    input: ExecutionValidationCommandRecord,
    planInput: ExecutionPlan
  ): Promise<ExecutionValidationCommandRecord> {
    const plan = assertExecutionPlanIntegrity(planInput)
    const record = assertExecutionValidationCommandPlan(input, plan)
    return this.provider.transaction(async (transaction) => {
      const existing = await this.#read(transaction, record.scope)
      if (existing) {
        if (existing.payloadHash !== record.payloadHash)
          throw new Error('EXECUTION_VALIDATION_COMMAND_CONFLICT')
        return existing
      }
      const id = recordId(plan.executionPlanId)
      const stored = await transaction.get(namespaces.plans, id)
      if (stored && !isDeepStrictEqual(assertExecutionPlanIntegrity(stored.value), plan)) {
        throw new Error('EXECUTION_PLAN_ID_CONFLICT')
      }
      if (!stored) await transaction.put({ namespace: namespaces.plans, id, value: json(plan) })
      await transaction.put({
        namespace: 'execution-validation-commands',
        id: `r-${executionValidationCommandKey(record.scope)}`,
        value: json(record),
      })
      return record
    })
  }

  async #read(
    transaction: PersistenceTransaction,
    scope: ExecutionValidationCommandScope
  ): Promise<ExecutionValidationCommandRecord | undefined> {
    const stored = await transaction.get(
      'execution-validation-commands',
      `r-${executionValidationCommandKey(scope)}`
    )
    if (!stored) return undefined
    const record = ExecutionValidationCommandRecordSchema.parse(stored.value)
    if (!isDeepStrictEqual(record.scope, scope))
      throw new Error('EXECUTION_VALIDATION_COMMAND_SCOPE_MISMATCH')
    const storedPlan = await transaction.get(
      namespaces.plans,
      recordId(record.executionPlan.executionPlanId)
    )
    if (!storedPlan) throw new Error('EXECUTION_VALIDATION_COMMAND_PLAN_MISSING')
    return assertExecutionValidationCommandPlan(
      record,
      assertExecutionPlanIntegrity(storedPlan.value)
    )
  }
}

function scopeKey(scope: CommandInboxScope): string {
  return [
    scope.callerPrincipalId,
    scope.operation,
    scope.workspaceId,
    scope.projectId,
    scope.idempotencyKey,
  ].join('\u001f')
}

function recordId(value: string): string {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function sameImmutableCommand(left: CommandInboxRecord, right: CommandInboxRecord): boolean {
  return (
    scopeKey(left) === scopeKey(right) &&
    left.commandId === right.commandId &&
    left.requestId === right.requestId &&
    left.taskId === right.taskId &&
    left.agentId === right.agentId &&
    left.payloadHash === right.payloadHash &&
    left.executionId === right.executionId &&
    isDeepStrictEqual(left.executionPlan, right.executionPlan) &&
    left.receivedAt === right.receivedAt &&
    left.retentionExpiresAt === right.retentionExpiresAt
  )
}

function sameImmutableExecution(left: Execution, right: Execution): boolean {
  return (
    left.executionId === right.executionId &&
    isDeepStrictEqual(left.correlation, right.correlation) &&
    isDeepStrictEqual(left.executionPlan, right.executionPlan) &&
    left.parentExecutionId === right.parentExecutionId &&
    left.acceptedAt === right.acceptedAt &&
    left.createdAt === right.createdAt
  )
}

function sameImmutableAttempt(left: ExecutionAttempt, right: ExecutionAttempt): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.executionId === right.executionId &&
    left.sequence === right.sequence &&
    left.createdAt === right.createdAt
  )
}
