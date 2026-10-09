import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executionConstraintFixtures } from '@control-plane/domain'
import {
  bindProfileStorage,
  bindProfileRuntime,
  bindProfileWorkflowWake,
  ExecutionProfiles,
  ProfileAdapterError,
  ProfileCapabilityMatrix,
} from './index.ts'
import { ManagedPiAdapter, ManagedPiDriver } from '@control-plane/managed-pi-adapter'
import { PiDurableRuntimeAdapter } from '@control-plane/pi-durable-adapter'
import {
  DirectLocalRuntimeTransport,
  MockRuntimeAdapter,
  RemoteRuntimeGatewayTransport,
  TransportedRuntimeAdapter,
} from '@control-plane/runtime-sdk'

const component = (profile) => ({
  profile,
  start: async () => undefined,
  stop: async () => undefined,
  health: async () => ({ ready: true, component: 'fixture', version: '1.0.0' }),
})

const persistence = (profile, dialect) => ({
  profile,
  dialect,
  migrate: async () => undefined,
  health: async () => ({ ready: true, component: 'fixture', version: '1.0.0' }),
  transaction: async () => undefined,
  close: async () => undefined,
})

const composition = (
  profile,
  dialect = profile === 'hosted-server' || profile === 'cloud' ? 'postgresql' : 'sqlite'
) => ({
  profile,
  persistence: persistence(profile, dialect),
  workflow: component(profile),
  objectStore: {
    put: async () => ({}),
    get: async () => ({}),
    head: async () => ({}),
    delete: async () => undefined,
    close: async () => undefined,
  },
  secrets: {
    resolve: async () => ({}),
    health: async () => ({ ready: true, component: 'fixture', version: '1.0.0' }),
    close: async () => undefined,
  },
  coordination: { acquire: async () => undefined, close: async () => undefined },
  processes: { launch: async () => undefined, close: async () => undefined },
  discovery: { discover: async () => [] },
  observability: { write: () => undefined, close: async () => undefined },
})

const placement = (profile = 'local') => ({
  controlPlaneHostId: `${profile}-host`,
  runtimeHostId: `${profile}-host`,
  runtimeLocation:
    profile === 'local'
      ? 'local_device'
      : profile === 'self-hosted'
        ? 'remote_host'
        : 'agent_hq_cloud',
  coLocated: true,
})

const allowedGuards = (calls = []) => ({
  authority: {
    assertCurrent: async (context) => calls.push(['authority', context]),
  },
  residency: {
    assertCurrent: async (context) => calls.push(['residency', context]),
  },
})

const trustedTopology = (adapter, transport, calls = []) => ({
  assertCurrent: async (context, binding) => {
    calls.push(['topology', context])
    if (binding.adapter !== adapter || binding.transport !== transport) {
      throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH', {
        reason: 'TRUSTED_TOPOLOGY_REJECTED',
      })
    }
  },
})

const trustedWakeTopology = (driver) => ({
  assertCurrent: async (_context, candidate) => {
    if (candidate !== driver) {
      throw new ProfileAdapterError('PROFILE_WAKE_MISMATCH', {
        reason: 'TRUSTED_TOPOLOGY_REJECTED',
      })
    }
  },
})

const hostedPlacement = Object.freeze({
  controlPlaneHostId: 'cp-host',
  runtimeHostId: 'cloud-runtime-host',
  runtimeLocation: 'agent_hq_cloud',
  coLocated: false,
})

const managedPiNow = '2026-08-25T12:00:00.000Z'

/** Minimal managed-Pi client over the canonical driver contract, mirroring
 *  the hosted runtime-worker fixture so the real adapter classes are used. */
class RecordingManagedPiClient {
  starts = []
  executions = new Map()

  async inspect() {
    return {
      driverVersion: '1.0.0',
      runtimeVersion: '0.52.1',
      protocolVersion: '1.0.0',
      health: 'healthy',
      capabilities: [
        { name: 'stream.output', support: 'supported' },
        { name: 'execution.cancel', support: 'supported' },
        { name: 'interaction.user-input', support: 'supported' },
        { name: 'interaction.approval', support: 'supported' },
      ],
      limitations: [],
      observedAt: managedPiNow,
    }
  }

