import {
  CommandInboxService,
  ExecutionLifecycleService,
  ExecutionReconciliationService,
  InMemoryCommandAcceptanceRepository,
  InMemoryExecutionRepository,
  InMemoryInteractionRepository,
  InMemoryReconciliationCheckpointRepository,
  InteractionService,
} from '@control-plane/domain'
import {
  ExecutionEventDispatcher,
  ExecutionEventService,
  InMemoryExecutionEventRepository,
} from '@control-plane/events'
import { runExecutionLifecycle } from '../../apps/workflow-worker/src/execution-workflow.ts'
import { coreAcceptanceIds, createCoreDomainAcceptanceHarness } from './core-domain-acceptance.mjs'

export const durableExecutionIds = Object.freeze({
  executionId: 'exe_01KABCDEF0123456789ABCDEFG',
  attemptId: 'att_01KABCDEF0123456789ABCDEFG',
  workflowId: 'wfl_01KABCDEF0123456789ABCDEFG',
  interactionId: 'int_01KABCDEF0123456789ABCDEFG',
  responseId: 'cmd_01KABCDEF0123456789ABCDEFG',
  resultReference: 'art_01KABCDEF0123456789ABCDEFG',
})

const acceptedAt = '2026-08-24T16:00:00.000Z'
const deadlineAt = '2026-08-24T18:00:00.000Z'
const retentionExpiresAt = '2026-11-24T16:00:00.000Z'

