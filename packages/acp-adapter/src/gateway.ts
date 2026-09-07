import { createHash } from 'node:crypto'
import {
  GatewayAcknowledgementEnvelopeSchema,
  GatewayCommandEnvelopeSchema,
  GatewayErrorEnvelopeSchema,
  GatewayInventoryEnvelopeSchema,
  GatewayProgressEnvelopeSchema,
  GatewayProtocolManifest,
  GatewayResultEnvelopeSchema,
  ReferenceRuntimeNode,
  negotiateGatewayProtocolVersion,
  type GatewayAcknowledgementEnvelope,
  type GatewayCommandEnvelope,
  type GatewayErrorEnvelope,
  type GatewayInventoryEnvelope,
  type GatewayProgressEnvelope,
  type GatewayProtocolVersion,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import {
  AcpSnapshotSchema,
  AcpUpdateSchema,
  ReferenceAcpTransport,
  type AcpSessionReplay,
  type AcpSnapshot,
  type AcpTransport,
  type AcpUpdate,
  type ReferenceAcpScenario,
} from './index.js'

const MaximumGatewayOperations = 1_024
const GrantReferenceSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^grant:[A-Za-z0-9._:-]+$/)
const SessionReferenceSchema = z
  .string()
  .regex(/^nses_[0-9A-HJKMNP-TV-Z]{26}$/, 'Expected an opaque ACP session reference')
const NativeSessionIdSchema = z.string().min(1).max(512)
const RuntimeErrorDataSchema = z
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

export type AcpGatewayConnectionState = 'online' | 'offline' | 'revoked'
export type AcpLocalProjectGrantState = 'granted' | 'missing' | 'revoked'

export interface AcpGatewayExchange {
  readonly ack: GatewayAcknowledgementEnvelope
  readonly progress: readonly GatewayProgressEnvelope[]
  readonly result?: GatewayResultEnvelope
  readonly error?: GatewayErrorEnvelope
}

export interface AcpGatewayTransport {
  inventory(signal?: AbortSignal): Promise<GatewayInventoryEnvelope>
  connectionState(): AcpGatewayConnectionState
  grantState(grantRef: string): AcpLocalProjectGrantState
  dispatch(command: GatewayCommandEnvelope, signal?: AbortSignal): Promise<AcpGatewayExchange>
}

export interface AcpGatewayClientOptions {
  readonly transport: AcpGatewayTransport
  readonly nodeId: string
  readonly workspaceId: string
  readonly runtimeConnectionId: string
  readonly executionId: string
  readonly attemptId: string
  readonly traceId: string
  readonly runtimeOpaqueRef: string
  readonly localProjectGrantRef: string
  readonly commandId: (identity: string) => string
  readonly now?: () => Date
  readonly commandTtlMs?: number
  readonly requestTimeoutMs?: number
}

export class AcpGatewayClient implements AcpTransport {
  readonly #transport: AcpGatewayTransport
  readonly #nodeId: string
  readonly #workspaceId: string
  readonly #runtimeConnectionId: string
  readonly #executionId: string
  readonly #defaultAttemptId: string
  readonly #traceId: string
  readonly #runtimeOpaqueRef: string
  readonly #localProjectGrantRef: string
  readonly #commandId: (identity: string) => string
  readonly #now: () => Date
  readonly #commandTtlMs: number
  readonly #requestTimeoutMs: number
  readonly #updates = new Map<string, AcpUpdate[]>()
  readonly #requestSessions = new Map<number, string>()
  readonly #pendingCreates = new Map<
    string,
    { readonly promise: Promise<{ readonly sessionId: string }>; readonly signal?: AbortSignal }
  >()
  #sequence = 1
  #readSequence = 1
  #createSequence = 0
  #gatewayOperationCount = 0

  constructor(options: AcpGatewayClientOptions) {
    this.#transport = options.transport
    this.#nodeId = options.nodeId
    this.#workspaceId = options.workspaceId
    this.#runtimeConnectionId = options.runtimeConnectionId
    this.#executionId = options.executionId
    this.#defaultAttemptId = options.attemptId
    this.#traceId = options.traceId
    this.#runtimeOpaqueRef = options.runtimeOpaqueRef
    this.#localProjectGrantRef = GrantReferenceSchema.parse(options.localProjectGrantRef)
    this.#commandId = options.commandId
    this.#now = options.now ?? (() => new Date())
    this.#commandTtlMs = options.commandTtlMs ?? 60_000
    this.#requestTimeoutMs = options.requestTimeoutMs ?? this.#commandTtlMs
    if (
      !Number.isSafeInteger(this.#commandTtlMs) ||
      this.#commandTtlMs < 1_000 ||
      this.#commandTtlMs > 3_600_000
    ) {
      throw new Error('INVALID_ACP_COMMAND_TTL')
    }
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs < 1 ||
      this.#requestTimeoutMs > 3_600_000
    ) {
      throw new Error('INVALID_ACP_GATEWAY_REQUEST_TIMEOUT')
    }
  }

