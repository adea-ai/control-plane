import {
  RuntimeConnectionSchema,
  RuntimeSessionOperationSchema,
  RuntimeSessionResultSchema,
  assessExternalSession,
  type ExternalSession,
  type RuntimeSessionOperation,
  type RuntimeSessionResult,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { NativeSessionIdSchema } from './acp-schemas.js'
import { normalizeHistory } from './acp-helpers.js'
import { fail, stable, throwIfAborted, withAbortSignal } from './acp-utils.js'
import type { AcpDriverState } from './acp-driver-state.js'
import type { AcpSessionReplay } from './acp-driver-types.js'
import {
  awaitCreateReclamation,
  cleanupFailedStart,
  createNativeSession,
} from './acp-driver-execution.js'
import {
  markUnlistedSessionsRemoved,
  normalizedSession,
  observeNativeSession,
  rollbackObservedSession,
  scheduleObservationCompensation,
} from './acp-driver-observation.js'
import {
  deadline,
  externalSessionCall,
  inspectDriver,
  request,
  withCreateCapacity,
} from './acp-driver-transport.js'

export async function sessionDriverOperation(
  state: AcpDriverState,
  operationInput: RuntimeSessionOperation
): Promise<RuntimeSessionResult> {
  const operation = RuntimeSessionOperationSchema.parse(operationInput)
  const key = stable(operation)
  return deadline(state, (signal) => {
    let pending = state.pendingSessionOperations.get(key)
    if (!pending) {
      const promise = state.externalSessions
        ? externalSessionCall(state, () => sessionOperation(state, operation, signal))
        : sessionOperation(state, operation, signal)
      pending = promise
      state.pendingSessionOperations.set(key, promise)
      void promise
        .finally(() => {
          if (state.pendingSessionOperations.get(key) === promise) {
            state.pendingSessionOperations.delete(key)
          }
        })
        .catch(() => undefined)
    }
    return pending
  })
}

async function sessionOperation(
  state: AcpDriverState,
  operation: ReturnType<typeof RuntimeSessionOperationSchema.parse>,
  signal: AbortSignal
): Promise<RuntimeSessionResult> {
  const inspection = await inspectDriver(state)
  throwIfAborted(signal)
  const capability = `session.${operation.operation}`
  if (
    !inspection.capabilities.some(
      ({ name, support }) => name === capability && support !== 'unsupported'
    )
  ) {
    fail('CAPABILITY_UNSUPPORTED', 'unsupported', false)
  }
  if (operation.operation === 'create') {
    return idempotentSession(state, operation.idempotencyKey, operation, () =>
      withCreateCapacity(state, async () => {
        await withAbortSignal(signal, () => authorizeSession(state, 'create'))
        throwIfAborted(signal)
        const uncertaintyKey = `session-create:${operation.idempotencyKey}`
        await awaitCreateReclamation(state, uncertaintyKey)
        throwIfAborted(signal)
        const nativeSessionId = await createNativeSession(state, uncertaintyKey)
        const generation = state.nativeSessionGenerations.get(nativeSessionId)
        try {
          throwIfAborted(signal)
          const pendingObservation = observeNativeSession(
            state,
            nativeSessionId,
            'created_through_control_plane',
            undefined,
            'active',
            generation
          )
          await withAbortSignal(signal, () => pendingObservation)
          throwIfAborted(signal)
          return sessionResult(state, 'create', nativeSessionId)
        } catch (error) {
          const closed = await cleanupFailedStart(state, nativeSessionId)
          if (!closed) {
            state.uncertainAttempts.add(uncertaintyKey)
          }
          await rollbackObservedSession(state, nativeSessionId, closed, false, generation)
          scheduleObservationCompensation(state, nativeSessionId, closed, generation)
          throw error
        }
      })
    )
  }
  if (operation.operation === 'list') {
    await withAbortSignal(signal, () => authorizeSession(state, 'list'))
    throwIfAborted(signal)
    const result = z
      .object({
        sessions: z.array(
          z
            .object({
              sessionId: NativeSessionIdSchema,
              title: z.string().min(1).max(512).optional(),
            })
            .passthrough()
        ),
      })
      .parse(await request(state, 'session/list', {}))
    throwIfAborted(signal)
    const observed = new Set<string>()
    for (const native of result.sessions) {
      const session = await withAbortSignal(signal, () =>
        observeNativeSession(state, native.sessionId, 'native_discovery', native.title)
      )
      observed.add(session.sessionId)
    }
    await withAbortSignal(signal, () => markUnlistedSessionsRemoved(state, observed))
    throwIfAborted(signal)
    return RuntimeSessionResultSchema.parse({
      operation: 'list',
      sessions: result.sessions.map(({ sessionId }) =>
        normalizedSession(state, sessionId, 'active')
      ),
    })
  }
  const { nativeSessionId } = await withAbortSignal(signal, () =>
    authorizedSessionReference(state, operation.sessionId, operation.operation)
  )
  throwIfAborted(signal)
  if (operation.operation === 'history') {
    const replay = await sessionReplay(state, nativeSessionId, operation.afterSequence)
    throwIfAborted(signal)
    return RuntimeSessionResultSchema.parse({
      operation: 'history',
      session: normalizedSession(state, nativeSessionId, 'active'),
      completeness: replay.completeness,
      limitations:
        replay.completeness === 'complete'
          ? []
          : [replay.completeness === 'partial' ? 'ACP_HISTORY_PARTIAL' : 'ACP_HISTORY_UNAVAILABLE'],
      entries: replay.nativeUpdates
        ? replay.nativeUpdates.map((update, index) => ({
            sequence: (operation.afterSequence ?? 0) + index + 1,
            occurredAt: state.now().toISOString(),
            data: { type: 'native-acp-update', update },
          }))
        : normalizeHistory(replay.updates, state.now, operation.afterSequence ?? 0),
    })
  }
  if (operation.operation === 'load') {
    return idempotentSession(
      state,
      operation.idempotencyKey ?? `load:${operation.sessionId}`,
      operation,
      async () => {
        await sessionReplay(state, nativeSessionId)
        throwIfAborted(signal)
        await withAbortSignal(signal, () =>
          observeNativeSession(state, nativeSessionId, 'native_discovery')
        )
        throwIfAborted(signal)
        return RuntimeSessionResultSchema.parse({
          operation: 'load',
          session: normalizedSession(state, nativeSessionId, 'active'),
        })
      }
    )
  }
  if (operation.operation === 'resume') {
    return idempotentSession(
      state,
      operation.idempotencyKey ?? `resume:${operation.sessionId}`,
      operation,
      async () => {
        await request(state, 'session/resume', { sessionId: nativeSessionId })
        throwIfAborted(signal)
        await withAbortSignal(signal, () =>
          observeNativeSession(state, nativeSessionId, 'native_discovery')
        )
        throwIfAborted(signal)
        return RuntimeSessionResultSchema.parse({
          operation: 'resume',
          session: normalizedSession(state, nativeSessionId, 'active'),
        })
      }
    )
  }
  return idempotentSession(
    state,
    operation.idempotencyKey ?? `close:${operation.sessionId}`,
    operation,
    async () => {
      await request(state, 'session/close', { sessionId: nativeSessionId })
      throwIfAborted(signal)
      await withAbortSignal(signal, () =>
        observeNativeSession(state, nativeSessionId, 'native_discovery', undefined, 'closed')
      )
      throwIfAborted(signal)
      return RuntimeSessionResultSchema.parse({
        operation: 'close',
        session: normalizedSession(state, nativeSessionId, 'closed'),
      })
    }
  )
}

async function sessionReplay(
  state: AcpDriverState,
  nativeSessionId: string,
  afterSequence?: number
): Promise<AcpSessionReplay> {
  const replay = state.transport.replay
  if (!replay) fail('CAPABILITY_UNSUPPORTED', 'unsupported', false)
  return deadline(state, (signal) =>
    replay.call(state.transport, nativeSessionId, {
      ...(afterSequence === undefined ? {} : { afterSequence }),
      signal,
    })
  )
}

async function idempotentSession(
  state: AcpDriverState,
  key: string,
  input: unknown,
  action: () => Promise<RuntimeSessionResult>
): Promise<RuntimeSessionResult> {
  const fingerprint = stable(input)
  const replay = state.sessionActions.get(key)
  if (replay) {
    if (replay.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
    return structuredClone(replay.value)
  }
  const pending = state.pendingSessionActions.get(key)
  if (pending) {
    if (pending.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
    return structuredClone(await pending.value)
  }
  const started = action().then((value) => RuntimeSessionResultSchema.parse(value))
  state.pendingSessionActions.set(key, { fingerprint, value: started })
  try {
    const value = await started
    state.sessionActions.set(key, { fingerprint, value })
    return structuredClone(value)
  } finally {
    if (state.pendingSessionActions.get(key)?.value === started) {
      state.pendingSessionActions.delete(key)
    }
  }
}

async function authorizeSession(
  state: AcpDriverState,
  operation: RuntimeSessionOperation['operation'],
  session?: ExternalSession
): Promise<void> {
  const externalSessions = state.externalSessions
  if (!externalSessions) return
  if (!(await externalSessionCall(state, () => externalSessions.authorize(operation, session)))) {
    fail('ACP_SESSION_UNAUTHORIZED', 'validation', false)
  }
  if (session !== undefined) return
  const connection = RuntimeConnectionSchema.parse(externalSessions.runtimeConnection())
  const connected =
    externalSessions.nodeStatus() === 'online' &&
    !['unavailable', 'disconnected', 'expired', 'revoked'].includes(connection.status) &&
    !['offline', 'reconnecting', 'unknown', 'incompatible', 'revoked'].includes(
      connection.availabilityState ?? 'unknown'
    )
  const advertised = connection.capabilities.some(
    ({ name, support }) => name === `session.${operation}` && support !== 'unsupported'
  )
  if (!connected || !advertised) {
    fail('ACP_SESSION_OPERATION_UNAVAILABLE', 'unavailable', advertised)
  }
}

async function authorizedSessionReference(
  state: AcpDriverState,
  externalSessionId: string,
  operation: 'resume' | 'load' | 'close' | 'history'
): Promise<{ readonly nativeSessionId: string; readonly session?: ExternalSession }> {
  const externalSessions = state.externalSessions
  if (!externalSessions) {
    const nativeSessionId = state.nativeByExternalSession.get(externalSessionId)
    if (!nativeSessionId) fail('ACP_SESSION_REFERENCE_MISSING', 'validation', false)
    return { nativeSessionId }
  }
  const session = await externalSessionCall(state, () =>
    externalSessions.registry.get(externalSessionId)
  )
  await authorizeSession(state, operation, session)
  const context = {
    connection: RuntimeConnectionSchema.parse(externalSessions.runtimeConnection()),
    nodeStatus: externalSessions.nodeStatus(),
    evaluatedAt: state.now().toISOString(),
  }
  const availability = assessExternalSession(session, context).operations[operation]
  if (!availability.available) {
    const retryable = [
      'RUNTIME_MISSING',
      'RUNTIME_OFFLINE',
      'SESSION_CAPABILITIES_STALE',
      'CAPABILITY_NO_LONGER_ADVERTISED',
    ].includes(availability.reason)
    fail('ACP_SESSION_OPERATION_UNAVAILABLE', 'unavailable', retryable)
  }
  const nativeSessionId = await externalSessionCall(state, () =>
    externalSessions.resolveNativeSessionId(session.opaqueNativeSessionId)
  )
  if (!nativeSessionId) fail('ACP_SESSION_REFERENCE_STALE', 'unavailable', true)
  state.nativeByExternalSession.set(externalSessionId, nativeSessionId)
  return { nativeSessionId, session }
}

function sessionResult(
  state: AcpDriverState,
  operation: 'create',
  nativeSessionId: string
): RuntimeSessionResult {
  return RuntimeSessionResultSchema.parse({
    operation,
    session: normalizedSession(state, nativeSessionId, 'active'),
  })
}
