import {
  GatewayEnvelopeSchema,
  GatewayHeartbeatEnvelopeSchema,
  GatewayHelloEnvelopeSchema,
  GatewayProtocolManifest,
  GatewayCommandEnvelopeSchema,
  negotiateGatewayProtocolVersion,
  type GatewayCommandEnvelope,
  type GatewayEnvelope,
  type GatewayHelloEnvelope,
  type GatewayProtocolVersion,
} from '@control-plane/runtime-gateway-protocol'
import type { RuntimeNodeChannel } from './authentication.js'
import {
  type ActiveRuntimeNodeChannelRecord,
  type GatewayMetrics,
  type RuntimeNodeCoordinationPort,
  type RuntimeNodeReachabilityPublisher,
} from './websocket-coordination.js'

export * from './websocket-coordination.js'
export * from './websocket-server.js'

export interface RuntimeGatewaySocket {
  bufferedAmount(): number
  send(value: string): void
  close(code: number, reason: string): void
}

export interface RuntimeGatewayConnectionInput {
  readonly connectionId: string
  readonly authenticatedChannel: RuntimeNodeChannel
  readonly socket: RuntimeGatewaySocket
}

export interface RuntimeGatewayWebSocketLimits {
  readonly maxConnections: number
  readonly maxConnectionsPerWorkspace: number
  readonly maxFrameBytes: number
  readonly maxBufferedBytes: number
  readonly heartbeatTimeoutMs: number
  readonly idleTimeoutMs: number
}

export interface RuntimeGatewayMessageHandler {
  handle(record: ActiveRuntimeNodeChannelRecord, envelope: GatewayEnvelope): Promise<void>
}

export interface RuntimeGatewayReconnectHandler {
  reconcile(
    hello: GatewayHelloEnvelope,
    record: ActiveRuntimeNodeChannelRecord
  ): Promise<{ readonly redelivered?: number; readonly expired?: number } | undefined>
}

export interface RuntimeGatewayPendingCommandHandler {
  dispatch(record: ActiveRuntimeNodeChannelRecord, sequence: number): Promise<number>
}

export interface RuntimeGatewayWebSocketLifecycleOptions {
  readonly instanceId: string
  readonly coordination: RuntimeNodeCoordinationPort
  readonly reachability: RuntimeNodeReachabilityPublisher
  readonly metrics: GatewayMetrics
  readonly limits: RuntimeGatewayWebSocketLimits
  readonly now?: () => Date
  readonly messages?: RuntimeGatewayMessageHandler
  readonly reconnect?: RuntimeGatewayReconnectHandler
  readonly pending?: RuntimeGatewayPendingCommandHandler
}

export class RuntimeGatewayOutboundError extends Error {
  constructor(
    readonly code:
      | 'RUNTIME_GATEWAY_CHANNEL_UNAVAILABLE'
      | 'RUNTIME_GATEWAY_CHANNEL_BACKPRESSURED'
      | 'RUNTIME_GATEWAY_COMMAND_TOO_LARGE'
  ) {
    super(code)
    this.name = 'RuntimeGatewayOutboundError'
  }
}

interface LocalConnection {
  readonly connectionId: string
  readonly authenticatedChannel: RuntimeNodeChannel
  readonly socket: RuntimeGatewaySocket
  state: 'awaiting_hello' | 'active' | 'closed'
  record?: ActiveRuntimeNodeChannelRecord
  degraded: boolean
  nextOutboundSequence: number
  pendingDispatch: boolean
}

export class RuntimeGatewayWebSocketLifecycle {
  readonly #connections = new Map<string, LocalConnection>()
  readonly #coordination: RuntimeNodeCoordinationPort
  readonly #instanceId: string
  readonly #limits: RuntimeGatewayWebSocketLimits
  readonly #messages: RuntimeGatewayMessageHandler | undefined
  readonly #metrics: GatewayMetrics
  readonly #now: () => Date
  readonly #pending: RuntimeGatewayPendingCommandHandler | undefined
  readonly #reachability: RuntimeNodeReachabilityPublisher
  readonly #reconnect: RuntimeGatewayReconnectHandler | undefined
  readonly #unsubscribe: () => void
  #draining = false

