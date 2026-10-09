import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiDurableRuntimeAdapter } from '@control-plane/pi-durable-adapter'
import {
  bindProfileRuntime,
  bindProfileStorage,
  bindProfileWorkflowWake,
  ExecutionProfiles,
  ProfileAdapterError,
  ProfileCapabilityMatrix,
} from '@control-plane/profile-adapters'
import {
  DirectLocalRuntimeTransport,
  MockRuntimeAdapter,
  RemoteRuntimeGatewayTransport,
  TransportedRuntimeAdapter,
} from '@control-plane/runtime-sdk'

// Qualification facts for #1025 (M17.02.2): what each product profile can
// actually prove for recovery and rollback, pinned at the composition
// boundary. Everything here is offline and deterministic: no Pi process, no
// network, no credentials. The profile map in
// packages/profile-adapters/README.md is source-level, never a live
// certification, and unsupported profiles fail closed instead of falling back.

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

const hostedPlacement = Object.freeze({
  controlPlaneHostId: 'cp-host',
  runtimeHostId: 'cloud-runtime-host',
  runtimeLocation: 'agent_hq_cloud',
  coLocated: false,
})

const allowedGuards = (calls = []) => ({
  authority: {
    assertCurrent: async (context) => calls.push(['authority', context]),
  },
  residency: {
    assertCurrent: async (context) => calls.push(['residency', context]),
  },
})

