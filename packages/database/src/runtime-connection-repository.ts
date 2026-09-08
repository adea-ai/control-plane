import {
  RuntimeConnectionSchema,
  RuntimeConnectionScanSchema,
  type RuntimeConnectionScan,
  type RuntimeConnectionScanner,
  runtimeConnectionsShareStableIdentity,
  type RuntimeConnection,
  type RuntimeConnectionRepository,
} from '@control-plane/runtime-sdk'
import { and, asc, eq, gt } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { runtimeConnections } from './schema/runtime-connections.js'

export class PostgresRuntimeConnectionRepository
  implements RuntimeConnectionRepository, RuntimeConnectionScanner
{
  constructor(readonly database: Pick<ControlPlaneDatabase, 'select' | 'insert' | 'update'>) {}

  async scanByRuntimeNode(input: RuntimeConnectionScan): Promise<readonly RuntimeConnection[]> {
    const { runtimeNodeRefId, afterConnectionId, limit } = RuntimeConnectionScanSchema.parse(input)
    const rows = await this.database
      .select()
      .from(runtimeConnections)
      .where(
        and(
          eq(runtimeConnections.runtimeNodeRefId, runtimeNodeRefId),
          afterConnectionId === undefined
            ? undefined
            : gt(runtimeConnections.runtimeConnectionId, afterConnectionId)
        )
      )
      .orderBy(asc(runtimeConnections.runtimeConnectionId))
      .limit(limit)
    return rows.map(fromRuntimeConnectionRow)
  }

  async insert(connectionInput: RuntimeConnection): Promise<boolean> {
    const connection = RuntimeConnectionSchema.parse(connectionInput)
    const inserted = await this.database
      .insert(runtimeConnections)
      .values(toRuntimeConnectionRow(connection))
      .onConflictDoNothing()
      .returning({ runtimeConnectionId: runtimeConnections.runtimeConnectionId })
    return inserted.length === 1
  }

  async get(runtimeConnectionId: string): Promise<RuntimeConnection | undefined> {
    const [row] = await this.database
      .select()
      .from(runtimeConnections)
      .where(eq(runtimeConnections.runtimeConnectionId, runtimeConnectionId))
      .limit(1)
    return row ? fromRuntimeConnectionRow(row) : undefined
  }

  async getByIdentityDigest(identityDigest: string): Promise<RuntimeConnection | undefined> {
    const [row] = await this.database
      .select()
      .from(runtimeConnections)
      .where(eq(runtimeConnections.identityDigest, identityDigest))
      .limit(1)
    return row ? fromRuntimeConnectionRow(row) : undefined
  }

  async compareAndSet(
    expectedVersion: number,
    connectionInput: RuntimeConnection
  ): Promise<boolean> {
    const connection = RuntimeConnectionSchema.parse(connectionInput)
    const current = await this.get(connection.runtimeConnectionId)
    if (
      !current ||
      !runtimeConnectionsShareStableIdentity(current, connection) ||
      current.createdAt !== connection.createdAt
    ) {
      return false
    }
    const updated = await this.database
      .update(runtimeConnections)
      .set(toRuntimeConnectionUpdate(connection))
      .where(
        and(
          eq(runtimeConnections.runtimeConnectionId, connection.runtimeConnectionId),
          eq(runtimeConnections.version, expectedVersion)
        )
      )
      .returning({ runtimeConnectionId: runtimeConnections.runtimeConnectionId })
    return updated.length === 1
  }

  async listByRuntimeNode(runtimeNodeRefId: string): Promise<readonly RuntimeConnection[]> {
    const rows = await this.database
      .select()
      .from(runtimeConnections)
      .where(eq(runtimeConnections.runtimeNodeRefId, runtimeNodeRefId))
      .orderBy(asc(runtimeConnections.runtimeConnectionId))
    return rows.map(fromRuntimeConnectionRow)
  }
}

type RuntimeConnectionRow = typeof runtimeConnections.$inferSelect

