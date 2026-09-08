import { deepStrictEqual, strictEqual, ok } from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIsolatedPostgres } from '../packages/testing/src/postgres.ts'
import { createExecutionPlanTestFixture } from '../packages/execution-plan/src/testing.ts'
import {
  composeProviderContextPackage,
  contextPackageSerializationFixtures,
} from '../packages/context/src/index.ts'
import { ExecutionLifecycleService, InteractionService } from '../packages/domain/src/index.ts'
import { RuntimeConnectionRegistry } from '../packages/runtime-sdk/src/index.ts'
import {
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresRuntimeDiscoveryRepository,
  PostgresRuntimeCommandRepository,
  PostgresRuntimeEventEffectSink,
  PostgresExecutionEventRepository,
  PostgresRuntimeConnectionRepository,
  PostgresInteractionRepository,
} from '../packages/database/src/index.ts'
import { createManagedCloudWorkflowWorkerComposition } from '../apps/workflow-worker/src/cloud-composition.ts'
import { DurableRemoteWorkflowRuntime } from '../apps/workflow-worker/src/remote-workflow-runtime.ts'
import { ManagedPiRemoteCommandFactory } from '../apps/workflow-worker/src/managed-pi-remote-command.ts'
import {
  RuntimeCommandDeliveryService,
  RuntimeEventIngestionService,
  DefaultRuntimeAdapterEventNormalizer,
  RuntimeGatewayMessageRouter,
  RuntimeNodeChannelAuthenticator,
  SyntheticRuntimeNodeIdentityAuthority,
  RuntimeGatewayWebSocketLifecycle,
  RuntimeGatewayWebSocketServer,
  InMemoryRuntimeNodeCoordination,
  RecordingGatewayMetrics,
  RecordingRuntimeNodeReachabilityPublisher,
} from '../apps/runtime-gateway/src/index.ts'
import {
  HostedManagedPiTerminalBridge,
  ObjectStoreHostedArtifactStore,
} from '../apps/runtime-worker/src/hosted-managed-pi.ts'
import { FilesystemObjectStore } from '../packages/object-store/dist/index.js'
import { golden } from '../packages/runtime-gateway-protocol/fixtures/index.mjs'
import { GatewayProtocolManifest } from '../packages/runtime-gateway-protocol/src/index.ts'

