import { createHash } from 'node:crypto'
import {
  RuntimeAdapterError,
  RuntimeAdapterInspectionSchema,
  RuntimeApprovalRequestSchema,
  RuntimeArtifactReferenceSchema,
  RuntimeCapabilitySchema,
  RuntimeCancelRequestSchema,
  RuntimeExecutionHandleSchema,
  RuntimeExecutionProgressSchema,
  RuntimeExecutionStatusSchema,
  RuntimeInputRequestSchema,
  RuntimeConnectionSchema,
  RuntimeSessionOperationSchema,
  RuntimeSessionResultSchema,
  RuntimeStartRequestSchema,
  RuntimeUsageSchema,
  TransportedRuntimeAdapter,
  inspectRuntimeCapabilities,
  assessExternalSession,
  projectExternalSessionDiscovery,
  type ExternalSession,
  type ExternalSessionRegistry,
  type RuntimeAdapter,
  type RuntimeAdapterInspection,
  type RuntimeApprovalRequest,
  type RuntimeCapability,
  type RuntimeCancelRequest,
  type RuntimeExecutionHandle,
  type RuntimeExecutionPlanSnapshot,
  type RuntimeExecutionProgress,
  type RuntimeExecutionStatus,
  type RuntimeInputRequest,
  type RuntimeConnection,
  type RuntimeProgressOptions,
  type RuntimeSessionOperation,
  type RuntimeSessionResult,
  type RuntimeTransport,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'

const SemanticVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const TimestampSchema = z.iso.datetime()
const NativeSessionIdSchema = z.string().min(1).max(512)
const MaximumObservationRepairs = 1_024
const MaximumObservationRepairAttempts = 8
const MaximumPendingPublications = 1_024
const MaximumExternalSessionOperations = 1_024
const MaximumTransportOperations = 896
const MaximumCleanupTransportOperations = 128
const CleanupOperationsPerCreate = 2
const AcpInfoSchema = z
  .object({
    name: z.string().min(1).max(128),
    title: z.string().min(1).max(256).optional(),
    version: SemanticVersionSchema,
  })
  .strict()
const AcpSessionCapabilitiesSchema = z
  .object({
    prompt: z
      .object({
        image: z.object({}).strict().optional(),
        audio: z.object({}).strict().optional(),
        embeddedContext: z.object({}).strict().optional(),
      })
      .passthrough()
      .optional(),
    mcp: z
      .object({
        stdio: z.object({}).strict().optional(),
        http: z.object({}).strict().optional(),
      })
      .passthrough()
      .optional(),
    delete: z.object({}).strict().optional(),
    additionalDirectories: z.object({}).strict().optional(),
  })
  .passthrough()
const AcpControlPlaneMetadataSchema = z
  .object({
    capabilities: z.array(RuntimeCapabilitySchema.shape.name).max(64),
    driverVersion: SemanticVersionSchema,
  })
  .strict()
const AcpInitializeResultSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    capabilities: z
      .object({
        session: AcpSessionCapabilitiesSchema.optional(),
        auth: z.record(z.string(), z.json()).optional(),
        _meta: z
          .object({ controlPlane: AcpControlPlaneMetadataSchema.optional() })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    info: AcpInfoSchema,
    authMethods: z.array(z.record(z.string(), z.json())).max(32).optional(),
  })
  .passthrough()
const AcpV1InitializeResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    agentInfo: AcpInfoSchema,
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
        sessionCapabilities: z
          .object({
            list: z.object({}).passthrough().nullish(),
            resume: z.object({}).passthrough().nullish(),
            close: z.object({}).passthrough().nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough(),
  })
  .passthrough()

function normalizeV1Initialization(input: unknown): z.output<typeof AcpInitializeResultSchema> {
  const result = AcpV1InitializeResultSchema.parse(input)
  const sessions = result.agentCapabilities.sessionCapabilities
  return AcpInitializeResultSchema.parse({
    protocolVersion: result.protocolVersion,
    info: result.agentInfo,
    capabilities: {
      session: {},
      _meta: {
        controlPlane: {
          driverVersion: '1.0.0',
          capabilities: [
            'execution.cancel',
            'interaction.approval',
            'session.create',
            'stream.events',
            'stream.output',
            'tool.call',
            'session.history',
            ...(sessions?.list != null ? ['session.list'] : []),
            ...(sessions?.resume != null ? ['session.resume'] : []),
            ...(sessions?.close != null ? ['session.close'] : []),
            ...(result.agentCapabilities.loadSession ? ['session.load'] : []),
          ],
        },
      },
    },
  })
}
const AcpErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    classification: z.enum([
      'validation',
      'unsupported',
      'unavailable',
      'conflict',
      'timeout',
      'cancelled',
      'runtime',
      'infrastructure',
      'unknown',
    ]),
    message: z.string().min(1).max(4096),
    retryable: z.boolean(),
  })
  .strict()

export const AcpUpdateSchema = z.union([
  z.object({ sessionUpdate: z.literal('state_update'), state: z.literal('running') }).strict(),
  z
    .object({
      sessionUpdate: z.literal('state_update'),
      state: z.literal('idle'),
      stopReason: z.enum(['end_turn', 'cancelled', 'refusal', 'max_tokens', 'unknown']),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.enum(['agent_message', 'agent_message_chunk']),
      messageId: z.string().min(1).max(512),
      text: z.string().max(1_000_000),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.literal('request_permission'),
      requestId: z.number().int().nonnegative(),
      toolCallId: z.string().min(1).max(512),
      title: z.string().min(1).max(1024),
      options: z
        .array(
          z
            .object({
              optionId: z.string().min(1).max(128),
              kind: z.enum(['allow_once', 'reject']),
            })
            .strict()
        )
        .min(1)
        .max(32),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.literal('elicitation'),
      requestId: z.number().int().nonnegative(),
      prompt: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.literal('usage_update'),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      sessionUpdate: z.literal('artifact'),
      artifact: RuntimeArtifactReferenceSchema,
    })
    .strict(),
])

export const AcpSnapshotSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.enum(['starting', 'running', 'awaiting_input']),
      observedAt: TimestampSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('completed'),
      observedAt: TimestampSchema,
      output: z.json().optional(),
      usage: z
        .object({
          inputTokens: z.number().int().nonnegative(),
          outputTokens: z.number().int().nonnegative(),
          durationMs: z.number().int().nonnegative(),
        })
        .strict(),
      artifacts: z.array(RuntimeArtifactReferenceSchema).max(1024),
    })
    .strict(),
  z
    .object({
      state: z.literal('cancelled'),
      observedAt: TimestampSchema,
      usage: RuntimeUsageSchema.optional(),
    })
    .strict(),
  z
    .object({
      state: z.enum(['failed', 'timed_out']),
      observedAt: TimestampSchema,
      error: AcpErrorSchema,
    })
    .strict(),
])

export type AcpUpdate = z.output<typeof AcpUpdateSchema>
export type AcpSnapshot = z.output<typeof AcpSnapshotSchema>

export interface AcpTransportCall {
  readonly method: string
  readonly params: Record<string, z.util.JSONType>
}

export interface AcpTransport {
  // Transport implementations normalize native updates, results, and lifecycle
  // operations to this interface; initialize retains the selected wire version.
  connectionState(): 'connected' | 'disconnected'
  /** Repeating a create token must return the same native session. */
  createSession(createToken: string, signal?: AbortSignal): Promise<{ readonly sessionId: string }>
  request(
    method: string,
    params: Record<string, z.util.JSONType>,
    signal?: AbortSignal
  ): Promise<unknown>
  respond(
    requestId: number,
    result: Record<string, z.util.JSONType>,
    signal?: AbortSignal
  ): Promise<void>
  updates(nativeSessionId: string, signal?: AbortSignal): AsyncIterable<AcpUpdate>
  snapshot(nativeSessionId: string, signal?: AbortSignal): Promise<AcpSnapshot>
  cleanup(nativeSessionId: string, signal?: AbortSignal): Promise<void>
  replay?(
    nativeSessionId: string,
    options?: { readonly afterSequence?: number; readonly signal?: AbortSignal }
  ): Promise<AcpSessionReplay>
  replaySupport?(): boolean
}

export interface AcpSessionReplay {
  readonly updates: readonly AcpUpdate[]
  readonly nativeUpdates?: readonly z.util.JSONType[]
  readonly completeness: 'complete' | 'partial' | 'unavailable'
}

