import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionLifecycleService, InMemoryExecutionRepository } from '@control-plane/domain'
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
                  artifact: {
                    artifactId: 'art_01JABCDEF0123456789ABCDEFG',
                    digest: `sha256:${'a'.repeat(64)}`,
                    mediaType: 'application/json',
                    sizeBytes: 10,
                  },
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
      await fixture.pause(50)
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
              artifactId: 'art_01JABCDEF0123456789ABCDEFG',
              digest: `sha256:${'a'.repeat(64)}`,
              mediaType: 'application/json',
              sizeBytes: 10,
            },
          },
        })
      )
      await fixture.pause(100)
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
      await fixture.pause(100)
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
      await fixture.pause(100)
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

async function createFixture({ runtime = true, artifactDenied = false, denyAtValidation } = {}) {
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
  const authenticator = new RuntimeNodeChannelAuthenticator({
    identityValidator: authority.validationPort(),
    logger: { write() {} },
  })
  const openSockets = new Set()
  const allFrames = new WeakMap()
  let native
  let generation = 0

  async function compose() {
    const result = await composeRuntimeGateway({
      store: { backend: 'sqlite', path },
      objectStore: {
        async put() {
          throw new Error('unused')
        },
        async get() {
          throw new Error('unused')
        },
        async head() {
          throw new Error('unused')
        },
        async delete() {
          throw new Error('unused')
        },
      },
      authenticateUpgrade: async (request) => {
        const authenticationProof = JSON.parse(request.headers.get('x-test-node-proof') ?? 'null')
        return authenticator.authenticate(authenticationProof, {
          ...expectation,
          channelGeneration: generation,
        })
      },
      metrics: new RecordingGatewayMetrics(),
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
                  if (artifactDenied) throw new Error('artifact is not host-authorized')
                },
              },
              now: () => new Date('2026-08-25T12:00:30.000Z'),
            },
          }
        : {}),
      serve: (options) => {
        native = Bun.serve(options)
        return native
      },
    })
    return result
  }

  let composition = await compose()

  return {
    get composition() {
      return composition
    },
    set composition(value) {
      composition = value
    },
    events,
    quarantine,
    artifactVerifications,
    reconciled,
    framesFor(socket) {
      return allFrames.get(socket) ?? []
    },
    pause(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms))
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
      await rm(directory, { recursive: true, force: true })
      ownedDirectories.delete(directory)
    },
    async compose() {
      return compose()
    },
  }
}
