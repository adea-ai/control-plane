import {
  GatewayCommandEnvelopeSchema,
  GatewayInventoryEnvelopeSchema,
  GatewayProtocolManifest,
  ReferenceRuntimeNode,
  type GatewayCommandEnvelope,
  type GatewayInventoryEnvelope,
  type GatewayProtocolVersion,
} from '@control-plane/runtime-gateway-protocol'
import {
  MaximumGatewayOperations,
  type AcpGatewayConnectionState,
  type AcpGatewayExchange,
  type AcpGatewayTransport,
  type AcpLocalProjectGrantState,
} from './acp-gateway-types.js'
import type { ReferenceAcpDriver } from './acp-gateway-driver.js'
import { runtimeError, withGatewayTimeout } from './acp-gateway-protocol.js'

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