export interface AcpExternalSessionsOptions {
  readonly registry: ExternalSessionRegistry
  readonly runtimeConnection: () => RuntimeConnection
  readonly nodeStatus: () => 'online' | 'offline' | 'unknown' | 'revoked' | 'not_applicable'
  readonly workspaceId: string
  readonly projectId?: string
  readonly opaqueNativeSessionId: (nativeSessionId: string) => string
  readonly resolveNativeSessionId: (opaqueNativeSessionId: string) => Promise<string | undefined>
  readonly capabilityTtlMs: number
  readonly authorize: (
    operation: RuntimeSessionOperation['operation'],
    session?: ExternalSession
  ) => Promise<boolean>
  readonly publishDiscovery?: (input: {
    readonly scope: {
      readonly workspaceId: string
      readonly projectId?: string
      readonly runtimeNodeRefId?: string
    }
    readonly model: ReturnType<typeof projectExternalSessionDiscovery>
  }) => Promise<void>
}

export interface AcpDriverOptions {
  readonly transport: AcpTransport
  readonly adapterVersion: string
  readonly externalSessionId: (nativeSessionId: string) => string
  readonly interactionId: (nativeRequestId: number) => string
  /** Resolve authorized task content before creating a native session. No external effects. */
  readonly resolvePrompt?: (
    request: ReturnType<typeof RuntimeStartRequestSchema.parse>,
    signal: AbortSignal
  ) => Promise<string>
  readonly now?: () => Date
  readonly protocolVersion?: number
  readonly requestTimeoutMs?: number
  readonly externalSessions?: AcpExternalSessionsOptions
}

interface AcpExecution {
  readonly handle: RuntimeExecutionHandle
  readonly nativeSessionId: string
}

interface CachedValue<Value> {
  readonly fingerprint: string
  readonly value: Value
}

export class AcpDriver implements RuntimeAdapter {
  readonly #transport: AcpTransport
  readonly #adapterVersion: string
  readonly #externalSessionId: (nativeSessionId: string) => string
  readonly #interactionId: (nativeRequestId: number) => string
  readonly #interactionIds = new Map<string, string>()
  readonly #resolvePrompt: AcpDriverOptions['resolvePrompt']
  readonly #now: () => Date
  readonly #protocolVersion: number
  readonly #requestTimeoutMs: number
  readonly #externalSessions: AcpExternalSessionsOptions | undefined
  readonly #executions = new Map<string, AcpExecution>()
  readonly #starts = new Map<string, CachedValue<RuntimeExecutionHandle>>()
  readonly #pendingStarts = new Map<string, CachedValue<Promise<RuntimeExecutionHandle>>>()
  readonly #pendingAttempts = new Map<string, CachedValue<Promise<RuntimeExecutionHandle>>>()
  readonly #createReclamations = new Map<string, Promise<void>>()
  readonly #uncertainAttempts = new Set<string>()
  readonly #uncertainCreateTokens = new Map<string, string>()
  readonly #actions = new Map<string, CachedValue<RuntimeExecutionStatus>>()
  readonly #sessionActions = new Map<string, CachedValue<RuntimeSessionResult>>()
  readonly #pendingSessionActions = new Map<string, CachedValue<Promise<RuntimeSessionResult>>>()
  readonly #pendingSessionOperations = new Map<string, Promise<RuntimeSessionResult>>()
  readonly #interactions = new Map<
    string,
    {
      readonly requestId: number
      readonly kind: 'permission' | 'input'
      readonly options?: readonly {
        readonly optionId: string
        readonly kind: 'allow_once' | 'reject'
      }[]
    }
  >()
  readonly #nativeByExternalSession = new Map<string, string>()
  readonly #nativeSessionGenerations = new Map<string, string>()
  readonly #pendingPublications = new Map<
    string,
    {
      latestVersion: number
      pending: ExternalSession | undefined
      readonly promise: Promise<void>
    }
  >()
  readonly #observationRepairs = new Map<
    string,
    {
      readonly generation: string | undefined
      attempt: number
      timer: ReturnType<typeof setTimeout> | undefined
    }
  >()
  readonly #cleaned = new Set<string>()
  readonly #pendingCleanups = new Map<string, Promise<void>>()
  readonly #pendingFailedStartCleanups = new Map<string, Promise<boolean>>()
  #externalSessionOperationCount = 0
  #transportOperationCount = 0
  #cleanupTransportOperationCount = 0
  #createOperationCount = 0
  #uncertainCreateOperationCount = 0
  #createSequence = 0
  #initialize?: z.output<typeof AcpInitializeResultSchema>

