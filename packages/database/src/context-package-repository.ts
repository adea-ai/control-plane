import { isDeepStrictEqual } from 'node:util'
import {
  ContextPackageReferenceSchema,
  assertContextPackageIntegrity,
  type ContextPackage,
  type ContextPackageReference,
  type ContextPackageRepository,
} from '@control-plane/context'
import { and, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { contextPackages } from './schema/context-packages.js'

export class PostgresContextPackageRepository implements ContextPackageRepository {
  constructor(readonly database: Pick<ControlPlaneDatabase, 'select' | 'insert'>) {}

  async put(input: ContextPackage): Promise<ContextPackageReference> {
    const package_ = assertContextPackageIntegrity(input)
    const reference = {
      contextPackageId: package_.contextPackageId,
      contentDigest: package_.contentDigest,
    }
    const inserted = await this.database
      .insert(contextPackages)
      .values(toRow(package_))
      .onConflictDoNothing()
      .returning({ contextPackageId: contextPackages.contextPackageId })
    if (inserted.length === 1) return reference

    const existing = await this.getById(package_.contextPackageId)
    if (!existing || !isDeepStrictEqual(existing, package_)) {
      throw new Error('CONTEXT_PACKAGE_ID_CONFLICT')
    }
    return reference
  }

  async get(input: ContextPackageReference): Promise<ContextPackage | undefined> {
    const reference = ContextPackageReferenceSchema.parse(input)
    const [row] = await this.database
      .select()
      .from(contextPackages)
      .where(
        and(
          eq(contextPackages.contextPackageId, reference.contextPackageId),
          eq(contextPackages.contentDigest, reference.contentDigest)
        )
      )
      .limit(1)
    return row ? fromRow(row) : undefined
  }

  async getById(contextPackageId: string): Promise<ContextPackage | undefined> {
    const [row] = await this.database
      .select()
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, contextPackageId))
      .limit(1)
    return row ? fromRow(row) : undefined
  }
}

function toRow(package_: ContextPackage): typeof contextPackages.$inferInsert {
  return {
    contextPackageId: package_.contextPackageId,
    contentDigest: package_.contentDigest,
    schemaVersion: package_.schemaVersion,
    workspaceId: package_.projectState.workspaceId,
    projectId: package_.projectState.projectId,
    contextPackage: package_,
    compiledAt: new Date(package_.compiledAt),
  }
}

function fromRow(row: typeof contextPackages.$inferSelect): ContextPackage {
  const package_ = assertContextPackageIntegrity(row.contextPackage)
  if (
    row.contextPackageId !== package_.contextPackageId ||
    row.contentDigest !== package_.contentDigest ||
    row.schemaVersion !== package_.schemaVersion ||
    row.workspaceId !== package_.projectState.workspaceId ||
    row.projectId !== package_.projectState.projectId ||
    row.compiledAt.toISOString() !== package_.compiledAt
  ) {
    throw new Error('CONTEXT_PACKAGE_PERSISTENCE_INTEGRITY_ERROR')
  }
  return package_
}