  connectionState(): 'connected' | 'disconnected' {
    return this.#transport.connectionState() === 'online' ? 'connected' : 'disconnected'
  }

  async createSession(
    createToken: string,
    signal?: AbortSignal
  ): Promise<{ readonly sessionId: string }> {
    const pending = this.#pendingCreates.get(createToken)
    if (pending && !pending.signal?.aborted) return pending.promise
    const created = this.#sessionCommand(
      'new',
      'session.create',
      { createToken },
      signal,
      `create:${createToken}:${++this.#createSequence}`
    ).then((result) => z.object({ sessionId: SessionReferenceSchema }).strict().parse(result))
    this.#pendingCreates.set(createToken, {
      promise: created,
      ...(signal === undefined ? {} : { signal }),
    })
    try {
      return await created
    } finally {
      if (this.#pendingCreates.get(createToken)?.promise === created) {
        this.#pendingCreates.delete(createToken)
      }
    }
  }

  async request(
    method: string,
    params: Record<string, z.util.JSONType>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (method === 'initialize') {
      const driver = await this.#driver(signal)
      const exchange = await this.#dispatch(
        {
          operation: 'runtime.status',
          identity: `initialize:${stable(params)}`,
          requiredCapabilities: ['stream.events'],
          parameters: { action: 'initialize', request: params },
        },
        signal
      )
      this.#requireGrant()
      const initialize = z
        .record(z.string(), z.json())
        .parse(this.#successfulData(exchange)['initialize'])
      const capabilities = z.record(z.string(), z.json()).parse(initialize['capabilities'])
      return {
        ...initialize,
        capabilities: {
          ...capabilities,
          _meta: {
            controlPlane: {
              capabilities: driver.capabilities,
              driverVersion: driver.driverVersion,
            },
          },
        },
      }
    }
    if (method === 'session/new') {
      return this.createSession(`legacy:${stable(params)}`, signal)
    }
    if (method === 'session/list') {
      return this.#sessionCommand('list', 'session.list', {}, signal)
    }
    if (method === 'session/resume' || method === 'session/close') {
      const sessionRef = SessionReferenceSchema.parse(params['sessionId'])
      const action = method === 'session/resume' ? 'resume' : 'close'
      return this.#sessionCommand(action, `session.${action}`, { sessionRef }, signal)
    }
    if (method === 'session/prompt') {
      const prompt = z
        .object({
          sessionId: SessionReferenceSchema,
          prompt: z.array(z.record(z.string(), z.json())).min(1).max(64),
        })
        .strict()
        .parse(params)
      const attemptId =
        JSON.stringify(prompt.prompt).match(/att_[0-9A-HJKMNP-TV-Z]{26}/)?.[0] ??
        this.#defaultAttemptId
      const exchange = await this.#dispatch(
        {
          operation: 'runtime.execute',
          identity: `prompt:${attemptId}:${stable(prompt)}`,
          attemptId,
          requiredCapabilities: ['stream.output'],
          parameters: {
            sessionRef: prompt.sessionId,
            prompt: prompt.prompt,
            grantRef: this.#localProjectGrantRef,
          },
        },
        signal
      )
      this.#successfulData(exchange)
      const updates = exchange.progress.map(normalizeAcpProgress)
      this.#updates.set(prompt.sessionId, updates)
      for (const update of updates) {
        if (
          update.sessionUpdate === 'request_permission' ||
          update.sessionUpdate === 'elicitation'
        ) {
          this.#requestSessions.set(update.requestId, prompt.sessionId)
        }
      }
      return {}
    }
    if (method === 'session/cancel') {
      const sessionRef = SessionReferenceSchema.parse(params['sessionId'])
      const exchange = await this.#dispatch(
        {
          operation: 'runtime.cancel',
          identity: `cancel:${sessionRef}`,
          requiredCapabilities: ['execution.cancel'],
          parameters: { sessionRef, requestedAt: this.#now().toISOString() },
        },
        signal
      )
      this.#successfulData(exchange)
      return {}
    }
    throw runtimeError('ACP_GATEWAY_METHOD_UNSUPPORTED', 'unsupported', false)
  }

  async respond(
    requestId: number,
    result: Record<string, z.util.JSONType>,
    signal?: AbortSignal
  ): Promise<void> {
    const sessionRef = this.#requestSessions.get(requestId)
    if (!sessionRef) throw runtimeError('ACP_REQUEST_REFERENCE_MISSING', 'validation', false)
    const outcome = z
      .object({ outcome: z.object({ outcome: z.string() }).passthrough() })
      .parse(result)
    const approval = outcome.outcome.outcome === 'selected'
    const exchange = await this.#dispatch(
      {
        operation: approval ? 'runtime.approval' : 'runtime.input',
        identity: `respond:${requestId}:${stable(result)}`,
        requiredCapabilities: [approval ? 'interaction.approval' : 'interaction.user-input'],
        parameters: { sessionRef, requestId, response: result },
      },
      signal
    )
    this.#successfulData(exchange)
  }

  async *updates(sessionRefInput: string, signal?: AbortSignal): AsyncIterable<AcpUpdate> {
    const sessionRef = SessionReferenceSchema.parse(sessionRefInput)
    for (const update of this.#updates.get(sessionRef) ?? []) {
      if (signal?.aborted) return
      yield structuredClone(update)
    }
  }

  async snapshot(sessionRefInput: string, signal?: AbortSignal): Promise<AcpSnapshot> {
    const sessionRef = SessionReferenceSchema.parse(sessionRefInput)
    const exchange = await this.#dispatch(
      {
        operation: 'runtime.status',
        identity: `snapshot:${sessionRef}:${this.#readSequence++}`,
        requiredCapabilities: ['stream.events'],
        parameters: { action: 'snapshot', sessionRef },
      },
      signal
    )
    return AcpSnapshotSchema.parse(this.#successfulData(exchange)['snapshot'])
  }

  async cleanup(sessionRef: string): Promise<void> {
    SessionReferenceSchema.parse(sessionRef)
  }

  replaySupport(): boolean {
    return true
  }

  async replay(
    sessionRefInput: string,
    options: { readonly afterSequence?: number; readonly signal?: AbortSignal } = {}
  ): Promise<AcpSessionReplay> {
    const sessionRef = SessionReferenceSchema.parse(sessionRefInput)
    const result = await this.#sessionCommand(
      'replay',
      'session.history',
      {
        sessionRef,
        ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
      },
      options.signal
    )
    return z
      .object({
        updates: z.array(AcpUpdateSchema),
        completeness: z.enum(['complete', 'partial', 'unavailable']),
      })
      .parse(result)
  }

  async #sessionCommand(
    action: 'new' | 'list' | 'resume' | 'close' | 'replay',
    requiredCapability: string,
    parameters: Record<string, z.util.JSONType>,
    signal?: AbortSignal,
    identity = `session:${action}:${stable(parameters)}`
  ): Promise<Record<string, z.util.JSONType>> {
    const exchange = await this.#dispatch(
      {
        operation: 'runtime.session',
        identity,
        requiredCapabilities: [requiredCapability],
        parameters: { action, ...parameters },
      },
      signal
    )
    return this.#successfulData(exchange)
  }

  async #driver(signal?: AbortSignal) {
    const inventory = GatewayInventoryEnvelopeSchema.parse(
      await this.#gatewayCall((boundedSignal) => this.#transport.inventory(boundedSignal), signal)
    )
    if (
      !negotiateGatewayProtocolVersion(GatewayProtocolManifest.supported, [
        inventory.protocolVersion,
      ])
    ) {
      throw runtimeError('RUNTIME_GATEWAY_PROTOCOL_UNSUPPORTED', 'unsupported', false)
    }
    const driver = inventory.runtimeDrivers.find(
      (candidate) =>
        candidate.opaqueRef === this.#runtimeOpaqueRef && candidate.driverFamily === 'acp'
    )
    if (!driver) throw runtimeError('ACP_DRIVER_MISSING', 'unavailable', true)
    if (driver.protocolVersion.major !== 1 || driver.protocolVersion.minor < 5) {
      throw runtimeError('ACP_GATEWAY_DRIVER_PROTOCOL_UNSUPPORTED', 'unsupported', false)
    }
    return driver
  }

  #requireGrant(): void {
    const state = this.#transport.grantState(this.#localProjectGrantRef)
    if (state !== 'granted') {
      throw runtimeError(
        state === 'revoked' ? 'LOCAL_PROJECT_GRANT_REVOKED' : 'LOCAL_PROJECT_GRANT_MISSING',
        'validation',
        false
      )
    }
  }

  async #dispatch(
    input: {
      readonly operation: GatewayCommandEnvelope['operation']
      readonly identity: string
      readonly attemptId?: string
      readonly requiredCapabilities: readonly string[]
      readonly parameters: Record<string, z.util.JSONType>
    },
    signal?: AbortSignal
  ): Promise<AcpGatewayExchange> {
    if (this.#transport.connectionState() !== 'online') {
      throw runtimeError('RUNTIME_GATEWAY_UNAVAILABLE', 'unavailable', true)
    }
    await this.#driver(signal)
    const issuedAt = this.#now()
    const payload = { version: 1, parameters: input.parameters }
    const identity = `${input.operation}:${input.identity}`
    const command = GatewayCommandEnvelopeSchema.parse({
      type: 'command',
      schemaVersion: 1,
      protocolVersion: GatewayProtocolManifest.current,
      sequence: this.#sequence++,
      nodeId: this.#nodeId,
      workspaceId: this.#workspaceId,
      traceId: this.#traceId,
      sentAt: issuedAt.toISOString(),
      channelGeneration: 1,
      commandId: this.#commandId(identity),
      idempotencyKey: gatewayIdempotencyKey(identity),
      payloadHash: digest(payload),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.#commandTtlMs).toISOString(),
      family: 'runtime',
      operation: input.operation,
      driver: { family: 'acp', version: '1.0.0' },
      runtimeConnectionId: this.#runtimeConnectionId,
      executionId: this.#executionId,
      attemptId: input.attemptId ?? this.#defaultAttemptId,
      requiredCapabilities: [...new Set(input.requiredCapabilities)].sort(),
      payload,
    })
    try {
      const exchange = await this.#gatewayCall(
        (boundedSignal) => this.#transport.dispatch(command, boundedSignal),
        signal
      )
      assertExchange(command, exchange)
      return exchange
    } catch (error) {
      if (error instanceof RuntimeAdapterError) throw error
      throw runtimeError('RUNTIME_GATEWAY_UNAVAILABLE', 'unavailable', true)
    }
  }

  #gatewayCall<Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
    upstreamSignal?: AbortSignal
  ): Promise<Value> {
    return withGatewayTimeout(
      this.#requestTimeoutMs,
      (signal) => this.#gatewayOperation(() => operation(signal)),
      upstreamSignal
    )
  }

  #gatewayOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.#gatewayOperationCount >= MaximumGatewayOperations) {
      throw runtimeError('RUNTIME_GATEWAY_BACKPRESSURE', 'unavailable', true)
    }
    this.#gatewayOperationCount += 1
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.#gatewayOperationCount -= 1
      })
  }

  #successfulData(exchange: AcpGatewayExchange): Record<string, z.util.JSONType> {
    if (exchange.error) {
      throw runtimeError(exchange.error.code, 'infrastructure', exchange.error.retryable)
    }
    if (exchange.ack.disposition === 'expired' || exchange.ack.disposition === 'rejected') {
      throw runtimeError(
        exchange.ack.disposition === 'expired'
          ? 'RUNTIME_GATEWAY_COMMAND_EXPIRED'
          : 'RUNTIME_GATEWAY_COMMAND_REJECTED',
        exchange.ack.disposition === 'expired' ? 'timeout' : 'validation',
        false
      )
    }
    if (!exchange.result || !('data' in exchange.result.result)) {
      throw runtimeError('RUNTIME_GATEWAY_RESULT_MISSING', 'unknown', false)
    }
    const data = exchange.result.result.data
    if (exchange.result.status === 'failed') {
      throw new RuntimeAdapterError(RuntimeErrorDataSchema.parse(data['error']))
    }
    if (exchange.result.status === 'cancelled') {
      throw runtimeError('RUNTIME_GATEWAY_COMMAND_CANCELLED', 'cancelled', false)
    }
    return data
  }
}

