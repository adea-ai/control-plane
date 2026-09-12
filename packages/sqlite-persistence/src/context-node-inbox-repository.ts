import { createHash } from 'node:crypto'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  ContextCommandRecordSchema,
  ContextNodeInboxRecordSchema,
  contextNodeInboxOperationKey,
  contextNodeInboxTransitionAllowed,
  type ContextNodeInboxRecord,
  type ContextNodeInboxRepository,
} from '@control-plane/domain'

const records = 'context-node-inbox'
const operations = 'context-node-inbox-operations'

export class SqliteContextNodeInboxRepository implements ContextNodeInboxRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async accept(input: ContextNodeInboxRecord) {
    const record = ContextNodeInboxRecordSchema.parse(input)
    if (record.status !== 'accepted' || record.version !== 1)
      throw new Error('CONTEXT_INBOX_INITIAL_STATE_INVALID')
    return this.provider.transaction(async (transaction) => {
      const identity = contextNodeInboxOperationKey(record)
      const byId = await load(transaction, record.command.nodeId, record.command.commandId)
      if (byId && contextNodeInboxOperationKey(byId) !== identity)
        throw new Error('CONTEXT_INBOX_ID_CONFLICT')
      const index = await transaction.get(operations, key(identity))
      if (index) {
        const current = await load(
          transaction,
          record.command.nodeId,
          ContextCommandRecordSchema.shape.commandId.parse(index.value)
        )
        if (!current || contextNodeInboxOperationKey(current) !== identity)
          throw new Error('CONTEXT_INBOX_INDEX_INCONSISTENT')
        return {
          outcome:
            current.command.payloadHash === record.command.payloadHash
              ? ('duplicate' as const)
              : ('conflict' as const),
          record: current,
        }
      }
      if (byId) throw new Error('CONTEXT_INBOX_INDEX_INCONSISTENT')
      await transaction.put({
        namespace: records,
        id: recordKey(record.command.nodeId, record.command.commandId),
        value: json(record),
      })
      await transaction.put({
        namespace: operations,
        id: key(identity),
        value: record.command.commandId,
      })
      return { outcome: 'created' as const, record }
    })
  }

  async get(workspaceId: string, nodeId: string, commandId: string) {
    ContextCommandRecordSchema.shape.scope.shape.workspaceId.parse(workspaceId)
    ContextCommandRecordSchema.shape.nodeId.parse(nodeId)
    ContextCommandRecordSchema.shape.commandId.parse(commandId)
    return this.provider.transaction(async (transaction) => {
      const record = await load(transaction, nodeId, commandId)
      return record?.command.scope.workspaceId === workspaceId ? record : undefined
    })
  }

  async compareAndSet(expectedVersion: number, input: ContextNodeInboxRecord) {
    const record = ContextNodeInboxRecordSchema.parse(input)
    return this.provider.transaction(async (transaction) => {
      const id = recordKey(record.command.nodeId, record.command.commandId)
      const stored = await transaction.get(records, id)
      if (!stored) return false
      const current = ContextNodeInboxRecordSchema.parse(stored.value)
      if (
        current.version !== expectedVersion ||
        !contextNodeInboxTransitionAllowed(current, record)
      )
        return false
      const index = await transaction.get(operations, key(contextNodeInboxOperationKey(current)))
      if (index?.value !== current.command.commandId)
        throw new Error('CONTEXT_INBOX_INDEX_INCONSISTENT')
      await transaction.put({
        namespace: records,
        id,
        expectedRevision: stored.revision,
        value: json(record),
      })
      return true
    })
  }
}

async function load(transaction: PersistenceTransaction, nodeId: string, commandId: string) {
  const stored = await transaction.get(records, recordKey(nodeId, commandId))
  if (!stored) return undefined
  const record = ContextNodeInboxRecordSchema.parse(stored.value)
  if (record.command.nodeId !== nodeId || record.command.commandId !== commandId)
    throw new Error('CONTEXT_INBOX_ID_CONFLICT')
  return record
}
function recordKey(nodeId: string, commandId: string) {
  return key(JSON.stringify([nodeId, commandId]))
}
function key(input: string) {
  return `r-${createHash('sha256').update(input).digest('hex')}`
}
function json(input: unknown): JsonValue {
  return JSON.parse(JSON.stringify(input)) as JsonValue
}
