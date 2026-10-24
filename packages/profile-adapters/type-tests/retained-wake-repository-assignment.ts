import type { CommandAcceptanceRepository, ExecutionRepository } from '@control-plane/domain'
import type { ExecutionPlanRepository } from '@control-plane/execution-plan'
import type { RetainedProfileWorkflowWakeRecords } from '../src/wake.js'

declare const commands: CommandAcceptanceRepository
declare const executions: ExecutionRepository
declare const plans: ExecutionPlanRepository

// Keep this assignment compiled with exactOptionalPropertyTypes enabled. The
// production repositories expose Zod output types whose optional keys may be
// explicitly undefined, so this guards the real adapters against drifting
// from their persisted repository contracts.
export const retainedWakeRecords: RetainedProfileWorkflowWakeRecords = {
  commands,
  executions,
  plans,
}
