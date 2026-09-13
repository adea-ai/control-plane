import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeContextProvider } from '@control-plane/context'
import {
  ContextCommandGrantDeniedError,
  ContextProviderAdministration,
  createQueuedContextCommandRecord,
} from '@control-plane/domain'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  SqliteContextCommandGrantRepository,
  SqliteContextProviderRegistrationRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { createContextBundle } from '../packages/cortana-context-adapter/src/index.ts'
import {
  composeContextNode,
  ContextHttpProviderDriver,
  start as startWorker,
} from '../apps/runtime-worker/src/index.ts'
import {
  composeRuntimeGateway,
  RecordingGatewayMetrics,
  RecordingRuntimeNodeReachabilityPublisher,
  RuntimeNodeChannelAuthenticator,
  start as startGateway,
  SyntheticRuntimeNodeIdentityAuthority,
} from '../apps/runtime-gateway/src/index.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const nodeId = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const providerRef = 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const principalRef = 'principal://test/user'
const authorizationRef = 'authz:context-composition-test'
const traceId = 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const audience = 'control-plane-runtime-gateway'
const issuer = 'https://identity.composition.test.example'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}
async function deadline(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CONTEXT_COMPOSITION_TEST_DEADLINE')), 15000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function waitFor(predicate, label) {
  const started = Date.now()
  while (Date.now() - started < 10000) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`CONTEXT_COMPOSITION_TEST_TIMEOUT_${label}`)
}
function serviceEnvironment(appEnv) {
  const environment = { APP_ENV: appEnv }
  if (appEnv === 'production' || appEnv === 'staging') {
    environment.COMMIT_SHA = 'm11-composition-startup-test'
    environment.INSTANCE_ID = 'm11-composition-startup-test'
    environment.SERVICE_VERSION = '1.0.0'
  }
  return environment
}
function fakeProcessAdapter() {
  const listeners = new Map()
  return {
    listeners,
    on(event, listener) {
      listeners.set(event, listener)
    },
    off(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event)
    },
    setExitCode(code) {
      this.exitCode = code
    },
  }
}

/**
 * Provisions both stores strictly through ContextProviderAdministration — the same
 * service the operator CLI drives — and never seeds repositories directly.
 */
async function provisionStores(directory) {
  const gatewayPath = join(directory, 'gateway.sqlite')
  const nodePath = join(directory, 'node.sqlite')
  const gatewayStore = new SqlitePersistenceProvider({ path: gatewayPath })
  const nodeStore = new SqlitePersistenceProvider({ path: nodePath })
  await gatewayStore.migrate()
  await nodeStore.migrate()
  const bundle = createContextBundle({
    ...JSON.parse(
      await readFile(
        new URL(
          '../packages/cortana-context-adapter/fixtures/golden/context-bundle.v1.json',
          import.meta.url
        ),
        'utf8'
      )
    ),
    createdAt: new Date().toISOString(),
  })
  const grant = {
    authorizationRef,
    workspaceId,
    nodeId,
    providerRef,
    principalRef,
    mappedProjectRef: 'fixture-project',
    scopeDigest: bundle.scopeDigest,
    capabilities: ['evidenceSearch'],
    maximumTokens: 100,
    includeEvidence: true,
    includeMemory: true,
    issuedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    status: 'active',
  }
  const gatewayAdministration = new ContextProviderAdministration(
    new SqliteContextCommandGrantRepository(gatewayStore),
    new SqliteContextProviderRegistrationRepository(gatewayStore)
  )
  const nodeAdministration = new ContextProviderAdministration(
    new SqliteContextCommandGrantRepository(nodeStore),
    new SqliteContextProviderRegistrationRepository(nodeStore)
  )
  await gatewayAdministration.apply({ operation: 'grant', grant })
  await nodeAdministration.apply({ operation: 'grant', grant })
  const readModel = createFakeContextProvider({
    suffix: 'A',
    workspaceId,
    scopeDigest: bundle.scopeDigest,
    health: 'healthy',
    state: 'active',
    capabilities: { evidenceSearch: true, memoryRecall: true },
    kind: 'evidence',
    tokenCount: 1,
  }).readModel
  readModel.health.checkedAt = new Date().toISOString()
  await gatewayAdministration.apply({
    operation: 'register',
    expectedVersion: 0,
    registration: {
      version: 1,
      readModel,
      providerRef,
      mappedProjectRef: 'fixture-project',
      authorizationRef,
    },
  })
  await gatewayStore.close()
  await nodeStore.close()
  return { gatewayPath, nodePath, grant, bundle }
}

