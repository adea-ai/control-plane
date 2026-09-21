import {
  GatewayCommandEnvelopeSchema,
  GatewayInventoryEnvelopeSchema,
  GatewayProtocolManifest,
  ReferenceRuntimeNode,
  type GatewayCommandEnvelope,
  type GatewayInventoryEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import {
  type LocalProjectGrantState,
  type ManagedPiGatewayConnectionState,
  type ManagedPiGatewayExchange,
  type ManagedPiGatewayTransport,
} from './managed-pi-gateway-types.js'
import type { ReferenceManagedPiDriver } from './managed-pi-gateway-driver.js'

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
