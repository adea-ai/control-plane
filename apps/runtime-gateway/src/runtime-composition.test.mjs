import { afterEach, expect, test } from 'bun:test'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionLifecycleService, InMemoryExecutionRepository } from '@control-plane/domain'
import { FilesystemObjectStore } from '@control-plane/object-store'
import {
  InMemoryExecutionEventRepository,
  InMemoryRuntimeEventEffectSink,
} from '@control-plane/events'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import {
  RuntimeNodeChannelAuthenticator,
  SyntheticRuntimeNodeIdentityAuthority,
} from './authentication.ts'
import { composeRuntimeGateway } from './composition.ts'
import {
  RecordingGatewayMetrics,
  RecordingRuntimeNodeReachabilityPublisher,
} from './websocket-lifecycle.ts'

const ownedDirectories = new Set()

afterEach(async () => {
  for (const directory of ownedDirectories) {
    await rm(directory, { recursive: true, force: true })
    ownedDirectories.delete(directory)
  }
})

test.each([
  ['missing runtime ports', { runtime: {} }, 'RUNTIME_GATEWAY_RUNTIME_PORT_INVALID'],
  ['null runtime ports', { runtime: null }, 'RUNTIME_GATEWAY_RUNTIME_PORT_INVALID'],
  [
    'subsecond native idle timeout',
    {
      limits: {
        maxConnections: 1,
        maxConnectionsPerWorkspace: 1,
        maxFrameBytes: 1024,
        maxBufferedBytes: 1024,
        heartbeatTimeoutMs: 1,
        idleTimeoutMs: 999,
      },
    },
    'RUNTIME_GATEWAY_COMPOSITION_INVALID',
  ],
  [
    'heartbeat beyond idle timeout',
    {
      limits: {
        maxConnections: 1,
        maxConnectionsPerWorkspace: 1,
        maxFrameBytes: 1024,
        maxBufferedBytes: 1024,
        heartbeatTimeoutMs: 2000,
        idleTimeoutMs: 1000,
      },
    },
    'RUNTIME_GATEWAY_COMPOSITION_INVALID',
  ],
])('refuses %s before opening its owned store', async (_label, overrides, code) => {
  const fixture = await createFixture({ runtime: false })
  const path = join(fixture.directory, 'never-opened.sqlite')
  try {
    await expect(
      fixture.compose({ ...overrides, store: { backend: 'sqlite', path } })
    ).rejects.toThrow(code)
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await fixture.close()
  }
})

test.each(['succeeded', 'failed', 'cancelled'])(
  'composed runtime channel dispatches and ingests %s terminal usage through SQLite-backed command state',
  async (status) => {
    const fixture = await createFixture()
    try {
      expect(fixture.composition.runtime).toBeDefined()
      await fixture.composition.runtime.delivery.enqueue(golden.command)
      fixture.composition.webSocketServer.start()
      const socket = await fixture.connect(1)
      try {
        const command = await fixture.waitForFrame(socket, (frame) => frame.type === 'command')
        expect(command).toMatchObject({
          commandId: golden.command.commandId,
          workspaceId: golden.command.workspaceId,
          nodeId: golden.command.nodeId,
          runtimeConnectionId: golden.command.runtimeConnectionId,
          executionId: golden.command.executionId,
          attemptId: golden.command.attemptId,
          channelGeneration: 1,
        })

        socket.send(
          JSON.stringify({
            ...golden.ack,
            sequence: command.sequence,
            channelGeneration: 1,
            sentAt: '2026-08-25T12:00:01.000Z',
          })
        )
        await fixture.until(
          async () =>
            (await fixture.composition.runtime.delivery.get(golden.command.commandId))?.status ===
            'acknowledged'
        )

        const terminalUsage = { inputTokens: 12, outputTokens: 4, durationMs: 120 }
        const storedArtifact = status === 'succeeded' ? await fixture.seedArtifact() : undefined
        const result = {
          ...golden.result,
          protocolVersion: { major: 1, minor: 7 },
          sequence: command.sequence + 1,
          channelGeneration: 1,
          status,
          terminalUsage,
          result:
            status === 'succeeded'
              ? {
                  artifact: storedArtifact.artifact,
                }
              : { data: { error: { code: 'RUNTIME_FAILED', retryable: false } } },
        }
        socket.send(JSON.stringify(result))
        await fixture.until(
          async () =>
            (await fixture.composition.runtime.delivery.get(golden.command.commandId))?.status ===
            status
        )

        const executionEvents = await fixture.events.queryAfter(golden.command.executionId, 0, 10)
        expect(executionEvents).toHaveLength(1)
        expect(executionEvents[0].payload).toMatchObject({
          terminalUsage,
          runtimeUsageSource: {
            nodeId: golden.command.nodeId,
            runtimeConnectionId: golden.command.runtimeConnectionId,
            commandId: golden.command.commandId,
            channelGeneration: 1,
          },
        })
        expect(fixture.quarantine.records).toEqual([])
      } finally {
        socket.close()
      }
    } finally {
      await fixture.close()
    }
  }
)

