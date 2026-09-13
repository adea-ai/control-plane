import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeContextProvider } from '@control-plane/context'
import { ContextProviderAdministration } from '@control-plane/domain'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  SqliteContextCommandGrantRepository,
  SqliteContextProviderRegistrationRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { createContextBundle } from '../packages/cortana-context-adapter/src/index.ts'
import { composeContextNode, ContextHttpProviderDriver } from '../apps/runtime-worker/src/index.ts'
import {
  composeRuntimeGateway,
  RecordingGatewayMetrics,
  RecordingRuntimeNodeReachabilityPublisher,
  RuntimeNodeChannelAuthenticator,
  SyntheticRuntimeNodeIdentityAuthority,
} from '../apps/runtime-gateway/src/index.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const nodeId = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const providerRef = 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const principalRef = 'principal://test/user'
const authorizationRef = 'authz:consistency-metrics-test'
const traceId = 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const audience = 'control-plane-runtime-gateway'
const issuer = 'https://identity.consistency-metrics.test.example'

/** Records every metric emission so bounded labels are provable end to end. */
class RecordingMetricAdapter {
  emissions = []
  add(name, value, attributes) {
    this.emissions.push({ name, value, attributes })
  }
  record(name, value, attributes) {
    this.emissions.push({ name, value, attributes })
  }
}

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
        timer = setTimeout(() => reject(new Error('CONSISTENCY_METRICS_TEST_DEADLINE')), 15000)
      }),
    ])
  } finally {
    clearTimeout(timer)
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
  return { gatewayPath, nodePath, bundle }
}

test('the composed gateway emits bounded consistency metrics during a delivery and read scenario', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-consistency-metrics-'))
  const objects = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 262144,
  })
  let http
  let node
  let composition
  let authenticator
  const sockets = []
  const operations = []
  const recording = new RecordingMetricAdapter()
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
    const authority = new SyntheticRuntimeNodeIdentityAuthority({
      audience,
      issuer,
    })
    const device = authority.registerNode({ nodeId, workspaceId })
    authenticator = new RuntimeNodeChannelAuthenticator({
      identityValidator: authority.validationPort(),
      logger: { write: () => {} },
    })
    let native
    composition = await composeRuntimeGateway({
      store: { backend: 'sqlite', path: gatewayPath },
      objectStore: objects,
      metrics: new RecordingGatewayMetrics(),
      reachability: new RecordingRuntimeNodeReachabilityPublisher(),
      traceId: () => traceId,
      instanceId: 'm11-consistency-metrics-gateway',
      hostname: '127.0.0.1',
      port: 0,
      metricAdapter: recording,
      authenticateUpgrade: async (request) =>
        authenticator.authenticate(JSON.parse(request.headers.get('x-node-attempt')), {
          audience,
          issuer,
          nodeId,
          workspaceId,
          channelGeneration: 1,
          challenge: 'challenge-consistency-metrics',
        }),
      serve: (options) => {
        native = Bun.serve(options)
        return native
      },
    })
    composition.webSocketServer.start()

    const nodeState = { socket: undefined, received: new Set(), sequence: 2 }
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
        http: {
          endpoint: `http://127.0.0.1:${http.port}/read`,
          allowLoopbackHttp: true,
        },
      }),
      transport: {
        send: async (serialized) => nodeState.socket?.send(serialized),
        nextSequence: async () => nodeState.sequence++,
        assertCurrent: async (command) => {
          if (nodeState.socket?.readyState !== WebSocket.OPEN)
            throw new Error('CONSISTENCY_METRICS_CHANNEL_CLOSED')
          nodeState.received.add(command.commandId)
        },
      },
    })
    const pump = (data) => {
      operations.push(node.channel.receive(data).catch(() => {}))
    }
    const readRequest = (operationId, policyMode) => ({
      workspaceId,
      scopeDigest: bundle.scopeDigest,
      principalRef,
      executionLocation: 'runtime_node',
      capability: 'evidenceSearch',
      objective: 'Find fixture evidence',
      operationId,
      now: new Date().toISOString(),
      policy: {
        mode: policyMode,
        providerIds: [],
        connectionIds: [],
        includeEvidence: true,
        includeMemory: true,
        maximumTokens: 100,
        maximumAgeSeconds: 3600,
        maximumProviderHealthAgeSeconds: 60,
        maximumLatencyMs: 10000,
        failureBehavior: 'fail',
      },
    })

    // Connect the node through the authenticated gateway channel.
    const issued = authority.issueCredential(device, { channelGeneration: 1 })
    const hello = deferred()
    const socket = new WebSocket(`ws://127.0.0.1:${native.port}/runtime-gateway/v1/connect`, {
      headers: {
        'x-node-attempt': JSON.stringify(
          device.authenticationAttempt(issued.credential, 'challenge-consistency-metrics')
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
        channelGeneration: 1,
        sentAt: new Date().toISOString(),
      })
    )
    await deadline(hello.promise)

    // A delivered and executed context read proves the included emission.
    const resolution = await deadline(
      composition.resolver.resolve(readRequest('consistency-metrics:included-read', 'required'))
    )
    expect(resolution.status).toBe('included')
    expect(httpReads).toEqual(['consistency-metrics:included-read'])
    const commandId = [...nodeState.received][0]
    const record = await composition.delivery.get(workspaceId, commandId)
    expect(record.status).toBe('succeeded')
    expect(await composition.artifacts.read(record)).toEqual(bundle)

    // A disabled policy resolves through the no-provider path and is emitted too.
    const disabled = await deadline(
      composition.resolver.resolve(readRequest('consistency-metrics:disabled-read', 'disabled'))
    )
    expect(disabled.status).toBe('disabled')

    // Every emission is bounded, attributed, and exactly the cataloged provider set.
    expect(recording.emissions).toEqual([
      {
        name: 'context.provider_resolution.count',
        value: 1,
        attributes: {
          'service.name': 'runtime-gateway',
          outcome: 'included',
          reason: 'PROVIDER_SELECTED',
        },
      },
      {
        name: 'context.provider_resolution.count',
        value: 1,
        attributes: {
          'service.name': 'runtime-gateway',
          outcome: 'disabled',
          reason: 'POLICY_DISABLED',
        },
      },
    ])
    // Event frames stay fail-closed in this composition: no quarantine sink exists
    // yet, so no quarantine metric may be invented for the delivered scenario.
    expect(recording.emissions.some(({ name }) => name === 'control.event.quarantine.count')).toBe(
      false
    )
  } finally {
    for (const socket of sockets) socket.close()
    if (composition !== undefined) await composition.close()
    authenticator?.close()
    await Promise.allSettled(operations)
    http?.stop(true)
    objects.close()
    await node?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 30000)
