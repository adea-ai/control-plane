import type { ExecutionWorkflowInput } from '@control-plane/orchestration'
import { managedCloudOperationalPolicy } from '@control-plane/config'
import type { GraphActivityOutcome, GraphSegmentActivityPort } from './graph-segment-activity.js'

export const workflowPolicies = {
  version: 'execution-lifecycle-v1',
  graphSegmentVersion: 'execution-graph-segments-v1',
  taskQueue: 'control-plane.execution.v1',
  progressPersistence: 'postgres-execution-events',
  activities: {
    retry: {
      maximumAttempts: managedCloudOperationalPolicy.retry.maximumAttempts,
      initialInterval: `${managedCloudOperationalPolicy.retry.initialDelayMs / 1_000} seconds`,
      backoffCoefficient: managedCloudOperationalPolicy.retry.factor,
    },
    startToCloseTimeout: '2 minutes',
    heartbeatTimeout: '20 seconds',
  },
} as const

export interface ExecutionWorkflowResult {
  readonly executionId: string
  readonly attemptId?: string
  readonly status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
  readonly resultReference?: string
  readonly graphCheckpointId?: string
}

export interface ExecutionLifecycleActivities {
  ensureAttempt(input: {
    executionId: string
    workflowId: string
    effectKey: string
  }): Promise<{ attemptId: string }>
  persistStatus(input: {
    executionId: string
    attemptId?: string
    state: string
    effectKey: string
    failure?: { classification: string; code: string }
    resultReference?: string
  }): Promise<void>
  dispatch(input: {
    executionId: string
    attemptId: string
    executionPlan: ExecutionWorkflowInput['executionPlan']
    marketplacePluginReferences?: ExecutionWorkflowInput['marketplacePluginReferences']
    effectKey: string
  }): Promise<WorkflowRuntimeOutcome>
  applyInteraction(
    input: WorkflowInteractionResponse & {
      executionId: string
      attemptId: string
      effectKey: string
    }
  ): Promise<WorkflowRuntimeOutcome>
  runGraphSegment: GraphSegmentActivityPort['runGraphSegment']
  resumeGraphSegment: GraphSegmentActivityPort['resumeGraphSegment']
  continueGraphSegment: GraphSegmentActivityPort['continueGraphSegment']
  cancelActive(input: {
    executionId: string
    attemptId: string
    workflowId: string
    effectKey: string
    reason: 'user_request' | 'deadline'
    graph?: ExecutionWorkflowInput['graph']
  }): Promise<void>
  cleanup(input: { executionId: string; attemptId?: string; effectKey: string }): Promise<void>
}

export type TerminalControl = { readonly cancelled: true } | { readonly deadlineReached: true }

export type ActivityRaceResult<Value> =
  | { readonly type: 'activity'; readonly value: Value }
  | { readonly type: 'terminal'; readonly control: TerminalControl }

export interface WorkflowControl {
  readonly cancelled?: boolean
  readonly deadlineReached?: boolean
  readonly waitForInteraction?: (interactionId: string) => Promise<WorkflowInteractionResponse>
  readonly raceActivity?: <Value>(activity: Promise<Value>) => Promise<ActivityRaceResult<Value>>
  readonly checkTerminal?: () => Promise<TerminalControl | undefined>
}

export interface WorkflowInteractionResponse {
  readonly interactionId: string
  readonly responseId: string
  readonly action: 'approve' | 'deny' | 'input' | 'grant' | 'resume' | 'cancel'
  readonly value?: WorkflowInteractionValue
}

export type WorkflowInteractionValue =
  | null
  | boolean
  | number
  | string
  | readonly WorkflowInteractionValue[]
  | { readonly [key: string]: WorkflowInteractionValue }

export type WorkflowRuntimeOutcome =
  | { readonly outcome: 'completed'; readonly resultReference?: string }
  | { readonly outcome: 'failed'; readonly failureCode: string; readonly retryable: boolean }
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'awaiting_input'; readonly interactionId: string }
  | GraphActivityOutcome

