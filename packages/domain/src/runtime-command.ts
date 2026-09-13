import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const TimestampSchema = z.iso.datetime()
const PayloadHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const RuntimeCommandStatusSchema = z.enum([
  'queued',
  'dispatched',
  'acknowledged',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
])

export const RuntimeCommandResultReferenceSchema = IdentifierSchemas.artifactId

export const RuntimeCommandRecordSchema = z
  .object({
    commandId: IdentifierSchemas.commandId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    nodeId: IdentifierSchemas.runtimeNodeRefId,
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    workspaceId: IdentifierSchemas.workspaceId,
    idempotencyKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    payloadHash: PayloadHashSchema,
    commandEnvelope: z.record(z.string(), z.json()),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    status: RuntimeCommandStatusSchema,
    version: z.number().int().positive(),
    deliveryAttempts: z.number().int().nonnegative(),
    /**
     * Correlation carried into runtime dispatch. Tracers and reconciliation use these
     * to link a runtime command back to its accepted request; members are optional
     * because producers add context as it becomes available on the dispatch path.
     */
    correlation: z
      .object({
        traceId: IdentifierSchemas.traceId.optional(),
        requestId: IdentifierSchemas.requestId.optional(),
        projectId: IdentifierSchemas.projectId.optional(),
        taskId: IdentifierSchemas.taskId.optional(),
        agentId: IdentifierSchemas.agentId.optional(),
      })
      .optional(),
    lastChannelGeneration: z.number().int().positive().optional(),
    lastSequence: z.number().int().nonnegative().optional(),
    firstDispatchedAt: TimestampSchema.optional(),
    lastDispatchedAt: TimestampSchema.optional(),
    acknowledgementReference: z.string().min(5).max(128).optional(),
    acknowledgementDisposition: z.enum(['accepted', 'replayed', 'rejected', 'expired']).optional(),
    acknowledgedAt: TimestampSchema.optional(),
    resultReference: RuntimeCommandResultReferenceSchema.optional(),
    resultStatus: z.enum(['succeeded', 'failed', 'cancelled']).optional(),
    resultRecordedAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (Date.parse(record.expiresAt) <= Date.parse(record.issuedAt)) {
      context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'Expiry must follow issue' })
    }
    const dispatchMetadata = [
      record.lastChannelGeneration,
      record.lastSequence,
      record.firstDispatchedAt,
      record.lastDispatchedAt,
    ]
    if (record.deliveryAttempts === 0 && dispatchMetadata.some((value) => value !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Queued commands cannot have delivery metadata' })
    }
    if (record.deliveryAttempts > 0 && dispatchMetadata.some((value) => value === undefined)) {
      context.addIssue({ code: 'custom', message: 'Delivery attempts require complete metadata' })
    }
    if (record.status === 'queued' && record.deliveryAttempts !== 0) {
      context.addIssue({ code: 'custom', message: 'Queued commands cannot have delivery attempts' })
    }
    if (
      ['dispatched', 'acknowledged', 'succeeded', 'failed', 'cancelled'].includes(record.status) &&
      record.deliveryAttempts === 0
    ) {
      context.addIssue({ code: 'custom', message: 'Delivered commands require a delivery attempt' })
    }
    const acknowledgementMetadata = [
      record.acknowledgementReference,
      record.acknowledgementDisposition,
      record.acknowledgedAt,
    ]
    if (
      acknowledgementMetadata.some((value) => value !== undefined) &&
      acknowledgementMetadata.some((value) => value === undefined)
    ) {
      context.addIssue({ code: 'custom', message: 'ACK metadata must be complete' })
    }
    const resultMetadata = [record.resultStatus, record.resultRecordedAt]
    if (
      resultMetadata.some((value) => value !== undefined) &&
      resultMetadata.some((value) => value === undefined)
    ) {
      context.addIssue({ code: 'custom', message: 'Result metadata must be complete' })
    }
    if (record.resultReference !== undefined && record.resultStatus === undefined) {
      context.addIssue({ code: 'custom', message: 'Result references require result metadata' })
    }
    if (record.status === 'acknowledged' && record.acknowledgedAt === undefined) {
      context.addIssue({ code: 'custom', message: 'Acknowledged commands require ACK metadata' })
    }
    if (
      (['succeeded', 'failed', 'cancelled'].includes(record.status) ||
        record.resultStatus !== undefined) &&
      record.resultStatus !== record.status
    ) {
      context.addIssue({ code: 'custom', message: 'Terminal result and status must agree' })
    }
    if (
      record.status === 'failed' &&
      record.resultStatus === undefined &&
      record.acknowledgementDisposition !== 'rejected'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Failed commands require a rejected ACK or result',
      })
    }
  })

export type RuntimeCommandStatus = z.output<typeof RuntimeCommandStatusSchema>
export type RuntimeCommandRecord = z.output<typeof RuntimeCommandRecordSchema>

const RuntimeCommandEnvelopeIdentitySchema = z
  .object({
    commandId: IdentifierSchemas.commandId,
    executionId: IdentifierSchemas.executionId,
    attemptId: IdentifierSchemas.attemptId,
    nodeId: IdentifierSchemas.runtimeNodeRefId,
    runtimeConnectionId: IdentifierSchemas.runtimeConnectionId,
    workspaceId: IdentifierSchemas.workspaceId,
    idempotencyKey: RuntimeCommandRecordSchema.shape.idempotencyKey,
    payloadHash: RuntimeCommandRecordSchema.shape.payloadHash,
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
  })
  .passthrough()

