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
  type GatewayAcknowledgementEnvelope,
  type GatewayCommandEnvelope,
  type GatewayErrorEnvelope,
  type GatewayInventoryEnvelope,
  type GatewayProgressEnvelope,
  type GatewayResultEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import {
  RuntimeAdapterError,
  RuntimeArtifactReferenceSchema,
  RuntimeCapabilitySchema,
  RuntimeExecutionHandleSchema,
  RuntimeSessionOperationSchema,
  type RuntimeApprovalRequest,
  type RuntimeCancelRequest,
  type RuntimeExecutionHandle,
  type RuntimeInputRequest,
  type RuntimeSessionOperation,
  type RuntimeSessionResult,
} from '@control-plane/runtime-sdk'
import { z } from 'zod'
import {
  ManagedPiConfigurationSchema,
  ManagedPiEventSchema,
  ManagedPiInspectionSchema,
  ManagedPiStatusSchema,
  type ManagedPiClient,
  type ManagedPiEvent,
  type ManagedPiInspection,
  type ManagedPiStartCommand,
  type ManagedPiStatus,
} from './index.js'

const GrantReferenceSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^grant:[A-Za-z0-9._:-]+$/)
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

export type ManagedPiGatewayConnectionState = 'online' | 'offline' | 'revoked'
export type LocalProjectGrantState = 'granted' | 'missing' | 'revoked'

export interface ManagedPiGatewayExchange {
  readonly ack: GatewayAcknowledgementEnvelope
  readonly progress: readonly GatewayProgressEnvelope[]
  readonly result?: GatewayResultEnvelope
  readonly error?: GatewayErrorEnvelope
}

export interface ManagedPiGatewayTransport {
  inventory(): Promise<GatewayInventoryEnvelope>
  connectionState(): ManagedPiGatewayConnectionState
  grantState(grantRef: string): LocalProjectGrantState
  dispatch(command: GatewayCommandEnvelope): Promise<ManagedPiGatewayExchange>
}

export interface ManagedPiGatewayClientOptions {
  readonly transport: ManagedPiGatewayTransport
  readonly nodeId: string
  readonly workspaceId: string
  readonly runtimeConnectionId: string
  readonly executionId: string
  readonly traceId: string
  readonly runtimeOpaqueRef: string
  readonly localProjectGrantRef: string
  readonly commandId: (identity: string) => string
  readonly now?: () => Date
  readonly commandTtlMs?: number
}

export class ManagedPiGatewayClient implements ManagedPiClient {
  readonly #transport: ManagedPiGatewayTransport
  readonly #nodeId: string
  readonly #workspaceId: string
  readonly #runtimeConnectionId: string
  readonly #executionId: string
  readonly #traceId: string
  readonly #runtimeOpaqueRef: string
  readonly #localProjectGrantRef: string
  readonly #commandId: (identity: string) => string
  readonly #now: () => Date
  readonly #commandTtlMs: number
  readonly #progress = new Map<string, ManagedPiEvent[]>()
  #sequence = 1
  #statusSequence = 1

