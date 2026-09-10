import { describe, expect, test } from 'bun:test'
import { executionConstraintFixtures } from '@control-plane/domain'
import {
  RemoteRuntimeGatewayTransport,
  RuntimeCompatibilityMatrixSchema,
} from '@control-plane/runtime-sdk'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'
import { AcpAdapter, AcpDriver } from './index.ts'
import { AcpGatewayClient, ReferenceAcpDriver, ReferenceAcpGatewayTransport } from './gateway.ts'

const now = '2026-08-25T12:00:00.000Z'
const digest = (character) => `sha256:${character.repeat(64)}`
const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  traceId: 'trc_01JABCDEF0123456789ABCDEFG',
  runtimeOpaqueRef: 'nref_01JABCDEF0123456789ABCDEFG',
}
const matrixUrl = new URL(
  '../../../docs/runtime-compatibility/runtime-certifications.v1.json',
  import.meta.url
)

function plan() {
  return {
    schemaVersion: 1,
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: digest('a'),
    profile: {
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
      version: 3,
      revision: 2,
      schemaVersion: 1,
      contentDigest: digest('b'),
    },
    skills: [],
    contextPackage: {
      contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG',
      contentDigest: digest('d'),
      schemaVersion: 1,
      compilerVersion: '1.0.0',
    },
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
      { capability: 'execution.cancel', necessity: 'required', minimumSupport: 'supported' },
    ],
    constraints: globalThis.structuredClone(executionConstraintFixtures.write),
    policySnapshot: globalThis.structuredClone(executionConstraintFixtures.write.policySnapshot),
    outputContract: { contractRef: 'contract://execution-result/v1' },
  }
}

function fixture(options = {}) {
  const GatewayDriver = options.gatewayDriver ?? ReferenceAcpDriver
  const driver = new GatewayDriver({
    now: () => now,
    scenario: options.scenario ?? 'complete',
    protocolVersion: options.acpProtocolVersion,
    nativeSessions: [{ sessionId: 'native-session-1', title: 'Gateway session' }],
    sessionReplay: true,
  })
  driver.setGrantState('grant:project-0001', options.grantState ?? 'granted')
  const GatewayTransport = options.gatewayTransport ?? ReferenceAcpGatewayTransport
  const transport = new GatewayTransport({
    driver,
    now: () => now,
    ...ids,
    includeDriver: options.includeDriver,
    gatewayProtocolVersion: options.gatewayProtocolVersion,
    capabilities: options.capabilities,
  })
  const commandIds = new Map()
  let commandIndex = 0
  const client = new AcpGatewayClient({
    transport,
    ...ids,
    localProjectGrantRef: 'grant:project-0001',
    now: () => new Date(now),
    commandId: (identity) => {
      if (!commandIds.has(identity)) {
        const suffix = '01JABCDEF0123456789ABCDEFGHJKMNPQ'.slice(commandIndex, commandIndex + 26)
        commandIds.set(identity, `cmd_${suffix.padEnd(26, 'A')}`)
        commandIndex += 1
      }
      return commandIds.get(identity)
    },
    requestTimeoutMs: options.requestTimeoutMs,
  })
  const externalIds = new Map([
    ['nses_01JABCDEF0123456789ABCDEFG', 'ses_01JABCDEF0123456789ABCDEFG'],
  ])
  return {
    driver,
    transport,
    client,
    adapter: new AcpAdapter({
      transport: new RemoteRuntimeGatewayTransport(
        new AcpDriver({
          transport: client,
          adapterVersion: '1.0.0',
          externalSessionId: (sessionRef) => externalIds.get(sessionRef),
          interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
          now: () => new Date(now),
          requestTimeoutMs: options.requestTimeoutMs,
        })
      ),
    }),
  }
}