export async function runExecutionLifecycle(
  input: ExecutionWorkflowInput,
  activities: ExecutionLifecycleActivities,
  control: WorkflowControl = {}
): Promise<ExecutionWorkflowResult> {
  const key = (operation: string) => `${input.workflowId}:${workflowPolicies.version}:${operation}`
  if (control.cancelled) {
    return finishTerminal(input, activities, { cancelled: true }, key)
  }
  if (control.deadlineReached) {
    return finishTerminal(input, activities, { deadlineReached: true }, key)
  }
  await activities.persistStatus({
    executionId: input.executionId,
    state: 'queued',
    effectKey: key('queued'),
  })
  const { attemptId } = await activities.ensureAttempt({
    executionId: input.executionId,
    workflowId: input.workflowId,
    effectKey: key('attempt'),
  })
  await activities.persistStatus({
    executionId: input.executionId,
    attemptId,
    state: 'starting',
    effectKey: key('starting'),
  })
  await activities.persistStatus({
    executionId: input.executionId,
    attemptId,
    state: 'running',
    effectKey: key('running'),
  })
  let runtimeOutcome: WorkflowRuntimeOutcome
  if (input.graph) {
    const raced = await raceActivity(
      activities.runGraphSegment({
        executionId: input.executionId,
        attemptId,
        workspaceId: input.graph.workspaceId,
        workflowId: input.workflowId,
        graph: input.graph.reference,
        threadId: input.graph.threadId,
        input: input.graph.input,
        idempotencyKey: key('graph:run'),
      }),
      control
    )
    if (raced.type === 'terminal') {
      return finishTerminal(input, activities, raced.control, key, attemptId)
    }
    runtimeOutcome = raced.value
  } else {
    const raced = await raceActivity(
      activities.dispatch({
        executionId: input.executionId,
        attemptId,
        executionPlan: input.executionPlan,
        ...(input.marketplacePluginReferences === undefined
          ? {}
          : { marketplacePluginReferences: input.marketplacePluginReferences }),
        effectKey: key('dispatch'),
      }),
      control
    )
    if (raced.type === 'terminal') {
      return finishTerminal(input, activities, raced.control, key, attemptId)
    }
    runtimeOutcome = raced.value
  }
  while (runtimeOutcome.outcome === 'awaiting_input' || runtimeOutcome.outcome === 'continue') {
    if (runtimeOutcome.outcome === 'continue') {
      if (!input.graph) throw new Error('GRAPH_INPUT_REQUIRED')
      const raced = await raceActivity(
        activities.continueGraphSegment({
          executionId: input.executionId,
          attemptId,
          workspaceId: input.graph.workspaceId,
          workflowId: input.workflowId,
          graph: input.graph.reference,
          threadId: input.graph.threadId,
          checkpointId: runtimeOutcome.checkpointId,
          idempotencyKey: key(`graph:continue:${runtimeOutcome.checkpointId}`),
        }),
        control
      )
      if (raced.type === 'terminal') {
        return finishTerminal(input, activities, raced.control, key, attemptId)
      }
      runtimeOutcome = raced.value
      continue
    }
    const interactionId = runtimeOutcome.interactionId
    await activities.persistStatus({
      executionId: input.executionId,
      attemptId,
      state: 'awaiting_input',
      effectKey: key(`awaiting-input:${interactionId}`),
    })
    if (!control.waitForInteraction) throw new Error('INTERACTION_WAITER_REQUIRED')
    const raced = await raceActivity(control.waitForInteraction(interactionId), control)
    if (raced.type === 'terminal') {
      return finishTerminal(input, activities, raced.control, key, attemptId)
    }
    const response = raced.value
    if (response.interactionId !== interactionId) throw new Error('INTERACTION_SIGNAL_MISMATCH')
    validateInteractionResponse(response)
    if (input.graph) {
      if (!('checkpointId' in runtimeOutcome)) throw new Error('GRAPH_RESUME_ACTIVITY_REQUIRED')
      const raced = await raceActivity(
        activities.resumeGraphSegment({
          executionId: input.executionId,
          attemptId,
          workspaceId: input.graph.workspaceId,
          workflowId: input.workflowId,
          graph: input.graph.reference,
          threadId: input.graph.threadId,
          checkpointId: runtimeOutcome.checkpointId,
          response: { action: response.action, responseId: response.responseId },
          idempotencyKey: key(`graph:resume:${interactionId}:${response.responseId}`),
        }),
        control
      )
      if (raced.type === 'terminal') {
        return finishTerminal(input, activities, raced.control, key, attemptId)
      }
      runtimeOutcome = raced.value
    } else {
      const raced = await raceActivity(
        activities.applyInteraction({
          executionId: input.executionId,
          attemptId,
          ...response,
          effectKey: key(`interaction:${interactionId}:${response.responseId}`),
        }),
        control
      )
      if (raced.type === 'terminal') {
        return finishTerminal(input, activities, raced.control, key, attemptId)
      }
      runtimeOutcome = raced.value
    }
  }
  const terminal = await control.checkTerminal?.()
  if (terminal !== undefined) {
    return finishTerminal(input, activities, terminal, key, attemptId)
  }
  const status = runtimeOutcome.outcome
  await activities.persistStatus({
    executionId: input.executionId,
    attemptId,
    state: status,
    effectKey: key(status),
    ...(status === 'failed'
      ? {
          failure: {
            classification: 'runtime_error',
            code: 'failureCode' in runtimeOutcome ? runtimeOutcome.failureCode : 'RUNTIME_FAILED',
          },
        }
      : {}),
    ...('resultReference' in runtimeOutcome && runtimeOutcome.resultReference
      ? { resultReference: runtimeOutcome.resultReference }
      : {}),
  })
  await activities.cleanup({ executionId: input.executionId, attemptId, effectKey: key('cleanup') })
  return {
    executionId: input.executionId,
    attemptId,
    status,
    ...('resultReference' in runtimeOutcome && runtimeOutcome.resultReference
      ? { resultReference: runtimeOutcome.resultReference }
      : {}),
    ...('checkpointId' in runtimeOutcome && runtimeOutcome.checkpointId
      ? { graphCheckpointId: runtimeOutcome.checkpointId }
      : {}),
  }
}

