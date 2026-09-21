import { createHash } from 'node:crypto'
import {
  RuntimeExecutionHandleSchema,
  RuntimeExecutionStatusSchema,
  RuntimeStartRequestSchema,
  type RuntimeAdapter,
  type RuntimeExecutionHandle,
  type RuntimeExecutionStatus,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { NativeSessionIdSchema } from './acp-schemas.js'
import { acpPrompt, normalizeSnapshot } from './acp-helpers.js'
import { fail, stable, withTimeout } from './acp-utils.js'
import { executionOf, type AcpDriverState } from './acp-driver-state.js'
import {
  inspectDriver,
  request as transportRequest,
  transportCall,
  withCreateCapacity,
} from './acp-driver-transport.js'

export async function startExecution(
  state: AcpDriverState,
  requestInput: Parameters<RuntimeAdapter['start']>[0]
): Promise<RuntimeExecutionHandle> {
  const request = RuntimeStartRequestSchema.parse(requestInput)
  const fingerprint = stable(request)
  const replay = state.starts.get(request.idempotencyKey)
  if (replay) {
    if (replay.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
    return structuredClone(replay.value)
  }
  await awaitCreateReclamation(state, request.attemptId)
  if (state.executions.has(`acp:${request.attemptId}`)) {
    fail('ACP_ATTEMPT_ID_CONFLICT', 'conflict', false)
  }
  const pending = state.pendingStarts.get(request.idempotencyKey)
  if (pending) {
    if (pending.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
    return structuredClone(await pending.value)
  }
  const pendingAttempt = state.pendingAttempts.get(request.attemptId)
  if (pendingAttempt) {
    if (pendingAttempt.fingerprint !== fingerprint) {
      fail('ACP_ATTEMPT_ID_CONFLICT', 'conflict', false)
    }
    return structuredClone(await pendingAttempt.value)
  }
  const started = startOnce(state, request, fingerprint)
  state.pendingStarts.set(request.idempotencyKey, { fingerprint, value: started })
  state.pendingAttempts.set(request.attemptId, { fingerprint, value: started })
  try {
    return structuredClone(await started)
  } finally {
    if (state.pendingStarts.get(request.idempotencyKey)?.value === started) {
      state.pendingStarts.delete(request.idempotencyKey)
    }
    if (state.pendingAttempts.get(request.attemptId)?.value === started) {
      state.pendingAttempts.delete(request.attemptId)
    }
  }
}

async function startOnce(
  state: AcpDriverState,
  request: ReturnType<typeof RuntimeStartRequestSchema.parse>,
  fingerprint: string
): Promise<RuntimeExecutionHandle> {
  return withCreateCapacity(state, () => startOnceAdmitted(state, request, fingerprint))
}

async function startOnceAdmitted(
  state: AcpDriverState,
  request: ReturnType<typeof RuntimeStartRequestSchema.parse>,
  fingerprint: string
): Promise<RuntimeExecutionHandle> {
  const inspection = await inspectDriver(state, request.executionPlan.runtimeRequirements)
  if (inspection.health === 'unavailable' || !inspection.capabilityEvaluation?.eligible) {
    fail('ACP_RUNTIME_INELIGIBLE', 'unsupported', false)
  }
  const resolvePrompt = state.resolvePrompt
  const prompt = resolvePrompt
    ? await withTimeout(
        state.requestTimeoutMs,
        (signal) => resolvePrompt(structuredClone(request), signal),
        () => new Error('ACP_PROMPT_RESOLUTION_TIMEOUT')
      ).catch(() => fail('ACP_PROMPT_RESOLUTION_FAILED', 'validation', false))
    : acpPrompt(request.attemptId, request.executionPlan)
  if (typeof prompt !== 'string' || prompt.length === 0 || Buffer.byteLength(prompt) > 262_144)
    fail('ACP_PROMPT_INVALID', 'validation', false)
  const nativeSessionId = await createNativeSession(state, request.attemptId)
  let externalSessionId: string | undefined
  let handle: RuntimeExecutionHandle | undefined
  try {
    externalSessionId = state.externalSessionId(nativeSessionId)
    handle = RuntimeExecutionHandleSchema.parse({
      handleId: `acp:${request.attemptId}`,
      attemptId: request.attemptId,
      externalSessionId,
      startedAt: state.now().toISOString(),
    })
    await transportRequest(state, 'session/prompt', {
      sessionId: nativeSessionId,
      prompt: [{ type: 'text', text: prompt }],
    })
    state.nativeByExternalSession.set(externalSessionId, nativeSessionId)
    state.executions.set(handle.handleId, { handle, nativeSessionId })
    state.starts.set(request.idempotencyKey, { fingerprint, value: handle })
    return handle
  } catch (error) {
    if (
      externalSessionId &&
      state.nativeByExternalSession.get(externalSessionId) === nativeSessionId
    ) {
      state.nativeByExternalSession.delete(externalSessionId)
    }
    if (handle) state.executions.delete(handle.handleId)
    state.starts.delete(request.idempotencyKey)
    if (!(await cleanupFailedStart(state, nativeSessionId))) {
      state.uncertainAttempts.add(request.attemptId)
    }
    throw error
  }
}

export async function executionStatus(
  state: AcpDriverState,
  handleInput: RuntimeExecutionHandle
): Promise<RuntimeExecutionStatus> {
  const execution = executionOf(state, handleInput)
  if (state.transport.connectionState() === 'disconnected') {
    return RuntimeExecutionStatusSchema.parse({
      handle: execution.handle,
      state: 'unknown',
      observedAt: state.now().toISOString(),
    })
  }
  return normalizeSnapshot(
    execution.handle,
    await transportCall(state, (signal) =>
      state.transport.snapshot(execution.nativeSessionId, signal)
    )
  )
}

export async function cleanupExecution(
  state: AcpDriverState,
  handleInput: RuntimeExecutionHandle
): Promise<void> {
  const execution = executionOf(state, handleInput)
  if (state.cleaned.has(execution.handle.handleId)) return
  const pending = state.pendingCleanups.get(execution.handle.handleId)
  if (pending) return pending
  const cleanup = transportCall(state, (signal) =>
    state.transport.cleanup(execution.nativeSessionId, signal)
  ).then(() => {
    state.cleaned.add(execution.handle.handleId)
  })
  state.pendingCleanups.set(execution.handle.handleId, cleanup)
  try {
    await cleanup
  } finally {
    if (state.pendingCleanups.get(execution.handle.handleId) === cleanup) {
      state.pendingCleanups.delete(execution.handle.handleId)
    }
  }
}

export async function cleanupFailedStart(
  state: AcpDriverState,
  nativeSessionId: string
): Promise<boolean> {
  const pending = state.pendingFailedStartCleanups.get(nativeSessionId)
  if (pending) return pending
  const cleanup = cleanupFailedStartOnce(state, nativeSessionId)
  state.pendingFailedStartCleanups.set(nativeSessionId, cleanup)
  try {
    return await cleanup
  } finally {
    if (state.pendingFailedStartCleanups.get(nativeSessionId) === cleanup) {
      state.pendingFailedStartCleanups.delete(nativeSessionId)
    }
  }
}

async function cleanupFailedStartOnce(
  state: AcpDriverState,
  nativeSessionId: string
): Promise<boolean> {
  let closed = false
  try {
    await transportRequest(state, 'session/close', { sessionId: nativeSessionId }, true)
    closed = true
  } catch {
    // Preserve the startup failure; transport cleanup is still attempted below.
  }
  try {
    await transportCall(
      state,
      (signal) => state.transport.cleanup(nativeSessionId, signal),
      state.requestTimeoutMs,
      true
    )
  } catch {
    // Preserve the startup failure rather than masking it with cleanup failure.
  }
  return closed
}

export async function createNativeSession(
  state: AcpDriverState,
  attemptId: string
): Promise<string> {
  if (state.uncertainCreateTokens.size >= 128) fail('ACP_CREATE_BACKPRESSURE', 'unavailable', true)
  const createToken = `acp-create:${createHash('sha256')
    .update(`${attemptId}:${++state.createSequence}`)
    .digest('hex')}`
  let createRequest: Promise<{ readonly sessionId: string }> | undefined
  let result: unknown
  try {
    result = await transportCall(state, (signal) => {
      createRequest = Promise.resolve().then(() =>
        state.transport.createSession(createToken, signal)
      )
      return createRequest
    })
  } catch (error) {
    if (createRequest) {
      state.uncertainAttempts.add(attemptId)
      state.uncertainCreateTokens.set(attemptId, createToken)
      state.uncertainCreateOperationCount += 1
      const reclamation = reclaimCreatedSession(state, attemptId, createToken).finally(() => {
        if (state.createReclamations.get(attemptId) === reclamation) {
          state.createReclamations.delete(attemptId)
        }
      })
      const lateCleanup = createRequest
        .then(async (lateResult) => {
          await reclamation.catch(() => undefined)
          if (!state.uncertainAttempts.has(attemptId)) return
          const identifiable = z
            .object({ sessionId: NativeSessionIdSchema })
            .passthrough()
            .safeParse(lateResult)
          if (
            identifiable.success &&
            (await cleanupFailedStart(state, identifiable.data.sessionId))
          ) {
            state.uncertainAttempts.delete(attemptId)
            state.uncertainCreateTokens.delete(attemptId)
          }
        })
        .catch(() => undefined)
      state.createReclamations.set(attemptId, reclamation)
      void reclamation.catch(() => undefined)
      void Promise.allSettled([reclamation, lateCleanup]).then(() => {
        state.uncertainCreateOperationCount -= 1
      })
    }
    throw error
  }
  const identifiable = z
    .object({ sessionId: NativeSessionIdSchema })
    .passthrough()
    .safeParse(result)
  try {
    const nativeSessionId = z
      .object({ sessionId: NativeSessionIdSchema })
      .strict()
      .parse(result).sessionId
    state.nativeSessionGenerations.set(nativeSessionId, createToken)
    return nativeSessionId
  } catch (error) {
    if (identifiable.success && !(await cleanupFailedStart(state, identifiable.data.sessionId))) {
      state.uncertainAttempts.add(attemptId)
    }
    throw error
  }
}

async function reclaimCreatedSession(
  state: AcpDriverState,
  attemptId: string,
  createToken: string
): Promise<void> {
  let result: unknown
  try {
    result = await transportCall(state, (signal) =>
      state.transport.createSession(createToken, signal)
    )
  } catch {
    return
  }
  const identifiable = z
    .object({ sessionId: NativeSessionIdSchema })
    .passthrough()
    .safeParse(result)
  if (!identifiable.success) return
  if (await cleanupFailedStart(state, identifiable.data.sessionId)) {
    state.uncertainAttempts.delete(attemptId)
    state.uncertainCreateTokens.delete(attemptId)
  }
}

export async function awaitCreateReclamation(
  state: AcpDriverState,
  attemptId: string
): Promise<void> {
  const reclamation = state.createReclamations.get(attemptId)
  if (reclamation) await reclamation
  const createToken = state.uncertainCreateTokens.get(attemptId)
  if (state.uncertainAttempts.has(attemptId) && createToken)
    await reclaimCreatedSession(state, attemptId, createToken)
  if (state.uncertainAttempts.has(attemptId)) {
    fail('ACP_START_OUTCOME_UNKNOWN', 'conflict', false)
  }
}