  constructor(options: RuntimeGatewayWebSocketLifecycleOptions) {
    this.#instanceId = options.instanceId
    this.#coordination = options.coordination
    this.#reachability = options.reachability
    this.#metrics = options.metrics
    this.#limits = validateLimits(options.limits)
    this.#now = options.now ?? (() => new Date())
    this.#messages = options.messages
    this.#reconnect = options.reconnect
    this.#pending = options.pending
    this.#unsubscribe = this.#coordination.subscribeReplacements(
      this.#instanceId,
      async (record) => {
        const connection = this.#connections.get(record.connectionId)
        if (connection?.record === undefined || !sameChannel(connection.record, record)) return
        await this.#disconnect(connection, 4001, 'stale_channel_replaced', false)
      }
    )
    this.#updateActiveGauge()
  }

  open(input: RuntimeGatewayConnectionInput): boolean {
    if (this.#draining) return this.#rejectOpen(input.socket, 1012, 'gateway_draining')
    if (this.#connections.has(input.connectionId)) {
      return this.#rejectOpen(input.socket, 1008, 'duplicate_connection_id')
    }
    if (this.#connections.size >= this.#limits.maxConnections) {
      return this.#rejectOpen(input.socket, 1013, 'connection_limit')
    }
    const workspaceConnections = [...this.#connections.values()].filter(
      ({ authenticatedChannel }) =>
        authenticatedChannel.claims.workspaceId === input.authenticatedChannel.claims.workspaceId
    ).length
    if (workspaceConnections >= this.#limits.maxConnectionsPerWorkspace) {
      return this.#rejectOpen(input.socket, 1013, 'workspace_connection_limit')
    }
    if (!input.authenticatedChannel.active) {
      return this.#rejectOpen(input.socket, 1008, 'authentication_invalidated')
    }

    this.#connections.set(input.connectionId, {
      ...input,
      state: 'awaiting_hello',
      degraded: false,
      nextOutboundSequence: 1,
      pendingDispatch: false,
    })
    return true
  }

  async receive(connectionId: string, frame: string | ArrayBuffer | Uint8Array): Promise<void> {
    const connection = this.#connections.get(connectionId)
    if (connection === undefined || connection.state === 'closed') return
    if (!connection.authenticatedChannel.active) {
      await this.#disconnect(connection, 1008, 'authentication_invalidated')
      return
    }
    if (connection.socket.bufferedAmount() > this.#limits.maxBufferedBytes) {
      await this.#disconnect(connection, 1013, 'backpressure_limit')
      return
    }
    if (frameSize(frame) > this.#limits.maxFrameBytes) {
      await this.#disconnect(connection, 1009, 'frame_too_large')
      return
    }
    const value = parseFrame(frame)
    if (value === undefined) {
      await this.#disconnect(connection, 1002, 'malformed_frame')
      return
    }

    if (connection.state === 'awaiting_hello') {
      await this.#activate(connection, value)
      return
    }
    await this.#handleActiveFrame(connection, value)
  }

  async disconnect(connectionId: string, reason = 'peer_disconnected'): Promise<void> {
    const connection = this.#connections.get(connectionId)
    if (connection !== undefined) await this.#disconnect(connection, 1000, reason)
  }

  async send(commandValue: GatewayCommandEnvelope): Promise<void> {
    const command = GatewayCommandEnvelopeSchema.parse(commandValue)
    const coordinated = await this.#coordination.lookup(command.nodeId)
    const connection =
      coordinated?.gatewayInstanceId === this.#instanceId
        ? this.#connections.get(coordinated.connectionId)
        : undefined
    if (
      coordinated === undefined ||
      connection?.state !== 'active' ||
      connection.record === undefined ||
      !sameChannel(connection.record, coordinated)
    ) {
      throw new RuntimeGatewayOutboundError('RUNTIME_GATEWAY_CHANNEL_UNAVAILABLE')
    }
    await connection.authenticatedChannel.assertCommandAllowed(command)
    const serialized = JSON.stringify(command)
    if (Buffer.byteLength(serialized) > this.#limits.maxFrameBytes) {
      throw new RuntimeGatewayOutboundError('RUNTIME_GATEWAY_COMMAND_TOO_LARGE')
    }
    if (connection.socket.bufferedAmount() > this.#limits.maxBufferedBytes) {
      throw new RuntimeGatewayOutboundError('RUNTIME_GATEWAY_CHANNEL_BACKPRESSURED')
    }
    connection.socket.send(serialized)
  }

  async closed(connectionId: string, reason = 'peer_disconnected'): Promise<void> {
    const connection = this.#connections.get(connectionId)
    if (connection !== undefined) await this.#disconnect(connection, 1000, reason, true, false)
  }

  async sweep(): Promise<void> {
    const now = this.#now()
    // Snapshot the live connection map: #disconnect deletes entries during iteration.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const connection of [...this.#connections.values()]) {
      if (connection.state !== 'active' || connection.record === undefined) continue
      const silenceMs = now.getTime() - Date.parse(connection.record.lastHeartbeatAt)
      if (silenceMs > this.#limits.idleTimeoutMs) {
        await this.#disconnect(connection, 4000, 'idle_timeout')
      } else if (silenceMs > this.#limits.heartbeatTimeoutMs && !connection.degraded) {
        connection.degraded = true
        await this.#publishReachability(connection.record, 'degraded', 'heartbeat_stale', now)
      }
    }
  }

  async close(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    // Snapshot the live connection map: #disconnect deletes entries during iteration.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const connection of [...this.#connections.values()]) {
      await this.#disconnect(connection, 1001, 'gateway_shutdown')
    }
    this.#unsubscribe()
  }

  async #activate(connection: LocalConnection, value: unknown): Promise<void> {
    const helloResult = GatewayHelloEnvelopeSchema.safeParse(value)
    if (!helloResult.success) {
      await this.#disconnect(connection, 1002, 'hello_required')
      return
    }
    const hello = helloResult.data
    const claims = connection.authenticatedChannel.claims
    if (
      hello.nodeId !== claims.nodeId ||
      hello.workspaceId !== claims.workspaceId ||
      hello.channelGeneration !== claims.channelGeneration
    ) {
      await this.#disconnect(connection, 1008, 'hello_scope_mismatch')
      return
    }
    const negotiated = negotiateGatewayProtocolVersion(
      GatewayProtocolManifest.supported,
      hello.supportedVersions
    )
    if (negotiated === undefined) {
      await this.#disconnect(connection, 1002, 'protocol_version_unsupported')
      return
    }

    const observedAt = this.#now().toISOString()
    const record: ActiveRuntimeNodeChannelRecord = {
      nodeId: claims.nodeId,
      workspaceId: claims.workspaceId,
      gatewayInstanceId: this.#instanceId,
      connectionId: connection.connectionId,
      channelGeneration: claims.channelGeneration,
      protocolVersion: negotiated,
      connectedAt: observedAt,
      lastHeartbeatAt: observedAt,
    }
    const claim = await this.#coordination.claim(record)
    if (!claim.accepted) {
      await this.#disconnect(connection, 4001, 'stale_channel_generation')
      return
    }
    connection.record = record
    connection.state = 'active'
    connection.nextOutboundSequence = hello.lastAcknowledgedSequence + 1
    if (claim.previous !== undefined) this.#metrics.increment('runtime_gateway.reconnects')
    this.#metrics.increment('runtime_gateway.protocol_version', {
      version: versionLabel(negotiated),
    })
    this.#updateActiveGauge()
    await this.#publishReachability(record, 'online', 'channel_established', this.#now())
    connection.socket.send(JSON.stringify(serverHello(record, hello.lastAcknowledgedSequence)))
    try {
      const recovery = await this.#reconnect?.reconcile(hello, record)
      connection.nextOutboundSequence += (recovery?.redelivered ?? 0) + (recovery?.expired ?? 0)
    } catch {
      await this.#disconnect(connection, 1011, 'reconnect_reconciliation_failed')
    }
  }

  async #handleActiveFrame(connection: LocalConnection, value: unknown): Promise<void> {
    const envelopeResult = GatewayEnvelopeSchema.safeParse(value)
    if (!envelopeResult.success || connection.record === undefined) {
      await this.#disconnect(connection, 1002, 'malformed_frame')
      return
    }
    const envelope = envelopeResult.data
    if (!matchesRecord(envelope, connection.record)) {
      await this.#disconnect(connection, 1008, 'frame_scope_mismatch')
      return
    }
    const heartbeat = GatewayHeartbeatEnvelopeSchema.safeParse(envelope)
    if (heartbeat.success) {
      await this.#heartbeat(connection, heartbeat.data.sentAt)
      return
    }
    if (this.#messages === undefined) {
      await this.#disconnect(connection, 1003, 'unsupported_frame')
      return
    }
    await this.#messages.handle(connection.record, envelope)
  }

  async #heartbeat(connection: LocalConnection, sentAt: string): Promise<void> {
    const record = connection.record
    if (record === undefined) return
    const now = this.#now()
    const next = { ...record, lastHeartbeatAt: now.toISOString() }
    if (!(await this.#coordination.heartbeat(next))) {
      await this.#disconnect(connection, 4001, 'channel_ownership_lost', false)
      return
    }
    connection.record = next
    connection.degraded = false
    this.#metrics.observe(
      'runtime_gateway.heartbeat_lag_ms',
      Math.max(0, now.getTime() - Date.parse(sentAt))
    )
    await this.#dispatchPending(connection)
  }

  async #dispatchPending(connection: LocalConnection): Promise<void> {
    if (
      this.#pending === undefined ||
      connection.record === undefined ||
      connection.pendingDispatch
    ) {
      return
    }
    connection.pendingDispatch = true
    try {
      const delivered = await this.#pending.dispatch(
        connection.record,
        connection.nextOutboundSequence
      )
      if (!Number.isSafeInteger(delivered) || delivered < 0 || delivered > 1_000) {
        throw new Error('RUNTIME_GATEWAY_PENDING_DISPATCH_INVALID')
      }
      connection.nextOutboundSequence += delivered
    } finally {
      connection.pendingDispatch = false
    }
  }

  async #disconnect(
    connection: LocalConnection,
    code: number,
    reason: string,
    publishOffline = true,
    closeSocket = true
  ): Promise<void> {
    if (connection.state === 'closed') return
    const record = connection.record
    connection.state = 'closed'
    this.#connections.delete(connection.connectionId)
    if (closeSocket) connection.socket.close(code, reason)
    let released = false
    if (record !== undefined) released = await this.#coordination.release(record)
    if (publishOffline && released && record !== undefined) {
      await this.#publishReachability(record, 'offline', reason, this.#now())
    }
    this.#metrics.increment('runtime_gateway.disconnects', { reason })
    this.#updateActiveGauge()
  }

  #rejectOpen(socket: RuntimeGatewaySocket, code: number, reason: string): false {
    socket.close(code, reason)
    this.#metrics.increment('runtime_gateway.disconnects', { reason })
    return false
  }

  async #publishReachability(
    record: ActiveRuntimeNodeChannelRecord,
    state: 'online' | 'degraded' | 'offline',
    reason: string,
    observedAt: Date
  ): Promise<void> {
    await this.#reachability.publish({
      nodeId: record.nodeId,
      workspaceId: record.workspaceId,
      channelGeneration: record.channelGeneration,
      state,
      reason,
      observedAt: observedAt.toISOString(),
    })
  }

  #updateActiveGauge(): void {
    const active = [...this.#connections.values()].filter(({ state }) => state === 'active').length
    this.#metrics.setGauge('runtime_gateway.active_nodes', active)
  }
}