export function toRuntimeConnectionRow(
  connection: RuntimeConnection
): typeof runtimeConnections.$inferInsert {
  return {
    runtimeConnectionId: connection.runtimeConnectionId,
    identityDigest: connection.identityDigest,
    connectionType: connection.connectionType,
    runtimeNodeRefId: connection.runtimeNodeRefId ?? null,
    runtimeDefinitionId: connection.runtimeDefinitionId,
    location: connection.location,
    opaqueNativeRef: connection.opaqueNativeRef ?? null,
    adapterVersion: connection.adapterVersion,
    driverVersion: connection.driverVersion,
    harnessVersion: connection.harnessVersion,
    status: connection.status,
    health: connection.health,
    capabilities: connection.capabilities,
    compatibilityState: connection.compatibilityState,
    availabilityState: connection.availabilityState ?? null,
    protocolVersion: connection.protocolVersion ?? null,
    capabilitySnapshotVersion: connection.capabilitySnapshotVersion ?? null,
    capabilitySnapshotObservedAt: optionalDate(connection.capabilitySnapshotObservedAt),
    capabilitySnapshotExpiresAt: optionalDate(connection.capabilitySnapshotExpiresAt),
    capabilityVerification: connection.capabilityVerification ?? null,
    lastHealthReportSequence: connection.lastHealthReportSequence ?? null,
    lastHealthReportDigest: connection.lastHealthReportDigest ?? null,
    limitations: connection.limitations,
    diagnostics: connection.diagnostics ?? null,
    lastDiscoveredAt: new Date(connection.lastDiscoveredAt),
    lastHeartbeatAt: new Date(connection.lastHeartbeatAt),
    lastHealthCheckAt: new Date(connection.lastHealthCheckAt),
    expiresAt: optionalDate(connection.expiresAt),
    version: connection.version,
    createdAt: new Date(connection.createdAt),
    updatedAt: new Date(connection.updatedAt),
  }
}

export function fromRuntimeConnectionRow(row: RuntimeConnectionRow): RuntimeConnection {
  return RuntimeConnectionSchema.parse({
    runtimeConnectionId: row.runtimeConnectionId,
    identityDigest: row.identityDigest,
    connectionType: row.connectionType,
    ...(row.runtimeNodeRefId ? { runtimeNodeRefId: row.runtimeNodeRefId } : {}),
    runtimeDefinitionId: row.runtimeDefinitionId,
    location: row.location,
    ...(row.opaqueNativeRef ? { opaqueNativeRef: row.opaqueNativeRef } : {}),
    adapterVersion: row.adapterVersion,
    driverVersion: row.driverVersion,
    harnessVersion: row.harnessVersion,
    status: row.status,
    health: row.health,
    capabilities: row.capabilities,
    compatibilityState: row.compatibilityState,
    ...(row.availabilityState ? { availabilityState: row.availabilityState } : {}),
    ...(row.protocolVersion ? { protocolVersion: row.protocolVersion } : {}),
    ...(row.capabilitySnapshotVersion
      ? { capabilitySnapshotVersion: row.capabilitySnapshotVersion }
      : {}),
    ...(row.capabilitySnapshotObservedAt
      ? { capabilitySnapshotObservedAt: row.capabilitySnapshotObservedAt.toISOString() }
      : {}),
    ...(row.capabilitySnapshotExpiresAt
      ? { capabilitySnapshotExpiresAt: row.capabilitySnapshotExpiresAt.toISOString() }
      : {}),
    ...(row.capabilityVerification ? { capabilityVerification: row.capabilityVerification } : {}),
    ...(row.lastHealthReportSequence
      ? { lastHealthReportSequence: row.lastHealthReportSequence }
      : {}),
    ...(row.lastHealthReportDigest ? { lastHealthReportDigest: row.lastHealthReportDigest } : {}),
    limitations: row.limitations,
    ...(row.diagnostics ? { diagnostics: row.diagnostics } : {}),
    lastDiscoveredAt: row.lastDiscoveredAt.toISOString(),
    lastHeartbeatAt: row.lastHeartbeatAt.toISOString(),
    lastHealthCheckAt: row.lastHealthCheckAt.toISOString(),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function toRuntimeConnectionUpdate(
  connection: RuntimeConnection
): Partial<typeof runtimeConnections.$inferInsert> {
  return {
    adapterVersion: connection.adapterVersion,
    driverVersion: connection.driverVersion,
    harnessVersion: connection.harnessVersion,
    status: connection.status,
    health: connection.health,
    capabilities: connection.capabilities,
    compatibilityState: connection.compatibilityState,
    availabilityState: connection.availabilityState ?? null,
    protocolVersion: connection.protocolVersion ?? null,
    capabilitySnapshotVersion: connection.capabilitySnapshotVersion ?? null,
    capabilitySnapshotObservedAt: optionalDate(connection.capabilitySnapshotObservedAt),
    capabilitySnapshotExpiresAt: optionalDate(connection.capabilitySnapshotExpiresAt),
    capabilityVerification: connection.capabilityVerification ?? null,
    lastHealthReportSequence: connection.lastHealthReportSequence ?? null,
    lastHealthReportDigest: connection.lastHealthReportDigest ?? null,
    limitations: connection.limitations,
    diagnostics: connection.diagnostics ?? null,
    lastDiscoveredAt: new Date(connection.lastDiscoveredAt),
    lastHeartbeatAt: new Date(connection.lastHeartbeatAt),
    lastHealthCheckAt: new Date(connection.lastHealthCheckAt),
    expiresAt: optionalDate(connection.expiresAt),
    version: connection.version,
    updatedAt: new Date(connection.updatedAt),
  }
}

function optionalDate(value: string | undefined): Date | null {
  return value ? new Date(value) : null
}
