import {
  RuntimeApprovalRequestSchema,
  RuntimeCancelRequestSchema,
  RuntimeExecutionProgressSchema,
  RuntimeExecutionStatusSchema,
  RuntimeInputRequestSchema,
  type RuntimeApprovalRequest,
  type RuntimeCancelRequest,
  type RuntimeExecutionHandle,
  type RuntimeExecutionProgress,
  type RuntimeExecutionStatus,
  type RuntimeInputRequest,
  type RuntimeProgressOptions,
} from '@control-plane/runtime-sdk'
import { AcpUpdateSchema, type AcpUpdate } from './acp-schemas.js'
import { fail, stable } from './acp-utils.js'
import { executionOf, type AcpDriverState, type AcpExecution } from './acp-driver-state.js'
import { executionStatus } from './acp-driver-execution.js'
import { request as transportRequest, transportCall } from './acp-driver-transport.js'

export async function* progressUpdates(
  state: AcpDriverState,
  handleInput: RuntimeExecutionHandle,
  options: RuntimeProgressOptions = {}
): AsyncIterable<RuntimeExecutionProgress> {
  const execution = executionOf(state, handleInput)
  let sequence = 0
  for await (const updateInput of state.transport.updates(
    execution.nativeSessionId,
    options.signal
  )) {
    sequence += 1
    if (sequence <= (options.afterSequence ?? 0)) continue
    const update = AcpUpdateSchema.parse(updateInput)
    const progress = normalizeUpdate(state, execution, update, sequence)
    if (progress) yield progress
  }
}

export async function submitDriverInput(
  state: AcpDriverState,
  handleInput: RuntimeExecutionHandle,
  requestInput: RuntimeInputRequest
): Promise<RuntimeExecutionStatus> {
  const { handle } = executionOf(state, handleInput)
  const request = RuntimeInputRequestSchema.parse(requestInput)
  return idempotentAction(
    state,
    `input:${request.idempotencyKey}`,
    { handle, request },
    async () => {
      const interaction = state.interactions.get(`${handle.handleId}:${request.interactionId}`)
      if (!interaction || interaction.kind !== 'input') {
        fail('ACP_INTERACTION_MISSING', 'validation', false)
      }
      await transportCall(state, (signal) =>
        state.transport.respond(
          interaction.requestId,
          { outcome: { outcome: 'submitted', value: request.text } },
          signal
        )
      )
      return executionStatus(state, handle)
    }
  )
}

export async function submitDriverApproval(
  state: AcpDriverState,
  handleInput: RuntimeExecutionHandle,
  requestInput: RuntimeApprovalRequest
): Promise<RuntimeExecutionStatus> {
  const { handle } = executionOf(state, handleInput)
  const request = RuntimeApprovalRequestSchema.parse(requestInput)
  return idempotentAction(
    state,
    `approval:${request.idempotencyKey}`,
    { handle, request },
    async () => {
      const interaction = state.interactions.get(`${handle.handleId}:${request.interactionId}`)
      if (!interaction || interaction.kind !== 'permission') {
        fail('ACP_INTERACTION_MISSING', 'validation', false)
      }
      const desired = request.decision === 'approve' ? 'allow_once' : 'reject'
      const optionId = interaction.options?.find((option) => option.kind === desired)?.optionId
      if (!optionId) fail('ACP_PERMISSION_OPTION_UNSUPPORTED', 'unsupported', false)
      await transportCall(state, (signal) =>
        state.transport.respond(
          interaction.requestId,
          { outcome: { outcome: 'selected', optionId } },
          signal
        )
      )
      return executionStatus(state, handle)
    }
  )
}

export async function cancelExecution(
  state: AcpDriverState,
  handleInput: RuntimeExecutionHandle,
  requestInput: RuntimeCancelRequest
): Promise<RuntimeExecutionStatus> {
  const execution = executionOf(state, handleInput)
  const request = RuntimeCancelRequestSchema.parse(requestInput)
  return idempotentAction(
    state,
    `cancel:${request.idempotencyKey}`,
    { handle: execution.handle, request },
    async () => {
      await transportRequest(state, 'session/cancel', { sessionId: execution.nativeSessionId })
      return executionStatus(state, execution.handle)
    }
  )
}

function stableInteractionId(
  state: AcpDriverState,
  execution: AcpExecution,
  requestId: number
): string {
  const key = `${execution.handle.handleId}:${requestId}`
  let id = state.interactionIds.get(key)
  if (id === undefined) {
    id = state.interactionId(requestId)
    state.interactionIds.set(key, id)
  }
  return id
}

function normalizeUpdate(
  state: AcpDriverState,
  execution: AcpExecution,
  update: AcpUpdate,
  sequence: number
): RuntimeExecutionProgress | undefined {
  const common = {
    handleId: execution.handle.handleId,
    sequence,
    occurredAt: state.now().toISOString(),
  }
  if (update.sessionUpdate === 'state_update') {
    const executionState =
      update.state === 'running'
        ? 'running'
        : update.stopReason === 'cancelled'
          ? 'cancelled'
          : 'completed'
    return RuntimeExecutionProgressSchema.parse({
      ...common,
      type: 'status',
      data: { state: executionState },
    })
  }
  if (update.sessionUpdate === 'agent_message' || update.sessionUpdate === 'agent_message_chunk') {
    return RuntimeExecutionProgressSchema.parse({
      ...common,
      type: 'output',
      data: { text: update.text, messageId: update.messageId },
    })
  }
  if (update.sessionUpdate === 'request_permission') {
    const interactionId = stableInteractionId(state, execution, update.requestId)
    state.interactions.set(`${execution.handle.handleId}:${interactionId}`, {
      requestId: update.requestId,
      kind: 'permission',
      options: update.options.map(({ kind, optionId }) => ({ kind, optionId })),
    })
    return RuntimeExecutionProgressSchema.parse({
      ...common,
      type: 'interaction',
      data: {
        interactionId,
        kind: 'permission',
        toolCallId: update.toolCallId,
        prompt: update.title,
      },
    })
  }
  if (update.sessionUpdate === 'elicitation') {
    const interactionId = stableInteractionId(state, execution, update.requestId)
    state.interactions.set(`${execution.handle.handleId}:${interactionId}`, {
      requestId: update.requestId,
      kind: 'input',
    })
    return RuntimeExecutionProgressSchema.parse({
      ...common,
      type: 'interaction',
      data: { interactionId, kind: 'input', prompt: update.prompt },
    })
  }
  if (update.sessionUpdate === 'usage_update') {
    return RuntimeExecutionProgressSchema.parse({
      ...common,
      type: 'usage',
      data: {
        inputTokens: update.inputTokens,
        outputTokens: update.outputTokens,
        durationMs: update.durationMs,
      },
    })
  }
  if (update.sessionUpdate === 'artifact') {
    return RuntimeExecutionProgressSchema.parse({
      ...common,
      type: 'artifact',
      data: { artifact: update.artifact },
    })
  }
  return undefined
}

async function idempotentAction(
  state: AcpDriverState,
  key: string,
  input: unknown,
  action: () => Promise<RuntimeExecutionStatus>
): Promise<RuntimeExecutionStatus> {
  const fingerprint = stable(input)
  const replay = state.actions.get(key)
  if (replay) {
    if (replay.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
    return structuredClone(replay.value)
  }
  const value = RuntimeExecutionStatusSchema.parse(await action())
  state.actions.set(key, { fingerprint, value })
  return structuredClone(value)
}
