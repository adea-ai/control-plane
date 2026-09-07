import {
  ExecutionLifecycleError,
  ExecutionStateSchema,
  type Execution,
  type ExecutionAttempt,
  type ExecutionLifecycleService,
} from '@control-plane/domain'
import type { ExecutionPlan, ExecutionPlanRepository } from '@control-plane/execution-plan'
import type { ExecutionWorkflowInput } from '@control-plane/orchestration'
import type { GraphSegmentActivityPort } from './graph-segment-activity.js'
import type {
  ExecutionLifecycleActivities,
  WorkflowInteractionResponse,
  WorkflowRuntimeOutcome,
} from './execution-workflow.js'

export interface WorkflowRuntimeActivityPort {
  dispatch(input: {
    readonly executionId: string
    readonly attemptId: string
    readonly executionPlan: ExecutionPlan
    readonly marketplacePluginReferences?: ExecutionWorkflowInput['marketplacePluginReferences']
    readonly effectKey: string
  }): Promise<WorkflowRuntimeOutcome>
  applyInteraction(
    input: WorkflowInteractionResponse & {
      readonly executionId: string
      readonly attemptId: string
      readonly effectKey: string
    }
  ): Promise<WorkflowRuntimeOutcome>
  cancel(input: {
    readonly executionId: string
    readonly attemptId: string
    readonly effectKey: string
    readonly reason: 'user_request' | 'deadline'
  }): Promise<void>
  cleanup(input: {
    readonly executionId: string
    readonly attemptId?: string
    readonly effectKey: string
  }): Promise<void>
}

export interface RuntimeAttemptRouter {
  resolve(input: {
    readonly execution: Execution
    readonly executionPlan: ExecutionPlan
  }): Promise<ExecutionAttempt['runtime']>
}

export interface DurableExecutionLifecycleActivitiesOptions {
  readonly lifecycle: ExecutionLifecycleService
  readonly plans: ExecutionPlanRepository
  readonly runtime: WorkflowRuntimeActivityPort
  readonly graph: GraphSegmentActivityPort
  readonly commands: ExecutionCommandLifecyclePort
  readonly runtimeRouter?: RuntimeAttemptRouter
  readonly now?: () => string
}

export interface ExecutionCommandLifecyclePort {
  transitionExecutionCommand(input: {
    readonly executionId: string
    readonly to: 'completed' | 'failed'
    readonly transitionedAt: string
    readonly resultReference?: string
    readonly errorReference?: string
  }): Promise<unknown>
}

export class DurableExecutionLifecycleActivities implements ExecutionLifecycleActivities {
  readonly #lifecycle: ExecutionLifecycleService
  readonly #plans: ExecutionPlanRepository
  readonly #runtime: WorkflowRuntimeActivityPort
  readonly #graph: GraphSegmentActivityPort
  readonly #commands: ExecutionCommandLifecyclePort
  readonly #runtimeRouter: RuntimeAttemptRouter | undefined
  readonly #now: () => string

  constructor(options: DurableExecutionLifecycleActivitiesOptions) {
    this.#lifecycle = options.lifecycle
    this.#plans = options.plans
    this.#runtime = options.runtime
    this.#graph = options.graph
    this.#commands = options.commands
    this.#runtimeRouter = options.runtimeRouter
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async ensureAttempt(input: {
    executionId: string
    workflowId: string
    effectKey: string
  }): Promise<{ attemptId: string }> {
    const attemptId = attemptIdFromExecutionId(input.executionId)
    const execution = await this.#lifecycle.getExecution(input.executionId)
    const current = await this.#existingAttempt(execution, attemptId)
    if (current !== undefined) return { attemptId: current.attemptId }
    const runtime = await this.#resolveRuntime(execution)
    try {
      const attempt = await this.#lifecycle.createAttempt({
        executionId: execution.executionId,
        attemptId,
        expectedExecutionVersion: execution.version,
        queuedAt: timestampAfter(this.#now(), execution.updatedAt),
        deadlineAt: execution.deadlineAt,
        ...(runtime === undefined ? {} : { runtime }),
      })
      return { attemptId: attempt.attemptId }
    } catch (error) {
      if (
        error instanceof ExecutionLifecycleError &&
        ['STALE_EXECUTION_VERSION', 'ATTEMPT_EXISTS_OR_STALE_EXECUTION'].includes(error.code)
      ) {
        const latest = await this.#lifecycle.getExecution(input.executionId)
        const replay = await this.#existingAttempt(latest, attemptId)
        if (replay !== undefined) return { attemptId: replay.attemptId }
      }
      throw error
    }
  }

