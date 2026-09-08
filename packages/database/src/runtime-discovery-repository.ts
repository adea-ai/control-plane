import {
  ExternalSessionDiscoveryReadModelSchema,
  IdentifierSchemas,
  RuntimeConnectionDiscoveryReadModelSchema,
  type ExternalSessionDiscoveryReadModel,
  type RuntimeConnectionDiscoveryReadModel,
} from '@control-plane/contracts'
import { and, asc, eq, sql, type SQL } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { runtimeDiscoveryProjections } from './schema/runtime-discovery-projections.js'

export interface PostgresRuntimeDiscoveryScope {
  readonly workspaceId: string
  readonly projectId?: string
  readonly runtimeNodeRefId?: string
}

export class PostgresRuntimeDiscoveryRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async compareAndSetRuntimeConnection(
    scopeValue: PostgresRuntimeDiscoveryScope,
    expectedValue: RuntimeConnectionDiscoveryReadModel,
    nextValue: RuntimeConnectionDiscoveryReadModel
  ): Promise<boolean> {
    const scope = parseScope(scopeValue)
    const expected = RuntimeConnectionDiscoveryReadModelSchema.parse(expectedValue)
    const next = RuntimeConnectionDiscoveryReadModelSchema.parse(nextValue)
    if (
      expected.runtimeConnectionId !== next.runtimeConnectionId ||
      expected.runtimeDefinitionId !== next.runtimeDefinitionId ||
      expected.node?.runtimeNodeRefId !== next.node?.runtimeNodeRefId ||
      Date.parse(next.observedAt) < Date.parse(expected.observedAt)
    ) {
      throw new Error('RUNTIME_DISCOVERY_REFRESH_IDENTITY_MISMATCH')
    }
    const rows = await this.database
      .update(runtimeDiscoveryProjections)
      .set({
        model: next,
        updatedAt: new Date(next.observedAt),
      })
      .where(
        and(
          ...conditions('runtime_connection', scope),
          eq(runtimeDiscoveryProjections.resourceId, expected.runtimeConnectionId),
          sql`${runtimeDiscoveryProjections.model} = ${JSON.stringify(expected)}::jsonb`
        )
      )
      .returning({ resourceId: runtimeDiscoveryProjections.resourceId })
    return rows.length === 1
  }

  async putRuntimeConnection(
    workspaceIdValue: string,
    input: RuntimeConnectionDiscoveryReadModel
  ): Promise<void> {
    const workspaceId = IdentifierSchemas.workspaceId.parse(workspaceIdValue)
    const model = RuntimeConnectionDiscoveryReadModelSchema.parse(input)
    await this.#put({
      kind: 'runtime_connection',
      resourceId: model.runtimeConnectionId,
      workspaceId,
      projectId: null,
      runtimeNodeRefId: model.node?.runtimeNodeRefId ?? null,
      model,
      updatedAt: new Date(model.observedAt),
    })
  }

  async putExternalSession(
    scopeValue: PostgresRuntimeDiscoveryScope,
    input: ExternalSessionDiscoveryReadModel
  ): Promise<void> {
    const scope = parseScope(scopeValue)
    const model = ExternalSessionDiscoveryReadModelSchema.parse(input)
    await this.#put({
      kind: 'external_session',
      resourceId: model.externalSessionId,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId ?? null,
      runtimeNodeRefId: scope.runtimeNodeRefId ?? null,
      model,
      updatedAt: new Date(model.freshness.observedAt),
    })
  }

  async listRuntimeConnections(
    scopeValue: PostgresRuntimeDiscoveryScope
  ): Promise<readonly RuntimeConnectionDiscoveryReadModel[]> {
    const scope = parseScope(scopeValue)
    const rows = await this.database
      .select({ model: runtimeDiscoveryProjections.model })
      .from(runtimeDiscoveryProjections)
      .where(and(...conditions('runtime_connection', scope)))
      .orderBy(asc(runtimeDiscoveryProjections.resourceId))
    return rows.map(({ model }) => RuntimeConnectionDiscoveryReadModelSchema.parse(model))
  }

  async getRuntimeConnection(
    scopeValue: PostgresRuntimeDiscoveryScope,
    runtimeConnectionIdValue: string
  ): Promise<RuntimeConnectionDiscoveryReadModel | undefined> {
    const scope = parseScope(scopeValue)
    const runtimeConnectionId =
      IdentifierSchemas.runtimeConnectionId.parse(runtimeConnectionIdValue)
    const [row] = await this.database
      .select({ model: runtimeDiscoveryProjections.model })
      .from(runtimeDiscoveryProjections)
      .where(
        and(
          ...conditions('runtime_connection', scope),
          eq(runtimeDiscoveryProjections.resourceId, runtimeConnectionId)
        )
      )
      .limit(1)
    return row === undefined
      ? undefined
      : RuntimeConnectionDiscoveryReadModelSchema.parse(row.model)
  }

  async listExternalSessions(
    scopeValue: PostgresRuntimeDiscoveryScope
  ): Promise<readonly ExternalSessionDiscoveryReadModel[]> {
    const scope = parseScope(scopeValue)
    const rows = await this.database
      .select({ model: runtimeDiscoveryProjections.model })
      .from(runtimeDiscoveryProjections)
      .where(and(...conditions('external_session', scope)))
      .orderBy(asc(runtimeDiscoveryProjections.resourceId))
    return rows.map(({ model }) => ExternalSessionDiscoveryReadModelSchema.parse(model))
  }

  async getExternalSession(
    scopeValue: PostgresRuntimeDiscoveryScope,
    externalSessionIdValue: string
  ): Promise<ExternalSessionDiscoveryReadModel | undefined> {
    const scope = parseScope(scopeValue)
    const externalSessionId = IdentifierSchemas.externalSessionId.parse(externalSessionIdValue)
    const [row] = await this.database
      .select({ model: runtimeDiscoveryProjections.model })
      .from(runtimeDiscoveryProjections)
      .where(
        and(
          ...conditions('external_session', scope),
          eq(runtimeDiscoveryProjections.resourceId, externalSessionId)
        )
      )
      .limit(1)
    return row === undefined ? undefined : ExternalSessionDiscoveryReadModelSchema.parse(row.model)
  }

  async #put(row: typeof runtimeDiscoveryProjections.$inferInsert): Promise<void> {
    await this.database
      .insert(runtimeDiscoveryProjections)
      .values(row)
      .onConflictDoUpdate({
        target: [runtimeDiscoveryProjections.kind, runtimeDiscoveryProjections.resourceId],
        set: {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          runtimeNodeRefId: row.runtimeNodeRefId,
          model: row.model,
          updatedAt: row.updatedAt,
        },
      })
  }
}

function parseScope(scope: PostgresRuntimeDiscoveryScope): PostgresRuntimeDiscoveryScope {
  return {
    workspaceId: IdentifierSchemas.workspaceId.parse(scope.workspaceId),
    ...(scope.projectId === undefined
      ? {}
      : { projectId: IdentifierSchemas.projectId.parse(scope.projectId) }),
    ...(scope.runtimeNodeRefId === undefined
      ? {}
      : { runtimeNodeRefId: IdentifierSchemas.runtimeNodeRefId.parse(scope.runtimeNodeRefId) }),
  }
}

function conditions(
  kind: 'runtime_connection' | 'external_session',
  scope: PostgresRuntimeDiscoveryScope
): SQL[] {
  return [
    eq(runtimeDiscoveryProjections.kind, kind),
    eq(runtimeDiscoveryProjections.workspaceId, scope.workspaceId),
    ...(kind !== 'external_session' || scope.projectId === undefined
      ? []
      : [eq(runtimeDiscoveryProjections.projectId, scope.projectId)]),
    ...(scope.runtimeNodeRefId === undefined
      ? []
      : [eq(runtimeDiscoveryProjections.runtimeNodeRefId, scope.runtimeNodeRefId)]),
  ]
}
