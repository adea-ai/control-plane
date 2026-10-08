import { executionRetentionScopeFromRow } from './execution-scope.js'
import { isDeepStrictEqual } from 'node:util'
import {
  ExecutionPlanReferenceSchema,
  ExecutionPlanError,
  assertExecutionPlanIntegrity,
  type ExecutionPlan,
  type ExecutionPlanReference,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'
import {
  RetentionAssessmentCounter,
  evaluateRetentionEligibility,
  observeReferenceRetentionWindow,
  type RetentionDeletionResult,
  type RetentionJournalSink,
  type RetentionHoldPolicy,
} from '@control-plane/domain'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { commandInbox } from './schema/commands.js'
import { executionValidationCommands } from './schema/execution-validation-commands.js'
import { executionPlans } from './schema/execution-plans.js'
import { executions } from './schema/executions.js'
import { delegations } from './schema/delegations.js'
import { lockAndResetReferenceRetentionWindows } from './context-package-repository.js'
import {
  acquirePostgresRetentionHoldClassMutex,
  countPostgresMatchingActiveRetentionHolds,
  validatePostgresRetentionHoldPolicy,
} from './retention-hold-repository.js'

const RETRY_EXECUTION_PLAN_REFERENCE_PUT = Symbol('RETRY_EXECUTION_PLAN_REFERENCE_PUT')

export class PostgresExecutionPlanRepository implements ExecutionPlanRepository {
  constructor(readonly database: Pick<ControlPlaneDatabase, 'select' | 'insert' | 'transaction'>) {}

  async put(input: ExecutionPlan): Promise<ExecutionPlanReference> {
    return this.#put(input, false)
  }

  /** Persist a plan whose caller also creates a new durable reference to it. */
  async putForReference(input: ExecutionPlan): Promise<ExecutionPlanReference> {
    return this.#put(input, true)
  }

  async #put(input: ExecutionPlan, referenced: boolean): Promise<ExecutionPlanReference> {
    const plan = assertExecutionPlanIntegrity(input)
    const reference = {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
    }
    let retriedReferencePut = false
    for (;;) {
      try {
        return await this.database.transaction(async (transaction) => {
          const existing = await this.#getById(transaction, plan.executionPlanId)
          if (existing) {
            if (!isDeepStrictEqual(existing, plan)) throw new Error('EXECUTION_PLAN_ID_CONFLICT')
            if (referenced) {
              const claim = await lockAndResetReferenceRetentionWindows(transaction, {
                executionPlans: [reference],
              })
              if (!claim.ok) {
                throw new ExecutionPlanError(
                  claim.target === 'context-package'
                    ? 'MISSING_CONTEXT_PACKAGE'
                    : 'INVALID_REFERENCE',
                  claim.id
                )
              }
            }
            return reference
          }

          if (plan.parentExecutionPlan) {
            if (plan.parentExecutionPlan.executionPlanId === plan.executionPlanId) {
              throw new ExecutionPlanError('INVALID_REFERENCE', plan.executionPlanId)
            }
          }
          // Claim every existing ancestor in one globally ordered package-then-plan
          // transaction before publishing this new immutable plan.
          const claim = await lockAndResetReferenceRetentionWindows(transaction, {
            contextPackages: [plan.contextPackage],
            executionPlans: plan.parentExecutionPlan ? [plan.parentExecutionPlan] : [],
          })
          if (!claim.ok) {
            throw new ExecutionPlanError(
              claim.target === 'context-package' ? 'MISSING_CONTEXT_PACKAGE' : 'INVALID_REFERENCE',
              claim.id
            )
          }
          const inserted = await transaction
            .insert(executionPlans)
            .values(toRow(plan))
            .onConflictDoNothing()
            .returning({ executionPlanId: executionPlans.executionPlanId })
          if (inserted.length === 1) return reference

          const raced = await this.#getById(transaction, plan.executionPlanId)
          if (!raced || !isDeepStrictEqual(raced, plan)) {
            throw new Error('EXECUTION_PLAN_ID_CONFLICT')
          }
          if (referenced) throw RETRY_EXECUTION_PLAN_REFERENCE_PUT
          return reference
        })
      } catch (error) {
        if (error !== RETRY_EXECUTION_PLAN_REFERENCE_PUT) throw error
        if (retriedReferencePut) {
          throw new Error('EXECUTION_PLAN_REFERENCE_CONFLICT_RETRY_EXHAUSTED', { cause: error })
        }
        // Awaiting the transaction rejection completes the rollback/savepoint
        // before a retry reacquires references in the global lock order.
        retriedReferencePut = true
      }
    }
  }

  async get(input: ExecutionPlanReference): Promise<ExecutionPlan | undefined> {
    const reference = ExecutionPlanReferenceSchema.parse(input)
    const [row] = await this.database
      .select()
      .from(executionPlans)
      .where(
        and(
          eq(executionPlans.executionPlanId, reference.executionPlanId),
          eq(executionPlans.contentDigest, reference.contentDigest)
        )
      )
      .limit(1)
    return row ? fromPlanRow(row) : undefined
  }

  async #getById(
    database: Pick<ControlPlaneDatabase, 'select'>,
    executionPlanId: string
  ): Promise<ExecutionPlan | undefined> {
    const [row] = await database
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, executionPlanId))
      .limit(1)
    return row ? fromPlanRow(row) : undefined
  }
}

