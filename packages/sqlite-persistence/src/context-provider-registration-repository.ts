import { createHash } from 'node:crypto'
import {
  ContextProviderRegistrationSchema,
  contextProviderRegistrationIdentity,
  type ContextProviderRegistration,
  type ContextProviderRegistrationRepository,
} from '@control-plane/domain'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'

const records = 'context-provider-registrations'
const hash = (...parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const index = (workspaceId: string, principalRef: string) =>
  `context-provider-scope-${hash(workspaceId, principalRef)}`

export class SqliteContextProviderRegistrationRepository implements ContextProviderRegistrationRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async save(expectedVersion: number, input: ContextProviderRegistration): Promise<boolean> {
    const next = ContextProviderRegistrationSchema.parse(input)
    if (
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0 ||
      next.version !== expectedVersion + 1
    )
      return false
    const connection = next.readModel.connection
    const id = hash(connection.workspaceId, connection.connectionId)
    return this.provider.transaction(async (tx) => {
      const stored = await tx.get(records, id)
      const scopeIndex = index(connection.workspaceId, connection.principalRef)
      const indexed = await tx.get(scopeIndex, connection.connectionId)
      if (stored) {
        const current = ContextProviderRegistrationSchema.parse(stored.value)
        if (
          current.version !== expectedVersion ||
          contextProviderRegistrationIdentity(current) !==
            contextProviderRegistrationIdentity(next) ||
          Date.parse(next.readModel.health.checkedAt) <
            Date.parse(current.readModel.health.checkedAt) ||
          (current.readModel.connection.state === 'revoked' && connection.state !== 'revoked')
        )
          return false
        if (current.readModel.connection.state === 'active' && indexed?.value !== id)
          throw new Error('CONTEXT_PROVIDER_REGISTRY_INDEX_INVALID')
      } else if (expectedVersion !== 0 || connection.state !== 'active') return false
      else if (indexed) throw new Error('CONTEXT_PROVIDER_REGISTRY_INDEX_INVALID')
      if (!stored && (await tx.scan(scopeIndex, { limit: 32 })).length >= 32) return false
      await tx.put({
        namespace: records,
        id,
        value: JSON.parse(JSON.stringify(next)) as JsonValue,
        ...(stored ? { expectedRevision: stored.revision } : {}),
      })
      if (!stored)
        await tx.put({
          namespace: scopeIndex,
          id: connection.connectionId,
          value: id,
        })
      if (connection.state === 'revoked' && indexed)
        await tx.delete(scopeIndex, connection.connectionId, indexed.revision)
      return true
    })
  }

  async list(scope: {
    workspaceId: string
    principalRef: string
  }): Promise<ContextProviderRegistration[]> {
    return this.provider.transaction(async (tx) => {
      const entries = await tx.scan(index(scope.workspaceId, scope.principalRef), { limit: 33 })
      if (entries.length > 32) throw new Error('CONTEXT_PROVIDER_REGISTRY_LIMIT_EXCEEDED')
      const result: ContextProviderRegistration[] = []
      for (const entry of entries) {
        if (typeof entry.value !== 'string')
          throw new Error('CONTEXT_PROVIDER_REGISTRY_INDEX_INVALID')
        const stored = await tx.get(records, entry.value)
        const record = ContextProviderRegistrationSchema.parse(stored?.value)
        const connection = record.readModel.connection
        if (
          connection.workspaceId !== scope.workspaceId ||
          connection.principalRef !== scope.principalRef ||
          connection.connectionId !== entry.id ||
          connection.state !== 'active' ||
          hash(connection.workspaceId, connection.connectionId) !== entry.value
        )
          throw new Error('CONTEXT_PROVIDER_REGISTRY_SCOPE_MISMATCH')
        result.push(record)
      }
      return result
    })
  }
}
