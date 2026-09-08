import { expect, test } from 'bun:test'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import {
  RuntimeNodeChannelAuthenticator,
  SyntheticRuntimeNodeIdentityAuthority,
} from './authentication.ts'
import {
  RuntimeGatewayWebSocketServer,
  RuntimeGatewayWebSocketLifecycle,
  InMemoryRuntimeNodeCoordination,
  RepositoryRuntimeNodeCoordination,
  RecordingGatewayMetrics,
  RecordingRuntimeNodeReachabilityPublisher,
} from './websocket-lifecycle.ts'

test.each(['shutdown', 'replacement'])(
  'real WebSocket authenticates traffic and closes through %s',
  async (closeMode) => {
    const now = () => new Date('2026-08-25T12:00:00.000Z')
    const expectation = {
      issuer: 'https://identity.test',
      audience: 'runtime-gateway',
      nodeId: golden.hello.nodeId,
      workspaceId: golden.hello.workspaceId,
      channelGeneration: 1,
      challenge: 'network-fixture-challenge',
    }
    const authority = new SyntheticRuntimeNodeIdentityAuthority({ ...expectation, now })
    const device = authority.registerNode(expectation)
    const issued = authority.issueCredential(device, { channelGeneration: 1 })
    const attempt = device.authenticationAttempt(issued.credential, expectation.challenge)
    const authenticator = new RuntimeNodeChannelAuthenticator({
      identityValidator: authority.validationPort(),
      logger: { write() {} },
      now,
    })
    const received = []
    const coordination = new RepositoryRuntimeNodeCoordination(
      new InMemoryRuntimeNodeCoordination()
    )
    const lifecycle = new RuntimeGatewayWebSocketLifecycle({
      instanceId: 'network-test',
      coordination,
      metrics: new RecordingGatewayMetrics(),
      reachability: new RecordingRuntimeNodeReachabilityPublisher(),
      now,
      messages: {
        handle: async (source, envelope) => {
          received.push({ source, envelope })
        },
      },
      limits: {
        maxConnections: 2,
        maxConnectionsPerWorkspace: 2,
        maxFrameBytes: 65536,
        maxBufferedBytes: 65536,
        heartbeatTimeoutMs: 15000,
        idleTimeoutMs: 30000,
      },
    })
    let native
    let socket
    const frames = []
    const server = new RuntimeGatewayWebSocketServer({
      lifecycle,
      sweepIntervalMs: 10,
      hostname: '127.0.0.1',
      port: 0,
      limits: { maxFrameBytes: 65536, maxBufferedBytes: 65536, idleTimeoutSeconds: 30 },
      authenticateUpgrade: async (request) =>
        authenticator.authenticate(
          JSON.parse(request.headers.get('x-test-node-proof') ?? 'null'),
          expectation
        ),
      serve: (options) => {
        native = Bun.serve(options)
        return native
      },
    })
    try {
      server.start()
      const url = `http://127.0.0.1:${native.port}/runtime-gateway/v1/connect`
      expect((await fetch(url)).status).toBe(426)
      expect((await fetch(url, { headers: { upgrade: 'websocket' } })).status).toBe(401)
      socket = new WebSocket(url.replace('http:', 'ws:'), {
        headers: { 'x-test-node-proof': JSON.stringify(attempt) },
      })
      socket.addEventListener('message', (event) => frames.push(JSON.parse(event.data)))
      await until(() => socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(golden.hello))
      await until(() => frames.length === 1)
      expect(frames[0]).toMatchObject({
        type: 'hello',
        nodeId: expectation.nodeId,
        workspaceId: expectation.workspaceId,
      })
      await lifecycle.send(golden.command)
      await until(() => frames.length === 2)
      expect(frames[1]).toEqual(golden.command)
      socket.send(JSON.stringify(golden.ack))
      await until(() => received.length === 1)
      expect(received[0].envelope).toEqual(golden.ack)
      expect(received[0].source).toMatchObject({
        nodeId: expectation.nodeId,
        workspaceId: expectation.workspaceId,
        channelGeneration: 1,
      })
      authority.revokeCredential(issued.claims.credentialId)
      await expect(lifecycle.send(golden.command)).rejects.toThrow()
      expect(frames).toHaveLength(2)
      expect(
        (
          await fetch(url, {
            headers: { upgrade: 'websocket', 'x-test-node-proof': JSON.stringify(attempt) },
          })
        ).status
      ).toBe(401)
      if (closeMode === 'replacement') {
        const current = await coordination.lookup(expectation.nodeId)
        const replacement = {
          ...current,
          channelGeneration: 2,
          connectionId: 'replacement',
          gatewayInstanceId: 'other-gateway',
        }
        await coordination.claim(replacement)
        // No explicit sweep or push subscription: the server timer must close the stale socket.
        await until(() => socket.readyState === WebSocket.CLOSED)
        expect(await coordination.lookup(expectation.nodeId)).toEqual(replacement)
        await coordination.release(replacement)
      }
      await server.close()
      await until(() => socket.readyState === WebSocket.CLOSED)
      expect(await coordination.lookup(expectation.nodeId)).toBeUndefined()
      await expect(fetch(url)).rejects.toThrow()
    } finally {
      socket?.close()
      await server.close()
      await native?.stop(true)
      authenticator.close()
    }
  },
  10000
)

async function until(condition) {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('WEBSOCKET_NETWORK_TEST_TIMEOUT')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