const trustedTopology = (adapter, transport) => ({
  assertCurrent: async (_context, binding) => {
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

const localRuntimeFixture = (driver = new MockRuntimeAdapter()) => {
  const transport = new DirectLocalRuntimeTransport(driver)
  return { adapter: new TransportedRuntimeAdapter(transport, 'mock'), transport }
}

const remoteRuntimeFixture = (driver = new MockRuntimeAdapter()) => {
  const transport = new RemoteRuntimeGatewayTransport(driver)
  return { adapter: new TransportedRuntimeAdapter(transport, 'mock'), transport }
}

const wakeDriver = (deploymentProfile, kind, submitted = []) => ({
  deploymentProfile,
  kind,
  submit: async (input) => submitted.push(input),
})

const workflowInput = () => ({
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  workflowId: 'wfl_01JABCDEF0123456789ABCDEFG',
  executionPlan: {
    executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
    contentDigest: `sha256:${'a'.repeat(64)}`,
    schemaVersion: 1,
  },
  deadlineAt: '2026-10-09T12:00:00.000Z',
})

// [product profile, canonical deployment profile, wake kind, placement]
const profileStacks = [
  ['local', 'local', 'embedded-sqlite-queue', placement()],
  ['self-hosted', 'hosted-simple', 'restate-ingress', placement('self-hosted')],
  ['self-hosted', 'hosted-server', 'restate-ingress', placement('self-hosted')],
  ['hosted', 'cloud', 'restate-ingress', hostedPlacement],
]

describe('profile qualification facts (#1025)', () => {
  test('keeps each product profile on its exact canonical storage and wake stack', () => {
    expect(ProfileCapabilityMatrix.map(({ profile }) => profile)).toEqual([
      ExecutionProfiles.local,
      ExecutionProfiles.selfHosted,
      ExecutionProfiles.hosted,
    ])
    expect(ProfileCapabilityMatrix[0]).toMatchObject({
      deploymentProfiles: ['local'],
      storage: { state: 'supported', variants: ['sqlite'] },
      schedulerWake: { variants: ['embedded-sqlite-queue'] },
    })
    expect(ProfileCapabilityMatrix[1]).toMatchObject({
      deploymentProfiles: ['hosted-simple', 'hosted-server'],
      storage: { variants: ['hosted-simple:sqlite', 'hosted-server:postgresql'] },
      schedulerWake: { variants: ['restate-ingress'] },
    })
    expect(ProfileCapabilityMatrix[2]).toMatchObject({
      deploymentProfiles: ['cloud'],
      storage: { variants: ['cloud:postgresql'] },
      schedulerWake: { variants: ['restate-ingress'] },
      runtime: { state: 'conditional' },
    })
    // The hosted runtime stays conditional and names the fail-closed denial
    // plus the missing fallback in its own qualification reason.
    expect(ProfileCapabilityMatrix[2].runtime.reason).toContain('CLOUD_PROFILE_UNQUALIFIED')
    expect(ProfileCapabilityMatrix[2].runtime.reason).toContain('fail closed')
    expect(ProfileCapabilityMatrix[2].runtime.reason).toContain('No implicit fallback')

    for (const [profile, deploymentProfile] of profileStacks) {
      expect(bindProfileStorage(profile, composition(deploymentProfile))).toMatchObject({
        profile,
        deploymentProfile,
        persistenceDialect:
          deploymentProfile === 'local' || deploymentProfile === 'hosted-simple'
            ? 'sqlite'
            : 'postgresql',
      })
    }
  })

  test('maps only exact display labels and refuses to guess a Self-hosted variant', () => {
    expect(bindProfileStorage('Local', composition('local'))).toMatchObject({ profile: 'local' })
    expect(bindProfileStorage('Self-hosted', composition('hosted-server'))).toMatchObject({
      profile: 'self-hosted',
      deploymentProfile: 'hosted-server',
    })
    expect(bindProfileStorage('Hosted', composition('cloud'))).toMatchObject({
      profile: 'hosted',
    })
    expect(() => bindProfileStorage('HOSTED', composition('cloud'))).toThrow(
      expect.objectContaining({ code: 'PROFILE_NAME_INVALID' })
    )
    // A self-hosted deployment without an explicit canonical variant stays
    // unavailable; binding never guesses between simple and server.
    expect(() => bindProfileStorage('Self-hosted', composition('self-hosted'))).toThrow(
      expect.objectContaining({ code: 'PROFILE_DEPLOYMENT_MISMATCH' })
    )
    expect(() =>
      bindProfileStorage('self-hosted', composition('hosted-simple', 'postgresql'))
    ).toThrow(expect.objectContaining({ code: 'PROFILE_PERSISTENCE_MISMATCH' }))
  })

  test('binds only the exact workflow dispatcher per profile and refuses every mismatch', async () => {
    for (const [profile, deploymentProfile, kind, placementFor] of profileStacks) {
      const submitted = []
      const driver = wakeDriver(deploymentProfile, kind, submitted)
      const wake = await bindProfileWorkflowWake({
        profile,
        deployment: composition(deploymentProfile),
        driver,
        placement: placementFor,
        guards: allowedGuards(),
        topology: trustedWakeTopology(driver),
      })
      expect(wake).toMatchObject({ profile, deploymentProfile, kind })
      const input = workflowInput()
      await wake.submit(input)
      expect(submitted).toEqual([input])
    }

    // The embedded queue is never a Restate profile's route and vice versa:
    // each wrong kind is refused before any submit for every profile.
    for (const [profile, deploymentProfile, kind, placementFor] of profileStacks) {
      const wrongKind = kind === 'restate-ingress' ? 'embedded-sqlite-queue' : 'restate-ingress'
      const submitted = []
      const driver = wakeDriver(deploymentProfile, wrongKind, submitted)
      await expect(
        bindProfileWorkflowWake({
          profile,
          deployment: composition(deploymentProfile),
          driver,
          placement: placementFor,
          guards: allowedGuards(),
          topology: trustedWakeTopology(driver),
        })
      ).rejects.toMatchObject({ code: 'PROFILE_WAKE_MISMATCH' })
      expect(submitted).toEqual([])
    }

    // A dispatcher provisioned for one canonical variant is not replayed
    // through another: hosted-simple queue vs hosted-server deployment.
    const crossVariantDriver = wakeDriver('hosted-simple', 'restate-ingress')
    await expect(
      bindProfileWorkflowWake({
        profile: 'self-hosted',
        deployment: composition('hosted-server'),
        driver: crossVariantDriver,
        placement: placement('self-hosted'),
        guards: allowedGuards(),
        topology: trustedWakeTopology(crossVariantDriver),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_WAKE_MISMATCH' })
  })

  test('requires the trusted wake topology and current guards to approve each submit', async () => {
    const submitted = []
    const configuredDriver = wakeDriver('local', 'embedded-sqlite-queue')
    // The trusted topology guard compares exact dispatcher instances during
    // binding itself, so a substituted dispatcher is refused before any
    // submit path exists.
    await expect(
      bindProfileWorkflowWake({
        profile: 'local',
        deployment: composition('local'),
        driver: wakeDriver('local', 'embedded-sqlite-queue', submitted),
        placement: placement(),
        guards: allowedGuards(),
        topology: trustedWakeTopology(configuredDriver),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_WAKE_MISMATCH' })
    expect(submitted).toEqual([])

    // Authority is re-read before every effect: a stale grant blocks the
    // submit and the residency/authority order around the accepted path is
    // exactly residency -> authority -> submit -> authority -> residency.
    const calls = []
    const acceptedDriver = wakeDriver('local', 'embedded-sqlite-queue', submitted)
    const accepted = await bindProfileWorkflowWake({
      profile: 'local',
      deployment: composition('local'),
      driver: acceptedDriver,
      placement: placement(),
      guards: allowedGuards(calls),
      topology: trustedWakeTopology(acceptedDriver),
    })
    await accepted.submit(workflowInput())
    expect(calls.map(([guard]) => guard)).toEqual([
      'residency',
      'authority',
      'residency',
      'authority',
      'residency',
    ])

    const deniedSubmitted = []
    const deniedDriver = wakeDriver('local', 'embedded-sqlite-queue', deniedSubmitted)
    const denied = await bindProfileWorkflowWake({
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
    await expect(denied.submit(workflowInput())).rejects.toMatchObject({
      code: 'PROFILE_AUTHORITY_REJECTED',
    })
    expect(deniedSubmitted).toEqual([])
  })

  test('fails closed on substituted transports and rejected authority or residency before effects', async () => {
    // The topology guard compares exact instances: a swapped transport never
    // becomes the execution route.
    const configured = localRuntimeFixture()
    const substituted = localRuntimeFixture()
    await expect(
      bindProfileRuntime({
        profile: 'local',
        deployment: composition('local'),
        candidate: {
          adapter: configured.adapter,
          transport: substituted.transport,
          placement: placement(),
        },
        guards: allowedGuards(),
        topology: trustedTopology(configured.adapter, configured.transport),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_BINDING_MISMATCH' })

    // Authority binds to the authenticated original actor and is re-read
    // before the first effect; a rejected grant denies the start entirely.
    let startCount = 0
    class CountingRuntime extends MockRuntimeAdapter {
      async start(request) {
        startCount += 1
        return super.start(request)
      }
    }
    const deniedPair = localRuntimeFixture(new CountingRuntime())
    const deniedBinding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { ...deniedPair, placement: placement() },
      topology: trustedTopology(deniedPair.adapter, deniedPair.transport),
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
      deniedBinding.adapter.start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'profile-qualification:authority-denied',
        executionPlan: {
          schemaVersion: 1,
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          runtimeRequirements: [],
        },
      })
    ).rejects.toMatchObject({ code: 'PROFILE_AUTHORITY_REJECTED' })
    expect(startCount).toBe(0)

    // Residency is checked during composition itself, so a rejected placement
    // policy never yields a usable binding.
    const residencyPair = localRuntimeFixture()
    await expect(
      bindProfileRuntime({
        profile: 'local',
        deployment: composition('local'),
        candidate: { ...residencyPair, placement: placement() },
        topology: trustedTopology(residencyPair.adapter, residencyPair.transport),
        guards: {
          authority: { assertCurrent: async () => undefined },
          residency: {
            assertCurrent: async () => {
              throw new ProfileAdapterError('PROFILE_RESIDENCY_REJECTED')
            },
          },
        },
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RESIDENCY_REJECTED' })

    // An unhealthy adapter is unavailable for every profile, including the
    // hosted managed-cloud lane.
    const degradedPair = remoteRuntimeFixture(new MockRuntimeAdapter({ health: 'degraded' }))
    await expect(
      bindProfileRuntime({
        profile: 'hosted',
        deployment: composition('cloud'),
        candidate: { ...degradedPair, placement: hostedPlacement },
        guards: allowedGuards(),
        topology: trustedTopology(degradedPair.adapter, degradedPair.transport),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_UNAVAILABLE' })
  })

  test('hosted qualification fails closed exactly on the declared cloud denial, never a fallback', async () => {
    // Hosted execution is managed-cloud by definition: a direct-local
    // transport is refused instead of being downgraded to.
    const localPair = localRuntimeFixture()
    await expect(
      bindProfileRuntime({
        profile: 'hosted',
        deployment: composition('cloud'),
        candidate: {
          adapter: localPair.adapter,
          transport: localPair.transport,
          placement: { ...hostedPlacement, coLocated: true, runtimeHostId: 'cp-host' },
        },
        guards: allowedGuards(),
        topology: trustedTopology(localPair.adapter, localPair.transport),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_TRANSPORT_MISMATCH' })

    // Placement outside the managed-cloud location is refused even over the
    // right transport.
    const remotePair = remoteRuntimeFixture()
    await expect(
      bindProfileRuntime({
        profile: 'hosted',
        deployment: composition('cloud'),
        candidate: {
          adapter: remotePair.adapter,
          transport: remotePair.transport,
          placement: { ...hostedPlacement, runtimeLocation: 'remote_host' },
        },
        guards: allowedGuards(),
        topology: trustedTopology(remotePair.adapter, remotePair.transport),
      })
    ).rejects.toMatchObject({ code: 'PROFILE_PLACEMENT_MISMATCH' })

    // A healthy, capable remote adapter that declares the canonical Node Pi
    // Durable denial still fails the hosted qualification gate.
    const denialPair = remoteRuntimeFixture(
      new MockRuntimeAdapter({ limitations: ['CLOUD_PROFILE_UNQUALIFIED'] })
    )
    const denial = await bindProfileRuntime({
      profile: 'hosted',
      deployment: composition('cloud'),
      candidate: { ...denialPair, placement: hostedPlacement },
      guards: allowedGuards(),
      topology: trustedTopology(denialPair.adapter, denialPair.transport),
    }).catch((error) => error)
    expect(denial).toMatchObject({
      code: 'PROFILE_RUNTIME_NOT_QUALIFIED',
      details: { limitation: 'CLOUD_PROFILE_UNQUALIFIED' },
    })

    // The denial gate is exact: the same healthy remote shape with an
    // unrelated limitation is not denied by that gate (health, capability,
    // topology, authority, and residency gates still apply).
    const unrelatedPair = remoteRuntimeFixture(
      new MockRuntimeAdapter({ limitations: ['NODE_SQLITE_REMOTE_HOST_ONLY'] })
    )
    const unrelated = await bindProfileRuntime({
      profile: 'hosted',
      deployment: composition('cloud'),
      candidate: { ...unrelatedPair, placement: hostedPlacement },
      guards: allowedGuards(),
      topology: trustedTopology(unrelatedPair.adapter, unrelatedPair.transport),
    })
    expect(unrelated).toMatchObject({ profile: 'hosted', transportKind: 'remote-gateway' })
  })

  test('never presents the Node Pi Durable adapter as a hosted runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'profile-qualification-pi-durable-'))
    try {
      const durable = new PiDurableRuntimeAdapter({ directory })
      // The adapter self-identifies as direct-local and declares the
      // cloud-profile denial; both facts are what the hosted gate fails on.
      const inspection = await durable.inspect()
      expect(inspection.metadata.transportKind).toBe('direct-local')
      expect(inspection.limitations).toContain('CLOUD_PROFILE_UNQUALIFIED')

      const transport = new RemoteRuntimeGatewayTransport(durable)
      const adapter = new TransportedRuntimeAdapter(transport, 'pi-durable')
      // The hosted remote-gateway route refuses the direct-local adapter
      // before any qualification hint could be read.
      await expect(
        bindProfileRuntime({
          profile: 'hosted',
          deployment: composition('cloud'),
          candidate: { adapter, transport, placement: hostedPlacement },
          guards: allowedGuards(),
          topology: trustedTopology(adapter, transport),
        })
      ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_TRANSPORT_MISMATCH' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('capability requirements fail closed before start with no adapter effect', async () => {
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
    const pair = localRuntimeFixture(new EmptyCapabilityRuntime())
    const binding = await bindProfileRuntime({
      profile: 'local',
      deployment: composition('local'),
      candidate: { ...pair, placement: placement() },
      guards: allowedGuards(),
      topology: trustedTopology(pair.adapter, pair.transport),
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
        idempotencyKey: 'profile-qualification:missing-capability',
        executionPlan: {
          schemaVersion: 1,
          executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
          contentDigest: `sha256:${'a'.repeat(64)}`,
          runtimeRequirements: required,
        },
      })
    ).rejects.toMatchObject({ code: 'PROFILE_RUNTIME_CAPABILITY_UNAVAILABLE' })
    expect(startCount).toBe(0)
  })
})
