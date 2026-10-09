import { describe, expect, test } from 'bun:test'
import {
  bindProfileStorage,
  bindProfileRuntime,
  bindProfileWorkflowWake,
  ExecutionProfiles,
  ProfileAdapterError,
  ProfileCapabilityMatrix,
} from './index.ts'
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

  test('keeps Hosted runtime unavailable even when an adapter advertises capabilities', async () => {
    const runtime = new MockRuntimeAdapter()
    const transport = new DirectLocalRuntimeTransport(runtime)
    const adapter = new TransportedRuntimeAdapter(transport, 'mock')
    await expect(
      bindProfileRuntime({
        profile: 'hosted',
        deployment: composition('cloud'),
        candidate: {
          adapter,
          transport,
          placement: placement('hosted'),
        },
        guards: allowedGuards(),
        topology: trustedTopology(adapter, transport),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_NOT_REGISTERED' })
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