/** Lock and verify the exact plan row before a writer creates a plan reference. */
export async function lockExecutionPlanReference(
  database: Pick<ControlPlaneDatabase, 'select' | 'update'>,
  input: ExecutionPlanReference & { readonly schemaVersion?: number }
): Promise<boolean> {
  ExecutionPlanReferenceSchema.parse(input)
  return (await lockAndResetReferenceRetentionWindows(database, { executionPlans: [input] })).ok
}

function fromPlanRow(row: typeof executionPlans.$inferSelect): ExecutionPlan {
  const plan = assertExecutionPlanIntegrity(row.plan)
  if (
    row.executionPlanId !== plan.executionPlanId ||
    row.contentDigest !== plan.contentDigest ||
    row.schemaVersion !== plan.schemaVersion ||
    row.workspaceId !== plan.correlation.workspaceId ||
    row.projectId !== (plan.correlation.projectId ?? null) ||
    !isDeepStrictEqual(row.executionScope, plan.correlation.executionScope ?? null) ||
    row.taskId !== plan.correlation.taskId ||
    row.agentId !== plan.correlation.agentId ||
    row.compiledAt.toISOString() !== plan.compiledAt
  )
    throw new Error('EXECUTION_PLAN_PERSISTENCE_INTEGRITY_ERROR')
  return plan
}

function toRow(plan: ExecutionPlan): typeof executionPlans.$inferInsert {
  return {
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
    workspaceId: plan.correlation.workspaceId,
    projectId: plan.correlation.projectId ?? null,
    executionScope: plan.correlation.executionScope ?? null,
    taskId: plan.correlation.taskId,
    agentId: plan.correlation.agentId,
    plan,
    compiledAt: new Date(plan.compiledAt),
  }
}

/**
 * Retention deletion for execution plans (#194), beside the repository rather
 * than on it: the repository is constructed by its callers with a narrow
 * `select | insert` view while deletion needs `delete`.
 *
 * A plan is retained while anything pins it — the execution compiled from it,
 * the acceptance record that carried it, or a validation command that checked
 * it (the last is a foreign key, so the reference check is also the
 * foreign-key check). Plans are therefore freed bottom-up, after the executions
 * class has removed the executions that pinned them. The post-reference window
 * starts at the first bounded scan that proves the plan is unreferenced; the
 * delete is guarded by the content digest, so a replaced plan is reported as
 * `raced`.
 */
export class PostgresExecutionPlanRetention {
  constructor(readonly database: ControlPlaneDatabase) {}

