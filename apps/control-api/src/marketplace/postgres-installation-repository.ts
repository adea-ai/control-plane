import { and, asc, eq, isNull } from 'drizzle-orm'
import type {
  MarketplaceInstallationListOptions,
  MarketplaceInstallationRecord,
  MarketplaceInstallationRepository,
  MarketplaceUninstallTransition,
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

  async findById(
    workspaceId: string,
    installationId: string
  ): Promise<MarketplaceInstallationRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(marketplaceInstallations)
      .where(
        and(
          eq(marketplaceInstallations.workspaceId, workspaceId),
          eq(marketplaceInstallations.installationId, installationId)
        )
      )
      .limit(1)
    return row ? fromRow(row) : undefined
  }

  async findByUninstallIdempotency(
    workspaceId: string,
    idempotencyKey: string
  ): Promise<MarketplaceInstallationRecord | undefined> {
    const [row] = await this.database
      .select()
      .from(marketplaceInstallations)
      .where(
        and(
          eq(marketplaceInstallations.workspaceId, workspaceId),
          eq(marketplaceInstallations.uninstallIdempotencyKey, idempotencyKey)
        )
      )
      .limit(1)
    return row ? fromRow(row) : undefined
  }

  async listByWorkspace(
    workspaceId: string,
    options: MarketplaceInstallationListOptions = {}
  ): Promise<readonly MarketplaceInstallationRecord[]> {
    const rows = await this.database
      .select()
      .from(marketplaceInstallations)
      .where(
        and(
          eq(marketplaceInstallations.workspaceId, workspaceId),
          isNull(marketplaceInstallations.uninstalledAt),
          options.installedBy === undefined
            ? undefined
            : eq(marketplaceInstallations.userId, options.installedBy)
        )
      )
      .orderBy(asc(marketplaceInstallations.updatedAt))
    return rows.map(fromRow)
  }

  async save(record: MarketplaceInstallationRecord): Promise<MarketplaceInstallationRecord> {
    const [inserted] = await this.database
      .insert(marketplaceInstallations)
      .values({
        canonicalContentDigest: record.canonicalContentDigest,
        catalogId: record.catalogId,
        createdAt: new Date(record.createdAt),
        idempotencyKey: record.idempotencyKey,
        installationId: record.installationId,
        ...(record.installationInstanceId === undefined
          ? {}
          : { installationInstanceId: record.installationInstanceId }),
        ...(record.packageDigest === undefined ? {} : { packageDigest: record.packageDigest }),
        pluginId: record.pluginId,
        releaseId: record.releaseId,
        requestDigest: record.requestDigest,
        requestedHarness: record.requestedHarness,
        requiredConnectors: [...record.requiredConnectors],
        requiredCredentials: [...record.requiredCredentials],
        state: record.state,
        updatedAt: new Date(record.updatedAt),
        userId: record.userId,
        workspaceId: record.workspaceId,
      })
      .onConflictDoNothing()
      .returning({ installationId: marketplaceInstallations.installationId })
    if (inserted !== undefined) return record
    const existing = await this.findByIdempotency(record.workspaceId, record.idempotencyKey)
    if (!existing) throw new Error('MARKETPLACE_INSTALLATION_PERSISTENCE_CONFLICT')
    return existing
  }

  async markUninstalled(
    transition: MarketplaceUninstallTransition
  ): Promise<MarketplaceInstallationRecord | undefined> {
    const uninstalledAt = new Date(transition.uninstalledAt)
    try {
      // One conditional statement: only an active installation of this
      // workspace transitions, so concurrent uninstalls record one actor.
      const [row] = await this.database
        .update(marketplaceInstallations)
        .set({
          uninstallIdempotencyKey: transition.idempotencyKey,
          uninstallRequestDigest: transition.requestDigest,
          uninstalledAt,
          uninstalledBy: transition.uninstalledBy,
          updatedAt: uninstalledAt,
        })
        .where(
          and(
            eq(marketplaceInstallations.workspaceId, transition.workspaceId),
            eq(marketplaceInstallations.installationId, transition.installationId),
            isNull(marketplaceInstallations.uninstalledAt)
          )
        )
        .returning()
      return row ? fromRow(row) : undefined
    } catch (error) {
      // The uninstall key was claimed concurrently for another installation;
      // the caller re-reads it and reports the idempotency conflict.
      if (isUniqueViolation(error)) return undefined
      throw error
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current !== 'object') return false
    if ((current as { code?: unknown }).code === '23505') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
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
    ...(row.uninstalledAt === null ||
    row.uninstalledBy === null ||
    row.uninstallIdempotencyKey === null ||
    row.uninstallRequestDigest === null
      ? {}
      : {
          uninstallIdempotencyKey: row.uninstallIdempotencyKey,
          uninstallRequestDigest: row.uninstallRequestDigest,
          uninstalledAt: row.uninstalledAt.toISOString(),
          uninstalledBy: row.uninstalledBy,
        }),
    updatedAt: row.updatedAt.toISOString(),
    userId: row.userId,
    workspaceId: row.workspaceId,
  }
}
