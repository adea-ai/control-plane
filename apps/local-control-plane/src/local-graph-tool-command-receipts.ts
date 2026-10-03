import { createHash, randomUUID } from 'node:crypto'
import {
  canonicalJsonStringify,
  CorrelationMetadataSchema,
  ContractVersionSchema,
  IdentifierSchemas,
  type StateChangingCommandEnvelope,
} from '@control-plane/contracts'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'

export const LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS = 'local-graph-tool-reconciliation-receipts'

const LEASE_MS = 30_000

export type LocalGraphToolReconciliationCommand = {
  readonly callerPrincipalId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly operation: 'execution.tool-effect.reconcile'
  readonly idempotencyKey: string
  readonly commandId: string
  readonly contractVersion?: StateChangingCommandEnvelope['contractVersion']
  readonly correlation?: StateChangingCommandEnvelope['correlation']
  readonly requestId?: string
  readonly issuedAt?: string
  readonly payloadHash: string
  readonly payload: unknown
}

type StoredCommand = {
  readonly callerPrincipalId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly operation: 'execution.tool-effect.reconcile'
  readonly idempotencyKey: string
  readonly commandId: string
  readonly contractVersion?: StateChangingCommandEnvelope['contractVersion']
  readonly correlation?: StateChangingCommandEnvelope['correlation']
  readonly requestId?: string
  readonly issuedAt?: string
  readonly payloadHash: string
  readonly payload: JsonValue
}

type StoredReceipt = {
  readonly schemaVersion: 1
  readonly command: StoredCommand
  readonly status: 'pending' | 'completed'
  readonly createdAt: string
  readonly updatedAt: string
  readonly lease?: { readonly ownerId: string; readonly expiresAt: string }
  readonly intent?: JsonValue
  readonly response?: JsonValue
}

export type LocalGraphToolReconciliationClaim =
  | { readonly state: 'completed'; readonly response: JsonValue }
  | {
      readonly state: 'owned'
      readonly recordId: string
      readonly ownerId: string
      readonly receipt: StoredReceipt
    }
  | { readonly state: 'processing'; readonly response: JsonValue }

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** A durable Local-only command receipt; pending commands keep their replay identity indefinitely. */
export class LocalGraphToolCommandReceipts {
  constructor(readonly provider: Pick<PersistenceProvider, 'transaction'>) {}

  async claim(
    command: LocalGraphToolReconciliationCommand,
    now: string
  ): Promise<LocalGraphToolReconciliationClaim> {
    const at = validTimestamp(now)
    const recordId = receiptId(command)
    const ownerId = randomUUID()
    const expiresAt = new Date(Date.parse(at) + LEASE_MS).toISOString()
    return this.provider.transaction(async (transaction) => {
      const row = await transaction.get(LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS, recordId)
      if (row === undefined) {
        const receipt: StoredReceipt = {
          schemaVersion: 1,
          command: storedCommand(command),
          status: 'pending',
          createdAt: at,
          updatedAt: at,
          lease: { ownerId, expiresAt },
        }
        await transaction.put({
          namespace: LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS,
          id: recordId,
          value: json(receipt),
        })
        return { state: 'owned', recordId, ownerId, receipt }
      }

      const receipt = readReceipt(row.value, row.id)
      assertReplayIdentity(receipt.command, command)
      if (receipt.status === 'completed') {
        if (receipt.response === undefined)
          throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
        return { state: 'completed', response: receipt.response }
      }
      if (receipt.lease !== undefined && Date.parse(receipt.lease.expiresAt) > Date.parse(at)) {
        return {
          state: 'processing',
          response: json({ outcome: 'processing', commandId: receipt.command.commandId }),
        }
      }
      const claimed: StoredReceipt = {
        ...receipt,
        updatedAt: at,
        lease: { ownerId, expiresAt },
      }
      await transaction.put({
        namespace: LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS,
        id: recordId,
        expectedRevision: row.revision,
        value: json(claimed),
      })
      return { state: 'owned', recordId, ownerId, receipt: claimed }
    })
  }

  async saveIntent(
    claim: Extract<LocalGraphToolReconciliationClaim, { state: 'owned' }>,
    intent: unknown,
    now: string
  ): Promise<StoredReceipt> {
    const at = validTimestamp(now)
    const value = json(intent)
    return this.provider.transaction(async (transaction) => {
      const row = await transaction.get(LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS, claim.recordId)
      if (row === undefined) throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_MISSING')
      const current = readReceipt(row.value, row.id)
      assertOwner(current, claim.ownerId)
      if (
        current.intent !== undefined &&
        canonicalJsonStringify(current.intent) !== canonicalJsonStringify(value)
      )
        throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
      const updated = { ...current, intent: value, updatedAt: at }
      await transaction.put({
        namespace: LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS,
        id: claim.recordId,
        expectedRevision: row.revision,
        value: json(updated),
      })
      return updated
    })
  }

  async complete(
    claim: Extract<LocalGraphToolReconciliationClaim, { state: 'owned' }>,
    response: unknown,
    now: string
  ): Promise<JsonValue> {
    const at = validTimestamp(now)
    const value = json(response)
    return this.provider.transaction(async (transaction) => {
      const row = await transaction.get(LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS, claim.recordId)
      if (row === undefined) throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_MISSING')
      const current = readReceipt(row.value, row.id)
      if (current.status === 'completed') {
        if (current.response === undefined)
          throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
        return current.response
      }
      assertOwner(current, claim.ownerId)
      const completed: StoredReceipt = {
        schemaVersion: current.schemaVersion,
        command: current.command,
        status: 'completed',
        createdAt: current.createdAt,
        response: value,
        updatedAt: at,
        ...(current.intent === undefined ? {} : { intent: current.intent }),
      }
      await transaction.put({
        namespace: LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS,
        id: claim.recordId,
        expectedRevision: row.revision,
        value: json(completed),
      })
      return value
    })
  }

