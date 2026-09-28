import {
  ContextCommandRecordSchema,
  ContextCommandScopeSchema,
  ContextCommandPendingQuerySchema,
  type ContextCommandPendingQuery,
  contextCommandOperationKey,
  contextCommandTransitionAllowed,
  type CredentialRevocationFence,
  type ContextCommandCreateResult,
  type ContextCommandRecord,
  type ContextCommandRepository,
  type ContextCommandScope,
} from '@control-plane/domain'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { contextCommands } from './schema/context-commands.js'
import { assertRuntimeCredentialFence } from './runtime-credential-fence.js'

export class PostgresContextCommandRepository implements ContextCommandRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async create(input: ContextCommandRecord): Promise<ContextCommandCreateResult> {
    const record = ContextCommandRecordSchema.parse(input)
    if (record.status !== 'queued' || record.version !== 1)
      throw new Error('CONTEXT_COMMAND_INITIAL_STATE_INVALID')
    const inserted = await this.database
      .insert(contextCommands)
      .values(toRow(record))
      .onConflictDoNothing()
      .returning({ commandId: contextCommands.commandId })
    if (inserted.length === 1) return { outcome: 'created', record }

    // A global command-ID collision must not expose another operation's record.
    const [byId] = await this.database
      .select()
      .from(contextCommands)
      .where(eq(contextCommands.commandId, record.commandId))
      .limit(1)
    if (
      byId &&
      contextCommandOperationKey(fromRow(byId).scope) !== contextCommandOperationKey(record.scope)
    )
      throw new Error('CONTEXT_COMMAND_ID_CONFLICT')
    const current = await this.getByOperation(record.scope)
    if (!current) throw new Error('CONTEXT_COMMAND_CREATE_RACE')
    return {
      outcome: current.payloadHash === record.payloadHash ? 'duplicate' : 'conflict',
      record: current,
    }
  }

  async get(workspaceId: string, commandId: string): Promise<ContextCommandRecord | undefined> {
    ContextCommandScopeSchema.shape.workspaceId.parse(workspaceId)
    ContextCommandRecordSchema.shape.commandId.parse(commandId)
    const [row] = await this.database
      .select()
      .from(contextCommands)
      .where(
        and(eq(contextCommands.workspaceId, workspaceId), eq(contextCommands.commandId, commandId))
      )
      .limit(1)
    return row ? fromRow(row) : undefined
  }

  async getByOperation(input: ContextCommandScope): Promise<ContextCommandRecord | undefined> {
    const scope = ContextCommandScopeSchema.parse(input)
    const [row] = await this.database
      .select()
      .from(contextCommands)
      .where(
        and(
          eq(contextCommands.workspaceId, scope.workspaceId),
          eq(contextCommands.operationKey, contextCommandOperationKey(scope))
        )
      )
      .limit(1)
    return row ? fromRow(row) : undefined
  }

  async compareAndSet(
    expectedVersion: number,
    input: ContextCommandRecord,
    credentialFence?: CredentialRevocationFence
  ): Promise<boolean> {
    return this.#compareAndSet(expectedVersion, input, credentialFence)
  }

  async compareAndSetWithCredentialFence(
    expectedVersion: number,
    commandId: string,
    credentialFence: CredentialRevocationFence | undefined,
    prepare: (current: ContextCommandRecord) => Promise<ContextCommandRecord>
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(contextCommands)
        .where(eq(contextCommands.commandId, commandId))
        .limit(1)
        .for('update')
      const current = row ? fromRow(row) : undefined
      if (!current || current.version !== expectedVersion) return false

      await assertRuntimeCredentialFence(transaction, credentialFence, {
        nodeId: current.nodeId,
        workspaceId: current.scope.workspaceId,
      })
      const record = ContextCommandRecordSchema.parse(await prepare(structuredClone(current)))
      if (!contextCommandTransitionAllowed(current, record)) return false

      const updated = await transaction
        .update(contextCommands)
        .set(toRow(record))
        .where(
          and(
            eq(contextCommands.commandId, record.commandId),
            eq(contextCommands.workspaceId, current.scope.workspaceId),
            eq(contextCommands.operationKey, contextCommandOperationKey(current.scope)),
            eq(contextCommands.version, expectedVersion)
          )
        )
        .returning({ commandId: contextCommands.commandId })
      return updated.length === 1
    })
  }

  async #compareAndSet(
    expectedVersion: number,
    input: ContextCommandRecord,
    credentialFence: CredentialRevocationFence | undefined
  ): Promise<boolean> {
    const record = ContextCommandRecordSchema.parse(input)
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(contextCommands)
        .where(
          and(
            eq(contextCommands.commandId, record.commandId),
            eq(contextCommands.workspaceId, record.scope.workspaceId)
          )
        )
        .limit(1)
        .for('update')
      const current = row ? fromRow(row) : undefined
      if (
        !current ||
        current.version !== expectedVersion ||
        !contextCommandTransitionAllowed(current, record)
      )
        return false

      if (requiresCredentialFence(current, record) || credentialFence !== undefined) {
        await assertRuntimeCredentialFence(transaction, credentialFence, {
          nodeId: current.nodeId,
          workspaceId: current.scope.workspaceId,
        })
      }

      const updated = await transaction
        .update(contextCommands)
        .set(toRow(record))
        .where(
          and(
            eq(contextCommands.commandId, record.commandId),
            eq(contextCommands.workspaceId, record.scope.workspaceId),
            eq(contextCommands.operationKey, contextCommandOperationKey(record.scope)),
            eq(contextCommands.version, expectedVersion)
          )
        )
        .returning({ commandId: contextCommands.commandId })
      return updated.length === 1
    })
  }

  async listPending(input: ContextCommandPendingQuery): Promise<ContextCommandRecord[]> {
    const query = ContextCommandPendingQuerySchema.parse(input)
    const rows = await this.database
      .select()
      .from(contextCommands)
      .where(
        and(
          eq(contextCommands.workspaceId, query.workspaceId),
          eq(contextCommands.nodeId, query.nodeId),
          inArray(contextCommands.status, ['queued', 'dispatched', 'acknowledged']),
          query.afterCommandId ? gt(contextCommands.commandId, query.afterCommandId) : undefined
        )
      )
      .orderBy(asc(contextCommands.commandId))
      .limit(query.limit)
    return rows.map(fromRow)
  }
}

function requiresCredentialFence(
  current: ContextCommandRecord,
  next: ContextCommandRecord
): boolean {
  return (
    next.status === 'acknowledged' ||
    next.status === 'succeeded' ||
    next.completionDigest !== current.completionDigest
  )
}

function toRow(record: ContextCommandRecord): typeof contextCommands.$inferInsert {
  return {
    commandId: record.commandId,
    operationKey: contextCommandOperationKey(record.scope),
    workspaceId: record.scope.workspaceId,
    nodeId: record.nodeId,
    status: record.status,
    version: record.version,
    issuedAt: new Date(record.issuedAt),
    record,
  }
}

function fromRow(row: typeof contextCommands.$inferSelect): ContextCommandRecord {
  const record = ContextCommandRecordSchema.parse(row.record)
  if (
    row.commandId !== record.commandId ||
    row.operationKey !== contextCommandOperationKey(record.scope) ||
    row.workspaceId !== record.scope.workspaceId ||
    row.nodeId !== record.nodeId ||
    row.version !== record.version ||
    row.status !== record.status ||
    row.issuedAt.getTime() !== Date.parse(record.issuedAt)
  )
    throw new Error('CONTEXT_COMMAND_INDEX_INCONSISTENT')
  return record
}