export async function createDurableExecutionAcceptanceHarness({ interaction = true } = {}) {
  const core = await createCoreDomainAcceptanceHarness()
  const intent = await core.submitIntent()
  const commandRepository = new InMemoryCommandAcceptanceRepository()
  let planValidations = 0
  const commandService = new CommandInboxService({
    repository: commandRepository,
    executionIdFactory: () => durableExecutionIds.executionId,
    executionPlanValidator: {
      authorize: async () => true,
      validate: async ({ executionPlan }) => {
        planValidations += 1
        return (
          executionPlan.executionPlanId === intent.executionPlan.executionPlanId &&
          executionPlan.contentDigest === intent.executionPlan.contentDigest &&
          executionPlan.schemaVersion === intent.executionPlan.schemaVersion
        )
      },
    },
    now: () => acceptedAt,
  })
  const executionRepository = new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(executionRepository)
  const interactionRepository = new InMemoryInteractionRepository()
  const interactionService = new InteractionService(interactionRepository)
  const eventRepository = new InMemoryExecutionEventRepository()
  const eventService = new ExecutionEventService(eventRepository)
  const runtime = new DeterministicMockRuntimeAdapter({ interaction })
  const effectResults = new Map()
  let eventSequence = 0

  const commandInput = (overrides = {}) => ({
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId: coreAcceptanceIds.commandId,
    requestId: coreAcceptanceIds.requestId,
    idempotencyKey: 'm3-durable-execution-acceptance',
    payloadHash: '4'.repeat(64),
    correlation: {
      workspaceId: coreAcceptanceIds.workspaceId,
      projectId: coreAcceptanceIds.projectId,
      taskId: coreAcceptanceIds.taskId,
      agentId: coreAcceptanceIds.agentId,
    },
    executionPlan: {
      executionPlanId: intent.executionPlan.executionPlanId,
      contentDigest: intent.executionPlan.contentDigest,
      schemaVersion: intent.executionPlan.schemaVersion,
    },
    receivedAt: acceptedAt,
    retentionExpiresAt,
    deadlineAt,
    ...overrides,
  })

  const accept = async (overrides = {}) => {
    const result = await commandService.acceptExecution(commandInput(overrides))
    if (!result.replayed) await executionRepository.insertExecution(result.execution)
    return result
  }

  const appendStatusEvent = async ({ executionId, attemptId, state }) => {
    eventSequence += 1
    const occurredAt = new Date(Date.parse(acceptedAt) + eventSequence * 1_000).toISOString()
    return eventService.append({
      eventId: eventId(eventSequence),
      executionId,
      ...(attemptId ? { attemptId } : {}),
      workflowId: durableExecutionIds.workflowId,
      type: `execution.${state}`,
      schemaVersion: 1,
      correlation: {
        workspaceId: coreAcceptanceIds.workspaceId,
        projectId: coreAcceptanceIds.projectId,
        taskId: coreAcceptanceIds.taskId,
        agentId: coreAcceptanceIds.agentId,
        requestId: coreAcceptanceIds.requestId,
        commandId: coreAcceptanceIds.commandId,
        traceId: coreAcceptanceIds.traceId,
      },
      payload: {
        state,
        ...(state === 'completed' ? { resultReference: durableExecutionIds.resultReference } : {}),
      },
      occurredAt,
      recordedAt: occurredAt,
      retentionExpiresAt,
    })
  }

  const withEffect = async (effectKey, operation) => {
    if (effectResults.has(effectKey))
      return globalThis.structuredClone(effectResults.get(effectKey))
    const result = await operation()
    effectResults.set(effectKey, globalThis.structuredClone(result))
    return result
  }

  const activities = {
    ensureAttempt: ({ executionId, effectKey }) =>
      withEffect(effectKey, async () => {
        const execution = await lifecycle.getExecution(executionId)
        const attempt = await lifecycle.createAttempt({
          executionId,
          attemptId: durableExecutionIds.attemptId,
          expectedExecutionVersion: execution.version,
          queuedAt: '2026-08-24T16:00:02.000Z',
          runtime: {
            runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
            runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
            externalSessionId: 'ses_01KABCDEF0123456789ABCDEFG',
          },
        })
        return { attemptId: attempt.attemptId }
      }),
    persistStatus: ({ executionId, attemptId, state, effectKey }) =>
      withEffect(effectKey, async () => {
        const execution = await lifecycle.getExecution(executionId)
        if (execution.state !== state) {
          await lifecycle.transitionExecution({
            executionId,
            expectedVersion: execution.version,
            to: state,
            transitionedAt: statusTimestamp(state),
            ...(state === 'completed'
              ? { terminalResultRef: durableExecutionIds.resultReference }
              : {}),
          })
        }
        if (attemptId) {
          const attempt = await executionRepository.getAttempt(attemptId)
          if (attempt && attempt.state !== state) {
            await lifecycle.transitionAttempt({
              attemptId,
              expectedVersion: attempt.version,
              to: state,
              transitionedAt: statusTimestamp(state),
              ...(state === 'completed'
                ? { terminalResultRef: durableExecutionIds.resultReference }
                : {}),
            })
          }
        }
        await appendStatusEvent({ executionId, attemptId, state })
      }),
    dispatch: ({ executionId, attemptId, effectKey }) =>
      withEffect(effectKey, async () => {
        const outcome = await runtime.dispatch({ executionId, attemptId, effectKey })
        if (outcome.outcome === 'awaiting_input') {
          await interactionService.request({
            interactionId: outcome.interactionId,
            executionId,
            attemptId,
            kind: 'approval',
            prompt: { title: 'Approve deterministic mock completion' },
            allowedActions: ['approve', 'deny'],
            allowedPrincipalIds: ['svc_agent-hq'],
            requestedAt: '2026-08-24T16:00:05.000Z',
            expiresAt: '2026-08-24T17:00:00.000Z',
          })
        }
        return outcome
      }),
    applyInteraction: ({ effectKey, ...response }) =>
      withEffect(effectKey, () => runtime.applyInteraction(response)),
    cleanup: ({ effectKey }) => withEffect(effectKey, async () => undefined),
  }

  const workflowInput = {
    executionId: durableExecutionIds.executionId,
    workflowId: durableExecutionIds.workflowId,
    executionPlan: commandInput().executionPlan,
    deadlineAt,
  }

  const runWorkflow = ({ failDispatchOnce = false } = {}) => {
    runtime.failDispatchOnce = failDispatchOnce
    return runExecutionLifecycle(workflowInput, activities, {
      waitForInteraction: async (interactionId) => {
        const response = await interactionService.respond({
          interactionId,
          executionId: durableExecutionIds.executionId,
          attemptId: durableExecutionIds.attemptId,
          responseId: durableExecutionIds.responseId,
          action: 'approve',
          respondingPrincipalId: 'svc_agent-hq',
          expectedVersion: 1,
          respondedAt: '2026-08-24T16:00:06.000Z',
        })
        return {
          interactionId,
          responseId: response.response.responseId,
          action: response.response.action,
        }
      },
    })
  }

  return {
    accept,
    activities,
    commandInput,
    commandRepository,
    commandService,
    core,
    effectResults,
    eventRepository,
    eventService,
    executionRepository,
    interactionRepository,
    interactionService,
    intent,
    lifecycle,
    get planValidations() {
      return planValidations
    },
    restartServices: () => ({
      eventService: new ExecutionEventService(eventRepository),
      interactionService: new InteractionService(interactionRepository),
      lifecycle: new ExecutionLifecycleService(executionRepository),
    }),
    runWorkflow,
    runtime,
    workflowInput,
  }
}

export class DeterministicMockRuntimeAdapter {
  family = 'mock'
  failDispatchOnce = false
  dispatchFailures = 0
  dispatches = new Map()
  progress = new Map()
  terminals = new Map()