export interface ReferenceAcpDriverOptions {
  readonly now?: () => string
  readonly scenario?: ReferenceAcpScenario
  readonly protocolVersion?: number
  readonly nativeSessions?: readonly { readonly sessionId: string; readonly title?: string }[]
  readonly sessionReplay?: boolean
}

export class ReferenceAcpDriver {
  readonly #now: () => string
  readonly #harness: ReferenceAcpTransport
  readonly #grants = new Map<string, AcpLocalProjectGrantState>()
  readonly #nativeByReference = new Map<string, string>()
  readonly #referenceByNative = new Map<string, string>()
  readonly #effects = new Map<string, number>()
  readonly #nativeState = {
    authenticationOwner: 'native_harness',
    configurationOwner: 'native_harness',
    sessionFilesOwner: 'native_harness',
  }
  #nextReference = 0

  constructor(options: ReferenceAcpDriverOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#harness = new ReferenceAcpTransport({
      now: this.#now,
      ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
      ...(options.protocolVersion === undefined
        ? {}
        : { protocolVersion: options.protocolVersion }),
      ...(options.nativeSessions === undefined ? {} : { nativeSessions: options.nativeSessions }),
      ...(options.sessionReplay === undefined ? {} : { sessionReplay: options.sessionReplay }),
    })
  }

  setGrantState(grantRef: string, state: AcpLocalProjectGrantState): void {
    this.#grants.set(GrantReferenceSchema.parse(grantRef), state)
  }

  grantState(grantRef: string): AcpLocalProjectGrantState {
    return this.#grants.get(GrantReferenceSchema.parse(grantRef)) ?? 'missing'
  }

  nativeState() {
    return structuredClone(this.#nativeState)
  }

  effectCount(attemptId: string, operation: GatewayCommandEnvelope['operation']): number {
    return this.#effects.get(`${attemptId}:${operation}`) ?? 0
  }

  async handle(commandInput: GatewayCommandEnvelope): Promise<{
    readonly progress: GatewayProgressEnvelope[]
    readonly result: GatewayResultEnvelope
  }> {
    const command = GatewayCommandEnvelopeSchema.parse(commandInput)
    this.#increment(command)
    try {
      if (command.operation === 'runtime.execute') return this.#execute(command)
      if (command.operation === 'runtime.status') return this.#status(command)
      if (command.operation === 'runtime.session') return this.#session(command)
      if (command.operation === 'runtime.cancel') return this.#cancel(command)
      if (command.operation === 'runtime.approval' || command.operation === 'runtime.input') {
        return this.#respond(command)
      }
      return {
        progress: [],
        result: failureResult(
          command,
          'ACP_OPERATION_UNSUPPORTED',
          'unsupported',
          false,
          this.#now()
        ),
      }
    } catch (error) {
      const normalized =
        error instanceof RuntimeAdapterError
          ? error
          : runtimeError('ACP_DRIVER_FAILURE', 'runtime', true)
      return {
        progress: [],
        result: failureResult(
          command,
          normalized.code,
          normalized.classification,
          normalized.retryable,
          this.#now()
        ),
      }
    }
  }

  async #execute(command: GatewayCommandEnvelope) {
    const parameters = z
      .object({
        sessionRef: SessionReferenceSchema,
        prompt: z.array(z.record(z.string(), z.json())).min(1).max(64),
        grantRef: GrantReferenceSchema,
      })
      .strict()
      .parse(inlineParameters(command))
    const grant = this.grantState(parameters.grantRef)
    if (grant !== 'granted') {
      return {
        progress: [],
        result: failureResult(
          command,
          grant === 'revoked' ? 'LOCAL_PROJECT_GRANT_REVOKED' : 'LOCAL_PROJECT_GRANT_MISSING',
          'validation',
          false,
          this.#now()
        ),
      }
    }
    const nativeSessionId = this.#native(parameters.sessionRef)
    await this.#harness.request('session/prompt', {
      sessionId: nativeSessionId,
      prompt: parameters.prompt,
    })
    const updates: AcpUpdate[] = []
    for await (const update of this.#harness.updates(nativeSessionId)) updates.push(update)
    return {
      progress: updates.map((update, index) => progressEnvelope(command, update, index + 1)),
      result: successResult(command, {}, this.#now()),
    }
  }

  async #status(command: GatewayCommandEnvelope) {
    const parameters = z
      .union([
        z
          .object({ action: z.literal('initialize'), request: z.record(z.string(), z.json()) })
          .strict(),
        z.object({ action: z.literal('snapshot'), sessionRef: SessionReferenceSchema }).strict(),
      ])
      .parse(inlineParameters(command))
    if (parameters.action === 'initialize') {
      const initialize = await this.#harness.request('initialize', parameters.request)
      return { progress: [], result: successResult(command, { initialize }, this.#now()) }
    }
    const snapshot = await this.#harness.snapshot(this.#native(parameters.sessionRef))
    return { progress: [], result: successResult(command, { snapshot }, this.#now()) }
  }

  async #session(command: GatewayCommandEnvelope) {
    const parameters = z
      .object({
        action: z.enum(['new', 'list', 'resume', 'close', 'replay']),
        sessionRef: SessionReferenceSchema.optional(),
        afterSequence: z.number().int().nonnegative().optional(),
        createToken: z.string().min(1).max(256).optional(),
      })
      .strict()
      .parse(inlineParameters(command))
    if (parameters.action === 'new') {
      const result = await this.#harness.createSession(
        parameters.createToken ?? `gateway-command:${command.commandId}`
      )
      return {
        progress: [],
        result: successResult(
          command,
          { sessionId: this.#reference(result.sessionId) },
          this.#now()
        ),
      }
    }
    if (parameters.action === 'list') {
      const result = z
        .object({
          sessions: z.array(
            z
              .object({ sessionId: NativeSessionIdSchema, title: z.string().optional() })
              .passthrough()
          ),
        })
        .parse(await this.#harness.request('session/list', {}))
      return {
        progress: [],
        result: successResult(
          command,
          {
            sessions: result.sessions.map(({ sessionId, title }) => ({
              sessionId: this.#reference(sessionId),
              ...(title === undefined ? {} : { title }),
            })),
          },
          this.#now()
        ),
      }
    }
    if (!parameters.sessionRef)
      throw runtimeError('ACP_SESSION_REFERENCE_MISSING', 'validation', false)
    const nativeSessionId = this.#native(parameters.sessionRef)
    if (parameters.action === 'replay') {
      const replay = await this.#harness.replay(
        nativeSessionId,
        parameters.afterSequence === undefined ? {} : { afterSequence: parameters.afterSequence }
      )
      return { progress: [], result: successResult(command, replay, this.#now()) }
    }
    await this.#harness.request(`session/${parameters.action}`, { sessionId: nativeSessionId })
    return { progress: [], result: successResult(command, {}, this.#now()) }
  }

  async #cancel(command: GatewayCommandEnvelope) {
    const parameters = z
      .object({ sessionRef: SessionReferenceSchema, requestedAt: z.iso.datetime() })
      .strict()
      .parse(inlineParameters(command))
    const nativeSessionId = this.#native(parameters.sessionRef)
    await this.#harness.request('session/cancel', { sessionId: nativeSessionId })
    return { progress: [], result: successResult(command, {}, this.#now()) }
  }

  async #respond(command: GatewayCommandEnvelope) {
    const parameters = z
      .object({
        sessionRef: SessionReferenceSchema,
        requestId: z.number().int().nonnegative(),
        response: z.record(z.string(), z.json()),
      })
      .strict()
      .parse(inlineParameters(command))
    this.#native(parameters.sessionRef)
    await this.#harness.respond(parameters.requestId, parameters.response)
    return { progress: [], result: successResult(command, {}, this.#now()) }
  }

  #reference(nativeSessionId: string): string {
    const existing = this.#referenceByNative.get(nativeSessionId)
    if (existing) return existing
    const values = [
      'nses_01JABCDEF0123456789ABCDEFG',
      'nses_01JBBCDEF0123456789ABCDEFG',
      'nses_01JDBCDEF0123456789ABCDEFG',
    ]
    const sessionRef = values[this.#nextReference++]
    if (!sessionRef) throw runtimeError('ACP_SESSION_REFERENCE_CAPACITY', 'infrastructure', false)
    this.#referenceByNative.set(nativeSessionId, sessionRef)
    this.#nativeByReference.set(sessionRef, nativeSessionId)
    return sessionRef
  }

  #native(sessionRef: string): string {
    const native = this.#nativeByReference.get(sessionRef)
    if (!native) throw runtimeError('ACP_SESSION_REFERENCE_STALE', 'unavailable', true)
    return native
  }

  #increment(command: GatewayCommandEnvelope): void {
    const key = `${command.attemptId}:${command.operation}`
    this.#effects.set(key, (this.#effects.get(key) ?? 0) + 1)
  }
}

export interface ReferenceAcpGatewayTransportOptions {
  readonly driver: ReferenceAcpDriver
  readonly nodeId: string
  readonly workspaceId: string
  readonly runtimeConnectionId: string
  readonly runtimeOpaqueRef: string
  readonly now?: () => string
  readonly includeDriver?: boolean
  readonly gatewayProtocolVersion?: GatewayProtocolVersion
  readonly capabilities?: readonly string[]
}

export class ReferenceAcpGatewayTransport implements AcpGatewayTransport {
  readonly #driver: ReferenceAcpDriver
  readonly #node: ReferenceRuntimeNode
  readonly #nodeId: string
  readonly #workspaceId: string
  readonly #runtimeConnectionId: string
  readonly #runtimeOpaqueRef: string
  readonly #now: () => string
  readonly #gatewayProtocolVersion: GatewayProtocolVersion
  readonly #capabilities: readonly string[]
  readonly #commands = new Map<string, GatewayCommandEnvelope>()
  readonly #commandOrder: string[] = []
  readonly #exchanges = new Map<string, AcpGatewayExchange>()
  readonly #inFlight = new Map<string, Promise<AcpGatewayExchange>>()
  #handlerOperationCount = 0
  #includeDriver: boolean
  #driverRemoved = false
  #state: AcpGatewayConnectionState = 'online'

  constructor(options: ReferenceAcpGatewayTransportOptions) {
    this.#driver = options.driver
    this.#nodeId = options.nodeId
    this.#workspaceId = options.workspaceId
    this.#runtimeConnectionId = options.runtimeConnectionId
    this.#runtimeOpaqueRef = options.runtimeOpaqueRef
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#includeDriver = options.includeDriver ?? true
    this.#gatewayProtocolVersion = options.gatewayProtocolVersion ?? GatewayProtocolManifest.current
    this.#capabilities = options.capabilities ?? [
      'stream.output',
      'stream.events',
      'tool.call',
      'execution.cancel',
      'interaction.user-input',
      'interaction.approval',
      'session.create',
      'session.list',
      'session.resume',
      'session.close',
      'session.history',
      'session.load',
    ]
    this.#node = new ReferenceRuntimeNode({ now: () => new Date(this.#now()) })
  }

  async inventory(): Promise<GatewayInventoryEnvelope> {
    return GatewayInventoryEnvelopeSchema.parse({
      type: 'inventory',
      schemaVersion: 1,
      protocolVersion: this.#gatewayProtocolVersion,
      sequence: 1,
      nodeId: this.#nodeId,
      workspaceId: this.#workspaceId,
      traceId: 'trc_01JABCDEF0123456789ABCDEFG',
      sentAt: this.#now(),
      channelGeneration: 1,
      mode: 'snapshot',
      snapshotVersion: 1,
      observedAt: this.#now(),
      runtimeDrivers: this.#includeDriver
        ? [
            {
              opaqueRef: this.#runtimeOpaqueRef,
              driverFamily: 'acp',
              adapterVersion: '1.0.0',
              driverVersion: '1.0.0',
              harnessVersion: '2.4.0',
              protocolVersion: GatewayProtocolManifest.current,
              health: this.#state === 'online' ? 'healthy' : 'unavailable',
              capabilities: this.#capabilities,
              limitations: [],
            },
          ]
        : [],
      contextProviders: [],
    })
  }

  connectionState(): AcpGatewayConnectionState {
    return this.#driverRemoved ? 'offline' : this.#state
  }

  grantState(grantRef: string): AcpLocalProjectGrantState {
    return this.#driver.grantState(grantRef)
  }

  async dispatch(
    commandInput: GatewayCommandEnvelope,
    signal?: AbortSignal
  ): Promise<AcpGatewayExchange> {
    if (this.connectionState() !== 'online') throw new Error('REFERENCE_RUNTIME_NODE_UNAVAILABLE')
    const command = GatewayCommandEnvelopeSchema.parse(commandInput)
    if (
      command.nodeId !== this.#nodeId ||
      command.workspaceId !== this.#workspaceId ||
      command.runtimeConnectionId !== this.#runtimeConnectionId
    ) {
      throw new Error('REFERENCE_RUNTIME_NODE_SCOPE_MISMATCH')
    }
    const received = this.#node.receive(command)
    if (received.ack.disposition === 'replayed') {
      const replay = this.#exchanges.get(command.commandId)
      if (!replay) {
        const inFlight = this.#inFlight.get(command.commandId)
        if (!inFlight) throw new Error('REFERENCE_RUNTIME_NODE_REPLAY_MISSING')
        const completed = await inFlight
        return { ...structuredClone(completed), ack: received.ack }
      }
      return { ...structuredClone(replay), ack: received.ack }
    }
    const handling = (async () => {
      const handlerTimeoutMs = Math.max(
        1,
        Date.parse(command.expiresAt) - Date.parse(command.issuedAt)
      )
      const handled = await withGatewayTimeout(
        handlerTimeoutMs,
        () => this.#handlerOperation(() => this.#driver.handle(command)),
        signal
      )
      const exchange: AcpGatewayExchange = {
        ack: received.ack,
        progress: handled.progress,
        result: handled.result,
      }
      this.#commands.set(command.commandId, structuredClone(command))
      this.#commandOrder.push(command.commandId)
      this.#exchanges.set(command.commandId, structuredClone(exchange))
      return exchange
    })()
    this.#inFlight.set(command.commandId, handling)
    try {
      return await handling
    } finally {
      if (this.#inFlight.get(command.commandId) === handling) {
        this.#inFlight.delete(command.commandId)
      }
    }
  }

  disconnect(): void {
    this.#state = 'offline'
  }

  connect(): void {
    this.#state = 'online'
  }

  revokeNode(): void {
    this.#state = 'revoked'
  }

  removeDriver(): void {
    this.#includeDriver = false
    this.#driverRemoved = true
  }

  commands(): GatewayCommandEnvelope[] {
    return this.#commandOrder.map((commandId) => {
      const command = this.#commands.get(commandId)
      if (!command) throw new Error('REFERENCE_RUNTIME_NODE_COMMAND_MISSING')
      return structuredClone(command)
    })
  }

  inFlightCount(): number {
    return this.#inFlight.size
  }

  #handlerOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.#handlerOperationCount >= MaximumGatewayOperations) {
      throw runtimeError('RUNTIME_GATEWAY_BACKPRESSURE', 'unavailable', true)
    }
    this.#handlerOperationCount += 1
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        this.#handlerOperationCount -= 1
      })
  }

  async redeliver(commandId: string): Promise<AcpGatewayExchange> {
    const command = this.#commands.get(commandId)
    if (!command) throw new Error('REFERENCE_RUNTIME_NODE_COMMAND_MISSING')
    return this.dispatch(command)
  }
}

