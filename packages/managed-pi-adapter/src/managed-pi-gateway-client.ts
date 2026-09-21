import {
  GatewayCommandEnvelopeSchema,
  GatewayInventoryEnvelopeSchema,
  GatewayProtocolManifest,
  GrantReferenceSchema,
  RuntimeErrorDataSchema,
  type GatewayCommandEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import {
  RuntimeAdapterError,
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
  ManagedPiInspectionSchema,
  ManagedPiStatusSchema,
  type ManagedPiClient,
  type ManagedPiEvent,
  type ManagedPiInspection,
  type ManagedPiStartCommand,
  type ManagedPiStatus,
} from './index.js'
import {
  type ManagedPiGatewayClientOptions,
  type ManagedPiGatewayExchange,
  type ManagedPiGatewayTransport,
} from './managed-pi-gateway-types.js'
import {
  assertExchange,
  digest,
  gatewayIdempotencyKey,
  normalizeGatewayProgress,
  unavailableInspection,
} from './managed-pi-gateway-protocol.js'

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
      requiredCapabilities: [...new Set(input.requiredCapabilities)].toSorted(),
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