  async release(
    claim: Extract<LocalGraphToolReconciliationClaim, { state: 'owned' }>,
    now: string
  ): Promise<void> {
    const at = validTimestamp(now)
    await this.provider.transaction(async (transaction) => {
      const row = await transaction.get(LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS, claim.recordId)
      if (row === undefined) return
      const current = readReceipt(row.value, row.id)
      if (current.status !== 'pending' || current.lease?.ownerId !== claim.ownerId) return
      await transaction.put({
        namespace: LOCAL_GRAPH_TOOL_RECONCILIATION_RECEIPTS,
        id: claim.recordId,
        expectedRevision: row.revision,
        value: json({ ...current, updatedAt: at, lease: undefined }),
      })
    })
  }
}

function receiptId(command: LocalGraphToolReconciliationCommand): string {
  const scope = canonicalJsonStringify([
    command.callerPrincipalId,
    command.workspaceId,
    command.operation,
    command.idempotencyKey,
  ])
  return `r-${digest(scope)}`
}

function storedCommand(command: LocalGraphToolReconciliationCommand): StoredCommand {
  return {
    callerPrincipalId: command.callerPrincipalId,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    operation: command.operation,
    idempotencyKey: command.idempotencyKey,
    commandId: command.commandId,
    ...(command.contractVersion === undefined ? {} : { contractVersion: command.contractVersion }),
    ...(command.correlation === undefined ? {} : { correlation: command.correlation }),
    ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
    ...(command.issuedAt === undefined ? {} : { issuedAt: command.issuedAt }),
    payloadHash: command.payloadHash,
    payload: json(command.payload),
  }
}

function assertReplayIdentity(
  stored: StoredCommand,
  requested: LocalGraphToolReconciliationCommand
): void {
  if (
    stored.callerPrincipalId !== requested.callerPrincipalId ||
    stored.workspaceId !== requested.workspaceId ||
    stored.projectId !== requested.projectId ||
    stored.operation !== requested.operation ||
    stored.idempotencyKey !== requested.idempotencyKey ||
    stored.payloadHash !== requested.payloadHash ||
    canonicalJsonStringify(stored.payload) !== canonicalJsonStringify(json(requested.payload))
  )
    throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
}

function assertOwner(receipt: StoredReceipt, ownerId: string): void {
  if (receipt.status !== 'pending' || receipt.lease?.ownerId !== ownerId)
    throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_OWNERSHIP_LOST')
}

function readReceipt(value: JsonValue, recordId: string): StoredReceipt {
  if (
    !isObject(value) ||
    value['schemaVersion'] !== 1 ||
    !isObject(value['command']) ||
    !['pending', 'completed'].includes(String(value['status'])) ||
    typeof value['createdAt'] !== 'string' ||
    typeof value['updatedAt'] !== 'string'
  )
    throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
  const command = value['command']
  if (
    typeof command['callerPrincipalId'] !== 'string' ||
    typeof command['workspaceId'] !== 'string' ||
    typeof command['projectId'] !== 'string' ||
    command['operation'] !== 'execution.tool-effect.reconcile' ||
    typeof command['idempotencyKey'] !== 'string' ||
    typeof command['commandId'] !== 'string' ||
    typeof command['payloadHash'] !== 'string' ||
    !('payload' in command) ||
    (command['contractVersion'] !== undefined && !isObject(command['contractVersion'])) ||
    (command['correlation'] !== undefined && !isObject(command['correlation'])) ||
    (command['requestId'] !== undefined && typeof command['requestId'] !== 'string') ||
    (command['issuedAt'] !== undefined && typeof command['issuedAt'] !== 'string')
  )
    throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
  const storedCommandValue = command as unknown as StoredCommand
  if (
    receiptId(storedCommandValue) !== recordId ||
    storedCommandValue.payloadHash !== digest(canonicalJsonStringify(storedCommandValue.payload)) ||
    !Number.isFinite(Date.parse(String(value['createdAt']))) ||
    !Number.isFinite(Date.parse(String(value['updatedAt'])))
  )
    throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
  try {
    IdentifierSchemas.workspaceId.parse(storedCommandValue.workspaceId)
    IdentifierSchemas.projectId.parse(storedCommandValue.projectId)
    IdentifierSchemas.commandId.parse(storedCommandValue.commandId)
    if (storedCommandValue.requestId !== undefined)
      IdentifierSchemas.requestId.parse(storedCommandValue.requestId)
    if (storedCommandValue.contractVersion !== undefined)
      ContractVersionSchema.parse(storedCommandValue.contractVersion)
    if (storedCommandValue.correlation !== undefined)
      CorrelationMetadataSchema.parse(storedCommandValue.correlation)
    if (
      storedCommandValue.issuedAt !== undefined &&
      !Number.isFinite(Date.parse(storedCommandValue.issuedAt))
    )
      throw new Error('invalid issuedAt')
  } catch {
    throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
  }
  if (value['lease'] !== undefined) {
    const lease = value['lease']
    if (
      !isObject(lease) ||
      typeof lease['ownerId'] !== 'string' ||
      typeof lease['expiresAt'] !== 'string' ||
      Number.isNaN(Date.parse(lease['expiresAt']))
    )
      throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
  }
  if (value['status'] === 'completed' && (!('response' in value) || !isObject(value['response'])))
    throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
  return value as unknown as StoredReceipt
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validTimestamp(value: string): string {
  const at = Date.parse(value)
  if (!Number.isFinite(at)) throw new Error('TOOL_EFFECT_RECONCILIATION_CLOCK_INVALID')
  return new Date(at).toISOString()
}