  constructor(options: ManagedPiGatewayClientOptions) {
    this.#transport = options.transport
    this.#nodeId = options.nodeId
    this.#workspaceId = options.workspaceId
    this.#runtimeConnectionId = options.runtimeConnectionId
    this.#executionId = options.executionId
    this.#traceId = options.traceId
    this.#runtimeOpaqueRef = options.runtimeOpaqueRef
    this.#localProjectGrantRef = GrantReferenceSchema.parse(options.localProjectGrantRef)
    this.#commandId = options.commandId
    this.#now = options.now ?? (() => new Date())
    this.#commandTtlMs = options.commandTtlMs ?? 60_000
    if (
      !Number.isSafeInteger(this.#commandTtlMs) ||
      this.#commandTtlMs < 1_000 ||
      this.#commandTtlMs > 3_600_000
    ) {
      throw new Error('INVALID_MANAGED_PI_COMMAND_TTL')
    }
  }

  async inspect(): Promise<ManagedPiInspection> {
    const inventory = GatewayInventoryEnvelopeSchema.parse(await this.#transport.inventory())
    const driver = inventory.runtimeDrivers.find(
      (candidate) =>
        candidate.opaqueRef === this.#runtimeOpaqueRef && candidate.driverFamily === 'managed-pi'
    )
    if (!driver || driver.adapterVersion === undefined || driver.harnessVersion === undefined) {
      return unavailableInspection(inventory.observedAt, 'MANAGED_PI_DRIVER_MISSING')
    }
    const connectionState = this.#transport.connectionState()
    const grantState = this.#transport.grantState(this.#localProjectGrantRef)
    const stateLimitations = [
      ...(connectionState === 'online'
        ? []
        : [connectionState === 'revoked' ? 'RUNTIME_NODE_REVOKED' : 'RUNTIME_NODE_OFFLINE']),
      ...(grantState === 'granted'
        ? []
        : [
            grantState === 'revoked'
              ? 'LOCAL_PROJECT_GRANT_REVOKED'
              : 'LOCAL_PROJECT_GRANT_MISSING',
          ]),
    ]
    const capabilities = driver.capabilities.flatMap((name) => {
      const parsed = RuntimeCapabilitySchema.safeParse({ name, support: 'supported' })
      return parsed.success ? [parsed.data] : []
    })
    return ManagedPiInspectionSchema.parse({
      driverVersion: driver.driverVersion,
      runtimeVersion: driver.harnessVersion,
      protocolVersion: `${driver.protocolVersion.major}.${driver.protocolVersion.minor}.0`,
      health:
        connectionState === 'online' && grantState === 'granted' ? driver.health : 'unavailable',
      capabilities,
      limitations: [...driver.limitations, ...stateLimitations],
      observedAt: inventory.observedAt,
    })
  }

  async start(command: ManagedPiStartCommand): Promise<RuntimeExecutionHandle> {
    const exchange = await this.#dispatch({
      operation: 'runtime.execute',
      attemptId: command.attemptId,
      idempotencyKey: command.idempotencyKey,
      requiredCapabilities: command.configuration.runtimeRequirements.map(
        ({ capability }) => capability
      ),
      parameters: {
        configuration: command.configuration,
        grantRef: this.#localProjectGrantRef,
      },
    })
    const result = this.#successfulData(exchange)
    const handle = RuntimeExecutionHandleSchema.parse(result['handle'])
    this.#progress.set(
      handle.handleId,
      exchange.progress.map((event) => normalizeGatewayProgress(event))
    )
    return handle
  }

  async *progress(
    handleInput: RuntimeExecutionHandle,
    afterSequence = 0,
    signal?: AbortSignal
  ): AsyncIterable<ManagedPiEvent> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    for (const event of this.#progress.get(handle.handleId) ?? []) {
      if (signal?.aborted) return
      if (event.sequence > afterSequence) yield structuredClone(event)
    }
  }

  async submitInput(
    handle: RuntimeExecutionHandle,
    request: RuntimeInputRequest
  ): Promise<ManagedPiStatus> {
    return this.#controlStatus(
      handle,
      'runtime.input',
      request.idempotencyKey,
      'interaction.user-input',
      { interactionId: request.interactionId, text: request.text }
    )
  }

  async submitApproval(
    handle: RuntimeExecutionHandle,
    request: RuntimeApprovalRequest
  ): Promise<ManagedPiStatus> {
    return this.#controlStatus(
      handle,
      'runtime.approval',
      request.idempotencyKey,
      'interaction.approval',
      {
        interactionId: request.interactionId,
        decision: request.decision,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }
    )
  }

  async cancel(
    handle: RuntimeExecutionHandle,
    request: RuntimeCancelRequest
  ): Promise<ManagedPiStatus> {
    return this.#controlStatus(
      handle,
      'runtime.cancel',
      request.idempotencyKey,
      'execution.cancel',
      { requestedAt: request.requestedAt }
    )
  }

  async status(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus> {
    return this.#readStatus(handle, false)
  }

  async reconcile(handle: RuntimeExecutionHandle): Promise<ManagedPiStatus> {
    return this.#readStatus(handle, true)
  }

  async session(operation: RuntimeSessionOperation): Promise<RuntimeSessionResult> {
    RuntimeSessionOperationSchema.parse(operation)
    throw new RuntimeAdapterError({
      code: 'CAPABILITY_UNSUPPORTED',
      classification: 'unsupported',
      message: 'Managed Pi gateway sessions are not supported by this adapter version',
      retryable: false,
    })
  }

  async cleanup(handleInput: RuntimeExecutionHandle): Promise<void> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    this.#progress.delete(handle.handleId)
  }

  async #readStatus(
    handleInput: RuntimeExecutionHandle,
    reconcile: boolean
  ): Promise<ManagedPiStatus> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const identity = `status:${handle.handleId}:${reconcile}:${this.#statusSequence++}`
    const exchange = await this.#dispatch({
      operation: 'runtime.status',
      attemptId: handle.attemptId,
      idempotencyKey: identity,
      requiredCapabilities: ['stream.events'],
      parameters: { handleId: handle.handleId, reconcile },
    })
    return ManagedPiStatusSchema.parse(this.#successfulData(exchange)['status'])
  }

  async #controlStatus(
    handleInput: RuntimeExecutionHandle,
    operation: 'runtime.input' | 'runtime.approval' | 'runtime.cancel',
    idempotencyKey: string,
    requiredCapability: string,
    parameters: Record<string, z.util.JSONType>
  ): Promise<ManagedPiStatus> {
    const handle = RuntimeExecutionHandleSchema.parse(handleInput)
    const exchange = await this.#dispatch({
      operation,
      attemptId: handle.attemptId,
      idempotencyKey,
      requiredCapabilities: [requiredCapability],
      parameters: { handleId: handle.handleId, ...parameters },
    })
    return ManagedPiStatusSchema.parse(this.#successfulData(exchange)['status'])
  }

  async #dispatch(input: {
    readonly operation: GatewayCommandEnvelope['operation']
    readonly attemptId: string
    readonly idempotencyKey: string
    readonly requiredCapabilities: readonly string[]
    readonly parameters: Record<string, z.util.JSONType>
  }): Promise<ManagedPiGatewayExchange> {
    const issuedAt = this.#now()
    const payload = { version: 1, parameters: input.parameters }
    const identity = `${input.operation}:${input.idempotencyKey}`
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
      driver: { family: 'managed-pi', version: '1.0.0' },
      runtimeConnectionId: this.#runtimeConnectionId,
      executionId: this.#executionId,
      attemptId: input.attemptId,
      requiredCapabilities: [...new Set(input.requiredCapabilities)].sort(),
      payload,
    })
    try {
      const exchange = await this.#transport.dispatch(command)
      assertExchange(command, exchange)
      return exchange
    } catch (error) {
      if (error instanceof RuntimeAdapterError) throw error
      throw new RuntimeAdapterError({
        code: 'RUNTIME_GATEWAY_UNAVAILABLE',
        classification: 'unavailable',
        message: 'Runtime Gateway command delivery failed',
        retryable: true,
      })
    }
  }

  #successfulData(exchange: ManagedPiGatewayExchange): Record<string, z.util.JSONType> {
    if (exchange.error) {
      throw new RuntimeAdapterError({
        code: exchange.error.code,
        classification: 'infrastructure',
        message: exchange.error.code,
        retryable: exchange.error.retryable,
      })
    }
    if (exchange.ack.disposition === 'expired' || exchange.ack.disposition === 'rejected') {
      throw new RuntimeAdapterError({
        code:
          exchange.ack.disposition === 'expired'
            ? 'RUNTIME_GATEWAY_COMMAND_EXPIRED'
            : 'RUNTIME_GATEWAY_COMMAND_REJECTED',
        classification: exchange.ack.disposition === 'expired' ? 'timeout' : 'validation',
        message: `Runtime Gateway command ${exchange.ack.disposition}`,
        retryable: false,
      })
    }
    if (!exchange.result) {
      throw new RuntimeAdapterError({
        code: 'RUNTIME_GATEWAY_RESULT_MISSING',
        classification: 'unknown',
        message: 'Runtime Gateway command result is missing',
        retryable: false,
      })
    }
    if (!('data' in exchange.result.result)) {
      throw new RuntimeAdapterError({
        code: 'RUNTIME_GATEWAY_RESULT_UNSUPPORTED',
        classification: 'unsupported',
        message: 'Managed Pi command result must be inline normalized data',
        retryable: false,
      })
    }
    if (exchange.result.status === 'failed') {
      throw new RuntimeAdapterError(
        RuntimeErrorDataSchema.parse(exchange.result.result.data['error'])
      )
    }
    if (exchange.result.status === 'cancelled') {
      throw new RuntimeAdapterError({
        code: 'RUNTIME_GATEWAY_COMMAND_CANCELLED',
        classification: 'cancelled',
        message: 'Runtime Gateway command was cancelled',
        retryable: false,
      })
    }
    return exchange.result.result.data
  }
}

