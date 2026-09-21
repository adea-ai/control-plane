import {
  GatewayCommandEnvelopeSchema,
  GatewayInventoryEnvelopeSchema,
  GatewayProtocolManifest,
  GrantReferenceSchema,
  RuntimeErrorDataSchema,
  negotiateGatewayProtocolVersion,
  type GatewayCommandEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import { RuntimeAdapterError } from '@control-plane/runtime-sdk'
import { z } from 'zod'
import { AcpSnapshotSchema, AcpUpdateSchema, type AcpSnapshot, type AcpUpdate } from './acp-schemas.js'
import type { AcpSessionReplay, AcpTransport } from './acp-driver-types.js'
import {
  MaximumGatewayOperations,
  SessionReferenceSchema,
  type AcpGatewayClientOptions,
  type AcpGatewayExchange,
  type AcpGatewayTransport,
} from './acp-gateway-types.js'
import {
  assertExchange,
  digest,
  gatewayIdempotencyKey,
  normalizeAcpProgress,
  runtimeError,
  stable,
  withGatewayTimeout,
} from './acp-gateway-protocol.js'

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
      requiredCapabilities: [...new Set(input.requiredCapabilities)].toSorted(),
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
