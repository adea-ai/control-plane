import { isDeepStrictEqual } from 'node:util'
import {
  ExecutionValidationCommandRecordSchema,
  ExecutionValidationCommandScopeSchema,
  executionValidationCommandKey,
  assertExecutionPlanIntegrity,
  assertExecutionValidationCommandPlan,
  type ExecutionValidationCommandRecord,
  type ExecutionValidationCommandRepository,
  type ExecutionValidationCommandScope,
  type ExecutionPlan,
} from '@control-plane/execution-plan'
import { eq, sql } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.js'
import { executionValidationCommands } from './schema/execution-validation-commands.js'

export class PostgresExecutionValidationCommandRepository implements ExecutionValidationCommandRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

  get(
    input: ExecutionValidationCommandScope
  ): Promise<ExecutionValidationCommandRecord | undefined> {
    return read(this.database, ExecutionValidationCommandScopeSchema.parse(input))
  }

  commit(
    input: ExecutionValidationCommandRecord,
    planInput: ExecutionPlan
  ): Promise<ExecutionValidationCommandRecord> {
    const plan = assertExecutionPlanIntegrity(planInput)
    const record = assertExecutionValidationCommandPlan(input, plan)
    return this.database.transaction(async (transaction) => {
      const key = executionValidationCommandKey(record.scope)
      // Serialize competing candidates before either the command or plan is inserted.
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
      const existing = await read(transaction, record.scope)
      if (existing) {
        if (existing.payloadHash !== record.payloadHash)
          throw new Error('EXECUTION_VALIDATION_COMMAND_CONFLICT')
        return existing
      }
      await new PostgresExecutionPlanRepository(transaction).put(plan)
      await transaction.insert(executionValidationCommands).values({
        commandKey: key,
        workspaceId: record.scope.workspaceId,
        projectId: record.scope.projectId,
        executionPlanId: plan.executionPlanId,
        record,
      })
      return record
    })
  }
}

async function read(
  database: Pick<ControlPlaneDatabase, 'select' | 'insert'>,
  scope: ExecutionValidationCommandScope
): Promise<ExecutionValidationCommandRecord | undefined> {
  const [row] = await database
    .select()
    .from(executionValidationCommands)
    .where(eq(executionValidationCommands.commandKey, executionValidationCommandKey(scope)))
    .limit(1)
  if (!row) return undefined
  const record = ExecutionValidationCommandRecordSchema.parse(row.record)
  if (
    !isDeepStrictEqual(record.scope, scope) ||
    row.workspaceId !== scope.workspaceId ||
    row.projectId !== scope.projectId ||
    row.executionPlanId !== record.executionPlan.executionPlanId
  )
    throw new Error('EXECUTION_VALIDATION_COMMAND_SCOPE_MISMATCH')
  const plan = await new PostgresExecutionPlanRepository(database).get(record.executionPlan)
  if (!plan) throw new Error('EXECUTION_VALIDATION_COMMAND_PLAN_MISSING')
  return assertExecutionValidationCommandPlan(record, plan)
}