export type ReferenceManagedPiScenario =
  | 'complete'
  | 'running'
  | 'awaiting_input'
  | 'crash'
  | 'timeout'
  | 'ambiguous'

interface ReferenceExecution {
  readonly handle: RuntimeExecutionHandle
  readonly events: ManagedPiEvent[]
  status: ManagedPiStatus
}

export interface ReferenceManagedPiDriverOptions {
  readonly now?: () => string
  readonly scenario?: ReferenceManagedPiScenario
}

export class ReferenceManagedPiDriver {
  readonly #now: () => string
  readonly #scenario: ReferenceManagedPiScenario
  readonly #grants = new Map<string, LocalProjectGrantState>()
  readonly #executions = new Map<string, ReferenceExecution>()
  readonly #effects = new Map<string, number>()

  constructor(options: ReferenceManagedPiDriverOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#scenario = options.scenario ?? 'complete'
  }

  setGrantState(grantRef: string, state: LocalProjectGrantState): void {
    this.#grants.set(GrantReferenceSchema.parse(grantRef), state)
  }

  grantState(grantRef: string): LocalProjectGrantState {
    return this.#grants.get(GrantReferenceSchema.parse(grantRef)) ?? 'missing'
  }

  effectCount(attemptId: string, operation: GatewayCommandEnvelope['operation']): number {
    return this.#effects.get(`${attemptId}:${operation}`) ?? 0
  }

