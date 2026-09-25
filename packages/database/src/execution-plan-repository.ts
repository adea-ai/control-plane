import { isDeepStrictEqual } from 'node:util'
import {
  ExecutionPlanReferenceSchema,
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
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { commandInbox } from './schema/commands.js'
import { executionValidationCommands } from './schema/execution-validation-commands.js'
import { executionPlans } from './schema/execution-plans.js'
import { executions } from './schema/executions.js'

export class PostgresExecutionPlanRepository implements ExecutionPlanRepository {
  constructor(readonly database: Pick<ControlPlaneDatabase, 'select' | 'insert'>) {}

  async put(input: ExecutionPlan): Promise<ExecutionPlanReference> {
    const plan = assertExecutionPlanIntegrity(input)
    const reference = {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
    }
    const inserted = await this.database
      .insert(executionPlans)
      .values(toRow(plan))
      .onConflictDoNothing()
      .returning({ executionPlanId: executionPlans.executionPlanId })
    if (inserted.length === 1) return reference

    const existing = await this.#getById(plan.executionPlanId)
    if (!existing || !isDeepStrictEqual(existing, plan)) {
      throw new Error('EXECUTION_PLAN_ID_CONFLICT')
    }
    return reference
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

  async #getById(executionPlanId: string): Promise<ExecutionPlan | undefined> {
    const [row] = await this.database
      .select({ plan: executionPlans.plan })
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, executionPlanId))
      .limit(1)
    return row ? assertExecutionPlanIntegrity(row.plan) : undefined
  }
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
    const referenced = await this.#referencedPlans(
      candidates.map((candidate) => candidate.executionPlanId)
    )
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
        pendingReferences: referenced.has(candidate.executionPlanId) ? 1 : 0,
        holds: 0,
      })
      if (!counter.add(verdict)) break
      if (verdict.verdict !== 'eligible' || dryRun) continue
      if (options.journal !== undefined) {
        await options.journal([
          { kind: 'postgres.deleteExecutionPlan', executionPlanId: candidate.executionPlanId },
        ])
      }
      const removed = await this.database
        .delete(executionPlans)
        .where(
          and(
            eq(executionPlans.executionPlanId, candidate.executionPlanId),
            eq(executionPlans.contentDigest, candidate.contentDigest)
          )
        )
        .returning({ executionPlanId: executionPlans.executionPlanId })
      if (removed.length === 1) deleted += 1
      else raced += 1
    }
    return { dryRun, deleted, raced, ...counter.result() }
  }

  /** Plan ids among `ids` that an execution, acceptance record or validation pins. */
  async #referencedPlans(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const list = [...ids]
    const [executionRows, inboxRows, validationRows] = await Promise.all([
      this.database
        .select({ executionPlanId: executions.executionPlanId })
        .from(executions)
        .where(inArray(executions.executionPlanId, list)),
      this.database
        .select({ executionPlanId: commandInbox.executionPlanId })
        .from(commandInbox)
        .where(inArray(commandInbox.executionPlanId, list)),
      this.database
        .select({ executionPlanId: executionValidationCommands.executionPlanId })
        .from(executionValidationCommands)
        .where(inArray(executionValidationCommands.executionPlanId, list)),
    ])
    return new Set(
      [...executionRows, ...inboxRows, ...validationRows].map((row) => row.executionPlanId)
    )
  }
}
