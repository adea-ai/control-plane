import {
  RuntimeCommandRecordSchema,
  runtimeCommandRecordsShareIdentity,
  type RuntimeCommandCreateResult,
  type RuntimeCommandRecord,
  type RuntimeCommandRepository,
} from '@control-plane/domain'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { runtimeCommands } from './schema/runtime-commands.js'

export class PostgresRuntimeCommandRepository implements RuntimeCommandRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  /**
   * Bounded maintenance read for reconciliation: the most recent runtime
   * command issued for an attempt. At most one row is returned, so repeated
   * reconciliation passes stay bounded regardless of command history.
   */
  async latestForAttempt(attemptId: string): Promise<RuntimeCommandRecord | undefined> {
    RuntimeCommandRecordSchema.shape.attemptId.parse(attemptId)
    const [row] = await this.database
      .select()
      .from(runtimeCommands)
      .where(eq(runtimeCommands.attemptId, attemptId))
      .orderBy(desc(runtimeCommands.issuedAt), desc(runtimeCommands.commandId))
      .limit(1)
    return row === undefined ? undefined : fromRuntimeCommandRow(row)
  }

  async create(recordValue: RuntimeCommandRecord): Promise<RuntimeCommandCreateResult> {
    const record = RuntimeCommandRecordSchema.parse(recordValue)
    const inserted = await this.database
      .insert(runtimeCommands)
      .values(toRuntimeCommandRow(record))
      .onConflictDoNothing()
      .returning({ commandId: runtimeCommands.commandId })
    if (inserted.length === 1) return { outcome: 'created', record }

    const current = await this.get(record.commandId)
    if (current === undefined) throw new Error('RUNTIME_COMMAND_CREATE_RACE')
    return {
      outcome: runtimeCommandRecordsShareIdentity(current, record) ? 'duplicate' : 'conflict',
      record: current,
    }
  }

  async get(commandId: string): Promise<RuntimeCommandRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(runtimeCommands)
      .where(eq(runtimeCommands.commandId, commandId))
      .limit(1)
    return row === undefined ? undefined : fromRuntimeCommandRow(row)
  }

  async compareAndSet(
    expectedVersion: number,
    recordValue: RuntimeCommandRecord
  ): Promise<boolean> {
    const record = RuntimeCommandRecordSchema.parse(recordValue)
    const current = await this.get(record.commandId)
    if (
      current === undefined ||
      current.version !== expectedVersion ||
      !runtimeCommandRecordsShareIdentity(current, record)
    ) {
      return false
    }
    const updated = await this.database
      .update(runtimeCommands)
      .set(toRuntimeCommandRow(record))
      .where(
        and(
          eq(runtimeCommands.commandId, record.commandId),
          eq(runtimeCommands.version, expectedVersion),
          eq(runtimeCommands.payloadHash, record.payloadHash),
          eq(runtimeCommands.executionId, record.executionId),
          eq(runtimeCommands.attemptId, record.attemptId),
          eq(runtimeCommands.runtimeNodeRefId, record.nodeId),
          eq(runtimeCommands.runtimeConnectionId, record.runtimeConnectionId),
          eq(runtimeCommands.workspaceId, record.workspaceId),
          eq(runtimeCommands.idempotencyKey, record.idempotencyKey)
        )
      )
      .returning({ commandId: runtimeCommands.commandId })
    return updated.length === 1
  }

  async listDispatchable(
    nodeId: string,
    at: string,
    limit: number
  ): Promise<RuntimeCommandRecord[]> {
    if (Number.isNaN(Date.parse(at))) throw new Error('INVALID_TIMESTAMP')
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new Error('INVALID_LIMIT')
    }
    const rows = await this.database
      .select()
      .from(runtimeCommands)
      .where(
        and(
          eq(runtimeCommands.runtimeNodeRefId, nodeId),
          inArray(runtimeCommands.status, ['queued', 'dispatched', 'acknowledged'])
        )
      )
      .orderBy(asc(runtimeCommands.issuedAt), asc(runtimeCommands.commandId))
      .limit(limit)
    return rows.map(fromRuntimeCommandRow)
  }
}

type RuntimeCommandRow = typeof runtimeCommands.$inferSelect

export function toRuntimeCommandRow(
  record: RuntimeCommandRecord
): typeof runtimeCommands.$inferInsert {
  return {
    commandId: record.commandId,
    executionId: record.executionId,
    attemptId: record.attemptId,
    runtimeNodeRefId: record.nodeId,
    runtimeConnectionId: record.runtimeConnectionId,
    workspaceId: record.workspaceId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    commandEnvelope: record.commandEnvelope,
    issuedAt: new Date(record.issuedAt),
    expiresAt: new Date(record.expiresAt),
    status: record.status,
    version: record.version,
    deliveryAttempts: record.deliveryAttempts,
    lastChannelGeneration: record.lastChannelGeneration ?? null,
    lastSequence: record.lastSequence ?? null,
    firstDispatchedAt: optionalDate(record.firstDispatchedAt),
    lastDispatchedAt: optionalDate(record.lastDispatchedAt),
    acknowledgementReference: record.acknowledgementReference ?? null,
    acknowledgementDisposition: record.acknowledgementDisposition ?? null,
    acknowledgedAt: optionalDate(record.acknowledgedAt),
    resultReference: record.resultReference ?? null,
    resultStatus: record.resultStatus ?? null,
    resultRecordedAt: optionalDate(record.resultRecordedAt),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  }
}

export function fromRuntimeCommandRow(row: RuntimeCommandRow): RuntimeCommandRecord {
  return RuntimeCommandRecordSchema.parse({
    commandId: row.commandId,
    executionId: row.executionId,
    attemptId: row.attemptId,
    nodeId: row.runtimeNodeRefId,
    runtimeConnectionId: row.runtimeConnectionId,
    workspaceId: row.workspaceId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    commandEnvelope: row.commandEnvelope,
    issuedAt: row.issuedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: row.status,
    version: row.version,
    deliveryAttempts: row.deliveryAttempts,
    ...(row.lastChannelGeneration === null
      ? {}
      : { lastChannelGeneration: row.lastChannelGeneration }),
    ...(row.lastSequence === null ? {} : { lastSequence: row.lastSequence }),
    ...(row.firstDispatchedAt === null
      ? {}
      : { firstDispatchedAt: row.firstDispatchedAt.toISOString() }),
    ...(row.lastDispatchedAt === null
      ? {}
      : { lastDispatchedAt: row.lastDispatchedAt.toISOString() }),
    ...(row.acknowledgementReference === null
      ? {}
      : { acknowledgementReference: row.acknowledgementReference }),
    ...(row.acknowledgementDisposition === null
      ? {}
      : { acknowledgementDisposition: row.acknowledgementDisposition }),
    ...(row.acknowledgedAt === null ? {} : { acknowledgedAt: row.acknowledgedAt.toISOString() }),
    ...(row.resultReference === null ? {} : { resultReference: row.resultReference }),
    ...(row.resultStatus === null ? {} : { resultStatus: row.resultStatus }),
    ...(row.resultRecordedAt === null
      ? {}
      : { resultRecordedAt: row.resultRecordedAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function optionalDate(value: string | undefined): Date | null {
  return value === undefined ? null : new Date(value)
}