test('reopened SQLite composition reconciles a retained running outcome without redelivery', async () => {
  const fixture = await createFixture()
  let socket
  try {
    await fixture.composition.runtime.delivery.enqueue(golden.command)
    fixture.composition.webSocketServer.start()
    socket = await fixture.connect(1)
    const firstCommand = await fixture.waitForFrame(socket, (frame) => frame.type === 'command')
    expect(firstCommand.commandId).toBe(golden.command.commandId)
    socket.close()
    await fixture.composition.close()
    fixture.composition = await fixture.compose()
    fixture.composition.webSocketServer.start()

    const retained = {
      commandId: golden.command.commandId,
      payloadHash: golden.command.payloadHash,
      status: 'running',
      observedAt: '2026-08-25T12:00:02.000Z',
    }
    const reconnected = await fixture.connect(2, [retained])
    try {
      const hello = await fixture.waitForFrame(reconnected, (frame) => frame.type === 'hello')
      expect(hello).toMatchObject({ channelGeneration: 2 })
      await fixture.until(() => fixture.reconciled.length === 1)
      expect(fixture.framesFor(reconnected).filter((frame) => frame.type === 'command')).toEqual([])
      expect(fixture.reconciled).toEqual([golden.command.executionId])
      expect(
        await fixture.composition.runtime.delivery.get(golden.command.commandId)
      ).toMatchObject({
        status: 'dispatched',
        deliveryAttempts: 1,
        lastChannelGeneration: 1,
      })
    } finally {
      reconnected.close()
    }
  } finally {
    socket?.close()
    await fixture.close()
  }
})

test('context-only composition stays backward compatible and exposes no runtime command port', async () => {
  const fixture = await createFixture({ runtime: false })
  try {
    expect(fixture.composition.runtime).toBeUndefined()
    expect(fixture.composition.delivery).toBeDefined()
    expect(fixture.composition.recovery).toBeDefined()
  } finally {
    await fixture.close()
  }
})

test('composed terminal artifact requires the host verifier before execution effects', async () => {
  const fixture = await createFixture({ artifactDenied: true })
  try {
    const storedArtifact = await fixture.seedArtifact()
    await fixture.composition.runtime.delivery.enqueue(golden.command)
    fixture.composition.webSocketServer.start()
    const socket = await fixture.connect(1)
    try {
      const command = await fixture.waitForFrame(socket, (frame) => frame.type === 'command')
      socket.send(
        JSON.stringify({
          ...golden.result,
          sequence: command.sequence + 1,
          channelGeneration: 1,
          status: 'succeeded',
          result: { artifact: storedArtifact.artifact },
        })
      )
      await fixture.until(() => fixture.quarantine.records.length === 1)
      expect(fixture.artifactVerifications).toHaveLength(1)
      expect(
        await fixture.composition.runtime.delivery.get(golden.command.commandId)
      ).toMatchObject({ status: 'dispatched' })
      expect(await fixture.events.queryAfter(golden.command.executionId, 0, 10)).toEqual([])
      expect(fixture.quarantine.records).toHaveLength(1)
    } finally {
      socket.close()
    }
  } finally {
    await fixture.close()
  }
})