  async start(command) {
    this.starts.push(globalThis.structuredClone(command))
    const handle = {
      handleId: `managed-pi:${command.attemptId}`,
      attemptId: command.attemptId,
      startedAt: managedPiNow,
    }
    this.executions.set(handle.handleId, {
      handle,
      state: 'running',
      events: [
        { sequence: 1, occurredAt: managedPiNow, kind: 'status', state: 'running' },
        { sequence: 2, occurredAt: managedPiNow, kind: 'output', text: 'working' },
        {
          sequence: 3,
          occurredAt: managedPiNow,
          kind: 'tool_request',
          interactionId: 'int_01JABCDEF0123456789ABCDEFG',
          toolId: 'project-files',
          operation: 'read',
        },
        {
          sequence: 4,
          occurredAt: managedPiNow,
          kind: 'usage',
          inputTokens: 10,
          outputTokens: 2,
          durationMs: 100,
        },
      ],
    })
    return handle
  }

  async *progress(handle, afterSequence = 0) {
    for (const event of this.executions.get(handle.handleId).events) {
      if (event.sequence > afterSequence) yield event
    }
  }

  async submitInput(handle) {
    return this.status(handle)
  }

  async submitApproval(handle) {
    return this.status(handle)
  }

  async cancel(handle, request) {
    const execution = this.executions.get(handle.handleId)
    execution.state = 'cancelled'
    execution.observedAt = request.requestedAt
    return this.status(handle)
  }

  async status(handle) {
    const execution = this.executions.get(handle.handleId)
    return { state: execution.state, observedAt: execution.observedAt ?? managedPiNow }
  }
}

/** The exact hosted composition from the runtime-worker lane: a managed-Pi
 *  semantic adapter over the authenticated remote gateway transport. */
const hostedManagedPiFixture = (client) => {
  const transport = new RemoteRuntimeGatewayTransport(
    new ManagedPiDriver({ client, adapterVersion: '1.0.0' })
  )
  return { adapter: new ManagedPiAdapter({ transport }), transport }
}

