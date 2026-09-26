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
  type RetentionDeletionResult,
  type RetentionJournalSink,
} from '@control-plane/domain'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { commandInbox } from './schema/commands.js'
import { executionValidationCommands } from './schema/execution-validation-commands.js'
import { executionPlans } from './schema/execution-plans.js'
import { executions } from './schema/executions.js'
import { delegations } from './schema/delegations.js'
import { lockContextPackageReference } from './context-package-repository.js'

export class PostgresExecutionPlanRepository implements ExecutionPlanRepository {
  constructor(readonly database: Pick<ControlPlaneDatabase, 'select' | 'insert' | 'transaction'>) {}

  async put(input: ExecutionPlan): Promise<ExecutionPlanReference> {
    const plan = assertExecutionPlanIntegrity(input)
    const reference = {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
    }
    return this.database.transaction(async (transaction) => {
      const existing = await this.#getById(transaction, plan.executionPlanId, true)
      if (existing) {
        if (!isDeepStrictEqual(existing, plan)) throw new Error('EXECUTION_PLAN_ID_CONFLICT')
        return reference
      }

      if (!(await lockContextPackageReference(transaction, plan.contextPackage))) {
        throw new ExecutionPlanError(
          'MISSING_CONTEXT_PACKAGE',
          plan.contextPackage.contextPackageId
        )
      }
      const inserted = await transaction
        .insert(executionPlans)
        .values(toRow(plan))
        .onConflictDoNothing()
        .returning({ executionPlanId: executionPlans.executionPlanId })
      if (inserted.length === 1) return reference

      const raced = await this.#getById(transaction, plan.executionPlanId, true)
      if (!raced || !isDeepStrictEqual(raced, plan)) {
        throw new Error('EXECUTION_PLAN_ID_CONFLICT')
      }
      return reference
    })
  }

  async get(input: ExecutionPlanReference): Promise<ExecutionPlan | undefined> {
    const reference = ExecutionPlanReferenceSchema.parse(input)
    const [row] = await this.database
      .select({ plan: executionPlans.plan })
      .from(executionPlans)
      .where(
        and(
          eq(executionPlans.executionPlanId, reference.executionPlanId),
          eq(executionPlans.contentDigest, reference.contentDigest)
        )
      )
      .limit(1)
    return row ? assertExecutionPlanIntegrity(row.plan) : undefined
  }

  async #getById(
    database: Pick<ControlPlaneDatabase, 'select'>,
    executionPlanId: string,
    lock = false
  ): Promise<ExecutionPlan | undefined> {
    const query = database
      .select({ plan: executionPlans.plan })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, executionPlanId))
      .limit(1)
    const [row] = lock ? await query.for('key share') : await query
    return row ? assertExecutionPlanIntegrity(row.plan) : undefined
  }
}

/** Lock and verify the exact plan row before a writer creates a plan reference. */
export async function lockExecutionPlanReference(
  database: Pick<ControlPlaneDatabase, 'select'>,
  input: ExecutionPlanReference & { readonly schemaVersion?: number }
): Promise<boolean> {
  const reference = ExecutionPlanReferenceSchema.parse(input)
  const [row] = await database
    .select({
      plan: executionPlans.plan,
      contentDigest: executionPlans.contentDigest,
      schemaVersion: executionPlans.schemaVersion,
    })
    .from(executionPlans)
    .where(eq(executionPlans.executionPlanId, reference.executionPlanId))
    .limit(1)
    .for('key share')
  if (!row) return false
  const plan = assertExecutionPlanIntegrity(row.plan)
  if (
    plan.executionPlanId !== reference.executionPlanId ||
    row.schemaVersion !== plan.schemaVersion ||
    (input.schemaVersion !== undefined && input.schemaVersion !== plan.schemaVersion) ||
    row.contentDigest !== reference.contentDigest ||
    plan.contentDigest !== reference.contentDigest
  )
    return false
  // Lock order is plan then context. Context retention locks only the context
  // target before its fresh plan-reference scan, so this ordering cannot cycle.
  return lockContextPackageReference(database, plan.contextPackage)
}

function toRow(plan: ExecutionPlan): typeof executionPlans.$inferInsert {
  return {
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
    workspaceId: plan.correlation.workspaceId,
    projectId: plan.correlation.projectId,
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
 * class has removed the executions that pinned them. Age runs from `compiledAt`
 * and the delete is guarded by the content digest, so a replaced plan is
 * reported as `raced`.
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
    }
  ): Promise<RetentionDeletionResult> {
    if (Number.isNaN(now.getTime())) throw new Error('EXECUTION_PLAN_RETENTION_INVALID_TIMESTAMP')
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
        compiledAt: executionPlans.compiledAt,
      })
      .from(executionPlans)
      .where(
        options.policyRetainMs === null
          ? sql`true`
          : lt(executionPlans.compiledAt, new Date(now.getTime() - options.policyRetainMs))
      )
      .orderBy(asc(executionPlans.compiledAt))
      .limit(counter.bound + 1)
    let admittedCandidates = 0
    for (const candidate of candidates) {
      if (admittedCandidates >= counter.bound) {
        counter.add({ verdict: 'eligible' })
        break
      }
      const outcome = await this.database.transaction(async (transaction) => {
        // Lock the target before reading references. New-reference writers take
        // KEY SHARE on this same row before inserting their reference.
        const [stored] = await transaction
          .select({
            contentDigest: executionPlans.contentDigest,
            compiledAt: executionPlans.compiledAt,
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
        const pendingReference = await this.#isReferencedPlan(
          transaction,
          candidate.executionPlanId
        )
        const verdict = evaluateRetentionEligibility({
          retentionExpiresAt:
            options.policyRetainMs === null
              ? undefined
              : new Date(stored.compiledAt.getTime() + options.policyRetainMs).toISOString(),
          now: assessedAt,
          policyRetainMs: options.policyRetainMs,
          ownerTerminal: true,
          publicationSettled: true,
          rejectionKeyReserved: true,
          pendingReferences: pendingReference ? 1 : 0,
          holds: 0,
        })
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
        admittedCandidates += 1
        if (!counter.add(outcome.verdict)) break
      }
      if (outcome.removed) deleted += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
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
    return delegationRow !== undefined
  }
}
