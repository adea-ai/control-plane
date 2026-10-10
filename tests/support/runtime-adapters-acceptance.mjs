import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  AcpAdapter,
  AcpDriver,
  AcpGatewayClient,
  ReferenceAcpDriver,
  ReferenceAcpGatewayTransport,
} from '@control-plane/acp-adapter'
import { executionConstraintFixtures } from '@control-plane/domain'
import {
  ManagedPiAdapter,
  ManagedPiDriver,
  ManagedPiGatewayClient,
  ReferenceManagedPiDriver,
  ReferenceManagedPiGatewayTransport,
} from '@control-plane/managed-pi-adapter'
import {
  RuntimeCompatibilityMatrixSchema,
  RemoteRuntimeGatewayTransport,
  applyRuntimeCompatibilityCertification,
  evaluateRuntimeEligibility,
  routeRuntimeConnections,
  runRuntimeAdapterConformance,
} from '@control-plane/runtime-sdk'

export const acceptanceNow = '2026-08-25T12:00:00.000Z'
const digest = (character) => `sha256:${character.repeat(64)}`
const grantRef = 'grant:m6-project-0001'
const fixtureUrl = new URL('../fixtures/m6-runtime-adapters.v1.json', import.meta.url)
const matrixUrl = new URL(
  '../../docs/runtime-compatibility/runtime-certifications.v1.json',
  import.meta.url
)

export const runtimeAdapterAcceptanceIds = Object.freeze({
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  planId: 'pln_01JABCDEF0123456789ABCDEFG',
  piConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  acpConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG',
  hostedConnectionId: 'rtc_01JDBCDEF0123456789ABCDEFG',
  piAttemptId: 'att_01JABCDEF0123456789ABCDEFG',
  acpAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
  hostedAttemptId: 'att_01JDBCDEF0123456789ABCDEFG',
})

