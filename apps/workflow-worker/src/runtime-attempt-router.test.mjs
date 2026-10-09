import { describe, expect, test } from 'bun:test'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { RuntimeDiscoveryAttemptRouter } from './index.js'

const ids = {
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
  runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
}

describe('runtime discovery attempt routing', () => {
  test('selects one compatible scoped runtime deterministically and records its decision', async () => {
    const scopes = []
    const runtimeA = runtimeConnection('rtc_01JABCDEF0123456789ABCDEFA', {
      family: 'managed-pi',
      access: {
        localProjectGrant: { required: false, state: 'not_required' },
        entitlement: { state: 'allowed' },
      },
    })
    const runtimeB = runtimeConnection('rtc_01JABCDEF0123456789ABCDEFB')
    const router = new RuntimeDiscoveryAttemptRouter({
      discovery: {
        listRuntimeConnections: async (scope) => {
          scopes.push(scope)
          return [runtimeB, runtimeA]
        },
      },
      now: () => '2026-08-28T12:00:00.000Z',
    })
    const plan = createExecutionPlanTestFixture()

    const selected = await router.resolve({ execution: execution(plan), executionPlan: plan })

    expect(scopes).toEqual([
      { workspaceId: plan.correlation.workspaceId, projectId: plan.correlation.projectId },
    ])
    expect(selected).toMatchObject({
      runtimeDefinitionId: ids.runtimeDefinitionId,
      runtimeNodeRefId: ids.runtimeNodeRefId,
      runtimeConnectionId: runtimeA.runtimeConnectionId,
      routingDecision: {
        routingVersion: 1,
        policy: plan.policySnapshot,
        evaluatedAt: '2026-08-28T12:00:00.000Z',
        selectedRank: 1,
        candidateCount: 2,
        reasonCodes: ['RUNTIME_SELECTED'],
      },
    })
    expect(selected.routingDecision.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(selected.routingDecision.decisionDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('rejects stale, unauthorized, offline, incompatible, and capability-missing runtimes', async () => {
    const candidates = [
      runtimeConnection('rtc_01JABCDEF0123456789ABCDEFA', {
        freshness: { state: 'stale', observedAt: '2026-08-28T11:00:00.000Z' },
      }),
      runtimeConnection('rtc_01JABCDEF0123456789ABCDEFB', {
        access: {
          localProjectGrant: { required: true, state: 'missing' },
          entitlement: { state: 'allowed' },
        },
      }),
      runtimeConnection('rtc_01JABCDEF0123456789ABCDEFC', {
        node: runtimeNode({ status: 'offline', health: 'offline' }),
      }),
      runtimeConnection('rtc_01JABCDEF0123456789ABCDEFD', {
        compatibility: { state: 'incompatible', limitations: ['VERSION_MISMATCH'] },
      }),
      runtimeConnection('rtc_01JABCDEF0123456789ABCDEFE', {
        capabilities: ['filesystem.read'],
        capabilityDetails: [{ name: 'filesystem.read', support: 'supported' }],
      }),
    ]
    const router = new RuntimeDiscoveryAttemptRouter({
      discovery: { listRuntimeConnections: async () => candidates },
      now: () => '2026-08-28T12:00:00.000Z',
    })
    const plan = createExecutionPlanTestFixture()

    await expect(
      router.resolve({ execution: execution(plan), executionPlan: plan })
    ).rejects.toThrow('WORKFLOW_RUNTIME_UNAVAILABLE')
  })

  test('a pinned harness fails closed when the selected runtime does not expose it', async () => {
    const plan = createExecutionPlanTestFixture()
    const discovered = runtimeConnection('rtc_01JABCDEF0123456789ABCDEFA', {
      access: {
        localProjectGrant: { required: false, state: 'not_required' },
        entitlement: { state: 'allowed' },
      },
    })
    const denying = new RuntimeDiscoveryAttemptRouter({
      discovery: {
        listRuntimeConnections: async () => [discovered],
      },
      pinnedHarnessId: 'deepseek',
      now: () => '2026-08-28T12:00:00.000Z',
    })
    await expect(
      denying.resolve({ execution: execution(plan), executionPlan: plan })
    ).rejects.toMatchObject({ code: 'HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME' })

    const accepting = new RuntimeDiscoveryAttemptRouter({
      discovery: {
        listRuntimeConnections: async () => [discovered],
      },
      pinnedHarnessId: 'pi',
      now: () => '2026-08-28T12:00:00.000Z',
    })
    const selected = await accepting.resolve({ execution: execution(plan), executionPlan: plan })
    expect(selected.runtimeDefinitionId).toBeDefined()
  })
})

function execution(plan) {
  return {
    executionId: ids.executionId,
    state: 'queued',
    version: 2,
    correlation: plan.correlation,
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    attemptCount: 0,
    acceptedAt: '2026-08-28T11:59:59.000Z',
    queuedAt: '2026-08-28T12:00:00.000Z',
    createdAt: '2026-08-28T11:59:59.000Z',
    updatedAt: '2026-08-28T12:00:00.000Z',
  }
}

function runtimeNode(overrides = {}) {
  return {
    runtimeNodeRefId: ids.runtimeNodeRefId,
    location: 'remote_host',
    status: 'online',
    health: 'online',
    observedAt: '2026-08-28T11:59:59.000Z',
    ...overrides,
  }
}

function runtimeConnection(runtimeConnectionId, overrides = {}) {
  return {
    runtimeConnectionId,
    runtimeDefinitionId: ids.runtimeDefinitionId,
    family: 'pi',
    connectionType: 'managed_local',
    location: 'local_device',
    status: 'available',
    node: runtimeNode(),
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: {
      state: 'fresh',
      observedAt: '2026-08-28T11:59:59.000Z',
      expiresAt: '2026-08-28T12:00:30.000Z',
    },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '1.0.0', protocol: '1.0.0' },
    capabilities: ['filesystem.read', 'stream.output'],
    capabilityDetails: [
      { name: 'filesystem.read', support: 'supported' },
      { name: 'stream.output', support: 'supported' },
    ],
    compatibility: { state: 'compatible', limitations: [] },
    access: {
      localProjectGrant: { required: true, state: 'granted' },
      entitlement: { state: 'allowed' },
    },
    eligibility: { state: 'eligible', reasons: [], degradations: [], remediation: [] },
    observedAt: '2026-08-28T11:59:59.000Z',
    limitations: [],
    ...overrides,
  }
}

describe('no implicit cloud rerouting (TDD-A377)', () => {
  test('an offline local device is never silently replaced by a remote runtime', async () => {
    const plan = createExecutionPlanTestFixture()
    const router = new RuntimeDiscoveryAttemptRouter({
      discovery: {
        listRuntimeConnections: async () => [offlineLocalDevice(), cloudRuntime()],
      },
      now: () => '2026-08-28T12:00:00.000Z',
    })

    await expect(
      router.resolve({ execution: execution(plan), executionPlan: plan })
    ).rejects.toThrow('WORKFLOW_RUNTIME_LOCAL_UNAVAILABLE_NO_FALLBACK')
  })

  test('a revoked local device is fenced the same way and never rerouted', async () => {
    const plan = createExecutionPlanTestFixture()
    const router = new RuntimeDiscoveryAttemptRouter({
      discovery: {
        listRuntimeConnections: async () => [revokedLocalDevice(), cloudRuntime()],
      },
      now: () => '2026-08-28T12:00:00.000Z',
    })

    await expect(
      router.resolve({ execution: execution(plan), executionPlan: plan })
    ).rejects.toThrow('WORKFLOW_RUNTIME_LOCAL_UNAVAILABLE_NO_FALLBACK')
  })

  test('an offline local device with no remote alternative stays unavailable', async () => {
    const plan = createExecutionPlanTestFixture()
    const router = new RuntimeDiscoveryAttemptRouter({
      discovery: { listRuntimeConnections: async () => [offlineLocalDevice()] },
      now: () => '2026-08-28T12:00:00.000Z',
    })

    await expect(
      router.resolve({ execution: execution(plan), executionPlan: plan })
    ).rejects.toThrow('WORKFLOW_RUNTIME_UNAVAILABLE')
  })

  test('a remote runtime stays selectable when the offline local device could not have served the plan', async () => {
    const plan = createExecutionPlanTestFixture()
    const incapableLocal = offlineLocalDevice({
      capabilities: ['filesystem.read'],
      capabilityDetails: [{ name: 'filesystem.read', support: 'supported' }],
    })
    const cloud = cloudRuntime()
    const router = new RuntimeDiscoveryAttemptRouter({
      discovery: { listRuntimeConnections: async () => [incapableLocal, cloud] },
      now: () => '2026-08-28T12:00:00.000Z',
    })

    const selected = await router.resolve({ execution: execution(plan), executionPlan: plan })

    expect(selected.runtimeConnectionId).toBe(cloud.runtimeConnectionId)
  })

  test('a plan that excludes local locations is not blocked by an offline local device', async () => {
    const base = createExecutionPlanTestFixture()
    const remoteOnly = {
      ...base,
      constraints: {
        ...base.constraints,
        runtime: { ...base.constraints.runtime, allowedLocations: ['remote'] },
      },
    }
    const cloud = cloudRuntime()
    const router = new RuntimeDiscoveryAttemptRouter({
      discovery: { listRuntimeConnections: async () => [offlineLocalDevice(), cloud] },
      now: () => '2026-08-28T12:00:00.000Z',
    })

    const selected = await router.resolve({
      execution: execution(remoteOnly),
      executionPlan: remoteOnly,
    })

    expect(selected.runtimeConnectionId).toBe(cloud.runtimeConnectionId)
  })
})

function localDevice(overrides = {}) {
  return runtimeConnection('rtc_01JABCDEF0123456789ABCDEFA', {
    location: 'local_device',
    node: runtimeNode({ location: 'local_device' }),
    ...overrides,
  })
}

function offlineLocalDevice(overrides = {}) {
  return localDevice({
    status: 'unavailable',
    node: runtimeNode({ location: 'local_device', status: 'offline', health: 'offline' }),
    connection: { status: 'disconnected', health: 'unavailable', availability: 'offline' },
    ...overrides,
  })
}

function revokedLocalDevice() {
  return localDevice({
    status: 'revoked',
    node: runtimeNode({ location: 'local_device', status: 'revoked', health: 'revoked' }),
    connection: { status: 'revoked', health: 'unavailable', availability: 'revoked' },
    compatibility: { state: 'revoked', limitations: [] },
  })
}

function cloudRuntime(runtimeConnectionId = 'rtc_01JABCDEF0123456789ABCDEFB') {
  return runtimeConnection(runtimeConnectionId, {
    family: 'managed-pi',
    connectionType: 'managed_cloud',
    location: 'agent_hq_cloud',
    node: runtimeNode({ location: 'agent_hq_cloud' }),
    access: {
      localProjectGrant: { required: false, state: 'not_required' },
      entitlement: { state: 'allowed' },
    },
  })
}
