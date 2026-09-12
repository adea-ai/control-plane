import { createHash } from 'node:crypto'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  ContextCommandRecordSchema,
  ContextCommandScopeSchema,
  contextCommandOperationKey,
  contextCommandTransitionAllowed,
  type ContextCommandCreateResult,
  type ContextCommandRecord,
  type ContextCommandRepository,
  type ContextCommandScope,
} from '@control-plane/domain'

const records = 'context-provider-commands'
const operations = 'context-provider-command-operations'

export class SqliteContextCommandRepository implements ContextCommandRepository {
  constructor(readonly provider: PersistenceProvider) {}

  create(input: ContextCommandRecord): Promise<ContextCommandCreateResult> {
    const record = ContextCommandRecordSchema.parse(input)
    if (record.status !== 'queued' || record.version !== 1)
      throw new Error('CONTEXT_COMMAND_INITIAL_STATE_INVALID')
    return this.provider.transaction(async (transaction) => {
      const key = contextCommandOperationKey(record.scope)
      const byId = await load(transaction, record.commandId)
      if (byId && contextCommandOperationKey(byId.scope) !== key)
        throw new Error('CONTEXT_COMMAND_ID_CONFLICT')
      const index = await transaction.get(operations, operationId(record.scope))
      if (index) {
        const current = await load(
          transaction,
          ContextCommandRecordSchema.shape.commandId.parse(index.value)
        )
        if (!current || contextCommandOperationKey(current.scope) !== key)
          throw new Error('CONTEXT_COMMAND_INDEX_INCONSISTENT')
        return {
          outcome: current.payloadHash === record.payloadHash ? 'duplicate' : 'conflict',
          record: current,
        }
      }
      if (byId) throw new Error('CONTEXT_COMMAND_INDEX_INCONSISTENT')
      await transaction.put({
        namespace: records,
        id: recordId(record.commandId),
        value: json(record),
      })
      await transaction.put({
        namespace: operations,
        id: operationId(record.scope),
        value: record.commandId,
      })
      return { outcome: 'created', record }
    })
  }

  get(workspaceId: string, commandId: string): Promise<ContextCommandRecord | undefined> {
    ContextCommandScopeSchema.shape.workspaceId.parse(workspaceId)
    ContextCommandRecordSchema.shape.commandId.parse(commandId)
    return this.provider.transaction(async (transaction) => {
      const record = await load(transaction, commandId)
      return record?.scope.workspaceId === workspaceId ? record : undefined
    })
  }

  getByOperation(input: ContextCommandScope): Promise<ContextCommandRecord | undefined> {
    const scope = ContextCommandScopeSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const index = await transaction.get(operations, operationId(scope))
      if (!index) return undefined
      const current = await load(
        transaction,
        ContextCommandRecordSchema.shape.commandId.parse(index.value)
      )
      if (
        !current ||
        contextCommandOperationKey(current.scope) !== contextCommandOperationKey(scope)
      )
        throw new Error('CONTEXT_COMMAND_INDEX_INCONSISTENT')
      return current
    })
  }

  compareAndSet(expectedVersion: number, input: ContextCommandRecord): Promise<boolean> {
    const record = ContextCommandRecordSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const stored = await transaction.get(records, recordId(record.commandId))
      if (!stored) return false
      const current = ContextCommandRecordSchema.parse(stored.value)
      if (current.version !== expectedVersion || !contextCommandTransitionAllowed(current, record))
        return false
      const index = await transaction.get(operations, operationId(current.scope))
      if (index?.value !== current.commandId) throw new Error('CONTEXT_COMMAND_INDEX_INCONSISTENT')
      await transaction.put({
        namespace: records,
        id: recordId(record.commandId),
        expectedRevision: stored.revision,
        value: json(record),
      })
      return true
    })
  }
}

async function load(
  transaction: PersistenceTransaction,
  commandId: string
): Promise<ContextCommandRecord | undefined> {
  const record = await transaction.get(records, recordId(commandId))
  return record === undefined ? undefined : ContextCommandRecordSchema.parse(record.value)
}
function recordId(commandId: string): string {
  return `r-${createHash('sha256').update(commandId).digest('hex')}`
}
function operationId(scope: ContextCommandScope): string {
  return `r-${contextCommandOperationKey(scope).slice(7)}`
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}