export function acceptancePlan() {
  return {
    schemaVersion: 1,
    executionPlanId: runtimeAdapterAcceptanceIds.planId,
    contentDigest: digest('a'),
    profile: {
      profileId: 'prf_01JABCDEF0123456789ABCDEFG',
      profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
      version: 3,
      revision: 2,
      schemaVersion: 1,
      contentDigest: digest('b'),
    },
    skills: [
      {
        skillId: 'skl_01JABCDEF0123456789ABCDEFG',
        skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
        revision: 4,
        schemaVersion: 1,
        semanticVersion: '2.1.0',
        contentDigest: digest('c'),
      },
    ],
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

export async function createRuntimeAdaptersAcceptanceHarness() {
  const manifest = JSON.parse(await readFile(fixtureUrl, 'utf8'))
  const matrix = RuntimeCompatibilityMatrixSchema.parse(
    JSON.parse(await readFile(matrixUrl, 'utf8'))
  )
  const pi = createPiFixture(manifest.runtimes[0])
  const hosted = createHostedPiFixture(manifest.runtimes[1])
  const acp = createAcpFixture(manifest.runtimes[2])
  const client = new GenericRuntimeReferenceClient({ fixtures: [pi, hosted, acp], matrix })
  return { manifest, matrix, plan: acceptancePlan(), pi, hosted, acp, client }
}

export function createPiFixture(manifest, options = {}) {
  const ids = scopedIds(runtimeAdapterAcceptanceIds.piConnectionId)
  const driver = new ReferenceManagedPiDriver({
    now: () => acceptanceNow,
    scenario: options.scenario ?? 'complete',
  })
  driver.setGrantState(grantRef, options.grantState ?? 'granted')
  const transport = new ReferenceManagedPiGatewayTransport({
    driver,
    ...ids,
    harnessVersion: options.harnessVersion ?? manifest.harnessVersion,
    now: () => acceptanceNow,
  })
  const runtimeClient = new ManagedPiGatewayClient({
    transport,
    ...ids,
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: runtimeAdapterAcceptanceIds.piAttemptId,
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    localProjectGrantRef: grantRef,
    now: () => new Date(acceptanceNow),
    commandId: commandIdFactory('A'),
  })
  const adapter = new ManagedPiAdapter({
    transport: new RemoteRuntimeGatewayTransport(
      new ManagedPiDriver({
        client: runtimeClient,
        adapterVersion: options.adapterVersion ?? manifest.adapterVersion,
      })
    ),
  })
  return runtimeFixture({ manifest, adapter, driver, transport, ids, signal: 100 })
}

export function createAcpFixture(manifest, options = {}) {
  const ids = scopedIds(runtimeAdapterAcceptanceIds.acpConnectionId)
  const capabilities =
    options.capabilities ??
    (options.history === false
      ? [
          'stream.output',
          'stream.events',
          'tool.call',
          'execution.cancel',
          'interaction.user-input',
          'interaction.approval',
          'session.create',
          'session.list',
          'session.resume',
          'session.close',
        ]
      : undefined)
  const driver = new ReferenceAcpDriver({
    now: () => acceptanceNow,
    scenario: options.scenario ?? 'complete',
    protocolVersion: options.acpProtocolVersion,
    nativeSessions: [{ sessionId: 'native-session-1', title: 'Disposable ACP session' }],
    sessionReplay: options.history ?? true,
  })
  driver.setGrantState(grantRef, options.grantState ?? 'granted')
  const transport = new ReferenceAcpGatewayTransport({
    driver,
    ...ids,
    now: () => acceptanceNow,
    capabilities,
  })
  const externalIds = new Map([
    ['nses_01JABCDEF0123456789ABCDEFG', 'ses_01JABCDEF0123456789ABCDEFG'],
  ])
  const runtimeClient = new AcpGatewayClient({
    transport,
    ...ids,
    executionId: 'exe_01JBBCDEF0123456789ABCDEFG',
    attemptId: runtimeAdapterAcceptanceIds.acpAttemptId,
    traceId: 'trc_01JBBCDEF0123456789ABCDEFG',
    localProjectGrantRef: grantRef,
    now: () => new Date(acceptanceNow),
    commandId: commandIdFactory('B'),
  })
  const adapter = new AcpAdapter({
    transport: new RemoteRuntimeGatewayTransport(
      new AcpDriver({
        transport: runtimeClient,
        adapterVersion: options.adapterVersion ?? manifest.adapterVersion,
        externalSessionId: (sessionRef) => externalIds.get(sessionRef),
        interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
        now: () => new Date(acceptanceNow),
      })
    ),
  })
  return runtimeFixture({ manifest, adapter, driver, transport, ids, signal: 90 })
}

function createHostedPiFixture(manifest) {
  const ids = scopedIds(runtimeAdapterAcceptanceIds.hostedConnectionId, false)
  const client = new ReferenceHostedManagedPiClient()
  const adapter = new ManagedPiAdapter({
    transport: new RemoteRuntimeGatewayTransport(
      new ManagedPiDriver({ client, adapterVersion: manifest.adapterVersion })
    ),
  })
  return runtimeFixture({ manifest, adapter, driver: client, transport: client, ids, signal: 40 })
}

function runtimeFixture({ manifest, adapter, driver, transport, ids, signal }) {
  return {
    manifest,
    family: manifest.family,
    deployment: manifest.deployment,
    adapter,
    driver,
    transport,
    runtimeConnectionId: ids.runtimeConnectionId,
    signal,
    grantState: () =>
      manifest.deployment === 'managed' ? 'not_required' : driver.grantState(grantRef),
  }
}

export async function conformanceReports(fixtures, plan = acceptancePlan()) {
  return Promise.all(
    fixtures.map((fixture, index) =>
      runRuntimeAdapterConformance({
        adapter: fixture.adapter,
        executionPlan: plan,
        attemptId:
          [runtimeAdapterAcceptanceIds.piAttemptId, runtimeAdapterAcceptanceIds.acpAttemptId][
            index
          ] ?? runtimeAdapterAcceptanceIds.hostedAttemptId,
        complete: (handle) => fixture.adapter.status(handle),
      })
    )
  )
}

export class GenericRuntimeReferenceClient {
  #fixtures
  #matrix

  constructor({ fixtures, matrix }) {
    this.#fixtures = fixtures
    this.#matrix = matrix
  }

  async inspect(plan = acceptancePlan(), versionOverrides = new Map()) {
    return Promise.all(
      this.#fixtures.map(async (fixture) => {
        const inspection = await fixture.adapter.inspect(plan.runtimeRequirements)
        const connection = applyRuntimeCompatibilityCertification({
          matrix: this.#matrix,
          runtimeFamily: fixture.family,
          connection: connectionFromFixture(
            fixture,
            inspection,
            versionOverrides.get(fixture.runtimeConnectionId)
          ),
        })
        const local = fixture.deployment === 'local'
        const grantState = fixture.grantState()
        const eligibility = evaluateRuntimeEligibility({
          eligibilityVersion: 1,
          evaluatedAt: acceptanceNow,
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            runtimeRequirements: plan.runtimeRequirements,
          },
          candidate: {
            family: fixture.family,
            nodeStatus: local ? 'online' : 'not_applicable',
            connection,
          },
          policy: {
            snapshot: { policyId: 'm6-acceptance', version: 1, digest: digest('8') },
            allowedFamilies: ['managed-pi', 'acp'],
            allowedLocations: ['local_device', 'agent_hq_cloud'],
            deniedRuntimeConnectionIds: [],
            requireVerifiedCapabilities: true,
            security: { status: 'allowed' },
          },
          localProjectGrant: local
            ? { required: true, status: grantState, grantRef }
            : { required: false, status: 'not_required' },
          entitlement: { status: 'allowed', class: 'acceptance' },
        })
        return { fixture, inspection, connection, eligibility }
      })
    )
  }

  async route({ plan = acceptancePlan(), preference, versionOverrides } = {}) {
    const inspected = await this.inspect(plan, versionOverrides)
    const decision = routeRuntimeConnections({
      routingVersion: 1,
      executionPlanId: plan.executionPlanId,
      evaluatedAt: acceptanceNow,
      policy: {
        policyId: 'm6-runtime-routing',
        version: 1,
        digest: digest('7'),
        weights: {
          explicitConnection: 1_000_000,
          preferredFamily: 100_000,
          preferredDeployment: 10_000,
          locality: 100,
          health: 100,
          load: 10,
          queue: 10,
          entitlement: 10,
          cost: 10,
        },
      },
      ...(preference ? { preference } : {}),
      candidates: inspected.map(({ fixture, eligibility }) => ({
        runtimeConnectionId: fixture.runtimeConnectionId,
        family: fixture.family,
        deployment: fixture.deployment,
        eligibility,
        signals: {
          locality: fixture.signal,
          health: 100,
          loadPermille: 100,
          queueDepth: 0,
          entitlementPriority: 50,
          costClass: 'low',
        },
      })),
    })
    return { decision, inspected }
  }

  async execute({ plan = acceptancePlan(), attemptId, preference }) {
    const { decision, inspected } = await this.route({ plan, preference })
    if (!decision.selected) throw new Error('M6_RUNTIME_SELECTION_REQUIRED')
    const selected = inspected.find(
      ({ fixture }) => fixture.runtimeConnectionId === decision.selected.runtimeConnectionId
    )
    if (!selected) throw new Error('M6_SELECTED_FIXTURE_MISSING')
    const handle = await selected.fixture.adapter.start({
      attemptId,
      idempotencyKey: `m6:${attemptId}`,
      executionPlan: plan,
    })
    const progress = []
    for await (const event of selected.fixture.adapter.progress(handle)) progress.push(event)
    const status = await selected.fixture.adapter.status(handle)
    return {
      runtimeConnectionId: selected.fixture.runtimeConnectionId,
      family: selected.fixture.family,
      routing: decision,
      handle,
      progress,
      status,
      versions: selected.inspection.metadata,
    }
  }
}