function normalizeAcpProgress(progressInput: GatewayProgressEnvelope): AcpUpdate {
  const progress = GatewayProgressEnvelopeSchema.parse(progressInput)
  if (progress.event.kind !== 'acp.update') {
    throw runtimeError('ACP_GATEWAY_EVENT_UNSUPPORTED', 'unsupported', false)
  }
  return AcpUpdateSchema.parse(progress.event.data)
}

function progressEnvelope(
  command: GatewayCommandEnvelope,
  update: AcpUpdate,
  eventSequence: number
): GatewayProgressEnvelope {
  return GatewayProgressEnvelopeSchema.parse({
    type: 'progress',
    schemaVersion: 1,
    protocolVersion: command.protocolVersion,
    sequence: command.sequence + eventSequence,
    nodeId: command.nodeId,
    workspaceId: command.workspaceId,
    traceId: command.traceId,
    sentAt: command.sentAt,
    channelGeneration: command.channelGeneration,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    eventSequence,
    event: { kind: 'acp.update', data: jsonRecord(update) },
  })
}

function successResult(
  command: GatewayCommandEnvelope,
  dataInput: unknown,
  completedAt: string
): GatewayResultEnvelope {
  return GatewayResultEnvelopeSchema.parse({
    type: 'result',
    schemaVersion: 1,
    protocolVersion: command.protocolVersion,
    sequence: command.sequence + 1,
    nodeId: command.nodeId,
    workspaceId: command.workspaceId,
    traceId: command.traceId,
    sentAt: completedAt,
    channelGeneration: command.channelGeneration,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    status: 'succeeded',
    completedAt,
    result: { data: jsonRecord(dataInput) },
  })
}

