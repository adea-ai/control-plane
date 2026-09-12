import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeContextProvider } from '@control-plane/context'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  SqlitePersistenceProvider,
  SqliteContextCommandRepository,
  SqliteContextNodeInboxRepository,
  SqliteRuntimeChannelSequenceRepository,
} from '@control-plane/sqlite-persistence'
import {
  CortanaContextProviderAdapter,
  createContextBundle,
} from '../packages/cortana-context-adapter/src/index.ts'
import {
  ContextNodeHandler,
  ContextNodeChannel,
  ContextHttpProviderDriver,
} from '../apps/runtime-worker/src/index.ts'
import {
  ContextCommandDeliveryService,
  ContextGatewayReadClient,
  ContextCommandArtifactStore,
  RuntimeGatewayMessageRouter,
  RuntimeGatewayWebSocketLifecycle,
  RuntimeGatewayWebSocketServer,
  InMemoryRuntimeNodeCoordination,
  RecordingGatewayMetrics,
  RecordingRuntimeNodeReachabilityPublisher,
  RuntimeNodeChannelAuthenticator,
  SyntheticRuntimeNodeIdentityAuthority,
} from '../apps/runtime-gateway/src/index.ts'

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
        timer = setTimeout(() => reject(new Error('CONTEXT_TRANSPORT_TEST_DEADLINE')), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const loseFirstResult of [false, true]) {
  test(`adapter read crosses signed gateway WebSocket and durable Artifact storage (lost result: ${loseFirstResult})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'm11-context-transport-'))
    const gatewayDb = new SqlitePersistenceProvider({ path: join(directory, 'gateway.sqlite') })
    const nodeDb = new SqlitePersistenceProvider({ path: join(directory, 'node.sqlite') })
    const objects = new FilesystemObjectStore({
      rootDirectory: join(directory, 'objects'),
      maxObjectBytes: 262144,
    })
    let http, server, socket, authenticator
    const operations = []
    try {
      await gatewayDb.migrate()
      await nodeDb.migrate()
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
      const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        nodeId = 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
      const providerRef = 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV'
      const traceId = 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        principalRef = 'principal://test/user'
      let httpReads = 0
      http = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request) => {
          const body = await request.json()
          expect(body.operationId).toBe('context-author:transport-test')
          expect(body.mappedProjectRef).toBe('fixture-project')
          httpReads++
          return Response.json(bundle)
        },
      })
      const audience = 'control-plane-runtime-gateway',
        issuer = 'https://identity.test.example',
        challenge = 'challenge-context-transport-0001'
      const authority = new SyntheticRuntimeNodeIdentityAuthority({ audience, issuer })
      const device = authority.registerNode({ nodeId, workspaceId })
      const issued = authority.issueCredential(device, { channelGeneration: 1 })
      authenticator = new RuntimeNodeChannelAuthenticator({
        identityValidator: authority.validationPort(),
        logger: { write: () => {} },
      })
      const coordination = new InMemoryRuntimeNodeCoordination()
      const artifacts = new ContextCommandArtifactStore(objects)
      const repository = new SqliteContextCommandRepository(gatewayDb)
      const acknowledged = deferred(),
        completed = deferred(),
        hello = deferred()
      let lifecycle, channel, native, captured
      const delivery = new ContextCommandDeliveryService({
        repository,
        coordination,
        results: artifacts,
        sender: { send: (command) => lifecycle.send(command) },
      })
      const unexpected = async () => {
        throw new Error('UNEXPECTED_RUNTIME_ROUTE')
      }
      const router = new RuntimeGatewayMessageRouter({
        context: delivery,
        inventory: { handle: unexpected },
        delivery: { acknowledge: unexpected, recordResult: unexpected, recordError: unexpected },
        events: { ingestProgress: unexpected, ingestResult: unexpected, ingestError: unexpected },
      })
      lifecycle = new RuntimeGatewayWebSocketLifecycle({
        sequences: new SqliteRuntimeChannelSequenceRepository(gatewayDb),
        instanceId: 'context-test-gateway',
        coordination,
        metrics: new RecordingGatewayMetrics(),
        reachability: new RecordingRuntimeNodeReachabilityPublisher(),
        limits: {
          maxConnections: 2,
          maxConnectionsPerWorkspace: 2,
          maxFrameBytes: 262144,
          maxBufferedBytes: 262144,
          heartbeatTimeoutMs: 15000,
          idleTimeoutMs: 30000,
        },
        messages: {
          handle: async (source, frame) => {
            try {
              await router.handle(source, frame)
              if (frame.type === 'ack') acknowledged.resolve()
              if (frame.type === 'result')
                completed.resolve(await delivery.get(workspaceId, commandId))
            } catch (error) {
              completed.reject(error)
              throw error
            }
          },
        },
      })
      server = new RuntimeGatewayWebSocketServer({
        lifecycle,
        hostname: '127.0.0.1',
        port: 0,
        limits: { maxFrameBytes: 262144, maxBufferedBytes: 262144, idleTimeoutSeconds: 30 },
        authenticateUpgrade: async (request) => {
          channel = await authenticator.authenticate(
            JSON.parse(request.headers.get('x-node-attempt')),
            { audience, issuer, nodeId, workspaceId, channelGeneration: 1, challenge }
          )
          return channel
        },
        serve: (options) => {
          native = Bun.serve(options)
          return native
        },
      })
      server.start()
      const guard = async (command) => {
        await channel.assertCommandAllowed(command)
        const owner = await coordination.lookup(nodeId)
        if (
          owner?.channelGeneration !== command.channelGeneration ||
          owner.workspaceId !== workspaceId ||
          command.authorizationRef !== 'authz:context-transport-test' ||
          command.providerRef !== providerRef ||
          command.payload.parameters.principalRef !== principalRef
        )
          throw new Error('CONTEXT_TEST_GRANT_DENIED')
      }
      const handler = new ContextNodeHandler({
        workspaceId,
        nodeId,
        timeoutMs: 5000,
        repository: new SqliteContextNodeInboxRepository(nodeDb),
        authorize: (record) => guard(record.commandEnvelope),
        driver: new ContextHttpProviderDriver({
          workspaceId,
          nodeId,
          providerRef,
          mappedProjectRef: 'fixture-project',
          http: { endpoint: `http://127.0.0.1:${http.port}/read`, allowLoopbackHttp: true },
        }),
      })
      let sequence = 2
      let dropped = false,
        redelivered = false
      const bridge = new ContextNodeChannel({
        handler,
        assertCurrent: guard,
        nextSequence: async () => sequence++,
        send: async (value) => {
          if (loseFirstResult && !dropped && JSON.parse(value).type === 'result') {
            dropped = true
            return
          }
          socket.send(value)
        },
      })
      socket = new WebSocket(`ws://127.0.0.1:${native.port}/runtime-gateway/v1/connect`, {
        headers: {
          'x-node-attempt': JSON.stringify(
            device.authenticationAttempt(issued.credential, challenge)
          ),
        },
      })
      socket.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data))
        if (frame.type === 'hello') {
          hello.resolve()
          return
        }
        const operation = bridge
          .receive(String(event.data))
          .then(async () => {
            if (dropped && !redelivered) {
              redelivered = true
              await deadline(acknowledged.promise)
              const source = await coordination.lookup(nodeId)
              await delivery.deliver(source, commandId, await lifecycle.nextSequence(source))
            }
          })
          .catch((error) => completed.reject(error))
        operations.push(operation)
      })
      await deadline(
        new Promise((resolve, reject) => {
          socket.addEventListener('open', resolve, { once: true })
          socket.addEventListener('error', reject, { once: true })
        })
      )
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
      const adapter = new CortanaContextProviderAdapter({
        readModel,
        providerRef,
        mappedProjectRef: 'fixture-project',
        transport: 'runtime_node',
        maximumRetries: 0,
        bindRuntimeNodeRead: async ({ request }) => ({
          nodeId,
          workspaceId,
          traceId,
          channelGeneration: 1,
          sequence: 1,
          commandId,
          idempotencyKey: 'context-read:transport-test',
          authorizationRef: 'authz:context-transport-test',
          providerRef,
          principalRef,
          scopeDigest: request.scopeDigest,
          expiresAt: new Date(Date.now() + 10000).toISOString(),
        }),
        client: new ContextGatewayReadClient({
          delivery,
          artifacts,
          coordination,
          nextSequence: (source) => lifecycle.nextSequence(source),
          authorize: async (record) => {
            captured = record.commandEnvelope
            await guard(record.commandEnvelope)
          },
        }),
      })
      const contributions = await adapter.retrieve({
        workspaceId,
        scopeDigest: bundle.scopeDigest,
        principalRef,
        executionLocation: 'runtime_node',
        capability: 'evidenceSearch',
        objective: 'Find fixture evidence',
        operationId: 'context-author:transport-test',
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
          maximumLatencyMs: 10000,
          failureBehavior: 'fail',
        },
      })
      await Promise.all(operations)
      expect(contributions.map(({ kind }) => kind)).toEqual(['evidence', 'memory'])
      expect(httpReads).toBe(1)
      const terminal = await repository.get(workspaceId, commandId)
      expect(terminal.status).toBe('succeeded')
      expect(terminal.deliveryAttempts).toBe(loseFirstResult ? 2 : 1)
      expect(await artifacts.read(terminal)).toEqual(bundle)
      expect(
        (await new SqliteContextNodeInboxRepository(nodeDb).get(workspaceId, nodeId, commandId))
          .status
      ).toBe('succeeded')
      authority.revokeCredential(issued.claims.credentialId)
      await expect(lifecycle.send(captured)).rejects.toMatchObject({
        code: 'RUNTIME_NODE_CREDENTIAL_REVOKED',
      })
      expect(httpReads).toBe(1)
    } finally {
      socket?.close()
      await server?.close()
      await Promise.allSettled(operations)
      authenticator?.close()
      await http?.stop(true)
      objects.close()
      gatewayDb.close()
      nodeDb.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
}
