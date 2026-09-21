import {
  RuntimeExecutionHandleSchema,
  type ExternalSession,
  type RuntimeExecutionHandle,
  type RuntimeExecutionStatus,
  type RuntimeSessionResult,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { AcpInitializeResultSchema, SemanticVersionSchema } from './acp-schemas.js'
import { fail, stable } from './acp-utils.js'
import type {
  AcpDriverOptions,
  AcpExternalSessionsOptions,
  AcpTransport,
} from './acp-driver-types.js'

export interface AcpExecution {
  readonly handle: RuntimeExecutionHandle
  readonly nativeSessionId: string
}

export interface CachedValue<Value> {
  readonly fingerprint: string
  readonly value: Value
}

export interface AcpDriverInteraction {
  readonly requestId: number
  readonly kind: 'permission' | 'input'
  readonly options?: readonly {
    readonly optionId: string
    readonly kind: 'allow_once' | 'reject'
  }[]
}

/**
 * Internal state owned by a single AcpDriver instance. The class holds this
 * record in one private field; driver subsystem modules operate on it as
 * their first parameter so the state has exactly one owner.
 */
export interface AcpDriverState {
  // Immutable configuration, captured in the constructor.
  readonly transport: AcpTransport
  readonly adapterVersion: string
  readonly externalSessionId: (nativeSessionId: string) => string
  readonly interactionId: (nativeRequestId: number) => string
  readonly resolvePrompt: AcpDriverOptions['resolvePrompt']
  readonly now: () => Date
  readonly protocolVersion: number
  readonly requestTimeoutMs: number
  readonly externalSessions: AcpExternalSessionsOptions | undefined

  // Execution and idempotency state.
  executions: Map<string, AcpExecution>
  starts: Map<string, CachedValue<RuntimeExecutionHandle>>
  pendingStarts: Map<string, CachedValue<Promise<RuntimeExecutionHandle>>>
  pendingAttempts: Map<string, CachedValue<Promise<RuntimeExecutionHandle>>>
  actions: Map<string, CachedValue<RuntimeExecutionStatus>>
  sessionActions: Map<string, CachedValue<RuntimeSessionResult>>
  pendingSessionActions: Map<string, CachedValue<Promise<RuntimeSessionResult>>>
  pendingSessionOperations: Map<string, Promise<RuntimeSessionResult>>
  interactions: Map<string, AcpDriverInteraction>
  interactionIds: Map<string, string>

  // Native session creation uncertainty tracking.
  createReclamations: Map<string, Promise<void>>
  uncertainAttempts: Set<string>
  uncertainCreateTokens: Map<string, string>
  createSequence: number
  createOperationCount: number
  uncertainCreateOperationCount: number
  nativeByExternalSession: Map<string, string>
  nativeSessionGenerations: Map<string, string>

  // Session observation, compensation, and discovery publication.
  pendingPublications: Map<
    string,
    {
      latestVersion: number
      pending: ExternalSession | undefined
      readonly promise: Promise<void>
    }
  >
  observationRepairs: Map<
    string,
    {
      readonly generation: string | undefined
      attempt: number
      timer: ReturnType<typeof setTimeout> | undefined
    }
  >

  // Cleanup deduplication.
  cleaned: Set<string>
  pendingCleanups: Map<string, Promise<void>>
  pendingFailedStartCleanups: Map<string, Promise<boolean>>

  // Bounded-concurrency accounting.
  externalSessionOperationCount: number
  transportOperationCount: number
  cleanupTransportOperationCount: number

  // Lazily initialized connection result.
  initialize: z.output<typeof AcpInitializeResultSchema> | undefined
}

export function createAcpDriverState(options: AcpDriverOptions): AcpDriverState {
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 3_600_000
  ) {
    throw new Error('INVALID_ACP_REQUEST_TIMEOUT')
  }
  return {
    transport: options.transport,
    adapterVersion: SemanticVersionSchema.parse(options.adapterVersion),
    externalSessionId: options.externalSessionId,
    interactionId: options.interactionId,
    resolvePrompt: options.resolvePrompt,
    now: options.now ?? (() => new Date()),
    protocolVersion: options.protocolVersion ?? 2,
    requestTimeoutMs,
    externalSessions: options.externalSessions,
    executions: new Map(),
    starts: new Map(),
    pendingStarts: new Map(),
    pendingAttempts: new Map(),
    actions: new Map(),
    sessionActions: new Map(),
    pendingSessionActions: new Map(),
    pendingSessionOperations: new Map(),
    interactions: new Map(),
    interactionIds: new Map(),
    createReclamations: new Map(),
    uncertainAttempts: new Set(),
    uncertainCreateTokens: new Map(),
    createSequence: 0,
    createOperationCount: 0,
    uncertainCreateOperationCount: 0,
    nativeByExternalSession: new Map(),
    nativeSessionGenerations: new Map(),
    pendingPublications: new Map(),
    observationRepairs: new Map(),
    cleaned: new Set(),
    pendingCleanups: new Map(),
    pendingFailedStartCleanups: new Map(),
    externalSessionOperationCount: 0,
    transportOperationCount: 0,
    cleanupTransportOperationCount: 0,
    initialize: undefined,
  }
}

export function executionOf(
  state: AcpDriverState,
  handleInput: RuntimeExecutionHandle
): AcpExecution {
  const handle = RuntimeExecutionHandleSchema.parse(handleInput)
  const execution = state.executions.get(handle.handleId)
  if (!execution || stable(execution.handle) !== stable(handle)) {
    fail('ACP_EXECUTION_HANDLE_MISSING', 'validation', false)
  }
  return execution
}