  async #resolveRuntime(execution: Execution): Promise<ExecutionAttempt['runtime']> {
    if (this.#runtimeRouter === undefined) return undefined
    const executionPlan = await this.#plans.get(execution.executionPlan)
    if (executionPlan === undefined) throw new Error('WORKFLOW_EXECUTION_PLAN_MISSING')
    return this.#runtimeRouter.resolve({ execution, executionPlan })
  }

  async persistStatus(input: {
    executionId: string
    attemptId?: string
    state: string
    effectKey: string
    failure?: { classification: string; code: string }
    resultReference?: string
  }): Promise<void> {
    const state = ExecutionStateSchema.parse(input.state)
    if (state === 'completed' && input.resultReference === undefined) {
      throw new Error('WORKFLOW_COMPLETION_RESULT_MISSING')
    }
    const metadata = {
      ...(input.failure === undefined ? {} : { failure: input.failure }),
      ...(input.resultReference === undefined ? {} : { terminalResultRef: input.resultReference }),
    }
    await this.#transitionExecution(input.executionId, state, metadata)
    if (input.attemptId !== undefined) {
      await this.#transitionAttempt(input.attemptId, state, metadata)
    }
    await this.#transitionCommand(input.executionId, state, input)
  }

  async dispatch(
    input: Parameters<ExecutionLifecycleActivities['dispatch']>[0]
  ): Promise<WorkflowRuntimeOutcome> {
    const execution = await this.#lifecycle.getExecution(input.executionId)
    if (
      execution.latestAttemptId !== input.attemptId ||
      execution.executionPlan.executionPlanId !== input.executionPlan.executionPlanId ||
      execution.executionPlan.contentDigest !== input.executionPlan.contentDigest ||
      execution.executionPlan.schemaVersion !== input.executionPlan.schemaVersion
    ) {
      throw new Error('WORKFLOW_EXECUTION_IDENTITY_MISMATCH')
    }
    const plan = await this.#plans.get(input.executionPlan)
    if (plan === undefined || plan.schemaVersion !== input.executionPlan.schemaVersion) {
      throw new Error('WORKFLOW_EXECUTION_PLAN_MISSING')
    }
    return this.#runtime.dispatch({ ...input, executionPlan: plan })
  }

  applyInteraction(
    input: Parameters<ExecutionLifecycleActivities['applyInteraction']>[0]
  ): Promise<WorkflowRuntimeOutcome> {
    return this.#runtime.applyInteraction(input)
  }

  runGraphSegment(input: Parameters<GraphSegmentActivityPort['runGraphSegment']>[0]) {
    return this.#graph.runGraphSegment(input)
  }

  resumeGraphSegment(input: Parameters<GraphSegmentActivityPort['resumeGraphSegment']>[0]) {
    return this.#graph.resumeGraphSegment(input)
  }

  continueGraphSegment(input: Parameters<GraphSegmentActivityPort['continueGraphSegment']>[0]) {
    return this.#graph.continueGraphSegment(input)
  }