async function raceActivity<Value>(
  activity: Promise<Value>,
  control: WorkflowControl
): Promise<ActivityRaceResult<Value>> {
  if (control.raceActivity !== undefined) return control.raceActivity(activity)
  return { type: 'activity', value: await activity }
}

async function finishTerminal(
  input: ExecutionWorkflowInput,
  activities: ExecutionLifecycleActivities,
  control: TerminalControl,
  key: (operation: string) => string,
  attemptId?: string
): Promise<ExecutionWorkflowResult> {
  const status = 'cancelled' in control ? 'cancelled' : 'timed_out'
  if (attemptId !== undefined) {
    await activities.cancelActive({
      executionId: input.executionId,
      attemptId,
      workflowId: input.workflowId,
      effectKey: key(`cancel-active:${status}`),
      reason: status === 'cancelled' ? 'user_request' : 'deadline',
      ...(input.graph === undefined ? {} : { graph: input.graph }),
    })
  }
  await activities.persistStatus({
    executionId: input.executionId,
    ...(attemptId === undefined ? {} : { attemptId }),
    state: status,
    effectKey: key(status),
  })
  await activities.cleanup({
    executionId: input.executionId,
    ...(attemptId === undefined ? {} : { attemptId }),
    effectKey: key('cleanup'),
  })
  return {
    executionId: input.executionId,
    ...(attemptId === undefined ? {} : { attemptId }),
    status,
  }
}

export function validateInteractionResponse(response: WorkflowInteractionResponse): void {
  if ((response.action === 'input') !== (response.value !== undefined)) {
    throw new Error('INTERACTION_SIGNAL_VALUE_INVALID')
  }
  if (response.value === undefined) return
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(response.value)
  } catch {
    throw new Error('INTERACTION_SIGNAL_VALUE_INVALID')
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > 8_192) {
    throw new Error('INTERACTION_SIGNAL_VALUE_INVALID')
  }
}
