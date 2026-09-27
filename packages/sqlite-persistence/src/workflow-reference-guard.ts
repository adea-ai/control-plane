import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { PersistenceTransaction } from '@control-plane/deployment'
import { ExecutionSchema } from '@control-plane/domain'
import { assertSqliteStoredPlanReference } from './repositories.js'

/** Local lifecycle-job admission; caller holds the same writer transaction as enqueue. */
export async function assertSqliteWorkflowExecutionReference(
  transaction: PersistenceTransaction,
  record: { readonly workflowKey: string; readonly input: unknown }
): Promise<void> {
  const input = record.input as {
    executionId?: unknown
    workflowId?: unknown
    executionPlan?: unknown
    marketplacePluginReferences?: unknown
  } | null
  const executionId = ExecutionSchema.shape.executionId.parse(input?.executionId)
  if (record.workflowKey !== executionId || input?.workflowId !== `wfl_${executionId.slice(4)}`)
    throw new Error('WORKFLOW_EXECUTION_REFERENCE_INVALID')
  const reference = ExecutionSchema.shape.executionPlan.parse(input.executionPlan)
  const stored = await transaction.get(
    'executions',
    `r-${createHash('sha256').update(executionId).digest('hex')}`
  )
  if (stored === undefined) throw new Error('WORKFLOW_EXECUTION_REFERENCE_INVALID')
  const execution = ExecutionSchema.parse(stored.value)
  if (
    execution.executionId !== executionId ||
    !isDeepStrictEqual(execution.executionPlan, reference) ||
    !isDeepStrictEqual(
      execution.marketplacePluginReferences,
      ExecutionSchema.shape.marketplacePluginReferences.parse(input.marketplacePluginReferences)
    )
  )
    throw new Error('WORKFLOW_EXECUTION_REFERENCE_INVALID')
  const plan = await assertSqliteStoredPlanReference(transaction, reference)
  for (const key of ['workspaceId', 'projectId', 'taskId', 'agentId'] as const)
    if (execution.correlation[key] !== plan.correlation[key])
      throw new Error('WORKFLOW_EXECUTION_REFERENCE_INVALID')
}