  async cancelActive(
    input: Parameters<ExecutionLifecycleActivities['cancelActive']>[0]
  ): Promise<void> {
    if (input.graph !== undefined) {
      await this.#graph.cancelGraphSegment({
        executionId: input.executionId,
        attemptId: input.attemptId,
        workspaceId: input.graph.workspaceId,
        workflowId: input.workflowId,
        graph: input.graph.reference,
        threadId: input.graph.threadId,
        reason: input.reason,
        idempotencyKey: input.effectKey,
      })
      return
    }
    await this.#runtime.cancel(input)
  }

  cleanup(input: Parameters<ExecutionLifecycleActivities['cleanup']>[0]): Promise<void> {
    return this.#runtime.cleanup(input)
  }

  async #existingAttempt(
    execution: Execution,
    expectedAttemptId: string
  ): Promise<ExecutionAttempt | undefined> {
    if (execution.latestAttemptId === undefined) return undefined
    if (execution.latestAttemptId !== expectedAttemptId) {
      throw new Error('WORKFLOW_EXECUTION_ATTEMPT_CONFLICT')
    }
    const attempt = await this.#lifecycle.repository.getAttempt(expectedAttemptId)
    if (attempt === undefined) throw new Error('WORKFLOW_EXECUTION_ATTEMPT_MISSING')
    return attempt
  }

  async #transitionExecution(
    executionId: string,
    state: ReturnType<typeof ExecutionStateSchema.parse>,
    metadata: {
      readonly failure?: { readonly classification: string; readonly code: string }
      readonly terminalResultRef?: string
    }
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.#lifecycle.getExecution(executionId)
      if (current.state === state) {
        assertMatchingTerminalMetadata(current, metadata)
        return
      }
      try {
        await this.#lifecycle.transitionExecution({
          executionId,
          expectedVersion: current.version,
          to: state,
          transitionedAt: timestampAfter(this.#now(), current.updatedAt),
          ...metadata,
        })
        return
      } catch (error) {
        if (
          !(error instanceof ExecutionLifecycleError && error.code === 'STALE_EXECUTION_VERSION')
        ) {
          throw error
        }
      }
    }
    throw new Error('WORKFLOW_EXECUTION_TRANSITION_CONTENTION')
  }

  async #transitionAttempt(
    attemptId: string,
    state: ReturnType<typeof ExecutionStateSchema.parse>,
    metadata: {
      readonly failure?: { readonly classification: string; readonly code: string }
      readonly terminalResultRef?: string
    }
  ): Promise<void> {
    for (let update = 0; update < 3; update += 1) {
      const current = await this.#lifecycle.repository.getAttempt(attemptId)
      if (current === undefined) throw new Error('WORKFLOW_EXECUTION_ATTEMPT_MISSING')
      if (current.state === state) {
        assertMatchingTerminalMetadata(current, metadata)
        return
      }
      try {
        await this.#lifecycle.transitionAttempt({
          attemptId,
          expectedVersion: current.version,
          to: state,
          transitionedAt: timestampAfter(this.#now(), current.updatedAt),
          ...metadata,
        })
        return
      } catch (error) {
        if (!(error instanceof ExecutionLifecycleError && error.code === 'STALE_ATTEMPT_VERSION')) {
          throw error
        }
      }
    }
    throw new Error('WORKFLOW_ATTEMPT_TRANSITION_CONTENTION')
  }

  async #transitionCommand(
    executionId: string,
    state: ReturnType<typeof ExecutionStateSchema.parse>,
    input: {
      readonly failure?: { readonly code: string }
      readonly resultReference?: string
    }
  ): Promise<void> {
    if (!['completed', 'failed', 'cancelled', 'timed_out'].includes(state)) return
    const transitionedAt = this.#now()
    if (state === 'completed') {
      await this.#commands.transitionExecutionCommand({
        executionId,
        to: 'completed',
        transitionedAt,
        ...(input.resultReference === undefined ? {} : { resultReference: input.resultReference }),
      })
      return
    }
    const reason =
      state === 'failed' ? (input.failure?.code ?? 'RUNTIME_FAILED') : state.toUpperCase()
    await this.#commands.transitionExecutionCommand({
      executionId,
      to: 'failed',
      transitionedAt,
      errorReference: `execution://${state}/${executionId}/${encodeURIComponent(reason)}`,
    })
  }
}

function attemptIdFromExecutionId(executionId: string): string {
  if (!/^exe_[0-9A-HJKMNP-TV-Z]{26}$/.test(executionId)) {
    throw new Error('WORKFLOW_EXECUTION_ID_INVALID')
  }
  return `att_${executionId.slice(4)}`
}

function timestampAfter(now: string, previous: string): string {
  return new Date(Math.max(Date.parse(now), Date.parse(previous))).toISOString()
}

function assertMatchingTerminalMetadata(
  lifecycle: Execution | ExecutionAttempt,
  metadata: {
    readonly failure?: { readonly classification: string; readonly code: string }
    readonly terminalResultRef?: string
  }
): void {
  if (
    JSON.stringify(lifecycle.failure) !== JSON.stringify(metadata.failure) ||
    lifecycle.terminalResultRef !== metadata.terminalResultRef
  ) {
    throw new Error('WORKFLOW_TERMINAL_REPLAY_CONFLICT')
  }
}
