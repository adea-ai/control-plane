import {
  RuntimeAdapterError,
  RuntimeAdapterInspectionSchema,
  inspectRuntimeCapabilities,
  type RuntimeAdapter,
  type RuntimeAdapterInspection,
  type RuntimeCapability,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import {
  AcpInitializeResultSchema,
  CleanupOperationsPerCreate,
  MaximumCleanupTransportOperations,
  MaximumExternalSessionOperations,
  MaximumTransportOperations,
  normalizeV1Initialization,
} from './acp-schemas.js'
import { mapAcpCapabilities } from './acp-helpers.js'
import { fail, withTimeout } from './acp-utils.js'
import type { AcpDriverState } from './acp-driver-state.js'

export async function initializeConnection(
  state: AcpDriverState
): Promise<z.output<typeof AcpInitializeResultSchema>> {
  if (!state.initialize) {
    const info = { name: 'control-plane', title: 'Control Plane', version: state.adapterVersion }
    const response = await request(
      state,
      'initialize',
      state.protocolVersion === 1
        ? { protocolVersion: 1, clientCapabilities: {}, clientInfo: info }
        : { protocolVersion: state.protocolVersion, capabilities: {}, info }
    )
    state.initialize =
      state.protocolVersion === 1
        ? normalizeV1Initialization(response)
        : AcpInitializeResultSchema.parse(response)
  }
  return state.initialize
}

export async function request(
  state: AcpDriverState,
  method: string,
  params: Record<string, z.util.JSONType>,
  cleanup = false
): Promise<unknown> {
  if (state.transport.connectionState() === 'disconnected') {
    fail('ACP_DISCONNECTED', 'unavailable', true)
  }
  try {
    return await transportCall(
      state,
      (signal) => state.transport.request(method, params, signal),
      state.requestTimeoutMs,
      cleanup
    )
  } catch (error) {
    if (error instanceof RuntimeAdapterError) throw error
    fail('ACP_TRANSPORT_FAILURE', 'unavailable', true)
  }
}

export async function transportCall<Value>(
  state: AcpDriverState,
  operation: (signal: AbortSignal) => Promise<Value>,
  timeoutMs = state.requestTimeoutMs,
  cleanup = false
): Promise<Value> {
  return deadline(
    state,
    (signal) => transportOperation(state, () => operation(signal), cleanup),
    timeoutMs
  )
}

export function deadline<Value>(
  state: AcpDriverState,
  operation: (signal: AbortSignal) => Promise<Value>,
  timeoutMs = state.requestTimeoutMs
): Promise<Value> {
  return withTimeout(
    timeoutMs,
    operation,
    () =>
      new RuntimeAdapterError({
        code: 'ACP_REQUEST_TIMEOUT',
        classification: 'timeout',
        message: 'ACP_REQUEST_TIMEOUT',
        retryable: true,
      })
  )
}

export function transportOperation<Value>(
  state: AcpDriverState,
  operation: () => Promise<Value>,
  cleanup: boolean
): Promise<Value> {
  const count = cleanup ? state.cleanupTransportOperationCount : state.transportOperationCount
  const maximum = cleanup ? MaximumCleanupTransportOperations : MaximumTransportOperations
  if (count >= maximum) {
    fail('ACP_TRANSPORT_BACKPRESSURE', 'unavailable', true)
  }
  if (cleanup) state.cleanupTransportOperationCount += 1
  else state.transportOperationCount += 1
  return Promise.resolve()
    .then(operation)
    .finally(() => {
      if (cleanup) state.cleanupTransportOperationCount -= 1
      else state.transportOperationCount -= 1
    })
}

export async function withCreateCapacity<Value>(
  state: AcpDriverState,
  operation: () => Promise<Value>
): Promise<Value> {
  if (
    state.cleanupTransportOperationCount +
      CleanupOperationsPerCreate *
        (state.createOperationCount + state.uncertainCreateOperationCount + 1) >
    MaximumCleanupTransportOperations
  ) {
    fail('ACP_CREATE_BACKPRESSURE', 'unavailable', true)
  }
  state.createOperationCount += 1
  try {
    return await operation()
  } finally {
    state.createOperationCount -= 1
  }
}

export function externalSessionCall<Value>(
  state: AcpDriverState,
  operation: () => Promise<Value>
): Promise<Value> {
  if (state.externalSessionOperationCount >= MaximumExternalSessionOperations) {
    fail('ACP_EXTERNAL_SESSION_BACKPRESSURE', 'unavailable', true)
  }
  state.externalSessionOperationCount += 1
  return Promise.resolve()
    .then(operation)
    .finally(() => {
      state.externalSessionOperationCount -= 1
    })
}

export async function inspectDriver(
  state: AcpDriverState,
  requirements?: Parameters<RuntimeAdapter['inspect']>[0]
): Promise<RuntimeAdapterInspection> {
  let initialize: z.output<typeof AcpInitializeResultSchema>
  try {
    initialize = await initializeConnection(state)
  } catch (error) {
    return unavailableInspection(
      state,
      error instanceof RuntimeAdapterError ? error.code : 'ACP_INITIALIZATION_FAILED',
      requirements
    )
  }
  const connected = state.transport.connectionState() === 'connected'
  const versionSupported = initialize.protocolVersion === state.protocolVersion
  const capabilities = versionSupported
    ? mapAcpCapabilities(
        initialize,
        state.transport.replay !== undefined && (state.transport.replaySupport?.() ?? true)
      )
    : []
  const limitations = [
    ...(connected ? [] : ['ACP_DISCONNECTED']),
    ...(versionSupported ? [] : [`ACP_PROTOCOL_VERSION_UNSUPPORTED:${initialize.protocolVersion}`]),
    ...(!initialize.capabilities.session ? ['ACP_SESSION_SURFACE_UNAVAILABLE'] : []),
  ]
  return RuntimeAdapterInspectionSchema.parse({
    metadata: {
      contractVersion: { major: 1, minor: 0 },
      adapterName: 'acp',
      adapterVersion: state.adapterVersion,
      runtimeFamily: 'acp',
      driverVersion: initialize.capabilities._meta?.controlPlane?.driverVersion ?? '1.0.0',
      harnessVersion: initialize.info.version,
    },
    health:
      connected && versionSupported && initialize.capabilities.session ? 'healthy' : 'unavailable',
    capabilities,
    limitations,
    observedAt: state.now().toISOString(),
    ...(requirements
      ? { capabilityEvaluation: inspectRuntimeCapabilities(capabilities, requirements) }
      : {}),
  })
}

export function unavailableInspection(
  state: AcpDriverState,
  limitation: string,
  requirements?: Parameters<RuntimeAdapter['inspect']>[0]
): RuntimeAdapterInspection {
  const capabilities: RuntimeCapability[] = []
  return RuntimeAdapterInspectionSchema.parse({
    metadata: {
      contractVersion: { major: 1, minor: 0 },
      adapterName: 'acp',
      adapterVersion: state.adapterVersion,
      runtimeFamily: 'acp',
      driverVersion: '0.0.0',
      harnessVersion: '0.0.0',
    },
    health: 'unavailable',
    capabilities,
    limitations: [limitation],
    observedAt: state.now().toISOString(),
    ...(requirements
      ? { capabilityEvaluation: inspectRuntimeCapabilities(capabilities, requirements) }
      : {}),
  })
}
