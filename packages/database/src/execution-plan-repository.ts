import { isDeepStrictEqual } from 'node:util'
import {
  ExecutionPlanReferenceSchema,
  assertExecutionPlanIntegrity,
  type ExecutionPlan,
  type ExecutionPlanReference,
  type ExecutionPlanRepository,
} from '@control-plane/execution-plan'
import { and, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { executionPlans } from './schema/execution-plans.js'

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
