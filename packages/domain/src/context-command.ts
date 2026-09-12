import { createHash } from 'node:crypto'
import { IdentifierSchemas } from '@control-plane/contracts'
import { z } from 'zod'

const Timestamp = z.iso.datetime()
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const OperationId = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
const Principal = z.string().min(1).max(256)
const ProviderRef = z.string().regex(/^pvr_[0-9A-HJKMNP-TV-Z]{26}$/)
const Semantics = z.object({
  nodeId: IdentifierSchemas.runtimeNodeRefId,
  workspaceId: IdentifierSchemas.workspaceId,
  providerRef: ProviderRef,
  authorizationRef: z
    .string()
    .min(16)
    .max(128)
    .regex(/^authz:[A-Za-z0-9._:-]+$/),
  family: z.literal('context_provider'),
  operation: z.literal('context.read'),
  driver: z
    .object({ family: z.literal('context-provider'), version: z.string().regex(/^\d+\.\d+\.\d+$/) })
    .strict(),
  requiredCapabilities: z.tuple([z.literal('context.read')]),
  payload: z
    .object({
      version: z.literal(1),
      parameters: z
        .object({
          operationId: OperationId,
          principalRef: Principal,
          scopeDigest: Digest,
        })
        .catchall(z.json()),
    })
    .strict(),
})
const Envelope = z
  .object({
    ...Semantics.shape,
    type: z.literal('command'),
    schemaVersion: z.literal(1),
    protocolVersion: z
      .object({ major: z.literal(1), minor: z.number().int().nonnegative() })
      .strict(),
    commandId: IdentifierSchemas.commandId,
    traceId: IdentifierSchemas.traceId,
    channelGeneration: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    sentAt: Timestamp,
    idempotencyKey: OperationId,
    payloadHash: Digest,
    issuedAt: Timestamp,
    expiresAt: Timestamp,
  })
  .strict()
  .superRefine((command, context) => {
    if (command.payloadHash !== contextCommandSemanticHash(command))
      context.addIssue({ code: 'custom', message: 'Context command payload hash mismatch' })
    if (Buffer.byteLength(JSON.stringify(command), 'utf8') > 262144)
      context.addIssue({ code: 'custom', message: 'Context command exceeds its bounded envelope' })
  })

export const ContextCommandScopeSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    principalRef: Principal,
    providerRef: ProviderRef,
    operationId: OperationId,
  })
  .strict()
export type ContextCommandScope = z.output<typeof ContextCommandScopeSchema>