test('a no-op host verifier cannot authorize a missing terminal artifact', async () => {
  const fixture = await createFixture()
  try {
    await fixture.composition.runtime.delivery.enqueue(golden.command)
    fixture.composition.webSocketServer.start()
    const socket = await fixture.connect(1)
    try {
      const command = await fixture.waitForFrame(socket, (frame) => frame.type === 'command')
      socket.send(
        JSON.stringify({
          ...golden.result,
          sequence: command.sequence + 1,
          channelGeneration: 1,
          status: 'succeeded',
          result: {
            artifact: {
              artifactId: `art_${golden.command.attemptId.slice(4)}`,
              digest: `sha256:${'a'.repeat(64)}`,
              mediaType: 'application/json',
              sizeBytes: 10,
            },
          },
        })
      )
      await fixture.until(async () => {
        const commandRecord = await fixture.composition.runtime.delivery.get(
          golden.command.commandId
        )
        return (
          fixture.quarantine.records.length > 0 ||
          ['succeeded', 'failed', 'cancelled'].includes(commandRecord?.status)
        )
      })
      expect(fixture.quarantine.records).toHaveLength(1)
      expect(await fixture.events.queryAfter(golden.command.executionId, 0, 10)).toEqual([])
      expect(
        await fixture.composition.runtime.delivery.get(golden.command.commandId)
      ).toMatchObject({ status: 'dispatched' })
    } finally {
      socket.close()
    }
  } finally {
    await fixture.close()
  }
})

test.each([
  ['missing object', async (fixture, reference) => fixture.objectStore.delete(reference.key)],
  [
    'corrupt stored bytes',
    async (fixture, reference) =>
      fixture.objectStore.put({
        key: reference.key,
        body: new TextEncoder().encode('{"result":"corrupt"}'),
        contentType: 'application/json',
        metadata: { attempt: golden.command.attemptId },
      }),
  ],
  [
    'wrong attempt metadata',
    async (fixture, reference) =>
      fixture.objectStore.put({
        key: reference.key,
        body: reference.body,
        contentType: 'application/json',
        metadata: { attempt: `${golden.command.attemptId.slice(0, -1)}H` },
      }),
  ],
  [
    'wrong stored key',
    async (fixture) => {
      fixture.setArtifactStoreHooks({ head: (head) => ({ ...head, key: 'runtime-results/other' }) })
    },
  ],
  [
    'wrong artifact ID',
    async (_fixture, reference) =>
      (reference.artifact.artifactId = 'art_01JBBCDEF0123456789ABCDEFG'),
  ],
  [
    'wrong media type',
    async (_fixture, reference) => (reference.artifact.mediaType = 'text/plain'),
  ],
  ['wrong size', async (_fixture, reference) => (reference.artifact.sizeBytes += 1)],
  ['oversized reference', async (_fixture, reference) => (reference.artifact.sizeBytes = 262145)],
  [
    'HEAD GET swap',
    async (fixture, reference) => {
      fixture.setArtifactStoreHooks({
        beforeGet: async (key) =>
          fixture.objectStore.put({
            key,
            body: new TextEncoder().encode('{"result":"replaced"}'),
            contentType: 'application/json',
            metadata: { attempt: golden.command.attemptId },
          }),
      })
      return reference
    },
  ],
])(
  'composed %s artifact does not apply terminal effects or settle its command',
  async (_name, mutate) => {
    const fixture = await createFixture()
    try {
      const storedArtifact = await fixture.seedArtifact()
      const reference = { ...storedArtifact, artifact: { ...storedArtifact.artifact } }
      await mutate(fixture, reference)
      await fixture.composition.runtime.delivery.enqueue(golden.command)
      fixture.composition.webSocketServer.start()
      const socket = await fixture.connect(1)
      try {
        const command = await fixture.waitForFrame(socket, (frame) => frame.type === 'command')
        socket.send(
          JSON.stringify({
            ...golden.result,
            sequence: command.sequence + 1,
            channelGeneration: 1,
            status: 'succeeded',
            result: { artifact: reference.artifact },
          })
        )
        await fixture.until(() => fixture.quarantine.records.length === 1)
        expect(fixture.artifactVerifications).toEqual([])
        expect(await fixture.events.queryAfter(golden.command.executionId, 0, 10)).toEqual([])
        expect(
          await fixture.composition.runtime.delivery.get(golden.command.commandId)
        ).toMatchObject({ status: 'dispatched' })
      } finally {
        socket.close()
      }
    } finally {
      await fixture.close()
    }
  }
)