describe('non-co-located ACP through Runtime Gateway', () => {
  test('coalesces an in-flight duplicate create command', async () => {
    const { client, transport } = fixture()

    const [first, second] = await Promise.all([
      client.createSession('create-token-1'),
      client.createSession('create-token-1'),
    ])

    expect(second).toEqual(first)
    expect(
      transport.commands().filter(({ operation }) => operation === 'runtime.session')
    ).toHaveLength(1)
  })

  test('accepts a maximum-length public session idempotency key', async () => {
    const { adapter } = fixture()

    await expect(
      adapter.session({ operation: 'create', idempotencyKey: `session:${'a'.repeat(248)}` })
    ).resolves.toMatchObject({ operation: 'create', session: { state: 'active' } })
  })

  test('uses a distinct gateway command to reconcile a lost create response', async () => {
    const { adapter, transport } = fixture({
      gatewayTransport: LostCreateResponseTransport,
      requestTimeoutMs: 10,
    })

    await expect(
      adapter.session({ operation: 'create', idempotencyKey: 'session:lost-gateway-response' })
    ).rejects.toMatchObject({ classification: 'timeout' })
    await delay(30)

    const actions = transport
      .commands()
      .flatMap((command) =>
        command.operation === 'runtime.session' && 'parameters' in command.payload
          ? [command.payload.parameters.action]
          : []
      )
    expect(actions.filter((action) => action === 'new')).toHaveLength(2)
    expect(actions).toContain('close')
  })

  test('releases server in-flight state when a gateway handler never settles', async () => {
    const { client, transport } = fixture({
      gatewayDriver: HangingCreateGatewayDriver,
      requestTimeoutMs: 10,
    })

    await expect(client.createSession('create-token-hung-handler')).rejects.toMatchObject({
      code: 'RUNTIME_GATEWAY_TIMEOUT',
      classification: 'timeout',
    })
    await delay(20)
    expect(transport.inFlightCount()).toBe(0)
  })

  test('bounds gateway inventory and dispatch waits with abort propagation', async () => {
    const inventory = new HangingGatewayTransport('inventory')
    const inventoryClient = gatewayClient(inventory, { requestTimeoutMs: 10 })
    await expect(inventoryClient.request('initialize', {})).rejects.toMatchObject({
      code: 'RUNTIME_GATEWAY_TIMEOUT',
      classification: 'timeout',
    })

    const dispatch = new HangingGatewayTransport('dispatch')
    const dispatchClient = gatewayClient(dispatch, { requestTimeoutMs: 10 })
    await expect(dispatchClient.request('initialize', {})).rejects.toMatchObject({
      code: 'RUNTIME_GATEWAY_TIMEOUT',
      classification: 'timeout',
    })
  })

  test('matches the exact supported compatibility certification capability claim', async () => {
    const { adapter, transport } = fixture()
    const inspection = await adapter.inspect()
    const inventory = await transport.inventory()
    const matrix = RuntimeCompatibilityMatrixSchema.parse(
      JSON.parse(await readFile(matrixUrl, 'utf8'))
    )
    const certification = matrix.certifications.find(
      ({ certificationId }) => certificationId === 'acp-reference-gateway-1-6-0'
    )

    expect(certification).toMatchObject({
      classification: 'supported',
      versions: {
        adapter: inspection.metadata.adapterVersion,
        driver: inspection.metadata.driverVersion,
        harness: inspection.metadata.harnessVersion,
        protocol: `${inventory.protocolVersion.major}.${inventory.protocolVersion.minor}.0`,
      },
    })
    expect(certification.verifiedCapabilities).toEqual(
      inspection.capabilities.map(({ name }) => name).toSorted()
    )
  })

  test('executes a disposable ACP harness through the generic RuntimeAdapter path', async () => {
    const { adapter, driver, transport } = fixture()
    const nativeBefore = driver.nativeState()

    expect(await adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'healthy',
      metadata: {
        adapterVersion: '1.0.0',
        driverVersion: '1.0.0',
        harnessVersion: '2.4.0',
        transportKind: 'remote-gateway',
      },
      capabilityEvaluation: { eligible: true },
    })
    const handle = await adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'acp:gateway:start',
      executionPlan: plan(),
    })
    const progress = []
    for await (const event of adapter.progress(handle)) progress.push(event)

    expect(progress.map(({ type }) => type)).toEqual([
      'status',
      'output',
      'interaction',
      'usage',
      'artifact',
      'status',
    ])
    expect(await adapter.status(handle)).toMatchObject({ state: 'completed' })
    expect(transport.commands().map(({ operation }) => operation)).toEqual([
      'runtime.status',
      'runtime.session',
      'runtime.execute',
      'runtime.status',
    ])
    expect(transport.commands()[2]).toMatchObject({
      nodeId: ids.nodeId,
      workspaceId: ids.workspaceId,
      runtimeConnectionId: ids.runtimeConnectionId,
      attemptId: ids.attemptId,
      payload: { parameters: { grantRef: 'grant:project-0001' } },
    })
    expect(JSON.stringify(transport.commands())).not.toMatch(
      /native-session|\/Users\/|credential|apiKey|accessToken|privateKey|nativeConfig/
    )
    expect(driver.nativeState()).toEqual(nativeBefore)
  })

  test('reconnects with duplicate-effect protection and routes approval and cancellation', async () => {
    const { adapter, driver, transport } = fixture({ scenario: 'running' })
    const handle = await adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'acp:gateway:reconnect',
      executionPlan: plan(),
    })
    for await (const event of adapter.progress(handle)) {
      if (event.type === 'interaction') break
    }
    await adapter.submitApproval(handle, {
      interactionId: 'int_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'acp:gateway:approval',
      decision: 'approve',
    })
    expect(
      await adapter.cancel(handle, {
        idempotencyKey: 'acp:gateway:cancel',
        requestedAt: now,
      })
    ).toMatchObject({ state: 'cancelled' })
    const execute = transport.commands().find(({ operation }) => operation === 'runtime.execute')

    transport.disconnect()
    expect((await adapter.inspect()).health).toBe('unavailable')
    transport.connect()
    expect((await transport.redeliver(execute.commandId)).ack.disposition).toBe('replayed')
    expect(driver.effectCount(ids.attemptId, 'runtime.execute')).toBe(1)
    expect(await adapter.reconcile(handle)).toMatchObject({ state: 'cancelled' })
  })

  test('routes session listing, resume, and replay without exposing native IDs', async () => {
    const { adapter, transport } = fixture()
    const listed = await adapter.session({ operation: 'list' })
    const sessionId = listed.sessions[0].sessionId
    await adapter.session({ operation: 'resume', sessionId, idempotencyKey: 'resume:gateway' })
    const history = await adapter.session({ operation: 'history', sessionId })

    expect(history).toMatchObject({ operation: 'history', completeness: 'complete' })
    expect(
      transport.commands().filter(({ operation }) => operation === 'runtime.session')
    ).toHaveLength(3)
    expect(JSON.stringify(transport.commands())).not.toContain('native-session-1')
  })

  test('fails closed for gateway/ACP mismatch, missing driver, and grant denial', async () => {
    const gatewayMismatch = fixture({ gatewayProtocolVersion: { major: 2, minor: 0 } })
    expect(await gatewayMismatch.adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'unavailable',
      limitations: expect.arrayContaining(['RUNTIME_GATEWAY_PROTOCOL_UNSUPPORTED']),
    })

    const acpMismatch = fixture({ acpProtocolVersion: 1 })
    expect(await acpMismatch.adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'unavailable',
      limitations: expect.arrayContaining(['ACP_PROTOCOL_VERSION_UNSUPPORTED:1']),
    })

    const missing = fixture({ includeDriver: false })
    expect(await missing.adapter.inspect()).toMatchObject({
      health: 'unavailable',
      limitations: expect.arrayContaining(['ACP_DRIVER_MISSING']),
    })

    const denied = fixture({ grantState: 'revoked' })
    expect(await denied.adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      health: 'unavailable',
      limitations: expect.arrayContaining(['LOCAL_PROJECT_GRANT_REVOKED']),
    })
    await expect(
      denied.adapter.start({
        attemptId: ids.attemptId,
        idempotencyKey: 'acp:gateway:denied',
        executionPlan: plan(),
      })
    ).rejects.toMatchObject({ code: 'ACP_RUNTIME_INELIGIBLE' })
    expect(denied.transport.commands()).toHaveLength(1)
  })

  test('makes the runtime ineligible when a required capability is not reported', async () => {
    const unsupported = fixture({
      capabilities: [
        'stream.events',
        'tool.call',
        'execution.cancel',
        'interaction.user-input',
        'interaction.approval',
        'session.create',
        'session.list',
        'session.resume',
        'session.close',
        'session.history',
        'session.load',
      ],
    })

    expect(await unsupported.adapter.inspect(plan().runtimeRequirements)).toMatchObject({
      capabilityEvaluation: {
        eligible: false,
        missingRequired: ['stream.output'],
      },
    })
    await expect(
      unsupported.adapter.start({
        attemptId: ids.attemptId,
        idempotencyKey: 'acp:gateway:unsupported',
        executionPlan: plan(),
      })
    ).rejects.toMatchObject({ code: 'ACP_RUNTIME_INELIGIBLE' })
    expect(unsupported.transport.commands()).toHaveLength(1)
  })

  test('normalizes ACP timeout and disappeared runtime without retrying the attempt', async () => {
    const timeout = fixture({ scenario: 'timeout' })
    const handle = await timeout.adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'acp:gateway:timeout',
      executionPlan: plan(),
    })
    expect(await timeout.adapter.status(handle)).toMatchObject({
      state: 'timed_out',
      error: { code: 'ACP_PROMPT_TIMED_OUT', retryable: true },
    })
    expect(timeout.driver.effectCount(ids.attemptId, 'runtime.execute')).toBe(1)

    const disappeared = fixture({ scenario: 'running' })
    const active = await disappeared.adapter.start({
      attemptId: ids.attemptId,
      idempotencyKey: 'acp:gateway:disappeared',
      executionPlan: plan(),
    })
    disappeared.transport.removeDriver()
    expect(await disappeared.adapter.reconcile(active)).toMatchObject({ state: 'unknown' })
  })
})