  constructor({ interaction = true } = {}) {
    this.interaction = interaction
  }

  async dispatch({ attemptId, effectKey }) {
    if (this.failDispatchOnce && this.dispatchFailures === 0) {
      this.dispatchFailures += 1
      throw new Error('MOCK_TRANSIENT_DISPATCH')
    }
    if (this.dispatches.has(effectKey))
      return globalThis.structuredClone(this.dispatches.get(effectKey))
    this.emitProgress(attemptId, 1, { phase: 'started' })
    this.emitProgress(attemptId, 2, { phase: 'working' })
    const outcome = this.interaction
      ? { outcome: 'awaiting_input', interactionId: durableExecutionIds.interactionId }
      : this.complete(attemptId, {
          outcome: 'completed',
          resultReference: durableExecutionIds.resultReference,
        })
    this.dispatches.set(effectKey, globalThis.structuredClone(outcome))
    return outcome
  }

  async applyInteraction({ attemptId, action }) {
    if (action !== 'approve') return { outcome: 'cancelled' }
    return this.complete(attemptId, {
      outcome: 'completed',
      resultReference: durableExecutionIds.resultReference,
    })
  }

  emitProgress(attemptId, sequence, payload) {
    const frames = this.progress.get(attemptId) ?? []
    if (frames.some((frame) => frame.sequence >= sequence)) return false
    frames.push({ sequence, payload: globalThis.structuredClone(payload) })
    this.progress.set(attemptId, frames)
    return true
  }

  complete(attemptId, outcome) {
    const current = this.terminals.get(attemptId)
    if (current) return globalThis.structuredClone(current)
    this.terminals.set(attemptId, globalThis.structuredClone(outcome))
    return outcome
  }
}

export function createAgentHqReceiver({ outageCount = 0 } = {}) {
  const attempts = []
  const accepted = new Map()
  return {
    attempts,
    accepted,
    transport: {
      deliver: async (envelope) => {
        attempts.push(globalThis.structuredClone(envelope))
        if (attempts.length <= outageCount) {
          return { outcome: 'retryable_failure', code: 'TEST_OUTAGE' }
        }
        accepted.set(envelope.eventId, globalThis.structuredClone(envelope))
        return { outcome: 'accepted' }
      },
    },
  }
}

export function createEventDispatcher(harness, receiver, clock) {
  return new ExecutionEventDispatcher({
    repository: harness.eventRepository,
    publicationService: harness.eventService,
    transport: receiver.transport,
    now: () => clock.value,
    retry: { baseDelayMs: 1_000, maximumAttempts: 3 },
  })
}

export function createStaleReconciler({ executionId = durableExecutionIds.executionId } = {}) {
  const repository = new InMemoryReconciliationCheckpointRepository()
  const effects = []
  const observation = {
    executionId,
    checkedAt: '2026-08-24T18:00:00.000Z',
    command: { commandId: coreAcceptanceIds.commandId, status: 'processing' },
    execution: { state: 'running', updatedAt: '2026-08-24T17:00:00.000Z' },
    attempt: {
      attemptId: durableExecutionIds.attemptId,
      sequence: 1,
      state: 'running',
      updatedAt: '2026-08-24T17:00:00.000Z',
      runtimeCommandId: 'mock-command-1',
    },
    workflow: {
      workflowId: durableExecutionIds.workflowId,
      status: 'running',
      lastProgressAt: '2026-08-24T17:00:00.000Z',
    },
    runtime: { status: 'running', observedAt: '2026-08-24T18:00:00.000Z' },
    delivery: { pendingCount: 0 },
  }
  const service = new ExecutionReconciliationService({
    repository,
    source: { load: async () => observation, listCandidates: async () => [executionId] },
    effects: {
      markReconciliationRequired: async (input) => effects.push(['mark', input]),
      resumeWorkflow: async (input) => effects.push(['resume', input]),
      applyRuntimeTerminal: async (input) => effects.push(['terminal', input]),
      replayEvents: async (input) => effects.push(['replay', input]),
    },
  })
  return { effects, repository, service }
}

function eventId(sequence) {
  return `evt_${sequence.toString().padStart(26, '0')}`
}

function statusTimestamp(state) {
  const offsets = {
    queued: 1,
    starting: 3,
    running: 4,
    awaiting_input: 5,
    completed: 7,
    failed: 7,
    cancelled: 7,
    timed_out: 7,
  }
  return new Date(Date.parse(acceptedAt) + (offsets[state] ?? 6) * 1_000).toISOString()
}
