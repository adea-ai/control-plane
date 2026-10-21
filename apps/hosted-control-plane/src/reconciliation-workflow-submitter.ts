import type { ExecutionWorkflowDispatcher } from '@control-plane/control-api'
import { graphWorkflowInput } from '@control-plane/control-api'
import type { ExecutionPlanRepository } from '@control-plane/execution-plan'
import type { ExecutionWorkflowInput } from '@control-plane/orchestration'

/**
 * Reconciliation re-drives an accepted workflow from the execution record, which does not carry the
 * plan's graph. A submission without it is not the one acceptance made, and the retained-wake guard
 * correctly refuses it. This adds the graph from the retained plan, the same way acceptance does,
 * and nothing else: a missing plan or a plan without a graph is passed through unchanged, so the
 * wake guard still decides whether the submission is admissible.
 */
export function createRetainedGraphReconciliationSubmitter(options: {
  readonly plans: Pick<ExecutionPlanRepository, 'get'>
  readonly submitter: ExecutionWorkflowDispatcher
}): ExecutionWorkflowDispatcher {
  return {
    submit: async (input: ExecutionWorkflowInput) => {
      if (input.graph !== undefined) return options.submitter.submit(input)
      const plan = await options.plans.get(input.executionPlan)
      if (plan === undefined || plan.graph === undefined) return options.submitter.submit(input)
      return options.submitter.submit({
        ...input,
        ...graphWorkflowInput(plan, input.executionId),
      })
    },
  }
}
