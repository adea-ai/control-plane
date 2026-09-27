import { isDeepStrictEqual } from 'node:util'
import {
  ContextCompilationError,
  ContextPackageReferenceSchema,
  assertContextPackageIntegrity,
  type ContextPackage,
  type ContextPackageReference,
  type ContextPackageRepository,
} from '@control-plane/context'
import {
  ExecutionPlanReferenceSchema,
  assertExecutionPlanIntegrity,
  type ExecutionPlan,
  type ExecutionPlanReference,
} from '@control-plane/execution-plan'
import { compareCodePointOrder } from '@control-plane/contracts'
import {
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  observeReferenceRetentionWindow,
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import { and, asc, eq, gt, isNotNull, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { contextAuthoringCommands } from './schema/context-authoring-commands.js'
import { contextPackages } from './schema/context-packages.js'
import { delegations } from './schema/delegations.js'
import { executionPlans } from './schema/execution-plans.js'

export class PostgresContextPackageRepository implements ContextPackageRepository {
  constructor(readonly database: Pick<ControlPlaneDatabase, 'select' | 'insert' | 'transaction'>) {}

  async put(input: ContextPackage): Promise<ContextPackageReference> {
    return this.#put(input, false)
  }

  /** Create a package and a new authoring/reference record in one transaction. */
  async putForReference(input: ContextPackage): Promise<ContextPackageReference> {
    return this.#put(input, true)
  }

  async #put(input: ContextPackage, referenced: boolean): Promise<ContextPackageReference> {
    const package_ = assertContextPackageIntegrity(input)
    const reference = {
      contextPackageId: package_.contextPackageId,
      contentDigest: package_.contentDigest,
    }
    return this.database.transaction(async (transaction) => {
      const existing = await this.#getById(transaction, package_.contextPackageId, true)
      if (existing) {
        if (!isDeepStrictEqual(existing, package_)) throw new Error('CONTEXT_PACKAGE_ID_CONFLICT')
        if (
          referenced &&
          !(
            await lockAndResetReferenceRetentionWindows(transaction, {
              contextPackages: [reference],
            })
          ).ok
        ) {
          throw new ContextCompilationError(
            'CONTRADICTORY_CONTEXT_REFERENCE',
            package_.contextPackageId
          )
        }
        return reference
      }

      if (package_.parentContextPackage) {
        if (package_.parentContextPackage.contextPackageId === package_.contextPackageId) {
          throw new ContextCompilationError(
            'CONTRADICTORY_CONTEXT_REFERENCE',
            package_.contextPackageId
          )
        }
        const claim = await lockAndResetReferenceRetentionWindows(transaction, {
          contextPackages: [package_.parentContextPackage],
        })
        if (!claim.ok) {
          throw new ContextCompilationError(
            'CONTRADICTORY_CONTEXT_REFERENCE',
            package_.parentContextPackage.contextPackageId
          )
        }
      }

      const inserted = await transaction
        .insert(contextPackages)
        .values(toRow(package_))
        .onConflictDoNothing()
        .returning({ contextPackageId: contextPackages.contextPackageId })
      if (inserted.length === 1) return reference

      const raced = await this.#getById(transaction, package_.contextPackageId, true)
      if (!raced || !isDeepStrictEqual(raced, package_)) {
        throw new Error('CONTEXT_PACKAGE_ID_CONFLICT')
      }
      if (
        referenced &&
        !(
          await lockAndResetReferenceRetentionWindows(transaction, {
            contextPackages: [reference],
          })
        ).ok
      ) {
        throw new ContextCompilationError(
          'CONTRADICTORY_CONTEXT_REFERENCE',
          package_.contextPackageId
        )
      }
      return reference
    })
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
    return this.#getById(this.database, contextPackageId)
  }

  async #getById(
    database: Pick<ControlPlaneDatabase, 'select'>,
    contextPackageId: string,
    lock = false
  ): Promise<ContextPackage | undefined> {
    const query = database
      .select()
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, contextPackageId))
      .limit(1)
    const [row] = lock ? await query.for('update') : await query
    return row ? fromRow(row) : undefined
  }
}

export type ReferenceRetentionClaim =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly target: 'context-package' | 'execution-plan'
      readonly id: string
    }