async function composeGateway({
  path,
  objects,
  authority,
  instanceId,
  challenge,
  channelGeneration,
}) {
  const authenticator = new RuntimeNodeChannelAuthenticator({
    identityValidator: authority.validationPort(),
    logger: { write: () => {} },
  })
  let native
  const composition = await composeRuntimeGateway({
    store: { backend: 'sqlite', path },
    objectStore: objects,
    metrics: new RecordingGatewayMetrics(),
    reachability: new RecordingRuntimeNodeReachabilityPublisher(),
    traceId: () => traceId,
    instanceId,
    hostname: '127.0.0.1',
    port: 0,
    authenticateUpgrade: async (request) =>
      authenticator.authenticate(JSON.parse(request.headers.get('x-node-attempt')), {
        audience,
        issuer,
        nodeId,
        workspaceId,
        channelGeneration,
        challenge,
      }),
    serve: (options) => {
      native = Bun.serve(options)
      return native
    },
  })
  composition.webSocketServer.start()
  return { composition, authenticator, port: native.port, challenge }
}

test('composed gateway and node deliver a context command end to end from administration-provisioned stores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-composition-'))
  const objects = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 262144,
  })
  let http
  let node
  const sockets = []
  const gateways = []
  const operations = []
  const channelErrors = []
  try {
    const { gatewayPath, nodePath, bundle } = await provisionStores(directory)
    const httpReads = []
    http = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const body = await request.json()
        expect(body.mappedProjectRef).toBe('fixture-project')
        httpReads.push(body.operationId)
        return Response.json(bundle)
      },
    })
    const authority = new SyntheticRuntimeNodeIdentityAuthority({ audience, issuer })
    const device = authority.registerNode({ nodeId, workspaceId })

    const nodeState = {
      socket: undefined,
      dropNextResult: false,
      received: new Set(),
      envelopes: new Map(),
      sequence: 2,
      channelGeneration: 0,
    }
    node = await composeContextNode({
      store: { backend: 'sqlite', path: nodePath },
      workspaceId,
      nodeId,
      timeoutMs: 5000,
      driver: new ContextHttpProviderDriver({
        workspaceId,
        nodeId,
        providerRef,
        mappedProjectRef: 'fixture-project',
        http: { endpoint: `http://127.0.0.1:${http.port}/read`, allowLoopbackHttp: true },
      }),

      transport: {
        send: async (serialized) => {
          if (JSON.parse(serialized).type === 'result' && nodeState.dropNextResult) {
            nodeState.dropNextResult = false
            return
          }
          nodeState.socket?.send(serialized)
        },
        nextSequence: async () => nodeState.sequence++,
        assertCurrent: async (command) => {
          if (nodeState.socket?.readyState !== WebSocket.OPEN)
            throw new Error('CONTEXT_COMPOSITION_CHANNEL_CLOSED')
          if (
            command.workspaceId !== workspaceId ||
            command.nodeId !== nodeId ||
            command.channelGeneration !== nodeState.channelGeneration
          )
            throw new Error('CONTEXT_COMPOSITION_CHANNEL_INVALID')
          nodeState.received.add(command.commandId)
          nodeState.envelopes.set(command.commandId, command)
        },
      },
    })
    const pump = (data) => {
      operations.push(
        node.channel.receive(data).catch((error) => {
          channelErrors.push(error)
        })
      )
    }
    const readRequest = (operationId, maximumLatencyMs) => ({
      workspaceId,
      scopeDigest: bundle.scopeDigest,
      principalRef,
      executionLocation: 'runtime_node',
      capability: 'evidenceSearch',
      objective: 'Find fixture evidence',
      operationId,
      now: new Date().toISOString(),
      policy: {
        mode: 'required',
        providerIds: [],
        connectionIds: [],
        includeEvidence: true,
        includeMemory: true,
        maximumTokens: 100,
        maximumAgeSeconds: 3600,
        maximumProviderHealthAgeSeconds: 60,
        maximumLatencyMs,
        failureBehavior: 'fail',
      },
    })
    const sendHeartbeat = () => {
      const sentAt = new Date().toISOString()
      nodeState.socket?.send(
        JSON.stringify({
          type: 'heartbeat',
          schemaVersion: 1,
          protocolVersion: { major: 1, minor: 5 },
          sequence: nodeState.sequence++,
          nodeId,
          workspaceId,
          traceId,
          channelGeneration: nodeState.channelGeneration,
          sentAt,
          observedAt: sentAt,
          status: 'online',
        })
      )
    }
    const connectNode = async (gateway) => {
      nodeState.channelGeneration += 1
      const issued = authority.issueCredential(device, {
        channelGeneration: nodeState.channelGeneration,
      })
      const hello = deferred()
      const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/runtime-gateway/v1/connect`, {
        headers: {
          'x-node-attempt': JSON.stringify(
            device.authenticationAttempt(issued.credential, gateway.challenge)
          ),
        },
      })
      socket.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data))
        if (frame.type === 'hello') {
          hello.resolve()
          return
        }
        pump(String(event.data))
      })
      await deadline(
        new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
      )
      sockets.push(socket)
      nodeState.socket = socket
      socket.send(
        JSON.stringify({
          type: 'hello',
          schemaVersion: 1,
          protocolVersion: { major: 1, minor: 5 },
          supportedVersions: [{ major: 1, minor: 5 }],
          sequence: 0,
          lastAcknowledgedSequence: 0,
          nodeId,
          workspaceId,
          traceId,
          channelGeneration: nodeState.channelGeneration,
          sentAt: new Date().toISOString(),
        })
      )
      await deadline(hello.promise)
      return socket
    }

    // Deliver a context command through the composed gateway and node.
    const first = await composeGateway({
      path: gatewayPath,
      objects,
      authority,
      instanceId: 'm11-composition-gateway-a',
      challenge: 'challenge-composition-a',
      channelGeneration: 1,
    })
    gateways.push(first)
    await connectNode(first)
    const firstResolution = await deadline(
      first.composition.resolver.resolve(readRequest('context-composition:initial-read', 10000))
    )
    expect(firstResolution.status).toBe('included')
    expect(firstResolution.contributions.map(({ kind }) => kind)).toEqual(['evidence', 'memory'])
    expect(httpReads).toEqual(['context-composition:initial-read'])
    expect(nodeState.received.size).toBe(1)
    const firstCommandId = [...nodeState.received][0]
    const firstRecord = await first.composition.delivery.get(workspaceId, firstCommandId)
    expect(firstRecord.status).toBe('succeeded')
    expect(firstRecord.deliveryAttempts).toBe(1)
    expect(await first.composition.artifacts.read(firstRecord)).toEqual(bundle)
    const inbox = node.handler.options.repository
    expect((await inbox.get(workspaceId, nodeId, firstCommandId)).status).toBe('succeeded')

    // Lose a result so a second command stays pending, then restart the gateway.
    nodeState.dropNextResult = true
    const secondResolution = first.composition.resolver.resolve(
      readRequest('context-composition:restart-read', 10000)
    )
    const secondOutcome = secondResolution.then(
      () => 'resolved',
      (error) => error
    )
    const secondCommandId = await waitFor(async () => {
      const candidates = [...nodeState.received].filter((id) => id !== firstCommandId)
      if (candidates.length === 0) return undefined
      const record = await first.composition.delivery.get(workspaceId, candidates[0])
      return record.status === 'acknowledged' ? candidates[0] : undefined
    }, 'SECOND_ACKNOWLEDGED')
    await first.composition.close()
    nodeState.socket = undefined
    expect(await secondOutcome).toBeInstanceOf(Error)

    // Recomposing from the same store must keep the pending command recoverable.
    const second = await composeGateway({
      path: gatewayPath,
      objects,
      authority,
      instanceId: 'm11-composition-gateway-b',
      challenge: 'challenge-composition-b',
      channelGeneration: 2,
    })
    gateways.push(second)
    expect((await second.composition.delivery.get(workspaceId, secondCommandId)).status).toBe(
      'acknowledged'
    )
    await connectNode(second)
    await waitFor(
      async () =>
        (await second.composition.delivery.get(workspaceId, secondCommandId)).status === 'succeeded'
          ? true
          : undefined,
      'RECOVERY_SUCCEEDED'
    )
    const recovered = await second.composition.delivery.get(workspaceId, secondCommandId)
    expect(recovered.deliveryAttempts).toBe(2)
    expect(httpReads).toEqual([
      'context-composition:initial-read',
      'context-composition:restart-read',
    ])
    expect((await inbox.get(workspaceId, nodeId, secondCommandId)).status).toBe('succeeded')

    // A third command is left pending before revocation, to prove gateway redelivery denies.
    nodeState.dropNextResult = true
    const thirdOutcome = second.composition.resolver
      .resolve(readRequest('context-composition:pre-revoke-read', 10000))
      .then(
        () => 'resolved',
        (error) => error
      )
    const thirdCommandId = await waitFor(async () => {
      const candidates = [...nodeState.received].filter(
        (id) => id !== firstCommandId && id !== secondCommandId
      )
      if (candidates.length === 0) return undefined
      const record = await second.composition.delivery.get(workspaceId, candidates[0])
      return record.status === 'acknowledged' ? candidates[0] : undefined
    }, 'THIRD_ACKNOWLEDGED')
    await second.composition.administration.apply({
      operation: 'revoke',
      workspaceId,
      authorizationRef,
    })
    await node.administration.apply({ operation: 'revoke', workspaceId, authorizationRef })

    // A re-invoked node-side authorize denies against the revoked node-local grant.
    const secondEnvelope = nodeState.envelopes.get(secondCommandId)
    await expect(
      node.authorize(createQueuedContextCommandRecord(secondEnvelope, secondEnvelope.issuedAt))
    ).rejects.toThrow('CONTEXT_GRANT_DENIED')

    // New reads are denied by the grant authority before anything is enqueued or executed.
    const denied = await second.composition.resolver
      .resolve(readRequest('context-composition:revoked-read', 10000))
      .then(
        () => 'resolved',
        (error) => error
      )
    expect(denied).toBeInstanceOf(Error)

    // Recovery redelivery of the still-pending command fails closed at the gateway.
    sendHeartbeat()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const deniedRecord = await second.composition.delivery.get(workspaceId, thirdCommandId)
    expect(deniedRecord.status).toBe('acknowledged')
    expect(deniedRecord.deliveryAttempts).toBe(1)
    expect(nodeState.received.size).toBe(3)
    expect(httpReads).toEqual([
      'context-composition:initial-read',
      'context-composition:restart-read',
      'context-composition:pre-revoke-read',
    ])
    await second.composition.close()
    nodeState.socket = undefined
    expect(await thirdOutcome).toBeInstanceOf(Error)

    // Another restart must keep the revoked grant denied from durable state.
    const third = await composeGateway({
      path: gatewayPath,
      objects,
      authority,
      instanceId: 'm11-composition-gateway-c',
      challenge: 'challenge-composition-c',
      channelGeneration: 3,
    })
    gateways.push(third)
    await connectNode(third)
    sendHeartbeat()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const stillDenied = await third.composition.delivery.get(workspaceId, thirdCommandId)
    expect(stillDenied.status).toBe('acknowledged')
    expect(stillDenied.deliveryAttempts).toBe(1)
    expect(nodeState.received.size).toBe(3)
    expect(httpReads).toEqual([
      'context-composition:initial-read',
      'context-composition:restart-read',
      'context-composition:pre-revoke-read',
    ])
    // Revocation fencing is admission-time, not atomic with the send: a lifecycle sweep
    // that authorized before the revoke may still deliver one frame. The node must fail
    // closed on it as a grant denial, and the received/httpReads assertions above prove
    // no execution, read, or new dispatch occurred for that frame.
    expect(
      channelErrors.every((error) => error instanceof ContextCommandGrantDeniedError)
    ).toBe(true)
  } finally {
    for (const socket of sockets) socket.close()
    for (const gateway of gateways) await gateway.composition.close()
    for (const gateway of gateways) gateway.authenticator.close()
    await Promise.allSettled(operations)
    await http?.stop(true)
    objects.close()
    await node?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)

test('gateway start() refuses an empty shell in every environment', async () => {
  for (const appEnv of ['test', 'production']) {
    const processAdapter = fakeProcessAdapter()
    await expect(
      startGateway({
        environment: serviceEnvironment(appEnv),
        logger: { write: () => {} },
        processAdapter,
      })
    ).rejects.toMatchObject({ name: 'ServiceStartupError' })
    expect(processAdapter.exitCode).toBe(1)
  }
})

test('gateway start() fails closed on an invalid store backend token', async () => {
  const processAdapter = fakeProcessAdapter()
  await expect(
    startGateway({
      environment: {
        ...serviceEnvironment('test'),
        RUNTIME_GATEWAY_STORE_BACKEND: 'memory',
      },
      logger: { write: () => {} },
      processAdapter,
      objectStore: {},
      metrics: {},
      reachability: {},
      traceId: () => traceId,
      instanceId: 'm11-composition-gateway',
      hostname: '127.0.0.1',
      authenticateUpgrade: async () => {
        throw new Error('unused')
      },
    })
  ).rejects.toMatchObject({ name: 'ServiceStartupError' })
  expect(processAdapter.exitCode).toBe(1)
})

test('gateway start() fails closed when composition inputs are incomplete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-composition-invalid-'))
  try {
    const processAdapter = fakeProcessAdapter()
    await expect(
      startGateway({
        environment: {
          ...serviceEnvironment('test'),
          RUNTIME_GATEWAY_STORE_BACKEND: 'sqlite',
          RUNTIME_GATEWAY_SQLITE_PATH: join(directory, 'gateway.sqlite'),
        },
        logger: { write: () => {} },
        processAdapter,
        metrics: new RecordingGatewayMetrics(),
        reachability: new RecordingRuntimeNodeReachabilityPublisher(),
        traceId: () => traceId,
        instanceId: 'm11-composition-gateway',
        hostname: '127.0.0.1',
        authenticateUpgrade: async () => {
          throw new Error('unused')
        },
      })
    ).rejects.toMatchObject({ name: 'ServiceStartupError' })
    expect(processAdapter.exitCode).toBe(1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('worker start() composes a context node from explicit config and fails closed when partial', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-composition-worker-'))
  try {
    const partial = fakeProcessAdapter()
    await expect(
      startWorker({
        environment: serviceEnvironment('test'),
        logger: { write: () => {} },
        processAdapter: partial,
        contextNode: {
          store: { backend: 'sqlite', path: join(directory, 'node.sqlite') },
          workspaceId,
          nodeId,
          timeoutMs: 5000,
          driver: {
            execute: async () => {
              throw new Error('unused')
            },
            reconcile: async () => ({ status: 'unknown' }),
          },
        },
      })
    ).rejects.toMatchObject({ name: 'ServiceStartupError' })
    expect(partial.exitCode).toBe(1)

    const processAdapter = fakeProcessAdapter()
    const runtime = await startWorker({
      environment: serviceEnvironment('test'),
      logger: { write: () => {} },
      processAdapter,
      contextNode: {
        store: { backend: 'sqlite', path: join(directory, 'node.sqlite') },
        workspaceId,
        nodeId,
        timeoutMs: 5000,
        driver: {
          execute: async () => {
            throw new Error('unused')
          },
          reconcile: async () => ({ status: 'unknown' }),
        },
        transport: {
          send: async () => {
            throw new Error('unused')
          },
          nextSequence: async () => 1,
          assertCurrent: async () => {
            throw new Error('unused')
          },
        },
      },
    })
    expect(runtime.readiness().status).toBe('ready')
    await runtime.shutdown('test')
    expect(processAdapter.listeners.size).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
