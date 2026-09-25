import { isDeepStrictEqual } from 'node:util'
import {
  ContextPackageReferenceSchema,
  assertContextPackageIntegrity,
  type ContextPackage,
  type ContextPackageReference,
  type ContextPackageRepository,
} from '@control-plane/context'
import {
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { contextAuthoringCommands } from './schema/context-authoring-commands.js'
import { contextPackages } from './schema/context-packages.js'
import { executionPlans } from './schema/execution-plans.js'

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

/**
 * Retention deletion for the context-packages class (#194), kept beside the
 * repository rather than on it: the repository is constructed with a narrow
 * `select | insert` view by its callers, while deletion needs `delete`.
 */
export class PostgresContextPackageRetention {
  constructor(readonly database: ControlPlaneDatabase) {}

  /**
   * Deletes context packages past their retention window and free of
   * references (#194). A package is pinned by an execution plan (the pin lives
   * inside the plan JSON) and by the authoring command that produced it, so
   * either reference retains it as `reference_pending` — deletion is bottom-up
   * with plans. Age is measured from `compiledAt`, because a package is
   * immutable once compiled and "last reference released" cannot be observed
   * directly. `dryRun` defaults to true and the delete is guarded by the
   * package's content digest, so a replaced package is reported as `raced`.
   */
  async deleteEligibleContextPackages(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('CONTEXT_PACKAGE_RETENTION_INVALID_TIMESTAMP')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'context-packages',
      assessedAt,
      options.bound ?? 64
    )
    let deleted = 0
    let raced = 0
    const candidates = await this.database
      .select({
        contextPackageId: contextPackages.contextPackageId,
        contentDigest: contextPackages.contentDigest,
        compiledAt: contextPackages.compiledAt,
      })
      .from(contextPackages)
      .where(
        options.policyRetainMs === null
          ? sql`true`
          : lt(contextPackages.compiledAt, new Date(now.getTime() - options.policyRetainMs))
      )
      .orderBy(asc(contextPackages.compiledAt))
      .limit(counter.bound + 1)
    const ids = candidates.map((candidate) => candidate.contextPackageId)
    const referenced = await this.#referencedPackages(ids)
    for (const candidate of candidates) {
      const verdict = evaluateRetentionEligibility({
        retentionExpiresAt:
          options.policyRetainMs === null
            ? undefined
            : new Date(candidate.compiledAt.getTime() + options.policyRetainMs).toISOString(),
        now: assessedAt,
        policyRetainMs: options.policyRetainMs,
        ownerTerminal: true,
        publicationSettled: true,
        rejectionKeyReserved: true,
        pendingReferences: referenced.has(candidate.contextPackageId) ? 1 : 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun) continue
      if (options.journal !== undefined) {
        await options.journal([
          {
            kind: 'postgres.deleteContextPackage',
            contextPackageId: candidate.contextPackageId,
          },
        ])
      }
      const removed = await this.database
        .delete(contextPackages)
        .where(
          and(
            eq(contextPackages.contextPackageId, candidate.contextPackageId),
            eq(contextPackages.contentDigest, candidate.contentDigest)
          )
        )
        .returning({ contextPackageId: contextPackages.contextPackageId })
      if (removed.length === 1) deleted += 1
      else raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  /** Package ids among `ids` that a plan pins or an authoring command produced. */
  async #referencedPackages(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const list = [...ids]
    const [plans, commands] = await Promise.all([
      this.database
        .select({ contextPackageId: sql<string>`plan->'contextPackage'->>'contextPackageId'` })
        .from(executionPlans)
        .where(inArray(sql`plan->'contextPackage'->>'contextPackageId'`, list)),
      this.database
        .select({ contextPackageId: contextAuthoringCommands.contextPackageId })
        .from(contextAuthoringCommands)
        .where(inArray(contextAuthoringCommands.contextPackageId, list)),
    ])
    return new Set(
      [...plans, ...commands]
        .map((row) => row.contextPackageId)
        .filter((value): value is string => typeof value === 'string')
    )
  }
}