  async deleteEligibleExecutionPlans(
    now: Date,
    options: {
      readonly policyRetainMs: number | null
      readonly bound?: number
      readonly dryRun?: boolean
      readonly journal?: RetentionJournalSink
      readonly afterId?: string
      readonly retentionHoldPolicy?: RetentionHoldPolicy
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('EXECUTION_PLAN_RETENTION_INVALID_TIMESTAMP')
    if (
      options.afterId !== undefined &&
      (options.afterId.length < 1 || options.afterId.length > 30)
    )
      throw new Error('EXECUTION_PLAN_RETENTION_INVALID_CURSOR')
    const assessedAt = now.toISOString()
    const dryRun = options.dryRun ?? true
    const counter = new RetentionAssessmentCounter(
      'execution-plans',
      assessedAt,
      options.bound ?? 64
    )
    let deleted = 0
    let raced = 0
    const candidates = await this.database
      .select({
        executionPlanId: executionPlans.executionPlanId,
        contentDigest: executionPlans.contentDigest,
      })
      .from(executionPlans)
      .where(
        options.afterId === undefined
          ? undefined
          : gt(executionPlans.executionPlanId, options.afterId)
      )
      .orderBy(asc(executionPlans.executionPlanId))
      .limit(counter.bound + 1)
    const page = candidates.slice(0, counter.bound)
    await this.database.transaction((transaction) =>
      validatePostgresRetentionHoldPolicy(transaction, options.retentionHoldPolicy)
    )
    const truncated = candidates.length > page.length
    let scanned = 0
    for (const candidate of page) {
      scanned += 1
      const outcome = await this.database.transaction(async (transaction) => {
        await acquirePostgresRetentionHoldClassMutex(transaction, 'execution-plans')
        // The target lock serializes this fresh reference scan with writers,
        // which take the same lifetime lock before recording references.
        const [stored] = await transaction
          .select({
            contentDigest: executionPlans.contentDigest,
            unreferencedSince: executionPlans.unreferencedSince,
            workspaceId: executionPlans.workspaceId,
            projectId: executionPlans.projectId,
            executionScope: executionPlans.executionScope,
            plan: executionPlans.plan,
          })
          .from(executionPlans)
          .where(
            and(
              eq(executionPlans.executionPlanId, candidate.executionPlanId),
              eq(executionPlans.contentDigest, candidate.contentDigest)
            )
          )
          .limit(1)
          .for('update')
        if (!stored) return { verdict: undefined, removed: false, raced: true }
        const canonicalPlan = assertExecutionPlanIntegrity(stored.plan)
        if (
          canonicalPlan.executionPlanId !== candidate.executionPlanId ||
          canonicalPlan.contentDigest !== stored.contentDigest ||
          canonicalPlan.correlation.workspaceId !== stored.workspaceId ||
          (canonicalPlan.correlation.projectId ?? null) !== stored.projectId ||
          !isDeepStrictEqual(
            canonicalPlan.correlation.executionScope ?? null,
            stored.executionScope
          )
        ) {
          return { verdict: undefined, removed: false, raced: true }
        }
        const pendingReference = await this.#isReferencedPlan(
          transaction,
          candidate.executionPlanId
        )
        const holds = await countPostgresMatchingActiveRetentionHolds(
          transaction,
          {
            classId: 'execution-plans',
            scope: executionRetentionScopeFromRow(stored),
          },
          options.retentionHoldPolicy
        )
        const observation = observeReferenceRetentionWindow({
          now: assessedAt,
          unreferencedSince: stored.unreferencedSince?.toISOString() ?? null,
          pendingReferences: pendingReference ? 1 : 0,
          policyRetainMs: options.policyRetainMs,
        })
        const verdict =
          options.policyRetainMs !== null && pendingReference
            ? { verdict: 'retained' as const, reason: 'reference_pending' as const }
            : evaluateRetentionEligibility({
                retentionExpiresAt: observation.retentionExpiresAt,
                now: assessedAt,
                policyRetainMs: options.policyRetainMs,
                ownerTerminal: true,
                publicationSettled: true,
                rejectionKeyReserved: true,
                pendingReferences: pendingReference ? 1 : 0,
                holds,
              })
        if (
          !dryRun &&
          stored.unreferencedSince?.toISOString() !== (observation.unreferencedSince ?? null)
        ) {
          await transaction
            .update(executionPlans)
            .set({
              unreferencedSince:
                observation.unreferencedSince === null
                  ? null
                  : new Date(observation.unreferencedSince),
            })
            .where(
              and(
                eq(executionPlans.executionPlanId, candidate.executionPlanId),
                eq(executionPlans.contentDigest, candidate.contentDigest)
              )
            )
        }
        if (verdict.verdict !== 'eligible' || dryRun)
          return { verdict, removed: false, raced: false }
        if (options.journal !== undefined) {
          await options.journal([
            { kind: 'postgres.deleteExecutionPlan', executionPlanId: candidate.executionPlanId },
          ])
        }
        const removed = await transaction
          .delete(executionPlans)
          .where(
            and(
              eq(executionPlans.executionPlanId, candidate.executionPlanId),
              eq(executionPlans.contentDigest, candidate.contentDigest)
            )
          )
          .returning({ executionPlanId: executionPlans.executionPlanId })
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
        ? { nextAfterId: page[page.length - 1]!.executionPlanId }
        : {}),
    }
  }

  /** Fresh references read after locking the target, in the same claim transaction. */
  async #isReferencedPlan(
    transaction: Pick<ControlPlaneDatabase, 'select'>,
    executionPlanId: string
  ): Promise<boolean> {
    const [executionRow] = await transaction
      .select({ executionPlanId: executions.executionPlanId })
      .from(executions)
      .where(eq(executions.executionPlanId, executionPlanId))
      .limit(1)
    if (executionRow) return true
    const [commandRow] = await transaction
      .select({ executionPlanId: commandInbox.executionPlanId })
      .from(commandInbox)
      .where(eq(commandInbox.executionPlanId, executionPlanId))
      .limit(1)
    if (commandRow) return true
    const [validationRow] = await transaction
      .select({ executionPlanId: executionValidationCommands.executionPlanId })
      .from(executionValidationCommands)
      .where(eq(executionValidationCommands.executionPlanId, executionPlanId))
      .limit(1)
    if (validationRow) return true
    const [delegationRow] = await transaction
      .select({ delegationId: delegations.delegationId })
      .from(delegations)
      .where(
        sql`record->>'parentExecutionPlanId' = ${executionPlanId} or record->>'childExecutionPlanId' = ${executionPlanId}`
      )
      .limit(1)
    if (delegationRow) return true
    const [childPlan] = await transaction
      .select({ executionPlanId: executionPlans.executionPlanId })
      .from(executionPlans)
      .where(sql`plan->'parentExecutionPlan'->>'executionPlanId' = ${executionPlanId}`)
      .limit(1)
    return childPlan !== undefined
  }
}