/**
 * Lock and verify a set of references in the global package-before-plan order,
 * then clear their observation clocks in that same order. Plan rows are first
 * read without locks solely to discover their context pins; the exact rows are
 * revalidated after the sorted locks are held.
 */
export async function lockAndResetReferenceRetentionWindows(
  database: Pick<ControlPlaneDatabase, 'select' | 'update'>,
  input: {
    readonly contextPackages?: readonly ContextPackageReference[]
    readonly executionPlans?: readonly (ExecutionPlanReference & {
      readonly schemaVersion?: number
    })[]
  }
): Promise<ReferenceRetentionClaim> {
  const contextReferences = new Map<string, ContextPackageReference>()
  const planReferences = new Map<
    string,
    ExecutionPlanReference & { readonly schemaVersion?: number }
  >()
  const addContext = (reference: ContextPackageReference): ReferenceRetentionClaim | undefined => {
    const parsed = ContextPackageReferenceSchema.parse(reference)
    const previous = contextReferences.get(parsed.contextPackageId)
    if (previous && previous.contentDigest !== parsed.contentDigest)
      return { ok: false, target: 'context-package', id: parsed.contextPackageId }
    contextReferences.set(parsed.contextPackageId, parsed)
    return undefined
  }
  for (const reference of input.contextPackages ?? []) {
    const conflict = addContext(reference)
    if (conflict) return conflict
  }
  for (const inputReference of input.executionPlans ?? []) {
    const reference = ExecutionPlanReferenceSchema.parse(inputReference)
    const parsed = {
      ...reference,
      ...(inputReference.schemaVersion === undefined
        ? {}
        : { schemaVersion: inputReference.schemaVersion }),
    }
    const previous = planReferences.get(parsed.executionPlanId)
    if (
      previous &&
      (previous.contentDigest !== parsed.contentDigest ||
        (previous.schemaVersion !== undefined &&
          parsed.schemaVersion !== undefined &&
          previous.schemaVersion !== parsed.schemaVersion))
    )
      return { ok: false, target: 'execution-plan', id: parsed.executionPlanId }
    const schemaVersion = parsed.schemaVersion ?? previous?.schemaVersion
    planReferences.set(
      parsed.executionPlanId,
      schemaVersion === undefined ? parsed : { ...parsed, schemaVersion }
    )
  }

  const planIds = [...planReferences.keys()].toSorted(compareCodePointOrder)
  const snapshots = new Map<
    string,
    {
      readonly plan: ExecutionPlan
      readonly contentDigest: string
      readonly schemaVersion: number
      readonly workspaceId: string
      readonly projectId: string
      readonly taskId: string
      readonly agentId: string
      readonly compiledAt: Date
    }
  >()
  for (const executionPlanId of planIds) {
    const [row] = await database
      .select({
        plan: executionPlans.plan,
        contentDigest: executionPlans.contentDigest,
        schemaVersion: executionPlans.schemaVersion,
        workspaceId: executionPlans.workspaceId,
        projectId: executionPlans.projectId,
        taskId: executionPlans.taskId,
        agentId: executionPlans.agentId,
        compiledAt: executionPlans.compiledAt,
      })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, executionPlanId))
      .limit(1)
    const reference = planReferences.get(executionPlanId)!
    if (!row) return { ok: false, target: 'execution-plan', id: executionPlanId }
    const plan = assertExecutionPlanIntegrity(row.plan)
    if (
      plan.executionPlanId !== executionPlanId ||
      plan.contentDigest !== reference.contentDigest ||
      row.contentDigest !== reference.contentDigest ||
      row.schemaVersion !== plan.schemaVersion ||
      (reference.schemaVersion !== undefined && reference.schemaVersion !== plan.schemaVersion) ||
      row.workspaceId !== plan.correlation.workspaceId ||
      row.projectId !== plan.correlation.projectId ||
      row.taskId !== plan.correlation.taskId ||
      row.agentId !== plan.correlation.agentId ||
      row.compiledAt.toISOString() !== plan.compiledAt
    ) {
      return { ok: false, target: 'execution-plan', id: executionPlanId }
    }
    snapshots.set(executionPlanId, row)
    const conflict = addContext(plan.contextPackage)
    if (conflict) return conflict
  }

  const lockedContexts: Array<{
    readonly contextPackageId: string
    readonly contentDigest: string
  }> = []
  for (const contextPackageId of [...contextReferences.keys()].toSorted(compareCodePointOrder)) {
    const [row] = await database
      .select()
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, contextPackageId))
      .limit(1)
      .for('update')
    const reference = contextReferences.get(contextPackageId)!
    if (!row) return { ok: false, target: 'context-package', id: contextPackageId }
    const package_ = fromRow(row)
    if (
      row.contentDigest !== reference.contentDigest ||
      package_.contentDigest !== reference.contentDigest
    ) {
      return { ok: false, target: 'context-package', id: contextPackageId }
    }
    lockedContexts.push(reference)
  }

  const lockedPlans: Array<{ readonly executionPlanId: string; readonly contentDigest: string }> =
    []
  for (const executionPlanId of planIds) {
    const [row] = await database
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, executionPlanId))
      .limit(1)
      .for('update')
    const snapshot = snapshots.get(executionPlanId)!
    const plan = row ? assertExecutionPlanIntegrity(row.plan) : undefined
    if (
      !row ||
      !plan ||
      !isDeepStrictEqual(row.plan, snapshot.plan) ||
      row.contentDigest !== snapshot.contentDigest ||
      row.schemaVersion !== snapshot.schemaVersion ||
      row.workspaceId !== snapshot.workspaceId ||
      row.projectId !== snapshot.projectId ||
      row.taskId !== snapshot.taskId ||
      row.agentId !== snapshot.agentId ||
      row.compiledAt.getTime() !== snapshot.compiledAt.getTime()
    ) {
      return { ok: false, target: 'execution-plan', id: executionPlanId }
    }
    lockedPlans.push({
      executionPlanId,
      contentDigest: plan.contentDigest,
    })
  }

  // All validation precedes mutation. Keep the writes in the same global
  // order as acquisition so multi-reference writers cannot deadlock by target.
  for (const reference of lockedContexts) {
    await database
      .update(contextPackages)
      .set({ unreferencedSince: null })
      .where(
        and(
          eq(contextPackages.contextPackageId, reference.contextPackageId),
          eq(contextPackages.contentDigest, reference.contentDigest),
          isNotNull(contextPackages.unreferencedSince)
        )
      )
  }
  for (const reference of lockedPlans) {
    await database
      .update(executionPlans)
      .set({ unreferencedSince: null })
      .where(
        and(
          eq(executionPlans.executionPlanId, reference.executionPlanId),
          eq(executionPlans.contentDigest, reference.contentDigest),
          isNotNull(executionPlans.unreferencedSince)
        )
      )
  }
  return { ok: true }
}

