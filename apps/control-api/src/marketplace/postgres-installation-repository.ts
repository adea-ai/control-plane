import { and, asc, eq } from 'drizzle-orm'
import type {
  MarketplaceInstallationRecord,
  MarketplaceInstallationRepository,
} from './installation.js'
import type { ControlPlaneDatabase } from '@control-plane/database'
import { marketplaceInstallations } from '@control-plane/database'

export class PostgresMarketplaceInstallationRepository implements MarketplaceInstallationRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  async findByIdempotency(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<MarketplaceInstallationRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(marketplaceInstallations)
      .where(
        and(
          eq(marketplaceInstallations.workspaceId, workspaceId),
          eq(marketplaceInstallations.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1)
    return row ? fromRow(row) : undefined
  }

  async listByWorkspace(workspaceId: string): Promise<readonly MarketplaceInstallationRecord[]> {
    const rows = await this.database
      .select()
      .from(marketplaceInstallations)
      .where(eq(marketplaceInstallations.workspaceId, workspaceId))
      .orderBy(asc(marketplaceInstallations.updatedAt))
    return rows.map(fromRow)
  }

  async save(record: MarketplaceInstallationRecord): Promise<MarketplaceInstallationRecord> {
    const [inserted] = await this.database
      .insert(marketplaceInstallations)
      .values({
        ...record,
        canonicalContentDigest: record.canonicalContentDigest,
        ...(record.installationInstanceId === undefined
          ? {}
          : { installationInstanceId: record.installationInstanceId }),
        ...(record.packageDigest === undefined ? {} : { packageDigest: record.packageDigest }),
        createdAt: new Date(record.createdAt),
        requiredConnectors: [...record.requiredConnectors],
        requiredCredentials: [...record.requiredCredentials],
        updatedAt: new Date(record.updatedAt),
      })
      .onConflictDoNothing()
      .returning({ installationId: marketplaceInstallations.installationId })
    if (inserted !== undefined) return record
    const existing = await this.findByIdempotency(record.workspaceId, record.idempotencyKey)
    if (!existing) throw new Error('MARKETPLACE_INSTALLATION_PERSISTENCE_CONFLICT')
    return existing
  }
}

type MarketplaceInstallationRow = typeof marketplaceInstallations.$inferSelect

function fromRow(row: MarketplaceInstallationRow): MarketplaceInstallationRecord {
  return {
    canonicalContentDigest: row.canonicalContentDigest,
    catalogId: row.catalogId,
    createdAt: row.createdAt.toISOString(),
    idempotencyKey: row.idempotencyKey,
    ...(row.installationInstanceId === null
      ? {}
      : { installationInstanceId: row.installationInstanceId }),
    ...(row.packageDigest === null ? {} : { packageDigest: row.packageDigest }),
    installationId: row.installationId,
    pluginId: row.pluginId,
    releaseId: row.releaseId,
    requestDigest: row.requestDigest,
    requestedHarness: row.requestedHarness,
    requiredConnectors: row.requiredConnectors,
    requiredCredentials: row.requiredCredentials,
    state: row.state,
    updatedAt: row.updatedAt.toISOString(),
    userId: row.userId,
    workspaceId: row.workspaceId,
  }
}