function managedExecutionPlan() {
  const digest = (character) => `sha256:${character.repeat(64)}`
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

describe('profile infrastructure bindings', () => {
  test('keeps product profile labels distinct from canonical deployment profiles', () => {
    expect(ProfileCapabilityMatrix.map(({ profile }) => profile)).toEqual([
      ExecutionProfiles.local,
      ExecutionProfiles.selfHosted,
      ExecutionProfiles.hosted,
    ])
    expect(ProfileCapabilityMatrix[0].deploymentProfiles).toEqual(['local'])
    expect(ProfileCapabilityMatrix[1].deploymentProfiles).toEqual([
      'hosted-simple',
      'hosted-server',
    ])
    expect(ProfileCapabilityMatrix[2].deploymentProfiles).toEqual(['cloud'])
    expect(ProfileCapabilityMatrix[2].runtime).toMatchObject({ state: 'conditional' })
    expect(ProfileCapabilityMatrix[2].runtime.reason).toContain('remote-gateway')
    expect(ProfileCapabilityMatrix[2].runtime.reason).toContain('CLOUD_PROFILE_UNQUALIFIED')
  })

  test('preserves Local SQLite and both explicit Self-hosted storage variants', () => {
    expect(bindProfileStorage('local', composition('local'))).toMatchObject({
      profile: 'local',
      deploymentProfile: 'local',
      persistenceDialect: 'sqlite',
    })
    expect(bindProfileStorage('self-hosted', composition('hosted-simple'))).toMatchObject({
      deploymentProfile: 'hosted-simple',
      persistenceDialect: 'sqlite',
    })
    expect(bindProfileStorage('self-hosted', composition('hosted-server'))).toMatchObject({
      deploymentProfile: 'hosted-server',
      persistenceDialect: 'postgresql',
    })
    expect(bindProfileStorage('hosted', composition('cloud'))).toMatchObject({
      deploymentProfile: 'cloud',
      persistenceDialect: 'postgresql',
    })
  })

  test('maps only exact display labels and requires an exact canonical Self-hosted variant', () => {
    expect(bindProfileStorage('Local', composition('local'))).toMatchObject({
      profile: 'local',
      deploymentProfile: 'local',
    })
    expect(bindProfileStorage('Self-hosted', composition('hosted-server'))).toMatchObject({
      profile: 'self-hosted',
      deploymentProfile: 'hosted-server',
    })
    expect(bindProfileStorage('Hosted', composition('cloud'))).toMatchObject({
      profile: 'hosted',
      deploymentProfile: 'cloud',
    })
    expect(() => bindProfileStorage('Self-hosted', composition('self-hosted'))).toThrow(
      expect.objectContaining({ code: 'PROFILE_DEPLOYMENT_MISMATCH' })
    )
    expect(() => bindProfileStorage('LOCAL', composition('local'))).toThrow(
      expect.objectContaining({ code: 'PROFILE_NAME_INVALID' })
    )
  })

  test('rejects aliases, cross-profile composition, and mismatched persistence/workflow ports', () => {
    expect(() => bindProfileStorage('managed-cloud', composition('cloud'))).toThrow(
      ProfileAdapterError
    )
    expect(() => bindProfileStorage('local', composition('hosted-simple'))).toThrow(
      expect.objectContaining({ code: 'PROFILE_DEPLOYMENT_MISMATCH' })
    )
    expect(() => bindProfileStorage('self-hosted', composition('hosted-server', 'sqlite'))).toThrow(
      expect.objectContaining({ code: 'PROFILE_PERSISTENCE_MISMATCH' })
    )
    const mismatched = composition('local')
    mismatched.workflow.profile = 'hosted-simple'
    expect(() => bindProfileStorage('local', mismatched)).toThrow(
      expect.objectContaining({ code: 'PROFILE_WORKFLOW_MISMATCH' })
    )
  })

  test('binds the existing workflow wake path only for its exact profile/kind', async () => {
    const submitted = []
    const calls = []
    const driver = {
      deploymentProfile: 'local',
      kind: 'embedded-sqlite-queue',
      submit: async (input) => submitted.push(input),
    }
    const wake = await bindProfileWorkflowWake({
      profile: 'local',
      deployment: composition('local'),
      driver,
      placement: placement(),
      guards: allowedGuards(calls),
      topology: trustedWakeTopology(driver),
    })
    const workflow = {
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
      executionPlan: {
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        schemaVersion: 1,
      },
      deadlineAt: '2026-10-09T12:00:00.000Z',
    }
    await wake.submit(workflow)
    expect(submitted).toEqual([workflow])
    expect(calls.map(([guard]) => guard)).toEqual([
      'residency',
      'authority',
      'residency',
      'authority',
      'residency',
    ])
    expect(calls.find(([guard]) => guard === 'authority')[1].target).toMatchObject({
      kind: 'workflow',
      executionId: workflow.executionId,
      executionPlanId: workflow.executionPlan.executionPlanId,
      contentDigest: workflow.executionPlan.contentDigest,
    })

    const deniedDriver = {
      deploymentProfile: 'local',
      kind: 'embedded-sqlite-queue',
      submit: async () => submitted.push('unexpected'),
    }
    const deniedWake = await bindProfileWorkflowWake({
      profile: 'local',
      deployment: composition('local'),
      driver: deniedDriver,
      placement: placement(),
      guards: {
        authority: {
          assertCurrent: async () => {
            throw new ProfileAdapterError('PROFILE_AUTHORITY_REJECTED')
          },
        },
        residency: { assertCurrent: async () => undefined },
      },
      topology: trustedWakeTopology(deniedDriver),
    })
    await expect(deniedWake.submit(workflow)).rejects.toMatchObject({
      code: 'PROFILE_AUTHORITY_REJECTED',
    })
    expect(submitted).toEqual([workflow])
    const wrongKindDriver = {
      deploymentProfile: 'local',
      kind: 'restate-ingress',
      submit: async () => undefined,
    }
    await expect(
      bindProfileWorkflowWake({
        profile: 'local',
        deployment: composition('local'),
        driver: wrongKindDriver,
        placement: placement(),
        guards: allowedGuards(),
        topology: trustedWakeTopology(wrongKindDriver),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_WAKE_MISMATCH' })
  })

  test('binds the hosted workflow wake path to its exact cloud restate dispatcher', async () => {
    const submitted = []
    const calls = []
    const driver = {
      deploymentProfile: 'cloud',
      kind: 'restate-ingress',
      submit: async (input) => submitted.push(input),
    }
    const wake = await bindProfileWorkflowWake({
      profile: 'hosted',
      deployment: composition('cloud'),
      driver,
      placement: hostedPlacement,
      guards: allowedGuards(calls),
      topology: trustedWakeTopology(driver),
    })
    const workflow = {
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
      executionPlan: {
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        schemaVersion: 1,
      },
      deadlineAt: '2026-10-09T12:00:00.000Z',
    }
    await wake.submit(workflow)
    expect(submitted).toEqual([workflow])
    expect(calls.map(([guard]) => guard)).toEqual([
      'residency',
      'authority',
      'residency',
      'authority',
      'residency',
    ])

    // The embedded queue is never a hosted wake route and there is no fallback.
    const embedded = {
      deploymentProfile: 'cloud',
      kind: 'embedded-sqlite-queue',
      submit: async () => undefined,
    }
    const failure = await bindProfileWorkflowWake({
      profile: 'hosted',
      deployment: composition('cloud'),
      driver: embedded,
      placement: hostedPlacement,
      guards: allowedGuards(),
      topology: trustedWakeTopology(embedded),
    }).catch((error) => error)
    expect(failure.code).toBe('PROFILE_WAKE_MISMATCH')
  })

  test('validates the actual runtime/transport pair and recomputes capability eligibility', async () => {
    const driver = new MockRuntimeAdapter()
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const calls = []
    const binding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { adapter, transport, placement: placement() },
      guards: allowedGuards(calls),
      topology: trustedTopology(adapter, transport, calls),
      requiredCapabilities: [{ capability: 'stream.output', necessity: 'required' }],
    })
    expect(binding).toMatchObject({
      profile: 'local',
      deploymentProfile: 'local',
      transportKind: 'direct-local',
      inspection: {
        metadata: { adapterName: 'mock' },
        capabilityEvaluation: { eligible: true, mode: 'full' },
      },
    })

    const request = {
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'profile-local:one',
      executionPlan: {
        schemaVersion: 1,
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        runtimeRequirements: [
          { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
        ],
      },
    }
    const handle = await binding.adapter.start(request)
    expect(handle.attemptId).toBe(request.attemptId)
    expect(calls.filter(([guard]) => guard === 'authority')).toHaveLength(3)
    expect(calls.filter(([guard]) => guard === 'residency')).toHaveLength(7)
    expect(calls.filter(([guard]) => guard === 'topology')).toHaveLength(7)
    expect(calls.filter(([guard]) => guard === 'authority').at(-1)[1].target).toMatchObject({
      kind: 'handle',
      handleId: handle.handleId,
      attemptId: handle.attemptId,
      startedAt: handle.startedAt,
    })
  })

  test('requires the trusted topology to approve the exact workflow dispatcher instance', async () => {
    let submitCount = 0
    const configuredDriver = {
      deploymentProfile: 'local',
      kind: 'embedded-sqlite-queue',
      submit: async () => undefined,
    }
    const substitutedDriver = {
      deploymentProfile: 'local',
      kind: 'embedded-sqlite-queue',
      submit: async () => {
        submitCount += 1
      },
    }

    await expect(
      bindProfileWorkflowWake({
        profile: 'local',
        deployment: composition('local'),
        driver: substitutedDriver,
        placement: placement(),
        guards: allowedGuards(),
        topology: trustedWakeTopology(configuredDriver),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_WAKE_MISMATCH' })
    expect(submitCount).toBe(0)
  })

  test('denies a runtime before effects when current authority or placement does not match', async () => {
    let startCount = 0
    class CountingRuntime extends MockRuntimeAdapter {
      async start(request) {
        startCount += 1
        return super.start(request)
      }
    }
    const driver = new CountingRuntime()
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const binding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { adapter, transport, placement: placement() },
      topology: trustedTopology(adapter, transport),
      guards: {
        authority: {
          assertCurrent: async () => {
            throw new ProfileAdapterError('PROFILE_AUTHORITY_REJECTED')
          },
        },
        residency: { assertCurrent: async () => undefined },
      },
    })
    await expect(
      binding.adapter.start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'profile-local:denied',
        executionPlan: {
          schemaVersion: 1,
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          runtimeRequirements: [],
        },
      })
    ).rejects.toMatchObject({ code: 'PROFILE_AUTHORITY_REJECTED' })
    expect(startCount).toBe(0)
  })

  test('preserves progress cursor and timestamps while rechecking current guards', async () => {
    const observedAt = '2026-10-09T12:34:56.000Z'
    const driver = new MockRuntimeAdapter({ now: () => observedAt })
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const calls = []
    const binding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { adapter, transport, placement: placement() },
      guards: allowedGuards(calls),
      topology: trustedTopology(adapter, transport, calls),
    })
    const handle = await binding.adapter.start({
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'profile-local:progress',
      executionPlan: {
        schemaVersion: 1,
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        runtimeRequirements: [],
      },
    })

    const events = []
    for await (const event of binding.adapter.progress(handle, { afterSequence: 1 })) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      sequence: 2,
      occurredAt: observedAt,
      handleId: handle.handleId,
    })
    expect(calls.filter(([guard]) => guard === 'authority').length).toBeGreaterThanOrEqual(3)
    expect(calls.filter(([guard]) => guard === 'residency').length).toBeGreaterThanOrEqual(8)
    expect(calls.filter(([guard]) => guard === 'topology').length).toBeGreaterThanOrEqual(8)
  })

  test('rejects progress receipts from another handle', async () => {
    class MisroutedProgressRuntime extends MockRuntimeAdapter {
      async *progress() {
        yield {
          handleId: 'mock:another-attempt',
          sequence: 1,
          occurredAt: '2026-10-09T12:34:56.000Z',
          type: 'status',
          data: { state: 'running' },
        }
      }
    }
    const driver = new MisroutedProgressRuntime()
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const binding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { adapter, transport, placement: placement() },
      guards: allowedGuards(),
      topology: trustedTopology(adapter, transport),
    })
    const handle = await binding.adapter.start({
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'profile-local:misrouted-progress',
      executionPlan: {
        schemaVersion: 1,
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        runtimeRequirements: [],
      },
    })

    await expect(
      (async () => {
        for await (const _event of binding.adapter.progress(handle)) {
          throw new Error('MISRouted_EVENT_WAS_DELIVERED')
        }
      })()
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_PROGRESS_INVALID' })
  })

  test('binds hosted runtime through the real managed-Pi adapter over the authenticated remote gateway', async () => {
    const calls = []
    const { adapter, transport } = hostedManagedPiFixture(new RecordingManagedPiClient())
    const binding = await bindProfileRuntime({
      profile: 'hosted',
      deployment: composition('cloud'),
      candidate: { adapter, transport, placement: hostedPlacement },
      guards: allowedGuards(calls),
      topology: trustedTopology(adapter, transport, calls),
      requiredCapabilities: [
        { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
        { capability: 'execution.cancel', necessity: 'required', minimumSupport: 'supported' },
      ],
    })
    expect(binding).toMatchObject({
      profile: 'hosted',
      deploymentProfile: 'cloud',
      transportKind: 'remote-gateway',
      inspection: {
        metadata: { adapterName: 'managed-pi', transportKind: 'remote-gateway' },
        capabilityEvaluation: { eligible: true },
      },
    })
    const request = {
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'profile-hosted:one',
      executionPlan: managedExecutionPlan(),
    }
    const handle = await binding.adapter.start(request)
    expect(handle.attemptId).toBe(request.attemptId)
    const events = []
    for await (const event of binding.adapter.progress(handle)) events.push(event)
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    expect(calls.filter(([guard]) => guard === 'authority').length).toBeGreaterThanOrEqual(3)
    expect(calls.filter(([guard]) => guard === 'residency').length).toBeGreaterThanOrEqual(7)
    expect(calls.filter(([guard]) => guard === 'topology').length).toBeGreaterThanOrEqual(7)
  })

  test('refuses a hosted runtime over a direct-local transport instead of falling back', async () => {
    const driver = new MockRuntimeAdapter()
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    await expect(
      bindProfileRuntime({
        profile: 'hosted',
        deployment: composition('cloud'),
        candidate: {
          adapter,
          transport,
          placement: { ...hostedPlacement, coLocated: true, runtimeHostId: 'cp-host' },
        },
        guards: allowedGuards(),
        topology: trustedTopology(adapter, transport),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_TRANSPORT_MISMATCH' })
  })

  test('refuses hosted placement outside the managed-cloud location', async () => {
    const driver = new MockRuntimeAdapter()
    const transport = new RemoteRuntimeGatewayTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const failure = await bindProfileRuntime({
      profile: 'hosted',
      deployment: composition('cloud'),
      candidate: {
        adapter,
        transport,
        placement: { ...hostedPlacement, runtimeLocation: 'remote_host' },
      },
      guards: allowedGuards(),
      topology: trustedTopology(adapter, transport),
    }).catch((error) => error)
    expect(failure.code).toBe('PROFILE_PLACEMENT_MISMATCH')
  })

  test('refuses the Node Pi Durable adapter and a declared cloud-profile denial for hosted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'profile-adapters-hosted-'))
    try {
      const durable = new PiDurableRuntimeAdapter({ directory })
      const transport = new RemoteRuntimeGatewayTransport(durable)
      const adapter = new TransportedRuntimeAdapter(transport, 'pi-durable')
      const transportFailure = await bindProfileRuntime({
        profile: 'hosted',
        deployment: composition('cloud'),
        candidate: { adapter, transport, placement: hostedPlacement },
        guards: allowedGuards(),
        topology: trustedTopology(adapter, transport),
      }).catch((error) => error)
      // The real Node adapter self-identifies as direct-local, so the hosted
      // remote-gateway transport refuses it before any qualification hint.
      expect(transportFailure.code).toBe('PROFILE_RUNTIME_TRANSPORT_MISMATCH')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    // A remote-shaped adapter that declares the canonical Node Pi Durable
    // denial (`packages/pi-durable-adapter/src/adapter.ts`) fails the hosted
    // qualification gate even while healthy and advertising capabilities.
    const denialDriver = new MockRuntimeAdapter({ limitations: ['CLOUD_PROFILE_UNQUALIFIED'] })
    const denialTransport = new RemoteRuntimeGatewayTransport(denialDriver)
    const denialAdapter = new TransportedRuntimeAdapter(denialTransport, 'mock')
    const denial = await bindProfileRuntime({
      profile: 'hosted',
      deployment: composition('cloud'),
      candidate: { adapter: denialAdapter, transport: denialTransport, placement: hostedPlacement },
      guards: allowedGuards(),
      topology: trustedTopology(denialAdapter, denialTransport),
    }).catch((error) => error)
    expect(denial).toMatchObject({
      code: 'PROFILE_RUNTIME_NOT_QUALIFIED',
      details: { limitation: 'CLOUD_PROFILE_UNQUALIFIED' },
    })
  })

  test('refuses a degraded hosted adapter and a missing required capability', async () => {
    const degraded = new MockRuntimeAdapter({ health: 'degraded' })
    const degradedTransport = new RemoteRuntimeGatewayTransport(degraded)
    const degradedAdapter = new TransportedRuntimeAdapter(degradedTransport, 'mock')
    await expect(
      bindProfileRuntime({
        profile: 'hosted',
        deployment: composition('cloud'),
        candidate: {
          adapter: degradedAdapter,
          transport: degradedTransport,
          placement: hostedPlacement,
        },
        guards: allowedGuards(),
        topology: trustedTopology(degradedAdapter, degradedTransport),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_UNAVAILABLE' })

    const { adapter, transport } = hostedManagedPiFixture(new RecordingManagedPiClient())
    await expect(
      bindProfileRuntime({
        profile: 'hosted',
        deployment: composition('cloud'),
        candidate: { adapter, transport, placement: hostedPlacement },
        guards: allowedGuards(),
        topology: trustedTopology(adapter, transport),
        requiredCapabilities: [
          { capability: 'session.history', necessity: 'required', minimumSupport: 'supported' },
        ],
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_CAPABILITY_UNAVAILABLE' })
  })

  test('keeps hosted authority, residency, and exact-instance topology gates', async () => {
    const { adapter, transport } = hostedManagedPiFixture(new RecordingManagedPiClient())
    // Current authority is re-read before effects, not at composition time.
    const authorityDenied = await bindProfileRuntime({
      profile: 'hosted',
      deployment: composition('cloud'),
      candidate: { adapter, transport, placement: hostedPlacement },
      guards: {
        authority: {
          assertCurrent: async () => {
            throw new ProfileAdapterError('PROFILE_AUTHORITY_REJECTED')
          },
        },
        residency: { assertCurrent: async () => undefined },
      },
      topology: trustedTopology(adapter, transport),
    })
    const startFailure = await authorityDenied.adapter
      .start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'profile-hosted:denied',
        executionPlan: managedExecutionPlan(),
      })
      .catch((error) => error)
    expect(startFailure.code).toBe('PROFILE_AUTHORITY_REJECTED')

    const residencyFailure = await bindProfileRuntime({
      profile: 'hosted',
      deployment: composition('cloud'),
      candidate: { adapter, transport, placement: hostedPlacement },
      guards: {
        authority: { assertCurrent: async () => undefined },
        residency: {
          assertCurrent: async () => {
            throw new ProfileAdapterError('PROFILE_RESIDENCY_REJECTED')
          },
        },
      },
      topology: trustedTopology(adapter, transport),
    }).catch((error) => error)
    expect(residencyFailure.code).toBe('PROFILE_RESIDENCY_REJECTED')

    const topologyFailure = await bindProfileRuntime({
      profile: 'hosted',
      deployment: composition('cloud'),
      candidate: { adapter, transport, placement: hostedPlacement },
      guards: allowedGuards(),
      topology: trustedTopology(
        hostedManagedPiFixture(new RecordingManagedPiClient()).adapter,
        transport
      ),
    }).catch((error) => error)
    expect(topologyFailure.code).toBe('PROFILE_RUNTIME_BINDING_MISMATCH')
  })

  test('requires the trusted topology to approve the exact adapter and transport instances', async () => {
    const configuredDriver = new MockRuntimeAdapter()
    const configuredTransport = new DirectLocalRuntimeTransport(configuredDriver)
    const configuredAdapter = new TransportedRuntimeAdapter(configuredTransport, 'mock')
    const substitutedTransport = new DirectLocalRuntimeTransport(new MockRuntimeAdapter())

    await expect(
      bindProfileRuntime({
        profile: 'local',
        deployment: composition('local'),
        candidate: {
          adapter: configuredAdapter,
          transport: substitutedTransport,
          placement: placement(),
        },
        guards: allowedGuards(),
        topology: trustedTopology(configuredAdapter, configuredTransport),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_BINDING_MISMATCH' })
  })

  test('snapshots trusted placement before later runtime calls', async () => {
    const driver = new MockRuntimeAdapter()
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const mutablePlacement = placement()
    const checkedHosts = []
    const topology = {
      assertCurrent: async (context, binding) => {
        checkedHosts.push(context.placement.runtimeHostId)
        if (
          binding.adapter !== adapter ||
          binding.transport !== transport ||
          context.placement.runtimeHostId !== 'local-host'
        ) {
          throw new ProfileAdapterError('PROFILE_RUNTIME_BINDING_MISMATCH')
        }
      },
    }
    const binding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { adapter, transport, placement: mutablePlacement },
      guards: allowedGuards(),
      topology,
    })
    mutablePlacement.runtimeHostId = 'untrusted-reassignment'

    await binding.adapter.start({
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'profile-local:placement-snapshot',
      executionPlan: {
        schemaVersion: 1,
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        runtimeRequirements: [],
      },
    })

    expect(checkedHosts).toEqual([
      'local-host',
      'local-host',
      'local-host',
      'local-host',
      'local-host',
      'local-host',
      'local-host',
    ])
  })

  test('binds a remote self-hosted runtime only to the gateway transport', async () => {
    const driver = new MockRuntimeAdapter()
    const transport = new RemoteRuntimeGatewayTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const remotePlacement = {
      ...placement('self-hosted'),
      runtimeHostId: 'self-hosted-runtime',
      coLocated: false,
    }

    const binding = await bindProfileRuntime({
      profile: 'self-hosted',
      deployment: composition('hosted-server'),
      candidate: { adapter, transport, placement: remotePlacement },
      guards: allowedGuards(),
      topology: trustedTopology(adapter, transport),
    })

    expect(binding).toMatchObject({
      profile: 'self-hosted',
      deploymentProfile: 'hosted-server',
      transportKind: 'remote-gateway',
    })
  })

  test('denies required capabilities absent from inspection metadata before start', async () => {
    let startCount = 0
    class EmptyCapabilityRuntime extends MockRuntimeAdapter {
      constructor() {
        super({ capabilities: [] })
      }

      async start(request) {
        startCount += 1
        return super.start(request)
      }
    }
    const driver = new EmptyCapabilityRuntime()
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const binding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { adapter, transport, placement: placement() },
      guards: allowedGuards(),
      topology: trustedTopology(adapter, transport),
    })

    const required = [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
    ]
    await expect(binding.adapter.inspect(required)).rejects.toMatchObject({
      code: 'PROFILE_RUNTIME_CAPABILITY_UNAVAILABLE',
    })

    await expect(
      binding.adapter.start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'profile-local:missing-capability',
        executionPlan: {
          schemaVersion: 1,
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          runtimeRequirements: [
            { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
          ],
        },
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_CAPABILITY_UNAVAILABLE' })
    expect(startCount).toBe(0)
  })

  test('rejects a start handle from another attempt', async () => {
    class MisroutedStartRuntime extends MockRuntimeAdapter {
      async start(request) {
        const handle = await super.start(request)
        return { ...handle, attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV' }
      }
    }
    const driver = new MisroutedStartRuntime()
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const binding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { adapter, transport, placement: placement() },
      guards: allowedGuards(),
      topology: trustedTopology(adapter, transport),
    })

    await expect(
      binding.adapter.start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'profile-local:misrouted-start',
        executionPlan: {
          schemaVersion: 1,
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          runtimeRequirements: [],
        },
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_BINDING_MISMATCH' })
  })

  test('rejects a status for a changed retained handle tuple', async () => {
    class ChangedHandleStatusRuntime extends MockRuntimeAdapter {
      async status(handle) {
        const status = await super.status(handle)
        return {
          ...status,
          handle: { ...status.handle, startedAt: '2026-10-09T13:00:00.000Z' },
        }
      }
    }
    const driver = new ChangedHandleStatusRuntime({ now: () => '2026-10-09T12:00:00.000Z' })
    const transport = new DirectLocalRuntimeTransport(driver)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    const binding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { adapter, transport, placement: placement() },
      guards: allowedGuards(),
      topology: trustedTopology(adapter, transport),
    })
    const handle = await binding.adapter.start({
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      idempotencyKey: 'profile-local:changed-handle',
      executionPlan: {
        schemaVersion: 1,
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        contentDigest: `sha256:${'a'.repeat(64)}`,
        runtimeRequirements: [],
      },
    })

    await expect(binding.adapter.status(handle)).rejects.toMatchObject({
      code: 'PROFILE_RUNTIME_BINDING_MISMATCH',
    })
  })
})