export const ContextCommandRecordSchema = z
  .object({
    scope: ContextCommandScopeSchema,
    commandId: IdentifierSchemas.commandId,
    nodeId: IdentifierSchemas.runtimeNodeRefId,
    payloadHash: Digest,
    commandEnvelope: z.record(z.string(), z.json()),
    issuedAt: Timestamp,
    expiresAt: Timestamp,
    status: z.enum([
      'queued',
      'dispatched',
      'acknowledged',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
    ]),
    version: z.number().int().positive(),
    deliveryAttempts: z.number().int().nonnegative(),
    lastDelivery: z
      .object({
        channelGeneration: z.number().int().positive(),
        sequence: z.number().int().nonnegative(),
        at: Timestamp,
      })
      .strict()
      .optional(),
    resultReference: IdentifierSchemas.artifactId.optional(),
    errorCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Z0-9_]+$/)
      .optional(),
    terminalAt: Timestamp.optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .strict()
  .superRefine((record, context) => {
    const issue = (message: string) => context.addIssue({ code: 'custom', message })
    const parsed = Envelope.safeParse(record.commandEnvelope)
    if (!parsed.success) {
      issue('Invalid context command envelope')
      return
    }
    const command = parsed.data
    const parameters = command.payload.parameters
    if (
      command.commandId !== record.commandId ||
      command.nodeId !== record.nodeId ||
      command.workspaceId !== record.scope.workspaceId ||
      command.providerRef !== record.scope.providerRef ||
      parameters.principalRef !== record.scope.principalRef ||
      parameters.operationId !== record.scope.operationId ||
      command.payloadHash !== record.payloadHash ||
      command.issuedAt !== record.issuedAt ||
      command.expiresAt !== record.expiresAt
    )
      issue('Context command identity mismatch')
    if (
      Date.parse(record.expiresAt) <= Date.parse(record.issuedAt) ||
      Date.parse(record.createdAt) < Date.parse(record.issuedAt) ||
      Date.parse(record.updatedAt) < Date.parse(record.createdAt)
    )
      issue('Invalid context command chronology')
    if (record.deliveryAttempts > 0 !== (record.lastDelivery !== undefined))
      issue('Incomplete delivery metadata')
    if (record.status === 'queued' && record.deliveryAttempts !== 0)
      issue('Queued command has delivery attempts')
    if (
      ['dispatched', 'acknowledged', 'succeeded', 'failed'].includes(record.status) &&
      record.deliveryAttempts === 0
    )
      issue('Delivered command requires a delivery attempt')
    if (
      record.lastDelivery &&
      (Date.parse(record.lastDelivery.at) < Date.parse(record.createdAt) ||
        Date.parse(record.lastDelivery.at) > Date.parse(record.updatedAt))
    )
      issue('Invalid delivery chronology')
    const terminal = isTerminal(record.status)
    if (terminal !== (record.terminalAt !== undefined)) issue('Terminal metadata must match status')
    if (
      record.terminalAt &&
      (Date.parse(record.terminalAt) < Date.parse(record.createdAt) ||
        Date.parse(record.terminalAt) > Date.parse(record.updatedAt))
    )
      issue('Invalid terminal chronology')
    if ((record.status === 'succeeded') !== (record.resultReference !== undefined))
      issue('Successful command requires exactly one result reference')
    if (record.status === 'failed' && !record.errorCode)
      issue('Failed command requires a classified error')
    if (record.errorCode && !['failed', 'cancelled', 'expired'].includes(record.status))
      issue('Unexpected error metadata')
  })
export type ContextCommandRecord = z.output<typeof ContextCommandRecordSchema>
export type ContextCommandCreateResult = {
  outcome: 'created' | 'duplicate' | 'conflict'
  record: ContextCommandRecord
}
export interface ContextCommandRepository {
  create(record: ContextCommandRecord): Promise<ContextCommandCreateResult>
  get(workspaceId: string, commandId: string): Promise<ContextCommandRecord | undefined>
  getByOperation(scope: ContextCommandScope): Promise<ContextCommandRecord | undefined>
  compareAndSet(expectedVersion: number, record: ContextCommandRecord): Promise<boolean>
}

export function contextCommandSemanticHash(input: unknown): string {
  return digest(canonical(Semantics.parse(input)))
}
export function contextCommandOperationKey(input: ContextCommandScope): string {
  return digest(canonical(ContextCommandScopeSchema.parse(input)))
}
export function createQueuedContextCommandRecord(
  input: unknown,
  createdAt: string
): ContextCommandRecord {
  const command = Envelope.parse(input)
  return ContextCommandRecordSchema.parse({
    scope: {
      workspaceId: command.workspaceId,
      providerRef: command.providerRef,
      principalRef: command.payload.parameters.principalRef,
      operationId: command.payload.parameters.operationId,
    },
    commandId: command.commandId,
    nodeId: command.nodeId,
    payloadHash: command.payloadHash,
    commandEnvelope: command,
    issuedAt: command.issuedAt,
    expiresAt: command.expiresAt,
    status: 'queued',
    version: 1,
    deliveryAttempts: 0,
    createdAt,
    updatedAt: createdAt,
  })
}

