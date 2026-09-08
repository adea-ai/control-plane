import {
  ExternalSessionDiscoveryReadModelSchema,
  RuntimeConnectionDiscoveryReadModelSchema,
  IdentifierSchemas,
  type ExternalSessionDiscoveryReadModel,
  type RuntimeConnectionDiscoveryReadModel,
} from '@control-plane/contracts'
import type { JsonValue, PersistenceProvider } from '@control-plane/deployment'
import { isDeepStrictEqual } from 'node:util'

const runtimeNamespace = 'runtime-discovery-connections'
const sessionNamespace = 'runtime-discovery-sessions'

export interface SqliteRuntimeDiscoveryScope {
  readonly workspaceId: string
  readonly projectId?: string
  readonly runtimeNodeRefId?: string
}

interface RuntimeProjectionRecord {
  readonly workspaceId: string
  readonly runtimeNodeRefId?: string
  readonly model: RuntimeConnectionDiscoveryReadModel
}

interface SessionProjectionRecord {
  readonly workspaceId: string
  readonly projectId?: string
  readonly runtimeNodeRefId?: string
  readonly model: ExternalSessionDiscoveryReadModel
}

export class SqliteRuntimeDiscoveryRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async compareAndSetRuntimeConnection(
    scopeValue: SqliteRuntimeDiscoveryScope,
    expectedValue: RuntimeConnectionDiscoveryReadModel,
    nextValue: RuntimeConnectionDiscoveryReadModel
  ): Promise<boolean> {
    const scope = runtimeScope(scopeValue)
    const expected = RuntimeConnectionDiscoveryReadModelSchema.parse(expectedValue)
    const next = RuntimeConnectionDiscoveryReadModelSchema.parse(nextValue)
    if (
      expected.runtimeConnectionId !== next.runtimeConnectionId ||
      expected.runtimeDefinitionId !== next.runtimeDefinitionId ||
      expected.node?.runtimeNodeRefId !== next.node?.runtimeNodeRefId ||
      Date.parse(next.observedAt) < Date.parse(expected.observedAt)
    )
      throw new Error('RUNTIME_DISCOVERY_REFRESH_IDENTITY_MISMATCH')
    return this.provider.transaction(async (transaction) => {
      const stored = await transaction.get(runtimeNamespace, expected.runtimeConnectionId)
      if (!stored) return false
      const current = parseRuntimeRecord(stored.value)
      if (!matchesScope(current, scope) || !isDeepStrictEqual(current.model, expected)) return false
      await transaction.put({
        namespace: runtimeNamespace,
        id: expected.runtimeConnectionId,
        expectedRevision: stored.revision,
        value: { ...current, model: next } as JsonValue,
      })
      return true
    })
  }

  putRuntimeConnection(
    workspaceId: string,
    input: RuntimeConnectionDiscoveryReadModel
  ): Promise<void> {
    const model = RuntimeConnectionDiscoveryReadModelSchema.parse(input)
    return this.#put(runtimeNamespace, model.runtimeConnectionId, {
      workspaceId,
      ...(model.node === undefined ? {} : { runtimeNodeRefId: model.node.runtimeNodeRefId }),
      model,
    })
  }

  putExternalSession(
    scope: SqliteRuntimeDiscoveryScope,
    input: ExternalSessionDiscoveryReadModel
  ): Promise<void> {
    const model = ExternalSessionDiscoveryReadModelSchema.parse(input)
    return this.#put(sessionNamespace, model.externalSessionId, { ...scope, model })
  }

  async listRuntimeConnections(
    scope: SqliteRuntimeDiscoveryScope
  ): Promise<readonly RuntimeConnectionDiscoveryReadModel[]> {
    const records = await this.provider.transaction((transaction) =>
      transaction.list(runtimeNamespace)
    )
    return records
      .map((record) => parseRuntimeRecord(record.value))
      .filter(
        (record) =>
          record.workspaceId === scope.workspaceId &&
          (scope.runtimeNodeRefId === undefined ||
            record.runtimeNodeRefId === scope.runtimeNodeRefId)
      )
      .map((record) => structuredClone(record.model))
      .sort((left, right) => left.runtimeConnectionId.localeCompare(right.runtimeConnectionId))
  }

  async getRuntimeConnection(
    scope: SqliteRuntimeDiscoveryScope,
    runtimeConnectionId: string
  ): Promise<RuntimeConnectionDiscoveryReadModel | undefined> {
    const parsedScope = runtimeScope(scope)
    const id = IdentifierSchemas.runtimeConnectionId.parse(runtimeConnectionId)
    return this.provider.transaction(async (transaction) => {
      const stored = await transaction.get(runtimeNamespace, id)
      if (!stored) return undefined
      const current = parseRuntimeRecord(stored.value)
      if (current.model.runtimeConnectionId !== id)
        throw new Error('RUNTIME_DISCOVERY_RECORD_ID_MISMATCH')
      return matchesScope(current, parsedScope) ? structuredClone(current.model) : undefined
    })
  }

  async listExternalSessions(
    scope: SqliteRuntimeDiscoveryScope
  ): Promise<readonly ExternalSessionDiscoveryReadModel[]> {
    const records = await this.provider.transaction((transaction) =>
      transaction.list(sessionNamespace)
    )
    return records
      .map((record) => parseSessionRecord(record.value))
      .filter(
        (record) =>
          record.workspaceId === scope.workspaceId &&
          (scope.projectId === undefined || record.projectId === scope.projectId) &&
          (scope.runtimeNodeRefId === undefined ||
            record.runtimeNodeRefId === scope.runtimeNodeRefId)
      )
      .map((record) => structuredClone(record.model))
      .sort((left, right) => left.externalSessionId.localeCompare(right.externalSessionId))
  }

  async getExternalSession(
    scope: SqliteRuntimeDiscoveryScope,
    externalSessionId: string
  ): Promise<ExternalSessionDiscoveryReadModel | undefined> {
    return (await this.listExternalSessions(scope)).find(
      (model) => model.externalSessionId === externalSessionId
    )
  }

  async #put(namespace: string, id: string, value: object): Promise<void> {
    await this.provider.transaction(async (transaction) => {
      const current = await transaction.get(namespace, id)
      await transaction.put({
        namespace,
        id,
        ...(current === undefined ? {} : { expectedRevision: current.revision }),
        value: value as JsonValue,
      })
    })
  }
}

