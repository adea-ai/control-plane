import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'
import {
  ModelConnectionSchema,
  RuntimeProviderSelectionSchema,
  WorkspaceModelDefaultsSchema,
  type ModelConnection,
  type RuntimeProviderSelection,
  type WorkspaceModelDefaults,
} from './selection.js'
import type { ModelSelectionRepository } from './selection-service.js'

/** Transactional opaque metadata storage; no lease capabilities or secrets. */
export class PersistentModelSelectionRepository implements ModelSelectionRepository {
  constructor(readonly persistence: PersistenceProvider) {}
  async getConnection(workspaceId: string, ref: string) {
    return this.persistence.transaction(async (tx) => {
      const row = await tx.get(scope('connections', workspaceId), ref)
      if (!row) return undefined
      const value = ModelConnectionSchema.parse(row.value)
      if (value.workspaceId !== workspaceId || value.connectionRef !== ref)
        throw new Error('MODEL_STORE_SCOPE_MISMATCH')
      return value
    })
  }
  async listConnections(workspaceId: string) {
    return this.persistence.transaction(async (tx) =>
      (await tx.scan(scope('connections', workspaceId), { limit: 128 })).map((row) => {
        const value = ModelConnectionSchema.parse(row.value)
        if (value.workspaceId !== workspaceId || value.connectionRef !== row.id)
          throw new Error('MODEL_STORE_SCOPE_MISMATCH')
        return value
      })
    )
  }
  async saveConnection(expectedRevision: number, input: ModelConnection) {
    const next = ModelConnectionSchema.parse(input)
    return this.persistence.transaction(async (tx) => {
      const namespace = scope('connections', next.workspaceId)
      const row = await tx.get(namespace, next.connectionRef)
      if (
        !validConnectionUpdate(
          row ? ModelConnectionSchema.parse(row.value) : undefined,
          expectedRevision,
          next
        )
      )
        return false
      if (!row && (await tx.scan(namespace, { limit: 128 })).length >= 128) return false
      await tx.put({
        namespace,
        id: next.connectionRef,
        value: json(next),
        ...(row ? { expectedRevision: row.revision } : {}),
      })
      return true
    })
  }
  async getDefaults(workspaceId: string) {
    return this.persistence.transaction(async (tx) => {
      const row = await tx.get('workspace-model-defaults', workspaceId)
      if (!row) return undefined
      const value = WorkspaceModelDefaultsSchema.parse(row.value)
      if (value.workspaceId !== workspaceId) throw new Error('MODEL_STORE_SCOPE_MISMATCH')
      return value
    })
  }
  async saveDefaults(expectedRevision: number, input: WorkspaceModelDefaults) {
    const next = WorkspaceModelDefaultsSchema.parse(input)
    return this.persistence.transaction(async (tx) => {
      const row = await tx.get('workspace-model-defaults', next.workspaceId)
      if (
        (row ? WorkspaceModelDefaultsSchema.parse(row.value).revision : 0) !== expectedRevision ||
        next.revision !== expectedRevision + 1
      )
        return false
      await tx.put({
        namespace: 'workspace-model-defaults',
        id: next.workspaceId,
        value: json(next),
        ...(row ? { expectedRevision: row.revision } : {}),
      })
      return true
    })
  }
  async insertSelection(input: RuntimeProviderSelection) {
    const next = RuntimeProviderSelectionSchema.parse(input)
    return this.persistence.transaction(async (tx) => {
      const namespace = scope('selections', next.workspaceId)
      if (await tx.get(namespace, next.selectionRef)) return false
      await tx.put({ namespace, id: next.selectionRef, value: json(next) })
      return true
    })
  }
  async getSelection(workspaceId: string, ref: string) {
    return this.persistence.transaction(async (tx) => {
      const row = await tx.get(scope('selections', workspaceId), ref)
      if (!row) return undefined
      const value = RuntimeProviderSelectionSchema.parse(row.value)
      if (value.workspaceId !== workspaceId || value.selectionRef !== ref)
        throw new Error('MODEL_STORE_SCOPE_MISMATCH')
      return value
    })
  }
}
export function validConnectionUpdate(
  current: ModelConnection | undefined,
  expectedRevision: number,
  next: ModelConnection
): boolean {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    (current?.revision ?? 0) !== expectedRevision ||
    next.revision !== expectedRevision + 1 ||
    current?.status === 'revoked'
  )
    return false
  if (!current) return true
  return (
    [
      'workspaceId',
      'connectionRef',
      'ownerRef',
      'credentialRef',
      'provider',
      'accountRef',
      'authKind',
      'fundingSource',
    ].every((key) => Reflect.get(current, key) === Reflect.get(next, key)) &&
    next.credentialRevision >= current.credentialRevision &&
    next.workspaceGrant.revision >= current.workspaceGrant.revision &&
    (current.workspaceGrant.status !== 'revoked' || next.workspaceGrant.status === 'revoked') &&
    (next.workspaceGrant.revision > current.workspaceGrant.revision ||
      canonicalJsonStringify(next.workspaceGrant) ===
        canonicalJsonStringify(current.workspaceGrant))
  )
}
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function scope(kind: string, workspaceId: string): string {
  return `model-${kind}-${createHash('sha256').update(workspaceId).digest('hex')}`
}