/** Shared storage invariant: immutable envelope, sequential version, legal delivery transition. */
export function contextCommandTransitionAllowed(
  current: ContextCommandRecord,
  next: ContextCommandRecord
): boolean {
  if (
    isTerminal(current.status) ||
    next.version !== current.version + 1 ||
    Date.parse(next.updatedAt) < Date.parse(current.updatedAt)
  )
    return false
  for (const field of [
    'scope',
    'commandId',
    'nodeId',
    'payloadHash',
    'commandEnvelope',
    'issuedAt',
    'expiresAt',
    'createdAt',
  ] as const)
    if (canonical(current[field]) !== canonical(next[field])) return false
  const allowed =
    current.status === 'queued'
      ? ['dispatched', 'cancelled', 'expired']
      : ['dispatched', 'acknowledged', 'succeeded', 'failed', 'cancelled', 'expired']
  if (!allowed.includes(next.status)) return false
  if (next.status === 'dispatched') {
    if (next.deliveryAttempts !== current.deliveryAttempts + 1 || !next.lastDelivery) return false
    if (
      current.lastDelivery &&
      (next.lastDelivery.channelGeneration < current.lastDelivery.channelGeneration ||
        (next.lastDelivery.channelGeneration === current.lastDelivery.channelGeneration &&
          next.lastDelivery.sequence <= current.lastDelivery.sequence) ||
        Date.parse(next.lastDelivery.at) < Date.parse(current.lastDelivery.at))
    )
      return false
  } else if (
    next.deliveryAttempts !== current.deliveryAttempts ||
    canonical(next.lastDelivery) !== canonical(current.lastDelivery)
  )
    return false
  return true
}

export class InMemoryContextCommandRepository implements ContextCommandRepository {
  readonly #records = new Map<string, ContextCommandRecord>()
  readonly #operations = new Map<string, string>()
  async create(input: ContextCommandRecord): Promise<ContextCommandCreateResult> {
    const record = ContextCommandRecordSchema.parse(input)
    if (record.status !== 'queued' || record.version !== 1)
      throw new Error('CONTEXT_COMMAND_INITIAL_STATE_INVALID')
    const key = contextCommandOperationKey(record.scope)
    const byId = this.#records.get(record.commandId)
    if (byId && contextCommandOperationKey(byId.scope) !== key)
      throw new Error('CONTEXT_COMMAND_ID_CONFLICT')
    const existingId = this.#operations.get(key)
    const current = existingId === undefined ? byId : this.#records.get(existingId)
    if (current)
      return {
        outcome: current.payloadHash === record.payloadHash ? 'duplicate' : 'conflict',
        record: structuredClone(current),
      }
    this.#records.set(record.commandId, structuredClone(record))
    this.#operations.set(key, record.commandId)
    return { outcome: 'created', record: structuredClone(record) }
  }
  async get(workspaceId: string, commandId: string): Promise<ContextCommandRecord | undefined> {
    IdentifierSchemas.workspaceId.parse(workspaceId)
    IdentifierSchemas.commandId.parse(commandId)
    const record = this.#records.get(commandId)
    return record?.scope.workspaceId === workspaceId ? structuredClone(record) : undefined
  }
  async getByOperation(input: ContextCommandScope): Promise<ContextCommandRecord | undefined> {
    const scope = ContextCommandScopeSchema.parse(input)
    const id = this.#operations.get(contextCommandOperationKey(scope))
    return id === undefined ? undefined : this.get(scope.workspaceId, id)
  }
  async compareAndSet(expectedVersion: number, input: ContextCommandRecord): Promise<boolean> {
    const record = ContextCommandRecordSchema.parse(input)
    const current = this.#records.get(record.commandId)
    if (
      !current ||
      current.version !== expectedVersion ||
      !contextCommandTransitionAllowed(current, record)
    )
      return false
    this.#records.set(record.commandId, structuredClone(record))
    return true
  }
}

function isTerminal(status: ContextCommandRecord['status']): boolean {
  return ['succeeded', 'failed', 'cancelled', 'expired'].includes(status)
}
function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