  handle(commandInput: GatewayCommandEnvelope): {
    readonly progress: GatewayProgressEnvelope[]
    readonly result: GatewayResultEnvelope
  } {
    const command = GatewayCommandEnvelopeSchema.parse(commandInput)
    this.#increment(command)
    switch (command.operation) {
      case 'runtime.execute':
        return this.#execute(command)
      case 'runtime.status':
        return this.#status(command)
      case 'runtime.input':
        return this.#input(command)
      case 'runtime.approval':
        return this.#approval(command)
      case 'runtime.cancel':
        return this.#cancel(command)
      default:
        return {
          progress: [],
          result: failureResult(
            command,
            'MANAGED_PI_OPERATION_UNSUPPORTED',
            'unsupported',
            false,
            this.#now()
          ),
        }
    }
  }

  #execute(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({
        configuration: ManagedPiConfigurationSchema,
        grantRef: GrantReferenceSchema,
      })
      .strict()
      .parse(inlineParameters(command))
    const grantState = this.grantState(parameters.grantRef)
    if (grantState !== 'granted') {
      return {
        progress: [],
        result: failureResult(
          command,
          grantState === 'revoked' ? 'LOCAL_PROJECT_GRANT_REVOKED' : 'LOCAL_PROJECT_GRANT_MISSING',
          'validation',
          false,
          this.#now()
        ),
      }
    }
    const handle = RuntimeExecutionHandleSchema.parse({
      handleId: `managed-pi:${command.attemptId}`,
      attemptId: command.attemptId,
      startedAt: this.#now(),
    })
    const execution = scenarioExecution(handle, this.#scenario, this.#now())
    this.#executions.set(handle.handleId, execution)
    return {
      progress: execution.events.map((event) => progressEnvelope(command, event)),
      result: successResult(command, { handle }, this.#now()),
    }
  }

  #status(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({ handleId: z.string().min(1).max(256), reconcile: z.boolean() })
      .strict()
      .parse(inlineParameters(command))
    const execution = this.#execution(parameters.handleId)
    return {
      progress: [],
      result: successResult(command, { status: execution.status }, this.#now()),
    }
  }

  #input(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({
        handleId: z.string().min(1).max(256),
        interactionId: z.string().min(1).max(512),
        text: z.string().min(1).max(1_000_000),
      })
      .strict()
      .parse(inlineParameters(command))
    const execution = this.#execution(parameters.handleId)
    if (execution.status.state === 'waiting_input') {
      execution.status = { state: 'running', observedAt: this.#now() }
    }
    return {
      progress: [],
      result: successResult(command, { status: execution.status }, this.#now()),
    }
  }

  #approval(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({
        handleId: z.string().min(1).max(256),
        interactionId: z.string().min(1).max(512),
        decision: z.enum(['approve', 'deny']),
        reason: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .parse(inlineParameters(command))
    const execution = this.#execution(parameters.handleId)
    if (execution.status.state === 'waiting_input') {
      execution.status = { state: 'running', observedAt: this.#now() }
    }
    return {
      progress: [],
      result: successResult(command, { status: execution.status }, this.#now()),
    }
  }

  #cancel(command: GatewayCommandEnvelope): {
    progress: GatewayProgressEnvelope[]
    result: GatewayResultEnvelope
  } {
    const parameters = z
      .object({
        handleId: z.string().min(1).max(256),
        requestedAt: z.iso.datetime(),
      })
      .strict()
      .parse(inlineParameters(command))
    const execution = this.#execution(parameters.handleId)
    execution.status = { state: 'cancelled', observedAt: parameters.requestedAt }
    return {
      progress: [],
      result: successResult(command, { status: execution.status }, this.#now()),
    }
  }

  #execution(handleId: string): ReferenceExecution {
    const execution = this.#executions.get(handleId)
    if (!execution) throw new Error('REFERENCE_MANAGED_PI_EXECUTION_MISSING')
    return execution
  }

  #increment(command: GatewayCommandEnvelope): void {
    const key = `${command.attemptId}:${command.operation}`
    this.#effects.set(key, (this.#effects.get(key) ?? 0) + 1)
  }
}