function failureResult(
  command: GatewayCommandEnvelope,
  code: string,
  classification: z.output<typeof RuntimeErrorDataSchema>['classification'],
  retryable: boolean,
  completedAt: string
): GatewayResultEnvelope {
  return GatewayResultEnvelopeSchema.parse({
    type: 'result',
    schemaVersion: 1,
    protocolVersion: command.protocolVersion,
    sequence: command.sequence + 1,
    nodeId: command.nodeId,
    workspaceId: command.workspaceId,
    traceId: command.traceId,
    sentAt: completedAt,
    channelGeneration: command.channelGeneration,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    status: 'failed',
    completedAt,
    result: { data: { error: errorData(code, classification, retryable) } },
  })
}

function runtimeError(
  code: string,
  classification: z.output<typeof RuntimeErrorDataSchema>['classification'],
  retryable: boolean
): RuntimeAdapterError {
  return new RuntimeAdapterError({ code, classification, message: code, retryable })
}

function withGatewayTimeout<Value>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<Value>,
  upstreamSignal?: AbortSignal
): Promise<Value> {
  const controller = new AbortController()
  return new Promise<Value>((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      upstreamSignal?.removeEventListener('abort', abort)
      complete()
    }
    const timeout = () => runtimeError('RUNTIME_GATEWAY_TIMEOUT', 'timeout', true)
    const abort = () => {
      finish(() => reject(timeout()))
      controller.abort()
    }
    const timer = setTimeout(abort, timeoutMs)
    timer.unref?.()
    if (upstreamSignal?.aborted) {
      abort()
      return
    }
    upstreamSignal?.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error))
      )
  })
}