function validateLimits(limits: RuntimeGatewayWebSocketLimits): RuntimeGatewayWebSocketLimits {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`)
  }
  if (limits.heartbeatTimeoutMs >= limits.idleTimeoutMs) {
    throw new Error('Heartbeat timeout must be less than idle timeout')
  }
  return { ...limits }
}

function parseFrame(frame: string | ArrayBuffer | Uint8Array): unknown | undefined {
  try {
    const text =
      typeof frame === 'string'
        ? frame
        : new TextDecoder().decode(frame instanceof Uint8Array ? frame : new Uint8Array(frame))
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function frameSize(frame: string | ArrayBuffer | Uint8Array): number {
  return typeof frame === 'string' ? Buffer.byteLength(frame) : frame.byteLength
}

function versionLabel(version: GatewayProtocolVersion): string {
  return `${version.major}.${version.minor}`
}

function serverHello(record: ActiveRuntimeNodeChannelRecord, lastAcknowledgedSequence: number) {
  return {
    type: 'hello' as const,
    schemaVersion: 1 as const,
    protocolVersion: record.protocolVersion,
    sequence: 0,
    nodeId: record.nodeId,
    workspaceId: record.workspaceId,
    traceId: 'trc_00000000000000000000000000',
    sentAt: record.connectedAt,
    channelGeneration: record.channelGeneration,
    supportedVersions: GatewayProtocolManifest.supported,
    lastAcknowledgedSequence,
  }
}

function matchesRecord(envelope: GatewayEnvelope, record: ActiveRuntimeNodeChannelRecord): boolean {
  return (
    envelope.nodeId === record.nodeId &&
    envelope.workspaceId === record.workspaceId &&
    envelope.channelGeneration === record.channelGeneration &&
    envelope.protocolVersion.major === record.protocolVersion.major &&
    envelope.protocolVersion.minor <= record.protocolVersion.minor
  )
}

function sameChannel(
  left: ActiveRuntimeNodeChannelRecord,
  right: ActiveRuntimeNodeChannelRecord
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.gatewayInstanceId === right.gatewayInstanceId &&
    left.connectionId === right.connectionId &&
    left.channelGeneration === right.channelGeneration
  )
}