export interface ReferenceManagedPiGatewayTransportOptions {
  readonly driver: ReferenceManagedPiDriver
  readonly nodeId: string
  readonly workspaceId: string
  readonly runtimeConnectionId: string
  readonly runtimeOpaqueRef: string
  readonly now?: () => string
  readonly harnessVersion?: string
}

export class ReferenceManagedPiGatewayTransport implements ManagedPiGatewayTransport {
  readonly #driver: ReferenceManagedPiDriver
  readonly #node: ReferenceRuntimeNode
  readonly #nodeId: string
  readonly #workspaceId: string
  readonly #runtimeConnectionId: string
  readonly #runtimeOpaqueRef: string
  readonly #now: () => string
  readonly #harnessVersion: string
  readonly #commands = new Map<string, GatewayCommandEnvelope>()
  readonly #commandOrder: string[] = []
  readonly #exchanges = new Map<string, ManagedPiGatewayExchange>()
  #state: ManagedPiGatewayConnectionState = 'online'

  constructor(options: ReferenceManagedPiGatewayTransportOptions) {
    this.#driver = options.driver
    this.#nodeId = options.nodeId
    this.#workspaceId = options.workspaceId
    this.#runtimeConnectionId = options.runtimeConnectionId
    this.#runtimeOpaqueRef = options.runtimeOpaqueRef
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#harnessVersion = options.harnessVersion ?? '0.52.1'
    this.#node = new ReferenceRuntimeNode({ now: () => new Date(this.#now()) })
  }

  async inventory(): Promise<GatewayInventoryEnvelope> {
    return GatewayInventoryEnvelopeSchema.parse({
      type: 'inventory',
      schemaVersion: 1,
      protocolVersion: GatewayProtocolManifest.current,
      sequence: 1,
      nodeId: this.#nodeId,
      workspaceId: this.#workspaceId,
      traceId: 'trc_01JABCDEF0123456789ABCDEFG',
      sentAt: this.#now(),
      channelGeneration: 1,
      mode: 'snapshot',
      snapshotVersion: 1,
      observedAt: this.#now(),
      runtimeDrivers: [
        {
          opaqueRef: this.#runtimeOpaqueRef,
          driverFamily: 'managed-pi',
          adapterVersion: '1.0.0',
          driverVersion: '1.0.0',
          harnessVersion: this.#harnessVersion,
          protocolVersion: GatewayProtocolManifest.current,
          health: this.#state === 'online' ? 'healthy' : 'unavailable',
          capabilities: [
            'stream.output',
            'stream.events',
            'tool.call',
            'execution.cancel',
            'interaction.user-input',
            'interaction.approval',
          ],
          limitations: [],
        },
      ],
      contextProviders: [],
    })
  }

  connectionState(): ManagedPiGatewayConnectionState {
    return this.#state
  }