function errorData(
  code: string,
  classification: z.output<typeof RuntimeErrorDataSchema>['classification'],
  retryable: boolean
) {
  return RuntimeErrorDataSchema.parse({ code, classification, message: code, retryable })
}

function inlineParameters(command: GatewayCommandEnvelope): Record<string, z.util.JSONType> {
  if (!('parameters' in command.payload)) throw new Error('ACP_INLINE_PAYLOAD_REQUIRED')
  return command.payload.parameters
}

function assertExchange(command: GatewayCommandEnvelope, exchange: AcpGatewayExchange): void {
  GatewayAcknowledgementEnvelopeSchema.parse(exchange.ack)
  if (
    exchange.ack.commandId !== command.commandId ||
    exchange.ack.payloadHash !== command.payloadHash ||
    exchange.progress.some(
      (event) => event.commandId !== command.commandId || event.payloadHash !== command.payloadHash
    ) ||
    (exchange.result !== undefined &&
      (exchange.result.commandId !== command.commandId ||
        exchange.result.payloadHash !== command.payloadHash)) ||
    (exchange.error !== undefined &&
      (exchange.error.commandId !== command.commandId ||
        exchange.error.payloadHash !== command.payloadHash))
  ) {
    throw runtimeError('RUNTIME_GATEWAY_CORRELATION_MISMATCH', 'infrastructure', false)
  }
  exchange.progress.forEach((event) => GatewayProgressEnvelopeSchema.parse(event))
  if (exchange.result) GatewayResultEnvelopeSchema.parse(exchange.result)
  if (exchange.error) GatewayErrorEnvelopeSchema.parse(exchange.error)
}

function gatewayIdempotencyKey(identity: string): string {
  return `acp:${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stable(value)).digest('hex')}`
}

function stable(value: unknown): string {
  return JSON.stringify(value)
}

function jsonRecord(value: unknown): Record<string, z.util.JSONType> {
  return z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)))
}
