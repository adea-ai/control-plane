import { describe, expect, test } from 'bun:test'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import { RuntimeNodeChannel } from './authentication.js'
import {
  InMemoryRuntimeNodeCoordination,
  RepositoryRuntimeNodeCoordination,
  RecordingGatewayMetrics,
  RecordingRuntimeNodeReachabilityPublisher,
  RuntimeGatewayWebSocketServer,
  RuntimeGatewayWebSocketLifecycle,
} from './websocket-lifecycle.js'

const nodeId = 'rnr_01JABCDEF0123456789ABCDEFG'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const otherNodeId = 'rnr_01JBBCDEF0123456789ABCDEFG'

describe('Runtime Gateway WebSocket lifecycle', () => {
  test('recovers bounded context pages on connection and heartbeat and resets cursor on replacement', async () => {
    const calls = []
    const signals = []
    let next = 1
    const contextRecovery = {
      recover: async (source, allocate, cursor, signal) => {
        signals.push(signal)
        calls.push([source.channelGeneration, await allocate(), cursor])
        return cursor ? {} : { nextAfterCommandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV' }
      },
    }
    const sequences = { reserve: async () => next++ }
    expect(() =>
      setup(
        'missing-sequences',
        undefined,
        undefined,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        contextRecovery
      )
    ).toThrow('DURABLE_SEQUENCE_REQUIRED')
    const f = setup(
      'context-pages',
      undefined,
      undefined,
      {},
      undefined,
      undefined,
      sequences,
      undefined,
      contextRecovery
    )
    try {
      f.gateway.open(connection('first', channel(1), new FakeSocket()))
      await f.gateway.receive('first', JSON.stringify(hello(1)))
      await f.gateway.receive('first', JSON.stringify(golden.heartbeat))
      f.gateway.open(connection('second', channel(2), new FakeSocket()))
      await f.gateway.receive('second', JSON.stringify(hello(2)))
      expect(calls).toEqual([
        [1, 1, undefined],
        [1, 2, 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV'],
        [2, 3, undefined],
      ])
      expect(signals[0].aborted).toBe(true)
      expect(signals[2].aborted).toBe(false)
    } finally {
      await f.gateway.close()
    }
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })
  test('shares durable sequence reservations across reconnect, direct reads and pending runtime dispatch', async () => {
    let next = 100
    const reserved = []
    const sequences = {
      reserve: async ({ minimum, count }) => {
        const first = Math.max(next, minimum)
        next = first + count
        reserved.push(first)
        return first
      },
    }
    const pending = {
      dispatch: async (_, first, allocate) => {
        expect(first).toBe(102)
        expect(await allocate()).toBe(102)
        return 1
      },
    }
    const reconnect = {
      reconcile: async (_, __, allocate) => {
        expect(await allocate()).toBe(100)
        return { redelivered: 1 }
      },
    }
    const fixture = setup(
      'sequence-gateway',
      undefined,
      undefined,
      {},
      undefined,
      pending,
      sequences,
      reconnect
    )
    try {
      fixture.gateway.open(connection('sequence-channel', channel(1), new FakeSocket()))
      await fixture.gateway.receive('sequence-channel', JSON.stringify(golden.hello))
      const source = await fixture.coordination.lookup(nodeId)
      expect(await fixture.gateway.nextSequence(source)).toBe(101)
      await fixture.gateway.receive(
        'sequence-channel',
        JSON.stringify({ ...golden.heartbeat, sentAt: '2026-08-25T12:00:02.000Z' })
      )
      expect(await fixture.gateway.nextSequence(source)).toBe(103)
      await expect(
        fixture.gateway.nextSequence({ ...source, connectionId: 'stale-channel' })
      ).rejects.toThrow('CHANNEL_UNAVAILABLE')
      expect(reserved).toEqual([100, 101, 102, 103])
    } finally {
      await fixture.gateway.close()
    }
  })
  test.each(['frame', 'sweep', 'send', 'awaiting-hello'])(
    'stops expired credential authority through %s',
    async (trigger) => {
      let clock = new Date('2026-08-25T12:00:01.000Z')
      const now = () => clock
      const delivered = []
      const fixture = setup(
        'gateway-a',
        undefined,
        now,
        {},
        {
          handle: async (...args) => delivered.push(args),
        }
      )
      const socket = new FakeSocket()
      fixture.gateway.open(connection('expired-channel', channel(1, nodeId, now), socket))
      if (trigger !== 'awaiting-hello')
        await fixture.gateway.receive('expired-channel', JSON.stringify(golden.hello))
      const sentBefore = socket.sent.length
      clock = new Date('2026-08-25T12:05:30.001Z')
      if (trigger === 'frame')
        await fixture.gateway.receive('expired-channel', JSON.stringify(golden.ack))
      else {
        if (trigger === 'send')
          await expect(fixture.gateway.send(golden.command)).rejects.toMatchObject({
            code: 'RUNTIME_NODE_CREDENTIAL_EXPIRED',
          })
        await fixture.gateway.sweep()
      }
      expect(socket.closed).toEqual({ code: 1008, reason: 'authentication_invalidated' })
      expect(socket.sent).toHaveLength(sentBefore)
      expect(delivered).toEqual([])
      expect(await fixture.coordination.lookup(nodeId)).toBeUndefined()
      await fixture.gateway.close()
    }
  )

  test.each(['frame', 'sweep'])(
    'reconciles replaced ownership without notifications via %s',
    async (trigger) => {
      const repository = new InMemoryRuntimeNodeCoordination()
      const delivered = []
      const first = setup(
        'gateway-a',
        new RepositoryRuntimeNodeCoordination(repository),
        undefined,
        {},
        {
          handle: async (...args) => delivered.push(args),
        }
      )
      const second = setup('gateway-b', new RepositoryRuntimeNodeCoordination(repository))
      const oldSocket = new FakeSocket()
      const newSocket = new FakeSocket()
      first.gateway.open(connection('gwc-a', channel(1), oldSocket))
      await first.gateway.receive('gwc-a', JSON.stringify(golden.hello))
      second.gateway.open(connection('gwc-b', channel(2), newSocket))
      await second.gateway.receive('gwc-b', JSON.stringify(hello(2)))
      expect(oldSocket.closed).toBeUndefined()
      if (trigger === 'frame') {
        await first.gateway.receive('gwc-a', JSON.stringify(golden.ack))
      } else {
        await first.gateway.sweep()
      }
      expect(oldSocket.closed).toEqual({ code: 4001, reason: 'stale_channel_replaced' })
      expect(delivered).toEqual([])
      expect(await repository.lookup(nodeId)).toMatchObject({
        gatewayInstanceId: 'gateway-b',
        channelGeneration: 2,
      })
      expect(first.reachability.events.filter(({ state }) => state === 'offline')).toEqual([])
      await first.gateway.close()
      await second.gateway.close()
    }
  )

  test('negotiates hello and registers one authenticated active channel', async () => {
    const fixture = setup('gateway-a')
    const socket = new FakeSocket()

    expect(fixture.gateway.open(connection('gwc-a', channel(1), socket))).toBe(true)
    await fixture.gateway.receive('gwc-a', JSON.stringify(golden.hello))

    expect(await fixture.coordination.lookup(nodeId)).toMatchObject({
      gatewayInstanceId: 'gateway-a',
      connectionId: 'gwc-a',
      channelGeneration: 1,
      protocolVersion: { major: 1, minor: 0 },
    })
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      type: 'hello',
      nodeId,
      workspaceId,
      channelGeneration: 1,
    })
    expect(fixture.reachability.events.at(-1)).toMatchObject({ state: 'online', nodeId })
    expect(fixture.metrics.gaugeValue('runtime_gateway.active_nodes')).toBe(1)
    expect(
      fixture.metrics.counterValue('runtime_gateway.protocol_version', { version: '1.0' })
    ).toBe(1)
  })

  test('sends a scoped durable command through the authenticated active channel', async () => {
    const fixture = setup('gateway-a')
    const socket = new FakeSocket()
    fixture.gateway.open(connection('gwc-a', channel(1), socket))
    await fixture.gateway.receive('gwc-a', JSON.stringify(golden.hello))

    await fixture.gateway.send(golden.command)

    expect(JSON.parse(socket.sent.at(-1))).toEqual(golden.command)
    await expect(
      fixture.gateway.send({ ...golden.command, nodeId: otherNodeId })
    ).rejects.toMatchObject({ code: 'RUNTIME_GATEWAY_CHANNEL_UNAVAILABLE' })
    socket.bufferedBytes = 1_025
    await expect(fixture.gateway.send(golden.command)).rejects.toMatchObject({
      code: 'RUNTIME_GATEWAY_CHANNEL_BACKPRESSURED',
    })
  })

  test('reconnects across instances and replaces stale logical sessions deterministically', async () => {
    const coordination = new InMemoryRuntimeNodeCoordination()
    const durableState = new Map([['cmd_pending', { result: 'retained' }]])
    const first = setup('gateway-a', coordination)
    const second = setup('gateway-b', coordination)
    const stale = setup('gateway-c', coordination)
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const staleSocket = new FakeSocket()

    first.gateway.open(connection('gwc-a', channel(1), firstSocket))
    await first.gateway.receive('gwc-a', JSON.stringify(golden.hello))
    second.gateway.open(connection('gwc-b', channel(2), secondSocket))
    await second.gateway.receive('gwc-b', JSON.stringify(hello(2)))

    expect(firstSocket.closed).toEqual({ code: 4001, reason: 'stale_channel_replaced' })
    expect(await coordination.lookup(nodeId)).toMatchObject({
      gatewayInstanceId: 'gateway-b',
      connectionId: 'gwc-b',
      channelGeneration: 2,
    })
    expect(second.metrics.counterValue('runtime_gateway.reconnects')).toBe(1)

    stale.gateway.open(connection('gwc-c', channel(1), staleSocket))
    await stale.gateway.receive('gwc-c', JSON.stringify(golden.hello))
    expect(staleSocket.closed).toEqual({ code: 4001, reason: 'stale_channel_generation' })
    expect(durableState.get('cmd_pending')).toEqual({ result: 'retained' })
  })

  test('publishes heartbeat degradation and idle disconnects without sticky ownership', async () => {
    let current = new Date('2026-08-25T12:00:01.000Z')
    const fixture = setup('gateway-a', undefined, () => current)
    const socket = new FakeSocket()
    fixture.gateway.open(connection('gwc-a', channel(1), socket))
    await fixture.gateway.receive('gwc-a', JSON.stringify(golden.hello))
    await fixture.gateway.receive(
      'gwc-a',
      JSON.stringify({ ...golden.heartbeat, sentAt: '2026-08-25T12:00:00.000Z' })
    )

    current = new Date('2026-08-25T12:00:12.000Z')
    await fixture.gateway.sweep()
    expect(fixture.reachability.events.at(-1)).toMatchObject({
      state: 'degraded',
      reason: 'heartbeat_stale',
    })

    current = new Date('2026-08-25T12:00:32.000Z')
    await fixture.gateway.sweep()
    expect(socket.closed).toEqual({ code: 4000, reason: 'idle_timeout' })
    expect(await fixture.coordination.lookup(nodeId)).toBeUndefined()
    expect(fixture.reachability.events.at(-1)).toMatchObject({
      state: 'offline',
      reason: 'idle_timeout',
    })
    expect(fixture.metrics.observations('runtime_gateway.heartbeat_lag_ms')).toContain(1_000)
    expect(
      fixture.metrics.counterValue('runtime_gateway.disconnects', { reason: 'idle_timeout' })
    ).toBe(1)
  })

  test('dispatches newly queued commands on heartbeat after reconnect sequencing', async () => {
    const dispatched = []
    const fixture = setup('gateway-a', undefined, undefined, {}, undefined, {
      dispatch: async (record, sequence) => {
        dispatched.push({ record, sequence })
        return 2
      },
    })
    const socket = new FakeSocket()
    fixture.gateway.open(connection('gwc-a', channel(1), socket))
    await fixture.gateway.receive(
      'gwc-a',
      JSON.stringify({ ...golden.hello, lastAcknowledgedSequence: 7 })
    )

    await fixture.gateway.receive('gwc-a', JSON.stringify(golden.heartbeat))
    await fixture.gateway.receive('gwc-a', JSON.stringify(golden.heartbeat))

    expect(dispatched).toEqual([
      { record: expect.objectContaining({ nodeId }), sequence: 8 },
      { record: expect.objectContaining({ nodeId }), sequence: 10 },
    ])
  })

  test('disconnects an invalidated active channel before handling another frame', async () => {
    const handled = []
    const fixture = setup(
      'gateway-a',
      undefined,
      undefined,
      {},
      {
        handle: async (_record, envelope) => handled.push(envelope),
      }
    )
    const authenticatedChannel = channel(1)
    const socket = new FakeSocket()
    fixture.gateway.open(connection('gwc-a', authenticatedChannel, socket))
    await fixture.gateway.receive('gwc-a', JSON.stringify(golden.hello))

    authenticatedChannel.invalidate('revoked')
    await fixture.gateway.receive('gwc-a', JSON.stringify(golden.command))

    expect(handled).toEqual([])
    expect(socket.closed).toEqual({ code: 1008, reason: 'authentication_invalidated' })
    expect(await fixture.coordination.lookup(nodeId)).toBeUndefined()
    expect(fixture.reachability.events.at(-1)).toMatchObject({
      state: 'offline',
      reason: 'authentication_invalidated',
    })
  })

  test('fails oversized, malformed, backpressured, and over-limit connections safely', async () => {
    const fixture = setup('gateway-a')
    const malformed = new FakeSocket()
    fixture.gateway.open(connection('gwc-malformed', channel(1), malformed))
    await fixture.gateway.receive('gwc-malformed', '{broken')
    expect(malformed.closed).toEqual({ code: 1002, reason: 'malformed_frame' })

    const oversized = new FakeSocket()
    fixture.gateway.open(connection('gwc-oversized', channel(2), oversized))
    await fixture.gateway.receive('gwc-oversized', 'x'.repeat(2_049))
    expect(oversized.closed).toEqual({ code: 1009, reason: 'frame_too_large' })

    const backpressured = new FakeSocket(1_025)
    fixture.gateway.open(connection('gwc-backpressure', channel(3), backpressured))
    await fixture.gateway.receive('gwc-backpressure', JSON.stringify(hello(3)))
    expect(backpressured.closed).toEqual({ code: 1013, reason: 'backpressure_limit' })

    const limited = setup('gateway-limit', undefined, undefined, { maxConnections: 1 })
    const accepted = new FakeSocket()
    const rejected = new FakeSocket()
    expect(limited.gateway.open(connection('gwc-accepted', channel(1), accepted))).toBe(true)
    expect(limited.gateway.open(connection('gwc-rejected', channel(2), rejected))).toBe(false)
    expect(rejected.closed).toEqual({ code: 1013, reason: 'connection_limit' })
  })

  test('drains every active channel and rejects new work during graceful shutdown', async () => {
    const fixture = setup('gateway-a')
    const first = new FakeSocket()
    const second = new FakeSocket()
    fixture.gateway.open(connection('gwc-a', channel(1), first))
    await fixture.gateway.receive('gwc-a', JSON.stringify(golden.hello))
    fixture.gateway.open(connection('gwc-b', channel(1, otherNodeId), second))
    await fixture.gateway.receive('gwc-b', JSON.stringify(hello(1, otherNodeId)))

    await fixture.gateway.close()

    expect(first.closed).toEqual({ code: 1001, reason: 'gateway_shutdown' })
    expect(second.closed).toEqual({ code: 1001, reason: 'gateway_shutdown' })
    expect(fixture.metrics.gaugeValue('runtime_gateway.active_nodes')).toBe(0)
    expect(await fixture.coordination.lookup(nodeId)).toBeUndefined()
    expect(await fixture.coordination.lookup(otherNodeId)).toBeUndefined()
    const afterDrain = new FakeSocket()
    expect(fixture.gateway.open(connection('gwc-after-drain', channel(3), afterDrain))).toBe(false)
    expect(afterDrain.closed).toEqual({ code: 1012, reason: 'gateway_draining' })
  })

  test('binds the lifecycle to a dedicated upgrade server with native safety limits', async () => {
    const fixture = setup('gateway-a')
    let serveOptions
    let stopped = false
    let upgradeData
    const server = new RuntimeGatewayWebSocketServer({
      lifecycle: fixture.gateway,
      authenticateUpgrade: async () => channel(1),
      hostname: '127.0.0.1',
      port: 4301,
      limits: {
        maxFrameBytes: 2_048,
        maxBufferedBytes: 1_024,
        idleTimeoutSeconds: 30,
      },
      serve: (options) => {
        serveOptions = options
        return { stop: async () => (stopped = true) }
      },
    })
    server.start()

    const response = await serveOptions.fetch(
      new globalThis.Request('https://gateway.test/runtime-gateway/v1/connect', {
        headers: { upgrade: 'websocket' },
      }),
      {
        upgrade: (_request, options) => {
          upgradeData = options.data
          return true
        },
      }
    )
    expect(response).toBeUndefined()
    expect(serveOptions.websocket).toMatchObject({
      maxPayloadLength: 2_048,
      backpressureLimit: 1_024,
      closeOnBackpressureLimit: true,
      idleTimeout: 30,
    })

    const socket = new FakeServerSocket(upgradeData)
    serveOptions.websocket.open(socket)
    await serveOptions.websocket.message(socket, JSON.stringify(golden.hello))
    expect(await fixture.coordination.lookup(nodeId)).toMatchObject({
      connectionId: upgradeData.connectionId,
    })

    await server.close()
    expect(stopped).toBe(true)
    expect(socket.closed).toEqual({ code: 1001, reason: 'gateway_shutdown' })
  })
})