  grantState(grantRef: string): LocalProjectGrantState {
    return this.#driver.grantState(grantRef)
  }

  async dispatch(commandInput: GatewayCommandEnvelope): Promise<ManagedPiGatewayExchange> {
    if (this.#state !== 'online') throw new Error('REFERENCE_RUNTIME_NODE_UNAVAILABLE')
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
      if (!replay) throw new Error('REFERENCE_RUNTIME_NODE_REPLAY_MISSING')
      return { ...structuredClone(replay), ack: received.ack }
    }
    const handled = this.#driver.handle(command)
    const exchange: ManagedPiGatewayExchange = {
      ack: received.ack,
      progress: handled.progress,
      result: handled.result,
    }
    this.#commands.set(command.commandId, structuredClone(command))
    this.#commandOrder.push(command.commandId)
    this.#exchanges.set(command.commandId, structuredClone(exchange))
    return exchange
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

  commands(): GatewayCommandEnvelope[] {
    return this.#commandOrder.map((commandId) => {
      const command = this.#commands.get(commandId)
      if (!command) throw new Error('REFERENCE_RUNTIME_NODE_COMMAND_MISSING')
      return structuredClone(command)
    })
  }

  async redeliver(commandId: string): Promise<ManagedPiGatewayExchange> {
    const command = this.#commands.get(commandId)
    if (!command) throw new Error('REFERENCE_RUNTIME_NODE_COMMAND_MISSING')
    return this.dispatch(command)
  }
}

function unavailableInspection(observedAt: string, limitation: string): ManagedPiInspection {
  return ManagedPiInspectionSchema.parse({
    driverVersion: '0.0.0',
    runtimeVersion: '0.0.0',
    protocolVersion: '1.4.0',
    health: 'unavailable',
    capabilities: [],
    limitations: [limitation],
    observedAt,
  })
}

function normalizeGatewayProgress(progressInput: GatewayProgressEnvelope): ManagedPiEvent {
  const progress = GatewayProgressEnvelopeSchema.parse(progressInput)
  const common = { sequence: progress.eventSequence, occurredAt: progress.sentAt }
  switch (progress.event.kind) {
    case 'managed-pi.status':
      return ManagedPiEventSchema.parse({ ...common, kind: 'status', ...progress.event.data })
    case 'managed-pi.output':
      return ManagedPiEventSchema.parse({ ...common, kind: 'output', ...progress.event.data })
    case 'managed-pi.tool-request':
      return ManagedPiEventSchema.parse({ ...common, kind: 'tool_request', ...progress.event.data })
    case 'managed-pi.interaction':
      return ManagedPiEventSchema.parse({ ...common, kind: 'interaction', ...progress.event.data })
    case 'managed-pi.usage':
      return ManagedPiEventSchema.parse({ ...common, kind: 'usage', ...progress.event.data })
    case 'managed-pi.artifact':
      return ManagedPiEventSchema.parse({ ...common, kind: 'artifact', ...progress.event.data })
    case 'managed-pi.error':
      return ManagedPiEventSchema.parse({ ...common, kind: 'error', ...progress.event.data })
    default:
      throw new RuntimeAdapterError({
        code: 'MANAGED_PI_EVENT_UNSUPPORTED',
        classification: 'unsupported',
        message: 'Managed Pi progress event kind is unsupported',
        retryable: false,
      })
  }
}