const RuntimeCommandCorrelationSourceSchema = z
  .object({
    traceId: IdentifierSchemas.traceId.optional(),
    requestId: IdentifierSchemas.requestId.optional(),
    projectId: IdentifierSchemas.projectId.optional(),
    taskId: IdentifierSchemas.taskId.optional(),
    agentId: IdentifierSchemas.agentId.optional(),
  })
  .passthrough()

export function createQueuedRuntimeCommandRecord(
  commandValue: unknown,
  createdAtValue: string
): RuntimeCommandRecord {
  const command = RuntimeCommandEnvelopeIdentitySchema.parse(commandValue)
  const commandEnvelope = z.record(z.string(), z.json()).parse(commandValue)
  const createdAt = TimestampSchema.parse(createdAtValue)
  // Correlation flows from the command envelope when the producer provides it; the
  // factory never invents identities beyond what the dispatch context carries.
  const source = RuntimeCommandCorrelationSourceSchema.parse(commandValue)
  const correlation = Object.fromEntries(
    Object.entries({
      traceId: source.traceId,
      requestId: source.requestId,
      projectId: source.projectId,
      taskId: source.taskId,
      agentId: source.agentId,
    }).filter(([, value]) => value !== undefined)
  )
  return RuntimeCommandRecordSchema.parse({
    commandId: command.commandId,
    executionId: command.executionId,
    attemptId: command.attemptId,
    nodeId: command.nodeId,
    runtimeConnectionId: command.runtimeConnectionId,
    workspaceId: command.workspaceId,
    idempotencyKey: command.idempotencyKey,
    payloadHash: command.payloadHash,
    commandEnvelope,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    status: 'queued',
    version: 1,
    deliveryAttempts: 0,
    ...(Object.keys(correlation).length === 0 ? {} : { correlation }),
    createdAt,
    updatedAt: createdAt,
  })
}

export interface RuntimeCommandCreateResult {
  readonly outcome: 'created' | 'duplicate' | 'conflict'
  readonly record: RuntimeCommandRecord
}

export interface RuntimeCommandRepository {
  create(record: RuntimeCommandRecord): Promise<RuntimeCommandCreateResult>
  get(commandId: string): Promise<RuntimeCommandRecord | undefined>
  compareAndSet(expectedVersion: number, record: RuntimeCommandRecord): Promise<boolean>
  listDispatchable(nodeId: string, at: string, limit: number): Promise<RuntimeCommandRecord[]>
}

export class InMemoryRuntimeCommandRepository implements RuntimeCommandRepository {
  readonly #records = new Map<string, RuntimeCommandRecord>()

  async create(recordValue: RuntimeCommandRecord): Promise<RuntimeCommandCreateResult> {
    const record = RuntimeCommandRecordSchema.parse(recordValue)
    const current = this.#records.get(record.commandId)
    if (current !== undefined) {
      return {
        outcome: runtimeCommandRecordsShareIdentity(current, record) ? 'duplicate' : 'conflict',
        record: clone(current),
      }
    }
    this.#records.set(record.commandId, clone(record))
    return { outcome: 'created', record: clone(record) }
  }

  async get(commandId: string): Promise<RuntimeCommandRecord | undefined> {
    IdentifierSchemas.commandId.parse(commandId)
    const record = this.#records.get(commandId)
    return record === undefined ? undefined : clone(record)
  }

  async compareAndSet(
    expectedVersion: number,
    recordValue: RuntimeCommandRecord
  ): Promise<boolean> {
    const record = RuntimeCommandRecordSchema.parse(recordValue)
    const current = this.#records.get(record.commandId)
    if (
      current?.version !== expectedVersion ||
      !runtimeCommandRecordsShareIdentity(current, record)
    )
      return false
    this.#records.set(record.commandId, clone(record))
    return true
  }

  async listDispatchable(
    nodeId: string,
    at: string,
    limit: number
  ): Promise<RuntimeCommandRecord[]> {
    IdentifierSchemas.runtimeNodeRefId.parse(nodeId)
    TimestampSchema.parse(at)
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000)
      throw new Error('INVALID_LIMIT')
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.nodeId === nodeId &&
          ['queued', 'dispatched', 'acknowledged'].includes(record.status)
      )
      .toSorted((left, right) =>
        left.issuedAt === right.issuedAt
          ? left.commandId.localeCompare(right.commandId)
          : left.issuedAt.localeCompare(right.issuedAt)
      )
      .slice(0, limit)
      .map(clone)
  }
}

export function runtimeCommandRecordsShareIdentity(
  left: RuntimeCommandRecord,
  right: RuntimeCommandRecord
): boolean {
  return (
    left.commandId === right.commandId &&
    left.executionId === right.executionId &&
    left.attemptId === right.attemptId &&
    left.nodeId === right.nodeId &&
    left.workspaceId === right.workspaceId &&
    left.runtimeConnectionId === right.runtimeConnectionId &&
    left.payloadHash === right.payloadHash &&
    left.idempotencyKey === right.idempotencyKey &&
    JSON.stringify(left.commandEnvelope) === JSON.stringify(right.commandEnvelope)
  )
}

function clone(record: RuntimeCommandRecord): RuntimeCommandRecord {
  return structuredClone(record)
}