function setup(
  instanceId,
  coordination = new InMemoryRuntimeNodeCoordination(),
  now,
  limits = {},
  messages,
  pending,
  sequences,
  reconnect,
  contextRecovery
) {
  const reachability = new RecordingRuntimeNodeReachabilityPublisher()
  const metrics = new RecordingGatewayMetrics()
  const gateway = new RuntimeGatewayWebSocketLifecycle({
    instanceId,
    coordination,
    reachability,
    metrics,
    now: now ?? (() => new Date('2026-08-25T12:00:01.000Z')),
    messages,
    pending,
    sequences,
    reconnect,
    contextRecovery,
    limits: {
      maxConnections: 8,
      maxConnectionsPerWorkspace: 8,
      maxFrameBytes: 2_048,
      maxBufferedBytes: 1_024,
      heartbeatTimeoutMs: 10_000,
      idleTimeoutMs: 30_000,
      ...limits,
    },
  })
  return { coordination, gateway, metrics, reachability }
}

function channel(channelGeneration, id = nodeId, now = () => new Date('2026-08-25T12:00:01.000Z')) {
  return new RuntimeNodeChannel(
    {
      schemaVersion: 1,
      credentialKind: 'runtime_node',
      credentialId: `rgc_${id.slice(-8)}_${channelGeneration}`,
      issuer: 'https://identity.test.example',
      audience: 'control-plane-runtime-gateway',
      nodeId: id,
      workspaceId,
      keyId: 'rgk_000000000001',
      proofKeyThumbprint: `sha256:${'a'.repeat(64)}`,
      revocationVersion: 1,
      channelGeneration,
      issuedAt: '2026-08-25T12:00:00.000Z',
      expiresAt: '2026-08-25T12:05:00.000Z',
    },
    {
      isRevoked: async () => false,
      subscribeRevocations: () => () => undefined,
      verify: async () => undefined,
    },
    { now }
  )
}

function connection(connectionId, authenticatedChannel, socket) {
  return { connectionId, authenticatedChannel, socket }
}

function hello(channelGeneration, id = nodeId) {
  return { ...golden.hello, nodeId: id, channelGeneration }
}

class FakeSocket {
  sent = []
  closed

  constructor(bufferedBytes = 0) {
    this.bufferedBytes = bufferedBytes
  }

  bufferedAmount() {
    return this.bufferedBytes
  }

  send(value) {
    this.sent.push(value)
  }

  close(code, reason) {
    this.closed = { code, reason }
  }
}

class FakeServerSocket extends FakeSocket {
  constructor(data) {
    super()
    this.data = data
  }

  getBufferedAmount() {
    return this.bufferedBytes
  }
}