// Real database/network/Artifact plumbing; the synthetic node supplies a scripted
// terminal status. This is not a live Pi provider or Restate certification.
const database = await createIsolatedPostgres({ migrate: true })
const directory = await mkdtemp(join(tmpdir(), 'cloud-remote-drill-'))
const store = new FilesystemObjectStore({ rootDirectory: directory, maxObjectBytes: 65536 })
let server, native, socket, authenticator, dispatch, approval
try {
  const now = new Date().toISOString()
  const deadlineAt = new Date(Date.now() + 15000).toISOString()
  const context = composeProviderContextPackage(contextPackageSerializationFixtures.futurePi, {
    callerContextRefs: [],
    localProjectGrantRefs: ['grant:runtime-node:drill'],
    contributions: [],
  })
  const plan = createExecutionPlanTestFixture({ contextPackage: context })
  const executionId = golden.command.executionId
  const nodeId = golden.command.nodeId
  const workspaceId = plan.correlation.workspaceId
  await new RuntimeConnectionRegistry(
    new PostgresRuntimeConnectionRepository(database.application)
  ).register({
    runtimeConnectionId: golden.command.runtimeConnectionId,
    identityDigest: `sha256:${'8'.repeat(64)}`,
    runtimeNodeRefId: nodeId,
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    connectionType: 'managed_local',
    location: 'local_device',
    opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFG',
    adapterVersion: '1.0.0',
    driverVersion: '1.0.0',
    harnessVersion: '0.52.1',
    status: 'connected',
    health: 'healthy',
    capabilities: [
      { name: 'execution.cancel', support: 'supported' },
      { name: 'interaction.approval', support: 'supported' },
      { name: 'filesystem.read', support: 'supported' },
      { name: 'stream.output', support: 'supported' },
    ],
    compatibilityState: 'compatible',
    limitations: [],
    lastDiscoveredAt: now,
    lastHeartbeatAt: now,
    lastHealthCheckAt: now,
  })
  const discovery = new PostgresRuntimeDiscoveryRepository(database.application)
  await discovery.putRuntimeConnection(workspaceId, {
    runtimeConnectionId: golden.command.runtimeConnectionId,
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    family: 'managed-pi',
    connectionType: 'managed_local',
    location: 'local_device',
    status: 'available',
    node: {
      runtimeNodeRefId: nodeId,
      location: 'remote_host',
      status: 'online',
      health: 'online',
      observedAt: now,
    },
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: { state: 'fresh', observedAt: now, expiresAt: deadlineAt },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '0.52.1', protocol: '1.5.0' },
    capabilities: ['filesystem.read', 'stream.output', 'interaction.approval', 'execution.cancel'],
    capabilityDetails: [
      { name: 'execution.cancel', support: 'supported' },
      { name: 'interaction.approval', support: 'supported' },
      { name: 'filesystem.read', support: 'supported' },
      { name: 'stream.output', support: 'supported' },
    ],
    compatibility: { state: 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: true, state: 'granted' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    observedAt: now,
    limitations: [],
  })
  await new PostgresContextPackageRepository(database.application).put(context)
  await new PostgresExecutionPlanRepository(database.application).put(plan)
  const executions = new PostgresExecutionRepository(database.application)
  await new ExecutionLifecycleService(executions).createExecution({
    executionId,
    correlation: plan.correlation,
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: 1,
    },
    acceptedAt: now,
    deadlineAt,
  })
  const composition = createManagedCloudWorkflowWorkerComposition(
    {
      service: 'workflow-worker',
      database: { role: 'application', url: process.env.DATABASE_URL },
      restate: { role: 'endpoint', requestIdentityPublicKey: 'fixture' },
      runtime: { mode: 'remote' },
      secretEncryptionKey: 'fixture',
    },
    undefined,
    undefined,
    () => ({ database: database.application, check: async () => {}, close: async () => {} })
  )
  const { attemptId } = await composition.activities.ensureAttempt({
    executionId,
    workflowId: 'remote-drill',
    effectKey: 'remote-drill:attempt',
  })
  strictEqual((await executions.getAttempt(attemptId)).runtime.runtimeNodeRefId, nodeId)
  const authority = new SyntheticRuntimeNodeIdentityAuthority({
    issuer: 'https://identity.test',
    audience: 'runtime-gateway',
  })
  const device = authority.registerNode({ nodeId, workspaceId })
  const issued = authority.issueCredential(device, { channelGeneration: 1 })
  const expectation = {
    issuer: 'https://identity.test',
    audience: 'runtime-gateway',
    nodeId,
    workspaceId,
    channelGeneration: 1,
    challenge: 'cloud-remote-drill',
  }
  const proof = device.authenticationAttempt(issued.credential, expectation.challenge)
  authenticator = new RuntimeNodeChannelAuthenticator({
    identityValidator: authority.validationPort(),
    logger: { write() {} },
  })
  const coordination = new InMemoryRuntimeNodeCoordination()
  const metrics = new RecordingGatewayMetrics()
  const commands = new PostgresRuntimeCommandRepository(database.application)
  const received = []
  const quarantine = []
  let gatewayError
  const lifecycle = new RuntimeGatewayWebSocketLifecycle({
    instanceId: 'cloud-remote-drill',
    coordination,
    metrics,
    reachability: new RecordingRuntimeNodeReachabilityPublisher(),
    limits: {
      maxConnections: 2,
      maxConnectionsPerWorkspace: 2,
      maxFrameBytes: 65536,
      maxBufferedBytes: 65536,
      heartbeatTimeoutMs: 15000,
      idleTimeoutMs: 30000,
    },
    messages: {
      handle: async (source, envelope) => {
        try {
          await router.handle(source, envelope)
        } catch (error) {
          gatewayError = error
          throw error
        }
      },
    },
  })
  const delivery = new RuntimeCommandDeliveryService({
    repository: commands,
    sender: lifecycle,
    metrics,
  })
  const events = new RuntimeEventIngestionService({
    commands,
    executions,
    effects: new PostgresRuntimeEventEffectSink(database.application),
    normalizer: new DefaultRuntimeAdapterEventNormalizer(),
    metrics,
    channelAuthority: {
      isActive: async (source) => {
        const active = await coordination.lookup(source.nodeId)
        return (
          active?.workspaceId === source.workspaceId &&
          active?.channelGeneration === source.channelGeneration
        )
      },
    },
    quarantine: {
      record: async (entry) => {
        quarantine.push(entry)
      },
    },
  })
  const router = new RuntimeGatewayMessageRouter({
    delivery,
    events,
    inventory: {
      handle: async () => {
        throw new Error('UNEXPECTED_INVENTORY')
      },
    },
  })
  server = new RuntimeGatewayWebSocketServer({
    lifecycle,
    hostname: '127.0.0.1',
    port: 0,
    limits: { maxFrameBytes: 65536, maxBufferedBytes: 65536, idleTimeoutSeconds: 30 },
    authenticateUpgrade: (request) =>
      authenticator.authenticate(
        JSON.parse(request.headers.get('x-test-node-proof') ?? 'null'),
        expectation
      ),
    serve: (options) => {
      native = Bun.serve(options)
      return native
    },
  })
  server.start()
  socket = new WebSocket(`ws://127.0.0.1:${native.port}/runtime-gateway/v1/connect`, {
    headers: { 'x-test-node-proof': JSON.stringify(proof) },
  })
  socket.addEventListener('message', (event) => received.push(JSON.parse(event.data)))
  await until(() => socket.readyState === WebSocket.OPEN, 'socket-open')
  socket.send(
    JSON.stringify({
      ...golden.hello,
      protocolVersion: GatewayProtocolManifest.current,
      supportedVersions: GatewayProtocolManifest.supported,
      sentAt: now,
    })
  )
  await until(() => received.length === 1, 'hello')
  const input = { executionId, attemptId, executionPlan: plan, effectKey: 'remote-drill:dispatch' }
  dispatch = composition.runtime.dispatch(input)
  let dispatchError
  dispatch.catch((error) => {
    dispatchError = error
  })
  let pending
  await until(async () => {
    if (dispatchError) throw dispatchError
    pending = (await commands.listDispatchable(nodeId, new Date().toISOString(), 10))[0]
    return pending !== undefined
  }, 'queue-command')
  await delivery.deliver(pending.commandId, { channelGeneration: 1, sequence: 1 })
  await until(() => received.length === 2, 'command-delivery')
  const command = received[1]
  strictEqual(command.operation, 'runtime.execute')
  strictEqual(command.attemptId, attemptId)
  socket.send(
    JSON.stringify({
      ...golden.ack,
      commandId: command.commandId,
      payloadHash: command.payloadHash,
      sentAt: new Date().toISOString(),
      sequence: command.sequence,
    })
  )
  await until(
    async () => (await commands.get(command.commandId)).status === 'acknowledged',
    'command-ack'
  )
  // Seed an authorized response to exercise the real remote command and socket
  // boundary. The fixture node does not originate a native permission request.
  const interactionId = 'int_01JABCDEF0123456789ABCDEFG'
  const responseId = 'cmd_01JABCDEF0123456789ABCDEFH'
  const interactionService = new InteractionService(
    new PostgresInteractionRepository(database.application)
  )
  await interactionService.request({
    interactionId,
    executionId,
    attemptId,
    kind: 'permission',
    prompt: { title: 'Approve isolated fixture' },
    allowedActions: ['grant', 'deny'],
    allowedPrincipalIds: ['svc_drill'],
    requestedAt: now,
    expiresAt: deadlineAt,
  })
  await interactionService.respond({
    interactionId,
    executionId,
    attemptId,
    responseId,
    action: 'grant',
    respondingPrincipalId: 'svc_drill',
    expectedVersion: 1,
    respondedAt: new Date().toISOString(),
  })
  const approvalInput = {
    executionId,
    attemptId,
    interactionId,
    responseId,
    action: 'grant',
    effectKey: 'remote-drill:approval',
  }
  approval = composition.runtime.applyInteraction(approvalInput)
  let approvalError
  approval.catch((error) => {
    approvalError = error
  })
  let approvalRecord
  await until(async () => {
    if (approvalError) throw approvalError
    approvalRecord = (await commands.listDispatchable(nodeId, new Date().toISOString(), 10)).find(
      (record) => record.commandId !== command.commandId
    )
    return approvalRecord !== undefined
  }, 'approval-queued')
  await delivery.deliver(approvalRecord.commandId, { channelGeneration: 1, sequence: 2 })
  await until(() => received.length === 3, 'approval-delivery')
  const approvalCommand = received[2]
  strictEqual(approvalCommand.operation, 'runtime.approval')
  deepStrictEqual(approvalCommand.payload.parameters, {
    handleId: `managed-pi:${attemptId}`,
    interactionId,
    decision: 'approve',
  })
  socket.send(
    JSON.stringify({
      ...golden.ack,
      commandId: approvalCommand.commandId,
      payloadHash: approvalCommand.payloadHash,
      sentAt: new Date().toISOString(),
      sequence: approvalCommand.sequence,
    })
  )
  await until(
    async () => (await commands.get(approvalCommand.commandId)).status === 'acknowledged',
    'approval-ack'
  )
  const bridge = new HostedManagedPiTerminalBridge({
    artifactStore: new ObjectStoreHostedArtifactStore(store),
  })
  const result = await bridge.result({
    command,
    sequence: 3,
    status: {
      state: 'succeeded',
      observedAt: new Date().toISOString(),
      result: {
        output: { answer: 'remote-drill' },
        usage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
        artifacts: [],
      },
    },
  })
  socket.send(JSON.stringify(result))
  await until(async () => {
    if (gatewayError) throw gatewayError
    if (socket.readyState === WebSocket.CLOSED)
      throw new Error('CLOUD_REMOTE_SOCKET_CLOSED_BEFORE_RESULT')
    if (quarantine.length) throw new Error(`CLOUD_REMOTE_QUARANTINED:${quarantine[0].reason}`)
    return (await executions.getExecution(executionId)).state === 'completed'
  }, 'terminal-execution')
  const outcome = await dispatch
  deepStrictEqual(await approval, outcome)
  const retainedApproval = await commands.get(approvalCommand.commandId)
  deepStrictEqual(await composition.runtime.applyInteraction(approvalInput), outcome)
  deepStrictEqual(await commands.get(approvalCommand.commandId), retainedApproval)
  strictEqual(received.length, 3)
  strictEqual(outcome.outcome, 'completed')
  strictEqual(outcome.resultReference, result.result.artifact.artifactId)
  await until(
    async () => (await commands.get(command.commandId)).status === 'succeeded',
    'command-result'
  )
  const terminalCommand = await commands.get(command.commandId)
  deepStrictEqual(await composition.runtime.dispatch(input), outcome)
  deepStrictEqual(await commands.get(command.commandId), terminalCommand)
  strictEqual(
    (await executions.getExecution(executionId)).terminalResultRef,
    outcome.resultReference
  )
  strictEqual(
    (
      await new PostgresExecutionEventRepository(database.application).queryAfter(
        executionId,
        0,
        100
      )
    ).length,
    1
  )
  deepStrictEqual(quarantine, [])
  ok(result.result.artifact.sizeBytes > 0)
  // Cancellation delivery and ACK use the real channel. The execution has
  // already completed and the waiter is scripted: this does not prove a native stop.
  let cancellationClock = new Date()
  const cancellationFactory = new ManagedPiRemoteCommandFactory({
    contextPackages: new PostgresContextPackageRepository(database.application),
    runtimeDiscovery: {
      getRuntimeConnection: ({ runtimeConnectionId, ...scope }) =>
        discovery.getRuntimeConnection(scope, runtimeConnectionId),
    },
    executions,
    interactions: new PostgresInteractionRepository(database.application),
    now: () => cancellationClock,
  })
  const cancellationRecords = []
  const cancellationRuntime = () =>
    new DurableRemoteWorkflowRuntime({
      attempts: executions,
      commands,
      factory: cancellationFactory,
      waiter: {
        wait: async ({ command }) => {
          cancellationRecords.push(command)
          return { outcome: 'cancelled' }
        },
      },
    })
  const cancellationInput = {
    executionId,
    attemptId,
    effectKey: 'remote-drill:cancel',
    reason: 'user_request',
  }
  await cancellationRuntime().cancel(cancellationInput)
  await delivery.deliver(cancellationRecords[0].commandId, { channelGeneration: 1, sequence: 4 })
  await until(() => received.length === 4, 'cancellation-delivery')
  const cancellationCommand = received[3]
  strictEqual(cancellationCommand.operation, 'runtime.cancel')
  deepStrictEqual(cancellationCommand.payload.parameters, {
    handleId: `managed-pi:${attemptId}`,
    requestedAt: cancellationRecords[0].issuedAt,
  })
  socket.send(
    JSON.stringify({
      ...golden.ack,
      commandId: cancellationCommand.commandId,
      payloadHash: cancellationCommand.payloadHash,
      sentAt: new Date().toISOString(),
      sequence: cancellationCommand.sequence,
    })
  )
  await until(
    async () => (await commands.get(cancellationCommand.commandId)).status === 'acknowledged',
    'cancellation-ack'
  )
  const acknowledgedCancellation = await commands.get(cancellationCommand.commandId)
  cancellationClock = new Date(cancellationClock.getTime() + 6 * 60 * 1000)
  await Promise.all(
    Array.from({ length: 8 }, () => cancellationRuntime().cancel(cancellationInput))
  )
  strictEqual(cancellationRecords.length, 9)
  for (const record of cancellationRecords.slice(1)) {
    deepStrictEqual(record, acknowledgedCancellation)
  }
  deepStrictEqual(await commands.get(cancellationCommand.commandId), acknowledgedCancellation)
  strictEqual(received.length, 4)
  deepStrictEqual(quarantine, [])
  if (gatewayError) throw gatewayError
  console.log(
    'Cloud remote drill passed: PostgreSQL dispatch, approval and cancellation, authenticated WebSocket delivery/ACK and result, Artifact-backed terminal state, and immutable command replay. Approval response is seeded; node and cancellation waiter are scripted. Cancellation is delivered after execution completion, not a native stop proof. Native permission origination, active cancellation confirmation, usage settlement and live provider execution remain unverified.'
  )
} finally {
  socket?.close()
  await server?.close()
  await native?.stop(true)
  authenticator?.close()
  await dispatch?.catch(() => {})
  await approval?.catch(() => {})
  await store.close()
  await database.dispose()
  await rm(directory, { recursive: true, force: true })
}

async function until(condition, stage) {
  const deadline = Date.now() + 5000
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`CLOUD_REMOTE_DRILL_TIMEOUT:${stage}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