test('revocation during supplemental artifact policy prevents terminal effects', async () => {
  const fixture = await createFixture({ revokeCredentialDuringArtifactVerification: true })
  try {
    const storedArtifact = await fixture.seedArtifact()
    await fixture.composition.runtime.delivery.enqueue(golden.command)
    fixture.composition.webSocketServer.start()
    const socket = await fixture.connect(1)
    try {
      const command = await fixture.waitForFrame(socket, (frame) => frame.type === 'command')
      socket.send(
        JSON.stringify({
          ...golden.result,
          sequence: command.sequence + 1,
          channelGeneration: 1,
          status: 'succeeded',
          result: { artifact: storedArtifact.artifact },
        })
      )
      await fixture.until(() => fixture.quarantine.records.length === 1)
      expect(fixture.artifactVerifications).toHaveLength(1)
      expect(await fixture.events.queryAfter(golden.command.executionId, 0, 10)).toEqual([])
      expect(
        await fixture.composition.runtime.delivery.get(golden.command.commandId)
      ).toMatchObject({ status: 'dispatched' })
    } finally {
      socket.close()
    }
  } finally {
    await fixture.close()
  }
})

test('production composition denies before durable admission', async () => {
  const fixture = await createFixture({ denyAtValidation: 1 })
  try {
    await expect(
      fixture.composition.runtime.delivery.enqueue(golden.command)
    ).rejects.toMatchObject({ code: 'RUNTIME_COMMAND_AUTHORIZATION_DENIED' })
    expect(await fixture.composition.runtime.delivery.get(golden.command.commandId)).toBeUndefined()
  } finally {
    await fixture.close()
  }
})

test('production composition rechecks revoked authority at the socket send boundary', async () => {
  const fixture = await createFixture({ denyAtValidation: 4 })
  try {
    await fixture.composition.runtime.delivery.enqueue(golden.command)
    fixture.composition.webSocketServer.start()
    const socket = await fixture.connect(1)
    try {
      await fixture.until(
        () => fixture.validationCalls >= 4 && socket.readyState === WebSocket.CLOSED
      )
      expect(fixture.framesFor(socket).filter((frame) => frame.type === 'command')).toEqual([])
      expect(
        await fixture.composition.runtime.delivery.get(golden.command.commandId)
      ).toMatchObject({ status: 'dispatched', deliveryAttempts: 1 })
    } finally {
      socket.close()
    }
  } finally {
    await fixture.close()
  }
})

test('production composition rejects inventory after durable revocation when notification is missed', async () => {
  const fixture = await createFixture({ missRevocationNotifications: true })
  let socket
  try {
    fixture.composition.webSocketServer.start()
    socket = await fixture.connect(1)
    await fixture.waitForFrame(socket, (frame) => frame.type === 'hello')
    fixture.revokeActiveCredential()
    socket.send(JSON.stringify(golden.inventory))

    await fixture.until(
      () =>
        fixture.metrics.counterValue('runtime_gateway.inbound_failures') > 0 ||
        fixture.inventoryCalls.length > 0
    )
    expect(fixture.inventoryCalls).toEqual([])
    expect(fixture.metrics.counterValue('runtime_gateway.inbound_failures')).toBe(1)
  } finally {
    socket?.close()
    await fixture.close()
  }
})

test('a queued command above the negotiated protocol version remains unsent and queued', async () => {
  const fixture = await createFixture()
  try {
    await fixture.composition.runtime.delivery.enqueue({
      ...golden.command,
      protocolVersion: { major: 1, minor: 7 },
    })
    fixture.composition.webSocketServer.start()
    const socket = await fixture.connect(1, [], 6)
    try {
      await fixture.until(() => socket.readyState === WebSocket.CLOSED)
      expect(fixture.framesFor(socket).filter((frame) => frame.type === 'command')).toEqual([])
      expect(
        await fixture.composition.runtime.delivery.get(golden.command.commandId)
      ).toMatchObject({ status: 'queued', deliveryAttempts: 0 })
    } finally {
      socket.close()
    }
  } finally {
    await fixture.close()
  }
})