function connectionFromFixture(fixture, inspection, overrides = {}) {
  const local = fixture.deployment === 'local'
  const unavailable = inspection.health === 'unavailable'
  const degraded = inspection.health === 'degraded'
  return {
    runtimeConnectionId: fixture.runtimeConnectionId,
    identityDigest: digest(
      fixture.runtimeConnectionId === runtimeAdapterAcceptanceIds.piConnectionId
        ? '1'
        : fixture.runtimeConnectionId === runtimeAdapterAcceptanceIds.acpConnectionId
          ? '2'
          : '3'
    ),
    connectionType: local
      ? fixture.family === 'managed-pi'
        ? 'managed_local'
        : 'external_local'
      : 'managed_cloud',
    ...(local ? { runtimeNodeRefId: runtimeAdapterAcceptanceIds.nodeId } : {}),
    runtimeDefinitionId:
      fixture.family === 'managed-pi'
        ? 'rtd_01JABCDEF0123456789ABCDEFG'
        : 'rtd_01JBBCDEF0123456789ABCDEFG',
    location: local ? 'local_device' : 'agent_hq_cloud',
    opaqueNativeRef: fixture.runtimeConnectionId.replace('rtc_', 'nref_'),
    adapterVersion: inspection.metadata.adapterVersion,
    driverVersion: inspection.metadata.driverVersion,
    harnessVersion: inspection.metadata.harnessVersion,
    protocolVersion: fixture.manifest.protocolVersion,
    status: unavailable ? 'unavailable' : degraded ? 'degraded' : 'connected',
    health: inspection.health,
    availabilityState: unavailable ? 'unknown' : degraded ? 'degraded' : 'healthy',
    capabilities: inspection.capabilities,
    capabilitySnapshotVersion: 1,
    capabilitySnapshotObservedAt: acceptanceNow,
    capabilitySnapshotExpiresAt: '2026-08-25T12:05:00.000Z',
    capabilityVerification: 'verified',
    compatibilityState: 'untested',
    limitations: inspection.limitations,
    diagnostics: [],
    lastDiscoveredAt: acceptanceNow,
    lastHeartbeatAt: acceptanceNow,
    lastHealthCheckAt: acceptanceNow,
    version: 1,
    createdAt: acceptanceNow,
    updatedAt: acceptanceNow,
    ...overrides,
  }
}