/** Lock and verify the exact package row before a writer creates a package reference. */
export async function lockContextPackageReference(
  database: Pick<ControlPlaneDatabase, 'select' | 'update'>,
  input: ContextPackageReference
): Promise<boolean> {
  return (await lockAndResetReferenceRetentionWindows(database, { contextPackages: [input] })).ok
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
   * Deletes context packages past their post-reference retention window (#194).
   * A package is pinned by an execution plan, an authoring command, a child
   * package, or a delegation. The first pass that proves there are no such
   * references starts the full policy window; it never substitutes compiledAt
   * for an unobserved release time. Scans use lexicographic ID cursors so young
   * and newly compiled packages cannot starve older rows. Dry run is read-only.
   */
  async deleteEligibleContextPackages(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
      readonly afterId?: string
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('CONTEXT_PACKAGE_RETENTION_INVALID_TIMESTAMP')
    if (
      options.afterId !== undefined &&
      (options.afterId.length < 1 || options.afterId.length > 30)
    )
      throw new Error('CONTEXT_PACKAGE_RETENTION_INVALID_CURSOR')
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
      })
      .from(contextPackages)
      .where(
        options.afterId === undefined
          ? undefined
          : gt(contextPackages.contextPackageId, options.afterId)
      )
      .orderBy(asc(contextPackages.contextPackageId))
      .limit(counter.bound + 1)
    const page = candidates.slice(0, counter.bound)
    const truncated = candidates.length > page.length
    let scanned = 0
    for (const candidate of page) {
      scanned += 1
      const outcome = await this.database.transaction(async (transaction) => {
        // New-reference writers take the same FOR UPDATE lifetime claim before
        // inserting a reference or clearing its observation clock.
        const [stored] = await transaction
          .select({
            contentDigest: contextPackages.contentDigest,
            unreferencedSince: contextPackages.unreferencedSince,
          })
          .from(contextPackages)
          .where(
            and(
              eq(contextPackages.contextPackageId, candidate.contextPackageId),
              eq(contextPackages.contentDigest, candidate.contentDigest)
            )
          )
          .limit(1)
          .for('update')
        if (!stored) return { verdict: undefined, removed: false, raced: true }

        const [planPin] = await transaction
          .select({ contextPackageId: sql<string>`plan->'contextPackage'->>'contextPackageId'` })
          .from(executionPlans)
          .where(sql`plan->'contextPackage'->>'contextPackageId' = ${candidate.contextPackageId}`)
          .limit(1)
        const [childPackagePin] = await transaction
          .select({ contextPackageId: contextPackages.contextPackageId })
          .from(contextPackages)
          .where(
            sql`context_package->'parentContextPackage'->>'contextPackageId' = ${candidate.contextPackageId}`
          )
          .limit(1)
        const [authoringCommand] = await transaction
          .select({ contextPackageId: contextAuthoringCommands.contextPackageId })
          .from(contextAuthoringCommands)
          .where(eq(contextAuthoringCommands.contextPackageId, candidate.contextPackageId))
          .limit(1)
        const [delegation] = await transaction
          .select({ delegationId: delegations.delegationId })
          .from(delegations)
          .where(sql`record->>'contextPackageId' = ${candidate.contextPackageId}`)
          .limit(1)
        const pendingReferences =
          planPin !== undefined ||
          childPackagePin !== undefined ||
          authoringCommand !== undefined ||
          delegation !== undefined
            ? 1
            : 0
        const observation = observeReferenceRetentionWindow({
          now: assessedAt,
          unreferencedSince: stored.unreferencedSince?.toISOString() ?? null,
          pendingReferences,
          policyRetainMs: options.policyRetainMs,
        })
        const verdict =
          options.policyRetainMs !== null && pendingReferences > 0
            ? { verdict: 'retained' as const, reason: 'reference_pending' as const }
            : evaluateRetentionEligibility({
                retentionExpiresAt: observation.retentionExpiresAt,
                now: assessedAt,
                policyRetainMs: options.policyRetainMs,
                ownerTerminal: true,
                publicationSettled: true,
                rejectionKeyReserved: true,
                pendingReferences,
                holds: 0,
              })
        if (
          !dryRun &&
          stored.unreferencedSince?.toISOString() !== (observation.unreferencedSince ?? null)
        ) {
          await transaction
            .update(contextPackages)
            .set({
              unreferencedSince:
                observation.unreferencedSince === null
                  ? null
                  : new Date(observation.unreferencedSince),
            })
            .where(
              and(
                eq(contextPackages.contextPackageId, candidate.contextPackageId),
                eq(contextPackages.contentDigest, candidate.contentDigest)
              )
            )
        }
        if (verdict.verdict !== 'eligible' || dryRun)
          return { verdict, removed: false, raced: false }
        if (options.journal !== undefined) {
          await options.journal([
            {
              kind: 'postgres.deleteContextPackage',
              contextPackageId: candidate.contextPackageId,
            },
          ])
        }
        const removed = await transaction
          .delete(contextPackages)
          .where(
            and(
              eq(contextPackages.contextPackageId, candidate.contextPackageId),
              eq(contextPackages.contentDigest, candidate.contentDigest)
            )
          )
          .returning({ contextPackageId: contextPackages.contextPackageId })
        return { verdict, removed: removed.length === 1, raced: removed.length !== 1 }
      })
      if (outcome.raced) raced += 1
      if (outcome.verdict !== undefined) {
        counter.add(outcome.verdict)
      }
      if (outcome.removed) deleted += 1
    }
    return {
      dryRun,
      deleted,
      raced,
      ...counter.result(),
      scanned,
      truncated,
      ...(truncated && page.length > 0
        ? { nextAfterId: page[page.length - 1]!.contextPackageId }
        : {}),
    }
  }
}