async function createFixture({
  runtime = true,
  artifactDenied = false,
  revokeCredentialDuringArtifactVerification = false,
  missRevocationNotifications = false,
  denyAtValidation,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-runtime-gateway-'))
  ownedDirectories.add(directory)
  const path = join(directory, 'gateway.sqlite')
  const executions = new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(executions)
  let execution = await lifecycle.createExecution({
    executionId: golden.command.executionId,
    correlation: {
      workspaceId: golden.command.workspaceId,
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
      agentId: 'agt_01JABCDEF0123456789ABCDEFG',
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
    },
    executionPlan: {
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'d'.repeat(64)}`,
      schemaVersion: 1,
    },
    acceptedAt: '2026-08-25T11:59:58.000Z',
  })
  let attempt = await lifecycle.createAttempt({
    executionId: execution.executionId,
    attemptId: golden.command.attemptId,
    expectedExecutionVersion: execution.version,
    queuedAt: '2026-08-25T11:59:59.000Z',
    runtime: {
      runtimeNodeRefId: golden.command.nodeId,
      runtimeConnectionId: golden.command.runtimeConnectionId,
    },
  })
  execution = await lifecycle.getExecution(execution.executionId)
  execution = await lifecycle.transitionExecution({
    executionId: execution.executionId,
    expectedVersion: execution.version,
    to: 'queued',
    transitionedAt: '2026-08-25T11:59:59.000Z',
  })
  await lifecycle.transitionExecution({
    executionId: execution.executionId,
    expectedVersion: execution.version,
    to: 'running',
    transitionedAt: '2026-08-25T12:00:00.000Z',
  })
  await lifecycle.transitionAttempt({
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    to: 'running',
    transitionedAt: '2026-08-25T12:00:00.000Z',
  })

  const events = new InMemoryExecutionEventRepository()
  const effects = new InMemoryRuntimeEventEffectSink({ lifecycle, events })
  const quarantine = {
    records: [],
    async record(value) {
      this.records.push(value)
    },
  }
  const artifactVerifications = []
  const objectStoreStorage = new FilesystemObjectStore({
    rootDirectory: join(directory, 'objects'),
    maxObjectBytes: 64 * 1024 * 1024,
  })
  let artifactStoreHooks = {}
  let activeCredentialId
  let validationCalls = 0
  const reconciled = []
  const authority = new SyntheticRuntimeNodeIdentityAuthority({
    issuer: 'https://identity.test',
    audience: 'runtime-gateway',
  })
  const expectation = {
    issuer: 'https://identity.test',
    audience: 'runtime-gateway',
    nodeId: golden.command.nodeId,
    workspaceId: golden.command.workspaceId,
    challenge: 'runtime-gateway-composition-challenge',
  }
  const device = authority.registerNode({
    nodeId: expectation.nodeId,
    workspaceId: expectation.workspaceId,
  })
  const validationPort = authority.validationPort()
  const authenticator = new RuntimeNodeChannelAuthenticator({
    identityValidator: missRevocationNotifications
      ? { ...validationPort, subscribeRevocations: () => () => undefined }
      : validationPort,
    logger: { write() {} },
  })
  const openSockets = new Set()
  const allFrames = new WeakMap()
  const inventoryCalls = []
  let metrics
  let native
  let generation = 0

  async function compose(overrides = {}) {
    metrics = new RecordingGatewayMetrics()
    const result = await composeRuntimeGateway({
      store: { backend: 'sqlite', path },
      objectStore: {
        put: (input) => objectStoreStorage.put(input),
        putIfAbsent: (input) => objectStoreStorage.putIfAbsent(input),
        async get(key) {
          await artifactStoreHooks.beforeGet?.(key)
          const stored = await objectStoreStorage.get(key)
          return artifactStoreHooks.get?.(stored, key) ?? stored
        },
        async head(key) {
          const stored = await objectStoreStorage.head(key)
          return artifactStoreHooks.head?.(stored, key) ?? stored
        },
        delete: (key) => objectStoreStorage.delete(key),
        close: () => objectStoreStorage.close(),
      },
      authenticateUpgrade: async (request) => {
        const authenticationProof = JSON.parse(request.headers.get('x-test-node-proof') ?? 'null')
        return authenticator.authenticate(authenticationProof, {
          ...expectation,
          channelGeneration: generation,
        })
      },
      // The SAME runtime-node credential source the channel authenticator
      // trusts also fences runtime-command settlements (SQLite profile).
      runtimeNodeCredentialAuthority: authority.validationPort(),
      metrics,
      reachability: new RecordingRuntimeNodeReachabilityPublisher(),
      traceId: () => golden.command.traceId,
      instanceId: `composition-test-${generation || 1}`,
      hostname: '127.0.0.1',
      port: 0,
      ...(runtime
        ? {
            runtime: {
              executions,
              effects,
              quarantine,
              validator: {
                async validate() {
                  validationCalls += 1
                  return validationCalls === denyAtValidation
                    ? { valid: false, reason: 'grant_revoked' }
                    : { valid: true }
                },
              },
              outcomes: { apply: async () => {} },
              executionReconciler: {
                async reconcile(executionId) {
                  reconciled.push(executionId)
                },
                async requireManualIntervention() {},
              },
              artifactVerifier: {
                async verify(value) {
                  artifactVerifications.push(value)
                  if (
                    revokeCredentialDuringArtifactVerification &&
                    activeCredentialId !== undefined
                  ) {
                    authority.revokeCredential(activeCredentialId)
                  }
                  if (artifactDenied) throw new Error('artifact is not host-authorized')
                },
              },
              inventory: {
                async handle(source, envelope) {
                  inventoryCalls.push({ source, envelope })
                },
              },
              now: () => new Date('2026-08-25T12:00:30.000Z'),
            },
          }
        : {}),
      serve: (options) => {
        native = Bun.serve(options)
        console.info(`owned-runtime-gateway pid=${process.pid} port=${native.port}`)
        return native
      },
      ...overrides,
    })
    return result
  }

  let composition = await compose()

  return {
    directory,
    get validationCalls() {
      return validationCalls
    },
    get composition() {
      return composition
    },
    set composition(value) {
      composition = value
    },
    events,
    quarantine,
    artifactVerifications,
    inventoryCalls,
    get metrics() {
      return metrics
    },
    revokeActiveCredential() {
      if (activeCredentialId === undefined) throw new Error('NO_ACTIVE_CREDENTIAL')
      authority.revokeCredential(activeCredentialId)
    },
    objectStore: objectStoreStorage,
    setArtifactStoreHooks(hooks) {
      artifactStoreHooks = hooks
    },
    async seedArtifact({
      attemptId = golden.command.attemptId,
      key = `runtime-results/${attemptId}/result.json`,
      body = new TextEncoder().encode('{"result":"ok"}'),
      mediaType = 'application/json',
      metadataAttempt = attemptId,
    } = {}) {
      const bytes = new Uint8Array(body)
      const descriptor = await objectStoreStorage.put({
        key,
        body: bytes,
        contentType: mediaType,
        metadata: { attempt: metadataAttempt },
      })
      return {
        key,
        body: bytes,
        artifact: {
          artifactId: `art_${attemptId.slice(4)}`,
          digest: descriptor.sha256,
          mediaType,
          sizeBytes: descriptor.size,
        },
      }
    },
    reconciled,
    framesFor(socket) {
      return allFrames.get(socket) ?? []
    },
    async until(predicate) {
      const deadline = Date.now() + 3_000
      while (!(await predicate())) {
        if (Date.now() >= deadline) throw new Error('RUNTIME_GATEWAY_COMPOSITION_TIMEOUT')
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    async waitForFrame(socket, predicate) {
      await this.until(() => (allFrames.get(socket) ?? []).some(predicate))
      return (allFrames.get(socket) ?? []).find(predicate)
    },
    async connect(channelGeneration, retainedCommandOutcomes = [], protocolMinor = 7) {
      generation = channelGeneration
      const issued = authority.issueCredential(device, { channelGeneration })
      activeCredentialId = issued.claims.credentialId
      const proof = device.authenticationAttempt(issued.credential, expectation.challenge)
      const socket = new WebSocket(`ws://127.0.0.1:${native.port}/runtime-gateway/v1/connect`, {
        headers: { 'x-test-node-proof': JSON.stringify(proof) },
      })
      const frames = []
      allFrames.set(socket, frames)
      openSockets.add(socket)
      socket.addEventListener('message', (event) => frames.push(JSON.parse(event.data)))
      await this.until(() => socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          ...golden.hello,
          protocolVersion: { major: 1, minor: protocolMinor },
          supportedVersions: [{ major: 1, minor: protocolMinor }],
          channelGeneration,
          retainedCommandOutcomes,
        })
      )
      return socket
    },
    async close() {
      for (const socket of openSockets) socket.close()
      await composition.close()
      authenticator.close()
      objectStoreStorage.close()
      await rm(directory, { recursive: true, force: true })
      ownedDirectories.delete(directory)
    },
    async compose(overrides) {
      return compose(overrides)
    },
  }
}