function gatewayClient(transport, options = {}) {
  return new AcpGatewayClient({
    transport,
    ...ids,
    localProjectGrantRef: 'grant:project-0001',
    now: () => new Date(now),
    commandId: () => 'cmd_01JABCDEF0123456789ABCDEFG',
    ...options,
  })
}

class HangingGatewayTransport {
  constructor(hangingMethod) {
    this.hangingMethod = hangingMethod
  }

  connectionState() {
    return 'online'
  }

  grantState() {
    return 'granted'
  }

  async inventory(signal) {
    if (this.hangingMethod === 'inventory') return waitForGatewayAbort(signal)
    return gatewayInventory()
  }

  async dispatch(_command, signal) {
    if (this.hangingMethod === 'dispatch') return waitForGatewayAbort(signal)
    throw new Error('UNEXPECTED_GATEWAY_DISPATCH')
  }
}

class LostCreateResponseTransport extends ReferenceAcpGatewayTransport {
  loseFirstCreate = true

  async dispatch(command, signal) {
    if (
      this.loseFirstCreate &&
      command.operation === 'runtime.session' &&
      'parameters' in command.payload &&
      command.payload.parameters.action === 'new'
    ) {
      this.loseFirstCreate = false
      await super.dispatch(command, signal)
      return waitForGatewayAbort(signal)
    }
    return super.dispatch(command, signal)
  }
}

class HangingCreateGatewayDriver extends ReferenceAcpDriver {
  async handle(command) {
    if (
      command.operation === 'runtime.session' &&
      'parameters' in command.payload &&
      command.payload.parameters.action === 'new'
    ) {
      return new Promise(() => {})
    }
    return super.handle(command)
  }
}

function waitForGatewayAbort(signal) {
  if (!signal) throw new Error('MISSING_ABORT_SIGNAL')
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true })
  })
}

function gatewayInventory() {
  return {
    type: 'inventory',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 5 },
    sequence: 1,
    nodeId: ids.nodeId,
    workspaceId: ids.workspaceId,
    traceId: ids.traceId,
    sentAt: now,
    channelGeneration: 1,
    mode: 'snapshot',
    snapshotVersion: 1,
    observedAt: now,
    runtimeDrivers: [
      {
        opaqueRef: ids.runtimeOpaqueRef,
        driverFamily: 'acp',
        adapterVersion: '1.0.0',
        driverVersion: '1.0.0',
        harnessVersion: '2.4.0',
        protocolVersion: { major: 1, minor: 5 },
        health: 'healthy',
        capabilities: ['stream.events'],
        limitations: [],
      },
    ],
    contextProviders: [],
  }
}
