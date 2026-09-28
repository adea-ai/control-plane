import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { connect } from 'node:net'
import { expect, test } from 'bun:test'
import { runtimeNodeWebSocketChallenge } from '@control-plane/runtime-gateway-protocol'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import {
  RuntimeNodeChannelAuthenticator,
  SyntheticRuntimeNodeIdentityAuthority,
} from './authentication.ts'
import {
  authenticateRuntimeNodeUpgrade,
  PostgresRuntimeNodeIdentityValidationPort,
  runtimeNodePublicKeyThumbprint,
} from './postgres-runtime-node-identity.ts'
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
        handle: async (source, envelope, credentialFence) => {
          received.push({ source, envelope, credentialFence })
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
    let replacementRecord
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
      expect(received[0].credentialFence).toEqual({
        credentialId: issued.claims.credentialId,
        revocationVersion: issued.claims.revocationVersion,
      })
      if (closeMode === 'replacement') {
        const current = await coordination.lookup(expectation.nodeId)
        replacementRecord = {
          ...current,
          channelGeneration: 2,
          connectionId: 'replacement',
          gatewayInstanceId: 'other-gateway',
        }
        await coordination.claim(replacementRecord)
        // Claim before revoking credentials so the timer cannot release the
        // original owner before the replacement scenario is established.
        await until(() => socket.readyState === WebSocket.OPEN)
      }
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
        // No explicit sweep or push subscription: the server timer must close the stale socket.
        await until(() => socket.readyState === WebSocket.CLOSED)
        expect(await coordination.lookup(expectation.nodeId)).toEqual(replacementRecord)
        await coordination.release(replacementRecord)
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

test('real WebSocket listener accepts operator-issued identity and rejects proof replay', async () => {
  const now = () => new Date('2026-08-25T12:00:00.000Z')
  const issuer = generateKeyPairSync('ed25519')
  const device = generateKeyPairSync('ed25519')
  const issuerPublicPem = issuer.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const devicePublicPem = device.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const claims = {
    schemaVersion: 1,
    credentialKind: 'runtime_node',
    credentialId: 'rgc_network_operator_0001',
    issuer: 'https://identity.test.example/runtime-nodes',
    audience: 'control-plane-runtime-gateway',
    nodeId: golden.hello.nodeId,
    workspaceId: golden.hello.workspaceId,
    keyId: 'rgk_network_device_0001',
    proofKeyThumbprint: runtimeNodePublicKeyThumbprint(devicePublicPem),
    revocationVersion: 1,
    channelGeneration: 1,
    issuedAt: now().toISOString(),
    expiresAt: new Date(now().getTime() + 5 * 60_000).toISOString(),
  }
  const issuerKeyId = 'operator-key-01'
  const credential = issueCredential(claims, issuerKeyId, issuer.privateKey)
  let consumed = false
  const issued = {
    credentialId: claims.credentialId,
    nodeId: claims.nodeId,
    workspaceId: claims.workspaceId,
    keyId: claims.keyId,
    claims,
    revocationVersion: claims.revocationVersion,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    revokedAt: null,
    consumedAt: null,
  }
  const key = {
    keyId: claims.keyId,
    nodeId: claims.nodeId,
    workspaceId: claims.workspaceId,
    publicKeyPem: devicePublicPem,
    thumbprint: claims.proofKeyThumbprint,
    status: 'active',
  }
  const repository = {
    getVerificationKey: async () => key,
    getIssuedCredential: async () => issued,
    isCredentialRevoked: async (_credentialId, version) =>
      issued.revokedAt !== null || version !== issued.revocationVersion || key.status !== 'active',
    consumeCredential: async () => {
      if (issued.revokedAt !== null) return 'revoked'
      if (consumed) return 'replayed'
      consumed = true
      issued.consumedAt = now().toISOString()
      return 'consumed'
    },
    subscribeRevocations: async () => async () => undefined,
  }
  const identity = new PostgresRuntimeNodeIdentityValidationPort(
    repository,
    new Map([[issuerKeyId, issuerPublicPem]])
  )
  await identity.startRevocationListener()
  const authenticator = new RuntimeNodeChannelAuthenticator({
    identityValidator: identity,
    logger: { write() {} },
    now,
  })
  const trust = {
    issuer: claims.issuer,
    audience: claims.audience,
    issuerPublicKeys: new Map([[issuerKeyId, issuerPublicPem]]),
  }
  const nativeKey = 'dGhlIHNhbXBsZSBub25jZQ=='
  const challenge = runtimeNodeWebSocketChallenge(nativeKey)
  const proofInput = `${createHash('sha256').update(credential).digest('base64url')}.${challenge}`
  const validProof = sign(null, Buffer.from(proofInput), device.privateKey).toString('base64url')
  const invalidProof = Buffer.alloc(64).toString('base64url')
  let native
  let socketServer
  const coordination = new RepositoryRuntimeNodeCoordination(new InMemoryRuntimeNodeCoordination())
  const lifecycle = new RuntimeGatewayWebSocketLifecycle({
    instanceId: 'operator-identity-network-test',
    coordination,
    metrics: new RecordingGatewayMetrics(),
    reachability: new RecordingRuntimeNodeReachabilityPublisher(),
    now,
    messages: { handle: async () => undefined },
    limits: {
      maxConnections: 2,
      maxConnectionsPerWorkspace: 2,
      maxFrameBytes: 65536,
      maxBufferedBytes: 65536,
      heartbeatTimeoutMs: 15000,
      idleTimeoutMs: 30000,
    },
  })
  socketServer = new RuntimeGatewayWebSocketServer({
    lifecycle,
    hostname: '127.0.0.1',
    port: 0,
    limits: { maxFrameBytes: 65536, maxBufferedBytes: 65536, idleTimeoutSeconds: 30 },
    authenticateUpgrade: (request) => authenticateRuntimeNodeUpgrade(request, authenticator, trust),
    serve: (options) => {
      native = Bun.serve(options)
      return native
    },
  })
  try {
    socketServer.start()
    const headers = {
      authorization: `RuntimeNode ${credential}`,
      'sec-websocket-key': nativeKey,
    }
    const denied = await rawWebSocketUpgrade(native.port, {
      ...headers,
      'x-runtime-node-proof': invalidProof,
    })
    expect(denied).toContain('HTTP/1.1 401')
    const accepted = await rawWebSocketUpgrade(native.port, {
      ...headers,
      'x-runtime-node-proof': validProof,
    })
    expect(accepted).toContain('HTTP/1.1 101')
    const replay = await rawWebSocketUpgrade(native.port, {
      ...headers,
      'x-runtime-node-proof': validProof,
    })
    expect(replay).toContain('HTTP/1.1 401')
  } finally {
    await socketServer.close()
    await native?.stop(true)
    authenticator.close()
    await identity.close()
  }
})

async function until(condition) {
  const deadline = Date.now() + 3000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('WEBSOCKET_NETWORK_TEST_TIMEOUT')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function rawWebSocketUpgrade(port, headers) {
  const client = connect(port, '127.0.0.1')
  const response = await new Promise((resolve, reject) => {
    let data = ''
    client.once('error', reject)
    client.once('connect', () => {
      client.write(
        [
          'GET /runtime-gateway/v1/connect HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
          '',
          '',
        ].join('\r\n')
      )
    })
    client.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (data.includes('\r\n\r\n')) resolve(data)
    })
    client.setTimeout(3000, () => reject(new Error('WEBSOCKET_UPGRADE_TIMEOUT')))
  })
  client.destroy()
  return response
}

function issueCredential(claims, issuerKeyId, issuerPrivateKey) {
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'RNGC', kid: issuerKeyId })
  ).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signingInput = `${header}.${payload}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput), issuerPrivateKey).toString('base64url')}`
}