function parseRuntimeRecord(value: JsonValue): RuntimeProjectionRecord {
  const record = value as unknown as RuntimeProjectionRecord
  return {
    workspaceId: record.workspaceId,
    ...(record.runtimeNodeRefId === undefined ? {} : { runtimeNodeRefId: record.runtimeNodeRefId }),
    model: RuntimeConnectionDiscoveryReadModelSchema.parse(record.model),
  }
}

function runtimeScope(scope: SqliteRuntimeDiscoveryScope): SqliteRuntimeDiscoveryScope {
  return {
    workspaceId: IdentifierSchemas.workspaceId.parse(scope.workspaceId),
    ...(scope.runtimeNodeRefId === undefined
      ? {}
      : { runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId.parse(scope.runtimeNodeRefId) }),
  }
}

function matchesScope(
  record: RuntimeProjectionRecord,
  scope: SqliteRuntimeDiscoveryScope
): boolean {
  return (
    record.workspaceId === scope.workspaceId &&
    (scope.runtimeNodeRefId === undefined || record.runtimeNodeRefId === scope.runtimeNodeRefId)
  )
}

function parseSessionRecord(value: JsonValue): SessionProjectionRecord {
  const record = value as unknown as SessionProjectionRecord
  return {
    workspaceId: record.workspaceId,
    ...(record.projectId === undefined ? {} : { projectId: record.projectId }),
    ...(record.runtimeNodeRefId === undefined ? {} : { runtimeNodeRefId: record.runtimeNodeRefId }),
    model: ExternalSessionDiscoveryReadModelSchema.parse(record.model),
  }
}