function scopedIds(runtimeConnectionId, local = true) {
  return {
    workspaceId: runtimeAdapterAcceptanceIds.workspaceId,
    ...(local ? { nodeId: runtimeAdapterAcceptanceIds.nodeId } : {}),
    runtimeConnectionId,
    runtimeOpaqueRef: runtimeConnectionId.replace('rtc_', 'nref_'),
  }
}

function commandIdFactory(character) {
  let index = 0
  return () => `cmd_${`${character}${String(index++).padStart(25, character)}`.slice(0, 26)}`
}

class ReferenceHostedManagedPiClient {
  executions = new Map()

  async inspect() {
    return {
      driverVersion: '1.0.0',
      runtimeVersion: '0.52.1',
      protocolVersion: '1.0.0',
      health: 'healthy',
      capabilities: [
        { name: 'stream.output', support: 'supported' },
        { name: 'stream.events', support: 'supported' },
        { name: 'tool.call', support: 'supported' },
        { name: 'execution.cancel', support: 'supported' },
        { name: 'interaction.user-input', support: 'supported' },
        { name: 'interaction.approval', support: 'supported' },
      ],
      limitations: ['STANDALONE_HOSTED_FIXTURE'],
      observedAt: acceptanceNow,
    }
  }

  async start(command) {
    const existing = this.executions.get(command.idempotencyKey)
    if (existing) return globalThis.structuredClone(existing.handle)
    const handle = {
      handleId: `hosted-pi:${command.attemptId}`,
      attemptId: command.attemptId,
      startedAt: acceptanceNow,
    }
    this.executions.set(command.idempotencyKey, {
      handle,
      events: [
        { sequence: 1, occurredAt: acceptanceNow, kind: 'status', state: 'running' },
        { sequence: 2, occurredAt: acceptanceNow, kind: 'output', text: 'hosted-pi-complete' },
        { sequence: 3, occurredAt: acceptanceNow, kind: 'status', state: 'succeeded' },
      ],
      status: {
        state: 'succeeded',
        observedAt: acceptanceNow,
        result: {
          output: { answer: 'hosted-pi-complete' },
          usage: { inputTokens: 8, outputTokens: 3, durationMs: 80 },
          artifacts: [],
        },
      },
    })
    return globalThis.structuredClone(handle)
  }

  async *progress(handle, afterSequence = 0) {
    const execution = this.#execution(handle)
    for (const event of execution.events) if (event.sequence > (afterSequence ?? 0)) yield event
  }

  async submitInput(handle) {
    return this.status(handle)
  }

  async submitApproval(handle) {
    return this.status(handle)
  }

  async cancel(handle, request) {
    const execution = this.#execution(handle)
    execution.status = { state: 'cancelled', observedAt: request.requestedAt }
    return this.status(handle)
  }

  async status(handle) {
    return globalThis.structuredClone(this.#execution(handle).status)
  }

  async reconcile(handle) {
    return this.status(handle)
  }

  async session() {
    throw new Error('HOSTED_PI_SESSION_UNSUPPORTED')
  }

  async cleanup(handle) {
    this.#execution(handle)
  }

  #execution(handle) {
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.handle.handleId === handle.handleId
    )
    if (!execution) throw new Error('HOSTED_PI_EXECUTION_MISSING')
    return execution
  }
}