  constructor(options: AcpDriverOptions) {
    this.#transport = options.transport
    this.#adapterVersion = SemanticVersionSchema.parse(options.adapterVersion)
    this.#externalSessionId = options.externalSessionId
    this.#interactionId = options.interactionId
    this.#resolvePrompt = options.resolvePrompt
    this.#now = options.now ?? (() => new Date())
    this.#protocolVersion = options.protocolVersion ?? 2
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > 3_600_000
    ) {
      throw new Error('INVALID_ACP_REQUEST_TIMEOUT')
    }
    this.#externalSessions = options.externalSessions
  }

  async inspect(
    requirements?: Parameters<RuntimeAdapter['inspect']>[0]
  ): Promise<RuntimeAdapterInspection> {
    let initialize: z.output<typeof AcpInitializeResultSchema>
    try {
      initialize = await this.#initializeConnection()
    } catch (error) {
      return this.#unavailableInspection(
        error instanceof RuntimeAdapterError ? error.code : 'ACP_INITIALIZATION_FAILED',
        requirements
      )
    }
    const connected = this.#transport.connectionState() === 'connected'
    const versionSupported = initialize.protocolVersion === this.#protocolVersion
    const capabilities = versionSupported
      ? mapAcpCapabilities(
          initialize,
          this.#transport.replay !== undefined && (this.#transport.replaySupport?.() ?? true)
        )
      : []
    const limitations = [
      ...(connected ? [] : ['ACP_DISCONNECTED']),
      ...(versionSupported
        ? []
        : [`ACP_PROTOCOL_VERSION_UNSUPPORTED:${initialize.protocolVersion}`]),
      ...(!initialize.capabilities.session ? ['ACP_SESSION_SURFACE_UNAVAILABLE'] : []),
    ]
    return RuntimeAdapterInspectionSchema.parse({
      metadata: {
        contractVersion: { major: 1, minor: 0 },
        adapterName: 'acp',
        adapterVersion: this.#adapterVersion,
        runtimeFamily: 'acp',
        driverVersion: initialize.capabilities._meta?.controlPlane?.driverVersion ?? '1.0.0',
        harnessVersion: initialize.info.version,
      },
      health:
        connected && versionSupported && initialize.capabilities.session
          ? 'healthy'
          : 'unavailable',
      capabilities,
      limitations,
      observedAt: this.#now().toISOString(),
      ...(requirements
        ? { capabilityEvaluation: inspectRuntimeCapabilities(capabilities, requirements) }
        : {}),
    })
  }

  async start(
    requestInput: Parameters<RuntimeAdapter['start']>[0]
  ): Promise<RuntimeExecutionHandle> {
    const request = RuntimeStartRequestSchema.parse(requestInput)
    const fingerprint = stable(request)
    const replay = this.#starts.get(request.idempotencyKey)
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
      return structuredClone(replay.value)
    }
    await this.#awaitCreateReclamation(request.attemptId)
    if (this.#executions.has(`acp:${request.attemptId}`)) {
      fail('ACP_ATTEMPT_ID_CONFLICT', 'conflict', false)
    }
    const pending = this.#pendingStarts.get(request.idempotencyKey)
    if (pending) {
      if (pending.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
      return structuredClone(await pending.value)
    }
    const pendingAttempt = this.#pendingAttempts.get(request.attemptId)
    if (pendingAttempt) {
      if (pendingAttempt.fingerprint !== fingerprint) {
        fail('ACP_ATTEMPT_ID_CONFLICT', 'conflict', false)
      }
      return structuredClone(await pendingAttempt.value)
    }
    const started = this.#startOnce(request, fingerprint)
    this.#pendingStarts.set(request.idempotencyKey, { fingerprint, value: started })
    this.#pendingAttempts.set(request.attemptId, { fingerprint, value: started })
    try {
      return structuredClone(await started)
    } finally {
      if (this.#pendingStarts.get(request.idempotencyKey)?.value === started) {
        this.#pendingStarts.delete(request.idempotencyKey)
      }
      if (this.#pendingAttempts.get(request.attemptId)?.value === started) {
        this.#pendingAttempts.delete(request.attemptId)
      }
    }
  }

  async #startOnce(
    request: ReturnType<typeof RuntimeStartRequestSchema.parse>,
    fingerprint: string
  ): Promise<RuntimeExecutionHandle> {
    return this.#withCreateCapacity(() => this.#startOnceAdmitted(request, fingerprint))
  }

  async #startOnceAdmitted(
    request: ReturnType<typeof RuntimeStartRequestSchema.parse>,
    fingerprint: string
  ): Promise<RuntimeExecutionHandle> {
    const inspection = await this.inspect(request.executionPlan.runtimeRequirements)
    if (inspection.health === 'unavailable' || !inspection.capabilityEvaluation?.eligible) {
      fail('ACP_RUNTIME_INELIGIBLE', 'unsupported', false)
    }
    const resolvePrompt = this.#resolvePrompt
    const prompt = resolvePrompt
      ? await withTimeout(
          this.#requestTimeoutMs,
          (signal) => resolvePrompt(structuredClone(request), signal),
          () => new Error('ACP_PROMPT_RESOLUTION_TIMEOUT')
        ).catch(() => fail('ACP_PROMPT_RESOLUTION_FAILED', 'validation', false))
      : acpPrompt(request.attemptId, request.executionPlan)
    if (typeof prompt !== 'string' || prompt.length === 0 || Buffer.byteLength(prompt) > 262_144)
      fail('ACP_PROMPT_INVALID', 'validation', false)
    const nativeSessionId = await this.#createNativeSession(request.attemptId)
    let externalSessionId: string | undefined
    let handle: RuntimeExecutionHandle | undefined
    try {
      externalSessionId = this.#externalSessionId(nativeSessionId)
      handle = RuntimeExecutionHandleSchema.parse({
        handleId: `acp:${request.attemptId}`,
        attemptId: request.attemptId,
        externalSessionId,
        startedAt: this.#now().toISOString(),
      })
      await this.#request('session/prompt', {
        sessionId: nativeSessionId,
        prompt: [{ type: 'text', text: prompt }],
      })
      this.#nativeByExternalSession.set(externalSessionId, nativeSessionId)
      this.#executions.set(handle.handleId, { handle, nativeSessionId })
      this.#starts.set(request.idempotencyKey, { fingerprint, value: handle })
      return handle
    } catch (error) {
      if (
        externalSessionId &&
        this.#nativeByExternalSession.get(externalSessionId) === nativeSessionId
      ) {
        this.#nativeByExternalSession.delete(externalSessionId)
      }
      if (handle) this.#executions.delete(handle.handleId)
      this.#starts.delete(request.idempotencyKey)
      if (!(await this.#cleanupFailedStart(nativeSessionId))) {
        this.#uncertainAttempts.add(request.attemptId)
      }
      throw error
    }
  }

  async *progress(
    handleInput: RuntimeExecutionHandle,
    options: RuntimeProgressOptions = {}
  ): AsyncIterable<RuntimeExecutionProgress> {
    const execution = this.#execution(handleInput)
    let sequence = 0
    for await (const updateInput of this.#transport.updates(
      execution.nativeSessionId,
      options.signal
    )) {
      sequence += 1
      if (sequence <= (options.afterSequence ?? 0)) continue
      const update = AcpUpdateSchema.parse(updateInput)
      const progress = this.#normalizeUpdate(execution, update, sequence)
      if (progress) yield progress
    }
  }

  async submitInput(
    handleInput: RuntimeExecutionHandle,
    requestInput: RuntimeInputRequest
  ): Promise<RuntimeExecutionStatus> {
    const { handle } = this.#execution(handleInput)
    const request = RuntimeInputRequestSchema.parse(requestInput)
    return this.#idempotentAction(
      `input:${request.idempotencyKey}`,
      { handle, request },
      async () => {
        const interaction = this.#interactions.get(`${handle.handleId}:${request.interactionId}`)
        if (!interaction || interaction.kind !== 'input') {
          fail('ACP_INTERACTION_MISSING', 'validation', false)
        }
        await this.#transportCall((signal) =>
          this.#transport.respond(
            interaction.requestId,
            { outcome: { outcome: 'submitted', value: request.text } },
            signal
          )
        )
        return this.status(handle)
      }
    )
  }

  async submitApproval(
    handleInput: RuntimeExecutionHandle,
    requestInput: RuntimeApprovalRequest
  ): Promise<RuntimeExecutionStatus> {
    const { handle } = this.#execution(handleInput)
    const request = RuntimeApprovalRequestSchema.parse(requestInput)
    return this.#idempotentAction(
      `approval:${request.idempotencyKey}`,
      { handle, request },
      async () => {
        const interaction = this.#interactions.get(`${handle.handleId}:${request.interactionId}`)
        if (!interaction || interaction.kind !== 'permission') {
          fail('ACP_INTERACTION_MISSING', 'validation', false)
        }
        const desired = request.decision === 'approve' ? 'allow_once' : 'reject'
        const optionId = interaction.options?.find((option) => option.kind === desired)?.optionId
        if (!optionId) fail('ACP_PERMISSION_OPTION_UNSUPPORTED', 'unsupported', false)
        await this.#transportCall((signal) =>
          this.#transport.respond(
            interaction.requestId,
            { outcome: { outcome: 'selected', optionId } },
            signal
          )
        )
        return this.status(handle)
      }
    )
  }

  async cancel(
    handleInput: RuntimeExecutionHandle,
    requestInput: RuntimeCancelRequest
  ): Promise<RuntimeExecutionStatus> {
    const execution = this.#execution(handleInput)
    const request = RuntimeCancelRequestSchema.parse(requestInput)
    return this.#idempotentAction(
      `cancel:${request.idempotencyKey}`,
      { handle: execution.handle, request },
      async () => {
        await this.#request('session/cancel', { sessionId: execution.nativeSessionId })
        return this.status(execution.handle)
      }
    )
  }

  async status(handleInput: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    const execution = this.#execution(handleInput)
    if (this.#transport.connectionState() === 'disconnected') {
      return RuntimeExecutionStatusSchema.parse({
        handle: execution.handle,
        state: 'unknown',
        observedAt: this.#now().toISOString(),
      })
    }
    return normalizeSnapshot(
      execution.handle,
      await this.#transportCall((signal) =>
        this.#transport.snapshot(execution.nativeSessionId, signal)
      )
    )
  }

  reconcile(handle: RuntimeExecutionHandle): Promise<RuntimeExecutionStatus> {
    return this.status(handle)
  }

  async session(operationInput: RuntimeSessionOperation): Promise<RuntimeSessionResult> {
    const operation = RuntimeSessionOperationSchema.parse(operationInput)
    const key = stable(operation)
    return this.#deadline((signal) => {
      let pending = this.#pendingSessionOperations.get(key)
      if (!pending) {
        const promise = this.#externalSessions
          ? this.#externalSessionCall(() => this.#sessionOperation(operation, signal))
          : this.#sessionOperation(operation, signal)
        pending = promise
        this.#pendingSessionOperations.set(key, promise)
        void promise
          .finally(() => {
            if (this.#pendingSessionOperations.get(key) === promise) {
              this.#pendingSessionOperations.delete(key)
            }
          })
          .catch(() => undefined)
      }
      return pending
    })
  }

  async #sessionOperation(
    operation: ReturnType<typeof RuntimeSessionOperationSchema.parse>,
    signal: AbortSignal
  ): Promise<RuntimeSessionResult> {
    const inspection = await this.inspect()
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
      return this.#idempotentSession(operation.idempotencyKey, operation, () =>
        this.#withCreateCapacity(async () => {
          await withAbortSignal(signal, () => this.#authorizeSession('create'))
          throwIfAborted(signal)
          const uncertaintyKey = `session-create:${operation.idempotencyKey}`
          await this.#awaitCreateReclamation(uncertaintyKey)
          throwIfAborted(signal)
          const nativeSessionId = await this.#createNativeSession(uncertaintyKey)
          const generation = this.#nativeSessionGenerations.get(nativeSessionId)
          try {
            throwIfAborted(signal)
            const pendingObservation = this.#observeNativeSession(
              nativeSessionId,
              'created_through_control_plane',
              undefined,
              'active',
              generation
            )
            await withAbortSignal(signal, () => pendingObservation)
            throwIfAborted(signal)
            return this.#sessionResult('create', nativeSessionId)
          } catch (error) {
            const closed = await this.#cleanupFailedStart(nativeSessionId)
            if (!closed) {
              this.#uncertainAttempts.add(uncertaintyKey)
            }
            await this.#rollbackObservedSession(nativeSessionId, closed, false, generation)
            this.#scheduleObservationCompensation(nativeSessionId, closed, generation)
            throw error
          }
        })
      )
    }
    if (operation.operation === 'list') {
      await withAbortSignal(signal, () => this.#authorizeSession('list'))
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
        .parse(await this.#request('session/list', {}))
      throwIfAborted(signal)
      const observed = new Set<string>()
      for (const native of result.sessions) {
        const session = await withAbortSignal(signal, () =>
          this.#observeNativeSession(native.sessionId, 'native_discovery', native.title)
        )
        observed.add(session.sessionId)
      }
      await withAbortSignal(signal, () => this.#markUnlistedSessionsRemoved(observed))
      throwIfAborted(signal)
      return RuntimeSessionResultSchema.parse({
        operation: 'list',
        sessions: result.sessions.map(({ sessionId }) =>
          this.#normalizedSession(sessionId, 'active')
        ),
      })
    }
    const { nativeSessionId } = await withAbortSignal(signal, () =>
      this.#authorizedSessionReference(operation.sessionId, operation.operation)
    )
    throwIfAborted(signal)
    if (operation.operation === 'history') {
      const replay = await this.#replay(nativeSessionId, operation.afterSequence)
      throwIfAborted(signal)
      return RuntimeSessionResultSchema.parse({
        operation: 'history',
        session: this.#normalizedSession(nativeSessionId, 'active'),
        completeness: replay.completeness,
        limitations:
          replay.completeness === 'complete'
            ? []
            : [
                replay.completeness === 'partial'
                  ? 'ACP_HISTORY_PARTIAL'
                  : 'ACP_HISTORY_UNAVAILABLE',
              ],
        entries: replay.nativeUpdates
          ? replay.nativeUpdates.map((update, index) => ({
              sequence: (operation.afterSequence ?? 0) + index + 1,
              occurredAt: this.#now().toISOString(),
              data: { type: 'native-acp-update', update },
            }))
          : normalizeHistory(replay.updates, this.#now, operation.afterSequence ?? 0),
      })
    }
    if (operation.operation === 'load') {
      return this.#idempotentSession(
        operation.idempotencyKey ?? `load:${operation.sessionId}`,
        operation,
        async () => {
          await this.#replay(nativeSessionId)
          throwIfAborted(signal)
          await withAbortSignal(signal, () =>
            this.#observeNativeSession(nativeSessionId, 'native_discovery')
          )
          throwIfAborted(signal)
          return RuntimeSessionResultSchema.parse({
            operation: 'load',
            session: this.#normalizedSession(nativeSessionId, 'active'),
          })
        }
      )
    }
    if (operation.operation === 'resume') {
      return this.#idempotentSession(
        operation.idempotencyKey ?? `resume:${operation.sessionId}`,
        operation,
        async () => {
          await this.#request('session/resume', { sessionId: nativeSessionId })
          throwIfAborted(signal)
          await withAbortSignal(signal, () =>
            this.#observeNativeSession(nativeSessionId, 'native_discovery')
          )
          throwIfAborted(signal)
          return RuntimeSessionResultSchema.parse({
            operation: 'resume',
            session: this.#normalizedSession(nativeSessionId, 'active'),
          })
        }
      )
    }
    return this.#idempotentSession(
      operation.idempotencyKey ?? `close:${operation.sessionId}`,
      operation,
      async () => {
        await this.#request('session/close', { sessionId: nativeSessionId })
        throwIfAborted(signal)
        await withAbortSignal(signal, () =>
          this.#observeNativeSession(nativeSessionId, 'native_discovery', undefined, 'closed')
        )
        throwIfAborted(signal)
        return RuntimeSessionResultSchema.parse({
          operation: 'close',
          session: this.#normalizedSession(nativeSessionId, 'closed'),
        })
      }
    )
  }

  async cleanup(handleInput: RuntimeExecutionHandle): Promise<void> {
    const execution = this.#execution(handleInput)
    if (this.#cleaned.has(execution.handle.handleId)) return
    const pending = this.#pendingCleanups.get(execution.handle.handleId)
    if (pending) return pending
    const cleanup = this.#transportCall((signal) =>
      this.#transport.cleanup(execution.nativeSessionId, signal)
    ).then(() => {
      this.#cleaned.add(execution.handle.handleId)
    })
    this.#pendingCleanups.set(execution.handle.handleId, cleanup)
    try {
      await cleanup
    } finally {
      if (this.#pendingCleanups.get(execution.handle.handleId) === cleanup) {
        this.#pendingCleanups.delete(execution.handle.handleId)
      }
    }
  }

  async #initializeConnection(): Promise<z.output<typeof AcpInitializeResultSchema>> {
    if (!this.#initialize) {
      const info = { name: 'control-plane', title: 'Control Plane', version: this.#adapterVersion }
      const response = await this.#request(
        'initialize',
        this.#protocolVersion === 1
          ? { protocolVersion: 1, clientCapabilities: {}, clientInfo: info }
          : { protocolVersion: this.#protocolVersion, capabilities: {}, info }
      )
      this.#initialize =
        this.#protocolVersion === 1
          ? normalizeV1Initialization(response)
          : AcpInitializeResultSchema.parse(response)
    }
    return this.#initialize
  }

  async #request(
    method: string,
    params: Record<string, z.util.JSONType>,
    cleanup = false
  ): Promise<unknown> {
    if (this.#transport.connectionState() === 'disconnected') {
      fail('ACP_DISCONNECTED', 'unavailable', true)
    }
    try {
      return await this.#transportCall(
        (signal) => this.#transport.request(method, params, signal),
        this.#requestTimeoutMs,
        cleanup
      )
    } catch (error) {
      if (error instanceof RuntimeAdapterError) throw error
      fail('ACP_TRANSPORT_FAILURE', 'unavailable', true)
    }
  }

  async #transportCall<Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
    timeoutMs = this.#requestTimeoutMs,
    cleanup = false
  ): Promise<Value> {
    return this.#deadline(
      (signal) => this.#transportOperation(() => operation(signal), cleanup),
      timeoutMs
    )
  }

  #deadline<Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
    timeoutMs = this.#requestTimeoutMs
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

  #transportOperation<Value>(operation: () => Promise<Value>, cleanup: boolean): Promise<Value> {
    const count = cleanup ? this.#cleanupTransportOperationCount : this.#transportOperationCount
    const maximum = cleanup ? MaximumCleanupTransportOperations : MaximumTransportOperations
    if (count >= maximum) {
      fail('ACP_TRANSPORT_BACKPRESSURE', 'unavailable', true)
    }
    if (cleanup) this.#cleanupTransportOperationCount += 1
    else this.#transportOperationCount += 1
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        if (cleanup) this.#cleanupTransportOperationCount -= 1
        else this.#transportOperationCount -= 1
      })
  }

  async #withCreateCapacity<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (
      this.#cleanupTransportOperationCount +
        CleanupOperationsPerCreate *
          (this.#createOperationCount + this.#uncertainCreateOperationCount + 1) >
      MaximumCleanupTransportOperations
    ) {
      fail('ACP_CREATE_BACKPRESSURE', 'unavailable', true)
    }
    this.#createOperationCount += 1
    try {
      return await operation()
    } finally {
      this.#createOperationCount -= 1
    }
  }

  async #cleanupFailedStart(nativeSessionId: string): Promise<boolean> {
    const pending = this.#pendingFailedStartCleanups.get(nativeSessionId)
    if (pending) return pending
    const cleanup = this.#cleanupFailedStartOnce(nativeSessionId)
    this.#pendingFailedStartCleanups.set(nativeSessionId, cleanup)
    try {
      return await cleanup
    } finally {
      if (this.#pendingFailedStartCleanups.get(nativeSessionId) === cleanup) {
        this.#pendingFailedStartCleanups.delete(nativeSessionId)
      }
    }
  }

  async #cleanupFailedStartOnce(nativeSessionId: string): Promise<boolean> {
    let closed = false
    try {
      await this.#request('session/close', { sessionId: nativeSessionId }, true)
      closed = true
    } catch {
      // Preserve the startup failure; transport cleanup is still attempted below.
    }
    try {
      await this.#transportCall(
        (signal) => this.#transport.cleanup(nativeSessionId, signal),
        this.#requestTimeoutMs,
        true
      )
    } catch {
      // Preserve the startup failure rather than masking it with cleanup failure.
    }
    return closed
  }

  async #createNativeSession(attemptId: string): Promise<string> {
    if (this.#uncertainCreateTokens.size >= 128)
      fail('ACP_CREATE_BACKPRESSURE', 'unavailable', true)
    const createToken = `acp-create:${createHash('sha256')
      .update(`${attemptId}:${++this.#createSequence}`)
      .digest('hex')}`
    let request: Promise<{ readonly sessionId: string }> | undefined
    let result: unknown
    try {
      result = await this.#transportCall((signal) => {
        request = Promise.resolve().then(() => this.#transport.createSession(createToken, signal))
        return request
      })
    } catch (error) {
      if (request) {
        this.#uncertainAttempts.add(attemptId)
        this.#uncertainCreateTokens.set(attemptId, createToken)
        this.#uncertainCreateOperationCount += 1
        const reclamation = this.#reclaimCreatedSession(attemptId, createToken).finally(() => {
          if (this.#createReclamations.get(attemptId) === reclamation) {
            this.#createReclamations.delete(attemptId)
          }
        })
        const lateCleanup = request
          .then(async (lateResult) => {
            await reclamation.catch(() => undefined)
            if (!this.#uncertainAttempts.has(attemptId)) return
            const identifiable = z
              .object({ sessionId: NativeSessionIdSchema })
              .passthrough()
              .safeParse(lateResult)
            if (
              identifiable.success &&
              (await this.#cleanupFailedStart(identifiable.data.sessionId))
            ) {
              this.#uncertainAttempts.delete(attemptId)
              this.#uncertainCreateTokens.delete(attemptId)
            }
          })
          .catch(() => undefined)
        this.#createReclamations.set(attemptId, reclamation)
        void reclamation.catch(() => undefined)
        void Promise.allSettled([reclamation, lateCleanup]).then(() => {
          this.#uncertainCreateOperationCount -= 1
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
      this.#nativeSessionGenerations.set(nativeSessionId, createToken)
      return nativeSessionId
    } catch (error) {
      if (identifiable.success && !(await this.#cleanupFailedStart(identifiable.data.sessionId))) {
        this.#uncertainAttempts.add(attemptId)
      }
      throw error
    }
  }

  async #reclaimCreatedSession(attemptId: string, createToken: string): Promise<void> {
    let result: unknown
    try {
      result = await this.#transportCall((signal) =>
        this.#transport.createSession(createToken, signal)
      )
    } catch {
      return
    }
    const identifiable = z
      .object({ sessionId: NativeSessionIdSchema })
      .passthrough()
      .safeParse(result)
    if (!identifiable.success) return
    if (await this.#cleanupFailedStart(identifiable.data.sessionId)) {
      this.#uncertainAttempts.delete(attemptId)
      this.#uncertainCreateTokens.delete(attemptId)
    }
  }

  async #awaitCreateReclamation(attemptId: string): Promise<void> {
    const reclamation = this.#createReclamations.get(attemptId)
    if (reclamation) await reclamation
    const createToken = this.#uncertainCreateTokens.get(attemptId)
    if (this.#uncertainAttempts.has(attemptId) && createToken)
      await this.#reclaimCreatedSession(attemptId, createToken)
    if (this.#uncertainAttempts.has(attemptId)) {
      fail('ACP_START_OUTCOME_UNKNOWN', 'conflict', false)
    }
  }

  async #rollbackObservedSession(
    nativeSessionId: string,
    closed: boolean,
    publishCorrection = false,
    generation?: string
  ): Promise<boolean> {
    try {
      if (
        generation !== undefined &&
        this.#nativeSessionGenerations.get(nativeSessionId) !== generation
      ) {
        return true
      }
      const externalSessionId = this.#externalSessionId(nativeSessionId)
      if (this.#nativeByExternalSession.get(externalSessionId) === nativeSessionId) {
        this.#nativeByExternalSession.delete(externalSessionId)
      }
      const externalSessions = this.#externalSessions
      if (!closed || !externalSessions) return true
      const timeoutMs = publishCorrection
        ? Math.min(30_000, Math.max(1_000, this.#requestTimeoutMs * 4))
        : this.#requestTimeoutMs
      return await this.#deadline(
        () =>
          this.#externalSessionCall(async () => {
            const connection = RuntimeConnectionSchema.parse(externalSessions.runtimeConnection())
            const session = await externalSessions.registry.repository.findByNativeIdentity(
              connection.runtimeConnectionId,
              externalSessions.opaqueNativeSessionId(nativeSessionId)
            )
            if (
              generation !== undefined &&
              this.#nativeSessionGenerations.get(nativeSessionId) !== generation
            ) {
              return true
            }
            if (!session) return false
            const corrected =
              session.state === 'active'
                ? await externalSessions.registry.update({
                    externalSessionId: session.externalSessionId,
                    expectedVersion: session.version,
                    observedAt: this.#now().toISOString(),
                    state: 'closed',
                  })
                : session
            if (publishCorrection && corrected.state === 'closed') {
              await this.#publishSessionDiscovery(corrected)
            }
            return true
          }),
        timeoutMs
      )
    } catch {
      // Native cleanup remains authoritative; stale projection repair can be retried by discovery.
      return false
    }
  }

  #scheduleObservationCompensation(
    nativeSessionId: string,
    closed: boolean,
    generation?: string
  ): void {
    if (!closed || !this.#externalSessions) return
    const existing = this.#observationRepairs.get(nativeSessionId)
    if (existing?.timer) clearTimeout(existing.timer)
    if (!existing && this.#observationRepairs.size >= MaximumObservationRepairs) return
    const repair: {
      generation: string | undefined
      attempt: number
      timer: ReturnType<typeof setTimeout> | undefined
    } = { generation, attempt: 0, timer: undefined }
    this.#observationRepairs.set(nativeSessionId, repair)

    const schedule = (): void => {
      if (this.#observationRepairs.get(nativeSessionId) !== repair) return
      const delayMs = Math.min(
        30_000,
        Math.max(20, this.#requestTimeoutMs * 2 ** Math.min(repair.attempt, 10))
      )
      const timer = setTimeout(() => {
        void (async () => {
          if (this.#observationRepairs.get(nativeSessionId) !== repair) return
          const repaired = await this.#rollbackObservedSession(
            nativeSessionId,
            true,
            true,
            generation
          )
          if (this.#observationRepairs.get(nativeSessionId) !== repair) return
          if (repaired) {
            this.#observationRepairs.delete(nativeSessionId)
            return
          }
          repair.attempt += 1
          if (repair.attempt >= MaximumObservationRepairAttempts) {
            this.#observationRepairs.delete(nativeSessionId)
            return
          }
          schedule()
        })()
      }, delayMs)
      repair.timer = timer
      timer.unref?.()
    }
    schedule()
  }

  #execution(handleInput: RuntimeExecutionHandle): AcpExecution {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const execution = this.#executions.get(handle.handleId)
    if (!execution || stable(execution.handle) !== stable(handle)) {
      fail('ACP_EXECUTION_HANDLE_MISSING', 'validation', false)
    }
    return execution
  }

  #stableInteractionId(execution: AcpExecution, requestId: number): string {
    const key = `${execution.handle.handleId}:${requestId}`
    let id = this.#interactionIds.get(key)
    if (id === undefined) {
      id = this.#interactionId(requestId)
      this.#interactionIds.set(key, id)
    }
    return id
  }

  #normalizeUpdate(
    execution: AcpExecution,
    update: AcpUpdate,
    sequence: number
  ): RuntimeExecutionProgress | undefined {
    const common = {
      handleId: execution.handle.handleId,
      sequence,
      occurredAt: this.#now().toISOString(),
    }
    if (update.sessionUpdate === 'state_update') {
      const state =
        update.state === 'running'
          ? 'running'
          : update.stopReason === 'cancelled'
            ? 'cancelled'
            : 'completed'
      return RuntimeExecutionProgressSchema.parse({ ...common, type: 'status', data: { state } })
    }
    if (
      update.sessionUpdate === 'agent_message' ||
      update.sessionUpdate === 'agent_message_chunk'
    ) {
      return RuntimeExecutionProgressSchema.parse({
        ...common,
        type: 'output',
        data: { text: update.text, messageId: update.messageId },
      })
    }
    if (update.sessionUpdate === 'request_permission') {
      const interactionId = this.#stableInteractionId(execution, update.requestId)
      this.#interactions.set(`${execution.handle.handleId}:${interactionId}`, {
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
      const interactionId = this.#stableInteractionId(execution, update.requestId)
      this.#interactions.set(`${execution.handle.handleId}:${interactionId}`, {
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

  async #idempotentAction(
    key: string,
    input: unknown,
    action: () => Promise<RuntimeExecutionStatus>
  ): Promise<RuntimeExecutionStatus> {
    const fingerprint = stable(input)
    const replay = this.#actions.get(key)
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
      return structuredClone(replay.value)
    }
    const value = RuntimeExecutionStatusSchema.parse(await action())
    this.#actions.set(key, { fingerprint, value })
    return structuredClone(value)
  }

  async #idempotentSession(
    key: string,
    input: unknown,
    action: () => Promise<RuntimeSessionResult>
  ): Promise<RuntimeSessionResult> {
    const fingerprint = stable(input)
    const replay = this.#sessionActions.get(key)
    if (replay) {
      if (replay.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
      return structuredClone(replay.value)
    }
    const pending = this.#pendingSessionActions.get(key)
    if (pending) {
      if (pending.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'conflict', false)
      return structuredClone(await pending.value)
    }
    const started = action().then((value) => RuntimeSessionResultSchema.parse(value))
    this.#pendingSessionActions.set(key, { fingerprint, value: started })
    try {
      const value = await started
      this.#sessionActions.set(key, { fingerprint, value })
      return structuredClone(value)
    } finally {
      if (this.#pendingSessionActions.get(key)?.value === started) {
        this.#pendingSessionActions.delete(key)
      }
    }
  }

  async #authorizeSession(
    operation: RuntimeSessionOperation['operation'],
    session?: ExternalSession
  ): Promise<void> {
    const externalSessions = this.#externalSessions
    if (!externalSessions) return
    if (!(await this.#externalSessionCall(() => externalSessions.authorize(operation, session)))) {
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

  async #authorizedSessionReference(
    externalSessionId: string,
    operation: 'resume' | 'load' | 'close' | 'history'
  ): Promise<{ readonly nativeSessionId: string; readonly session?: ExternalSession }> {
    const externalSessions = this.#externalSessions
    if (!externalSessions) {
      const nativeSessionId = this.#nativeByExternalSession.get(externalSessionId)
      if (!nativeSessionId) fail('ACP_SESSION_REFERENCE_MISSING', 'validation', false)
      return { nativeSessionId }
    }
    const session = await this.#externalSessionCall(() =>
      externalSessions.registry.get(externalSessionId)
    )
    await this.#authorizeSession(operation, session)
    const context = {
      connection: RuntimeConnectionSchema.parse(externalSessions.runtimeConnection()),
      nodeStatus: externalSessions.nodeStatus(),
      evaluatedAt: this.#now().toISOString(),
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
    const nativeSessionId = await this.#externalSessionCall(() =>
      externalSessions.resolveNativeSessionId(session.opaqueNativeSessionId)
    )
    if (!nativeSessionId) fail('ACP_SESSION_REFERENCE_STALE', 'unavailable', true)
    this.#nativeByExternalSession.set(externalSessionId, nativeSessionId)
    return { nativeSessionId, session }
  }

  async #observeNativeSession(
    nativeSessionId: string,
    origin: 'native_discovery' | 'created_through_control_plane',
    displayName?: string,
    state: 'active' | 'closed' = 'active',
    generation?: string
  ) {
    if (!this.#externalSessions) return this.#normalizedSession(nativeSessionId, state)
    return this.#externalSessionCall(() =>
      this.#observeNativeSessionUnbounded(nativeSessionId, origin, displayName, state, generation)
    )
  }

  async #observeNativeSessionUnbounded(
    nativeSessionId: string,
    origin: 'native_discovery' | 'created_through_control_plane',
    displayName?: string,
    state: 'active' | 'closed' = 'active',
    generation?: string
  ) {
    const normalized = this.#normalizedSession(nativeSessionId, state)
    if (!this.#externalSessions) return normalized
    const connection = RuntimeConnectionSchema.parse(this.#externalSessions.runtimeConnection())
    const observedAt = this.#now().toISOString()
    const capabilitySnapshot = {
      version: connection.capabilitySnapshotVersion ?? 1,
      observedAt: connection.capabilitySnapshotObservedAt ?? observedAt,
      expiresAt:
        connection.capabilitySnapshotExpiresAt ??
        new Date(this.#now().getTime() + this.#externalSessions.capabilityTtlMs).toISOString(),
      operations: connection.capabilities
        .filter(({ name, support }) => name.startsWith('session.') && support !== 'unsupported')
        .map(({ name }) => name),
    }
    const existing = await this.#externalSessions.registry.repository.findByNativeIdentity(
      connection.runtimeConnectionId,
      this.#externalSessions.opaqueNativeSessionId(nativeSessionId)
    )
    if (
      generation !== undefined &&
      this.#nativeSessionGenerations.get(nativeSessionId) !== generation
    ) {
      return normalized
    }
    const safeDisplayName = safeNativeDisplayName(displayName)
    if (!existing) {
      const session = await this.#externalSessions.registry.register({
        externalSessionId: normalized.sessionId,
        runtimeConnectionId: connection.runtimeConnectionId,
        opaqueNativeSessionId: this.#externalSessions.opaqueNativeSessionId(nativeSessionId),
        workspaceId: this.#externalSessions.workspaceId,
        ...(this.#externalSessions.projectId === undefined
          ? {}
          : { projectId: this.#externalSessions.projectId }),
        state,
        ownership: {
          authority: 'external_runtime',
          imported: false,
          concurrentNativeUse: 'allowed',
        },
        capabilitySnapshot,
        safeMetadata: {
          origin,
          ...(safeDisplayName === undefined ? {} : { displayName: safeDisplayName }),
          limitations: [],
        },
        lastObservedAt: observedAt,
      })
      if (
        generation === undefined ||
        this.#nativeSessionGenerations.get(nativeSessionId) === generation
      ) {
        await this.#publishSessionDiscovery(session)
      }
      return normalized
    }
    const session = await this.#externalSessions.registry.update({
      externalSessionId: existing.externalSessionId,
      expectedVersion: existing.version,
      observedAt,
      state,
      capabilitySnapshot,
      safeMetadata: {
        ...existing.safeMetadata,
        ...(safeDisplayName === undefined ? {} : { displayName: safeDisplayName }),
      },
    })
    if (
      generation === undefined ||
      this.#nativeSessionGenerations.get(nativeSessionId) === generation
    ) {
      await this.#publishSessionDiscovery(session)
    }
    return normalized
  }

  #externalSessionCall<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.#externalSessionOperationCount >= MaximumExternalSessionOperations) {
      fail('ACP_EXTERNAL_SESSION_BACKPRESSURE', 'unavailable', true)
    }
    this.#externalSessionOperationCount += 1
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.#externalSessionOperationCount -= 1
      })
  }

  async #markUnlistedSessionsRemoved(observed: ReadonlySet<string>): Promise<void> {
    const externalSessions = this.#externalSessions
    if (!externalSessions) return
    const connection = RuntimeConnectionSchema.parse(externalSessions.runtimeConnection())
    const sessions = await this.#externalSessionCall(() =>
      externalSessions.registry.list({
        workspaceId: externalSessions.workspaceId,
        ...(externalSessions.projectId === undefined
          ? {}
          : { projectId: externalSessions.projectId }),
        runtimeConnectionId: connection.runtimeConnectionId,
      })
    )
    for (const session of sessions) {
      if (session.state !== 'active' || observed.has(session.externalSessionId)) continue
      const updated = await this.#externalSessionCall(() =>
        externalSessions.registry.update({
          externalSessionId: session.externalSessionId,
          expectedVersion: session.version,
          observedAt: this.#now().toISOString(),
          state: 'removed',
        })
      )
      await this.#publishSessionDiscovery(updated)
    }
  }

  async #publishSessionDiscovery(session: ExternalSession): Promise<void> {
    if (!this.#externalSessions?.publishDiscovery) return
    const existing = this.#pendingPublications.get(session.externalSessionId)
    if (existing) {
      if (session.version > existing.latestVersion) {
        existing.latestVersion = session.version
        existing.pending = session
      }
      return
    }
    if (this.#pendingPublications.size >= MaximumPendingPublications) {
      fail('ACP_DISCOVERY_BACKPRESSURE', 'unavailable', true)
    }
    const state: {
      latestVersion: number
      pending: ExternalSession | undefined
      promise: Promise<void>
    } = {
      latestVersion: session.version,
      pending: session,
      promise: Promise.resolve(),
    }
    const publication = Promise.resolve().then(async () => {
      while (state.pending) {
        const next = state.pending
        state.pending = undefined
        const externalSessions = this.#externalSessions
        if (!externalSessions?.publishDiscovery) return
        const connection = RuntimeConnectionSchema.parse(externalSessions.runtimeConnection())
        const evaluatedAt = this.#now().toISOString()
        await externalSessions.publishDiscovery({
          scope: {
            workspaceId: externalSessions.workspaceId,
            ...(externalSessions.projectId === undefined
              ? {}
              : { projectId: externalSessions.projectId }),
            ...(connection.runtimeNodeRefId === undefined
              ? {}
              : { runtimeNodeRefId: connection.runtimeNodeRefId }),
          },
          model: projectExternalSessionDiscovery({
            session: next,
            assessment: assessExternalSession(next, {
              connection,
              nodeStatus: externalSessions.nodeStatus(),
              evaluatedAt,
            }),
          }),
        })
      }
    })
    state.promise = publication.finally(() => {
      if (this.#pendingPublications.get(session.externalSessionId) === state) {
        this.#pendingPublications.delete(session.externalSessionId)
      }
    })
    this.#pendingPublications.set(session.externalSessionId, state)
    await state.promise
  }

  async #replay(nativeSessionId: string, afterSequence?: number): Promise<AcpSessionReplay> {
    const replay = this.#transport.replay
    if (!replay) fail('CAPABILITY_UNSUPPORTED', 'unsupported', false)
    return this.#transportCall((signal) =>
      replay.call(this.#transport, nativeSessionId, {
        ...(afterSequence === undefined ? {} : { afterSequence }),
        signal,
      })
    )
  }

  #normalizedSession(nativeSessionId: string, state: 'active' | 'closed') {
    const sessionId = this.#externalSessionId(nativeSessionId)
    this.#nativeByExternalSession.set(sessionId, nativeSessionId)
    return { sessionId, state, observedAt: this.#now().toISOString() }
  }

  async #sessionResult(
    operation: 'create',
    nativeSessionId: string
  ): Promise<RuntimeSessionResult> {
    return RuntimeSessionResultSchema.parse({
      operation,
      session: this.#normalizedSession(nativeSessionId, 'active'),
    })
  }

  #unavailableInspection(
    limitation: string,
    requirements?: Parameters<RuntimeAdapter['inspect']>[0]
  ): RuntimeAdapterInspection {
    const capabilities: RuntimeCapability[] = []
    return RuntimeAdapterInspectionSchema.parse({
      metadata: {
        contractVersion: { major: 1, minor: 0 },
        adapterName: 'acp',
        adapterVersion: this.#adapterVersion,
        runtimeFamily: 'acp',
        driverVersion: '0.0.0',
        harnessVersion: '0.0.0',
      },
      health: 'unavailable',
      capabilities,
      limitations: [limitation],
      observedAt: this.#now().toISOString(),
      ...(requirements
        ? { capabilityEvaluation: inspectRuntimeCapabilities(capabilities, requirements) }
        : {}),
    })
  }
}

export interface AcpAdapterOptions {
  readonly transport: RuntimeTransport
}

export class AcpAdapter extends TransportedRuntimeAdapter {
  constructor(options: AcpAdapterOptions) {
    super(options.transport, 'acp')
  }
}

function mapAcpCapabilities(
  initialize: z.output<typeof AcpInitializeResultSchema>,
  supportsReplay: boolean
) {
  if (!initialize.capabilities.session) return []
  const reported = initialize.capabilities._meta?.controlPlane?.capabilities
  return RuntimeCapabilitySchema.array().parse(
    [
      'execution.cancel',
      'interaction.approval',
      'session.close',
      'session.create',
      'session.list',
      'session.resume',
      ...(supportsReplay ? ['session.history', 'session.load'] : []),
      'stream.events',
      'stream.output',
      'tool.call',
    ]
      .filter(
        (name) => reported === undefined || reported.includes(name as RuntimeCapability['name'])
      )
      .map((name) => ({ name, support: 'supported' as const }))
  )
}

function safeNativeDisplayName(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('://') ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  ) {
    return undefined
  }
  return value.slice(0, 128)
}

function normalizeHistory(
  updates: readonly AcpUpdate[],
  now: () => Date,
  afterSequence = 0
): Array<{ sequence: number; occurredAt: string; data: Record<string, z.util.JSONType> }> {
  return updates.flatMap((update, index) => {
    if (
      update.sessionUpdate !== 'agent_message' &&
      update.sessionUpdate !== 'agent_message_chunk'
    ) {
      return []
    }
    return [
      {
        sequence: afterSequence + index + 1,
        occurredAt: now().toISOString(),
        data: { type: 'output', text: update.text, messageId: update.messageId },
      },
    ]
  })
}

function acpPrompt(attemptId: string, plan: RuntimeExecutionPlanSnapshot): string {
  const contextPackage = z
    .object({ contextPackageId: z.string().min(1).max(512) })
    .passthrough()
    .safeParse(plan['contextPackage'])
  return [
    `Execute Control Plane plan ${plan.executionPlanId}.`,
    `Attempt reference: ${attemptId}.`,
    `Plan digest: ${plan.contentDigest}.`,
    ...(contextPackage.success
      ? [`Authorized context package: ${contextPackage.data.contextPackageId}.`]
      : []),
    'Preserve all native harness-owned behavior, instructions, plugins, tools, and session ownership.',
  ].join(' ')
}

function normalizeSnapshot(handle: RuntimeExecutionHandle, snapshotInput: AcpSnapshot) {
  const snapshot = AcpSnapshotSchema.parse(snapshotInput)
  if (snapshot.state === 'cancelled') {
    return RuntimeExecutionStatusSchema.parse({
      handle,
      state: 'cancelled',
      observedAt: snapshot.observedAt,
      ...(snapshot.usage === undefined ? {} : { terminalUsage: snapshot.usage }),
    })
  }
  if (snapshot.state === 'completed') {
    return RuntimeExecutionStatusSchema.parse({
      handle,
      state: 'completed',
      observedAt: snapshot.observedAt,
      result: {
        outcome: 'completed',
        ...(snapshot.output === undefined ? {} : { output: snapshot.output }),
        usage: snapshot.usage,
        artifacts: snapshot.artifacts,
      },
    })
  }
  if (snapshot.state === 'failed' || snapshot.state === 'timed_out') {
    return RuntimeExecutionStatusSchema.parse({
      handle,
      state: snapshot.state,
      observedAt: snapshot.observedAt,
      error: snapshot.error,
    })
  }
  return RuntimeExecutionStatusSchema.parse({
    handle,
    state: snapshot.state,
    observedAt: snapshot.observedAt,
  })
}

export type ReferenceAcpScenario = 'complete' | 'running' | 'timeout'

export interface ReferenceAcpTransportOptions {
  readonly now?: () => string
  readonly protocolVersion?: number
  readonly scenario?: ReferenceAcpScenario
  readonly nativeSessions?: readonly { readonly sessionId: string; readonly title?: string }[]
  readonly historyCompleteness?: AcpSessionReplay['completeness']
  readonly sessionReplay?: boolean
  readonly harnessVersion?: string
}

interface ReferenceSession {
  readonly attemptId: string
  readonly updates: AcpUpdate[]
  snapshot: AcpSnapshot
}

export class ReferenceAcpTransport implements AcpTransport {
  readonly #now: () => string
  readonly #protocolVersion: number
  readonly #scenario: ReferenceAcpScenario
  readonly #historyCompleteness: AcpSessionReplay['completeness']
  readonly #sessionReplay: boolean
  readonly #harnessVersion: string
  readonly #calls: AcpTransportCall[] = []
  readonly #responses: Array<{ requestId: number; result: Record<string, z.util.JSONType> }> = []
  readonly #sessions = new Map<string, ReferenceSession>()
  readonly #nativeSessions = new Map<
    string,
    { readonly sessionId: string; readonly title?: string }
  >()
  readonly #effects = new Map<string, number>()
  readonly #createdSessions = new Map<string, string>()
  readonly #pendingCreatedSessions = new Map<string, Promise<{ readonly sessionId: string }>>()
  #replays = 0
  #state: 'connected' | 'disconnected' = 'connected'

  constructor(options: ReferenceAcpTransportOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#protocolVersion = options.protocolVersion ?? 2
    this.#scenario = options.scenario ?? 'complete'
    this.#historyCompleteness = options.historyCompleteness ?? 'complete'
    this.#sessionReplay = options.sessionReplay ?? false
    this.#harnessVersion = SemanticVersionSchema.parse(options.harnessVersion ?? '2.4.0')
    for (const session of options.nativeSessions ?? []) {
      this.#nativeSessions.set(session.sessionId, structuredClone(session))
    }
  }

  connectionState(): 'connected' | 'disconnected' {
    return this.#state
  }

  async createSession(
    createToken: string,
    signal?: AbortSignal
  ): Promise<{ readonly sessionId: string }> {
    const existing = this.#createdSessions.get(createToken)
    if (existing) return { sessionId: existing }
    const pending = this.#pendingCreatedSessions.get(createToken)
    if (pending) return pending
    const created = this.request('session/new', {}, signal).then((result) => {
      const parsed = z.object({ sessionId: NativeSessionIdSchema }).strict().parse(result)
      this.#createdSessions.set(createToken, parsed.sessionId)
      return parsed
    })
    this.#pendingCreatedSessions.set(createToken, created)
    try {
      return await created
    } finally {
      if (this.#pendingCreatedSessions.get(createToken) === created) {
        this.#pendingCreatedSessions.delete(createToken)
      }
    }
  }

  async request(
    method: string,
    params: Record<string, z.util.JSONType>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error('ACP_REQUEST_ABORTED')
    if (this.#state === 'disconnected') throw new Error('ACP_DISCONNECTED')
    this.#calls.push({ method, params: structuredClone(params) })
    if (method === 'initialize') {
      return {
        protocolVersion: this.#protocolVersion,
        capabilities: { session: {} },
        info: {
          name: 'reference-acp-agent',
          title: 'Reference ACP Agent',
          version: this.#harnessVersion,
        },
        authMethods: [{ id: 'native-owned' }],
      }
    }
    if (method === 'session/new') {
      this.#nativeSessions.set('native-session-1', { sessionId: 'native-session-1' })
      return { sessionId: 'native-session-1' }
    }
    if (method === 'session/prompt') {
      const prompt = z
        .object({
          sessionId: NativeSessionIdSchema,
          prompt: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1),
        })
        .parse(params)
      const attemptId =
        prompt.prompt[0]?.text.match(/att_[0-9A-HJKMNP-TV-Z]{26}/)?.[0] ??
        [...this.#effects.keys()][0] ??
        'att_01JABCDEF0123456789ABCDEFG'
      this.#sessions.set(prompt.sessionId, referenceSession(attemptId, this.#scenario, this.#now()))
      this.#nativeSessions.set(prompt.sessionId, { sessionId: prompt.sessionId })
      this.#effects.set(attemptId, (this.#effects.get(attemptId) ?? 0) + 1)
      return {}
    }
    if (method === 'session/cancel') {
      const sessionId = NativeSessionIdSchema.parse(params['sessionId'])
      const session = this.#session(sessionId)
      session.snapshot = { state: 'cancelled', observedAt: this.#now() }
      return {}
    }
    if (method === 'session/list') {
      return { sessions: [...this.#nativeSessions.values()].map((session) => ({ ...session })) }
    }
    if (method === 'session/resume' || method === 'session/close') {
      const sessionId = NativeSessionIdSchema.parse(params['sessionId'])
      if (!this.#nativeSessions.has(sessionId)) {
        throw new RuntimeAdapterError({
          code: 'ACP_SESSION_NOT_FOUND',
          classification: 'unavailable',
          message: 'ACP session was not found',
          retryable: true,
        })
      }
      return {}
    }
    throw new Error('REFERENCE_ACP_METHOD_UNSUPPORTED')
  }

  async respond(requestId: number, result: Record<string, z.util.JSONType>): Promise<void> {
    this.#responses.push({ requestId, result: structuredClone(result) })
  }

  async *updates(nativeSessionId: string, signal?: AbortSignal): AsyncIterable<AcpUpdate> {
    for (const update of this.#session(nativeSessionId).updates) {
      if (signal?.aborted) return
      yield structuredClone(update)
    }
  }

  async snapshot(nativeSessionId: string): Promise<AcpSnapshot> {
    return structuredClone(this.#session(nativeSessionId).snapshot)
  }

  async cleanup(nativeSessionId: string): Promise<void> {
    this.#session(nativeSessionId)
  }

  async replay(
    nativeSessionId: string,
    options: { readonly afterSequence?: number } = {}
  ): Promise<AcpSessionReplay> {
    if (!this.#nativeSessions.has(nativeSessionId)) {
      throw new RuntimeAdapterError({
        code: 'ACP_SESSION_NOT_FOUND',
        classification: 'unavailable',
        message: 'ACP session was not found',
        retryable: true,
      })
    }
    this.#replays += 1
    const updates: AcpUpdate[] =
      this.#historyCompleteness === 'unavailable'
        ? []
        : [
            {
              sessionUpdate: 'agent_message',
              messageId: 'native-history-message-1',
              text: 'Earlier message',
            },
          ]
    return {
      completeness: this.#historyCompleteness,
      updates: updates.slice(options.afterSequence ?? 0),
    }
  }

  replaySupport(): boolean {
    return this.#sessionReplay
  }

  disconnect(): void {
    this.#state = 'disconnected'
  }

  connect(): void {
    this.#state = 'connected'
  }

  completeAttempt(attemptId: string): void {
    const session = [...this.#sessions.values()].find(
      (candidate) => candidate.attemptId === attemptId
    )
    if (!session) throw new Error('REFERENCE_ACP_SESSION_MISSING')
    session.snapshot = completedSnapshot(this.#now())
  }

  calls(): AcpTransportCall[] {
    return structuredClone(this.#calls)
  }

  responses(): Array<{ requestId: number; result: Record<string, z.util.JSONType> }> {
    return structuredClone(this.#responses)
  }

  effectCount(attemptId: string): number {
    return this.#effects.get(attemptId) ?? 0
  }

  replayCount(): number {
    return this.#replays
  }

  setNativeSessionTitle(nativeSessionId: string, title: string): void {
    const session = this.#nativeSessions.get(nativeSessionId)
    if (!session) throw new Error('REFERENCE_ACP_SESSION_MISSING')
    this.#nativeSessions.set(nativeSessionId, { ...session, title })
  }

  removeNativeSession(nativeSessionId: string): void {
    this.#nativeSessions.delete(nativeSessionId)
  }

  #session(nativeSessionId: string): ReferenceSession {
    const session = this.#sessions.get(nativeSessionId)
    if (!session) throw new Error('REFERENCE_ACP_SESSION_MISSING')
    return session
  }
}

function referenceSession(
  attemptId: string,
  scenario: ReferenceAcpScenario,
  observedAt: string
): ReferenceSession {
  const artifact = RuntimeArtifactReferenceSchema.parse({
    artifactId: 'art_01JABCDEF0123456789ABCDEFG',
    version: 1,
    mediaType: 'application/json',
    digest: `sha256:${'e'.repeat(64)}`,
    sizeBytes: 32,
    locator: 'artifact://acp/result',
  })
  const updates: AcpUpdate[] = [
    { sessionUpdate: 'state_update', state: 'running' },
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'native-message-1',
      text: 'ACP working',
    },
    {
      sessionUpdate: 'request_permission',
      requestId: 40,
      toolCallId: 'native-tool-call-1',
      title: 'Allow project read?',
      options: [
        { optionId: 'allow_once', kind: 'allow_once' },
        { optionId: 'reject', kind: 'reject' },
      ],
    },
    {
      sessionUpdate: 'usage_update',
      inputTokens: 12,
      outputTokens: 4,
      durationMs: 120,
    },
    { sessionUpdate: 'artifact', artifact },
    { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
  ].map((update) => AcpUpdateSchema.parse(update))
  const snapshot =
    scenario === 'complete'
      ? completedSnapshot(observedAt, artifact)
      : scenario === 'timeout'
        ? AcpSnapshotSchema.parse({
            state: 'timed_out',
            observedAt,
            error: {
              code: 'ACP_PROMPT_TIMED_OUT',
              classification: 'timeout',
              message: 'ACP prompt timed out',
              retryable: true,
            },
          })
        : AcpSnapshotSchema.parse({ state: 'running', observedAt })
  return { attemptId, updates, snapshot }
}

function completedSnapshot(
  observedAt: string,
  artifact = RuntimeArtifactReferenceSchema.parse({
    artifactId: 'art_01JABCDEF0123456789ABCDEFG',
    version: 1,
    mediaType: 'application/json',
    digest: `sha256:${'e'.repeat(64)}`,
    sizeBytes: 32,
    locator: 'artifact://acp/result',
  })
): AcpSnapshot {
  return AcpSnapshotSchema.parse({
    state: 'completed',
    observedAt,
    output: { text: 'ACP complete' },
    usage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
    artifacts: [artifact],
  })
}

function fail(
  code: string,
  classification: ConstructorParameters<typeof RuntimeAdapterError>[0]['classification'],
  retryable: boolean
): never {
  throw new RuntimeAdapterError({ code, classification, message: code, retryable })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) fail('ACP_REQUEST_TIMEOUT', 'timeout', true)
}

function withAbortSignal<Value>(
  signal: AbortSignal,
  operation: () => Promise<Value>
): Promise<Value> {
  if (signal.aborted) {
    return Promise.reject(
      new RuntimeAdapterError({
        code: 'ACP_REQUEST_TIMEOUT',
        classification: 'timeout',
        message: 'ACP_REQUEST_TIMEOUT',
        retryable: true,
      })
    )
  }
  return new Promise<Value>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      complete()
    }
    const abort = () =>
      finish(() =>
        reject(
          new RuntimeAdapterError({
            code: 'ACP_REQUEST_TIMEOUT',
            classification: 'timeout',
            message: 'ACP_REQUEST_TIMEOUT',
            retryable: true,
          })
        )
      )
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      )
  })
}

function withTimeout<Value>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<Value>,
  timeoutError: () => Error
): Promise<Value> {
  const controller = new AbortController()
  return new Promise<Value>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      complete()
    }
    const timer = setTimeout(() => {
      finish(() => reject(timeoutError()))
      controller.abort()
    }, timeoutMs)
    timer.unref?.()
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      )
  })
}

function stable(value: unknown): string {
  return JSON.stringify(value)
}

export * from './gateway.js'
export * from './stdio-client.js'
export * from './process-transport.js'
export * from './pinned-codex-build.js'
export * from './native-installation.js'