function scenarioExecution(
  handle: RuntimeExecutionHandle,
  scenario: ReferenceManagedPiScenario,
  observedAt: string
): ReferenceExecution {
  const artifact = RuntimeArtifactReferenceSchema.parse({
    artifactId: 'art_01JABCDEF0123456789ABCDEFG',
    version: 1,
    mediaType: 'application/json',
    digest: `sha256:${'e'.repeat(64)}`,
    sizeBytes: 32,
    locator: 'artifact://managed-pi/result',
  })
  const commonEvents: ManagedPiEvent[] = [
    { sequence: 1, occurredAt: observedAt, kind: 'status', state: 'running' },
    { sequence: 2, occurredAt: observedAt, kind: 'output', text: 'managed Pi running' },
    {
      sequence: 3,
      occurredAt: observedAt,
      kind: 'tool_request',
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      toolId: 'project-files',
      operation: 'read',
    },
    {
      sequence: 4,
      occurredAt: observedAt,
      kind: 'usage',
      inputTokens: 12,
      outputTokens: 4,
      durationMs: 120,
    },
    { sequence: 5, occurredAt: observedAt, kind: 'artifact', artifact },
  ]
  if (scenario === 'complete') {
    const result = {
      output: { answer: 'managed-pi-complete' },
      usage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
      artifacts: [artifact],
    }
    return {
      handle,
      events: [
        ...commonEvents,
        { sequence: 6, occurredAt: observedAt, kind: 'status', state: 'succeeded' },
      ],
      status: { state: 'succeeded', observedAt, result },
    }
  }
  if (scenario === 'awaiting_input') {
    return {
      handle,
      events: [
        { sequence: 1, occurredAt: observedAt, kind: 'status', state: 'waiting_input' },
        {
          sequence: 2,
          occurredAt: observedAt,
          kind: 'interaction',
          interactionId: 'int_01JABCDEF0123456789ABCDEFG',
          interactionKind: 'input',
          prompt: 'Continue execution?',
        },
      ],
      status: { state: 'waiting_input', observedAt },
    }
  }
  if (scenario === 'running') {
    return { handle, events: commonEvents, status: { state: 'running', observedAt } }
  }
  const error =
    scenario === 'crash'
      ? runtimeError('PI_PROCESS_CRASHED', 'runtime', true)
      : scenario === 'timeout'
        ? runtimeError('PI_EXECUTION_TIMED_OUT', 'timeout', true)
        : runtimeError('PI_AMBIGUOUS_OUTCOME', 'unknown', false)
  const state = scenario === 'timeout' ? 'timed_out' : 'errored'
  return {
    handle,
    events: [
      { sequence: 1, occurredAt: observedAt, kind: 'status', state },
      { sequence: 2, occurredAt: observedAt, kind: 'error', error },
    ],
    status: { state, observedAt, error },
  }
}

function progressEnvelope(
  command: GatewayCommandEnvelope,
  event: ManagedPiEvent
): GatewayProgressEnvelope {
  const { sequence, occurredAt, kind, ...data } = event
  return GatewayProgressEnvelopeSchema.parse({
    type: 'progress',
    schemaVersion: 1,
    protocolVersion: command.protocolVersion,
    sequence: command.sequence + sequence,
    nodeId: command.nodeId,
    workspaceId: command.workspaceId,
    traceId: command.traceId,
    sentAt: occurredAt,
    channelGeneration: command.channelGeneration,
    commandId: command.commandId,
    payloadHash: command.payloadHash,
    eventSequence: sequence,
    event: { kind: `managed-pi.${kind.replaceAll('_', '-')}`, data },
  })
}

function successResult(
  command: GatewayCommandEnvelope,
  dataInput: unknown,
  completedAt: string
): GatewayResultEnvelope {
  const data = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(dataInput)))
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
    result: { data },
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
    result: { data: { error: runtimeError(code, classification, retryable) } },
  })
}

function runtimeError(
  code: string,
  classification: z.output<typeof RuntimeErrorDataSchema>['classification'],
  retryable: boolean
): z.output<typeof RuntimeErrorDataSchema> {
  return RuntimeErrorDataSchema.parse({ code, classification, message: code, retryable })
}

function inlineParameters(command: GatewayCommandEnvelope): Record<string, z.util.JSONType> {
  if (!('parameters' in command.payload)) throw new Error('MANAGED_PI_INLINE_PAYLOAD_REQUIRED')
  return command.payload.parameters
}

function assertExchange(command: GatewayCommandEnvelope, exchange: ManagedPiGatewayExchange): void {
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
    throw new RuntimeAdapterError({
      code: 'RUNTIME_GATEWAY_CORRELATION_MISMATCH',
      classification: 'infrastructure',
      message: 'Runtime Gateway response correlation failed',
      retryable: false,
    })
  }
  exchange.progress.forEach((event) => GatewayProgressEnvelopeSchema.parse(event))
  if (exchange.result) GatewayResultEnvelopeSchema.parse(exchange.result)
  if (exchange.error) GatewayErrorEnvelopeSchema.parse(exchange.error)
}

function gatewayIdempotencyKey(identity: string): string {
  return `managed-pi:${createHash('sha256').update(identity).digest('hex').slice(0, 48)}`
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
