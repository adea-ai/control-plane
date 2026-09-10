import { describe, expect, test } from 'bun:test'
import { evaluateRuntimeEligibility } from './index.ts'

const connectionId = 'rtc_01JABCDEF0123456789ABCDEFG'

function input(overrides = {}) {
  const base = {
    eligibilityVersion: 1,
    evaluatedAt: '2026-08-24T20:01:30.000Z',
    executionPlan: {
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      runtimeRequirements: [
        { capability: 'stream.output', necessity: 'required' },
        { capability: 'session.history', necessity: 'optional' },
      ],
    },
    candidate: {
      family: 'pi',
      nodeStatus: 'online',
      connection: {
        runtimeConnectionId: connectionId,
        identityDigest: `sha256:${'1'.repeat(64)}`,
        connectionType: 'managed_local',
        runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
        runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
        location: 'local_device',
        opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFG',
        adapterVersion: '1.0.0',
        driverVersion: '1.0.0',
        harnessVersion: '1.0.0',
        protocolVersion: '1.0.0',
        status: 'connected',
        health: 'healthy',
        availabilityState: 'healthy',
        capabilities: [{ name: 'stream.output', support: 'supported' }],
        capabilitySnapshotVersion: 1,
        capabilitySnapshotObservedAt: '2026-08-24T20:01:00.000Z',
        capabilitySnapshotExpiresAt: '2026-08-24T20:02:00.000Z',
        capabilityVerification: 'verified',
        compatibilityState: 'compatible',
        limitations: [],
        diagnostics: [],
        lastDiscoveredAt: '2026-08-24T20:01:00.000Z',
        lastHeartbeatAt: '2026-08-24T20:01:00.000Z',
        lastHealthCheckAt: '2026-08-24T20:01:00.000Z',
        version: 2,
        createdAt: '2026-08-24T20:00:00.000Z',
        updatedAt: '2026-08-24T20:01:00.000Z',
      },
    },
    policy: {
      snapshot: {
        policyId: 'workspace-standard',
        version: 3,
        digest: `sha256:${'b'.repeat(64)}`,
      },
      allowedFamilies: ['pi', 'acp'],
      allowedLocations: ['local_device'],
      deniedRuntimeConnectionIds: [],
      requireVerifiedCapabilities: true,
      security: { status: 'allowed' },
    },
    localProjectGrant: { required: true, status: 'granted', grantRef: 'grant:project-1' },
    entitlement: { status: 'allowed', class: 'workspace' },
    preference: { runtimeConnectionId: connectionId, family: 'pi' },
  }
  return { ...base, ...overrides }
}

describe('runtime eligibility', () => {
  test('reports optional capability absence as a degraded eligible decision', () => {
    const decision = evaluateRuntimeEligibility(input())

    expect(decision).toMatchObject({
      eligible: true,
      mode: 'degraded',
      reasons: [],
      degradations: [{ code: 'OPTIONAL_CAPABILITY_MISSING', capability: 'session.history' }],
      audit: {
        eligibilityVersion: 1,
        executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
        runtimeConnectionId: connectionId,
        policySnapshot: { policyId: 'workspace-standard', version: 3 },
      },
    })
    expect(decision.audit.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test('rejects missing and insufficient required capabilities', () => {
    const missing = evaluateRuntimeEligibility(
      input({
        executionPlan: {
          ...input().executionPlan,
          runtimeRequirements: [{ capability: 'tool.call', necessity: 'required' }],
        },
      })
    )
    const insufficient = evaluateRuntimeEligibility(
      input({
        candidate: {
          ...input().candidate,
          connection: {
            ...input().candidate.connection,
            capabilities: [{ name: 'stream.output', support: 'degraded' }],
          },
        },
        executionPlan: {
          ...input().executionPlan,
          runtimeRequirements: [{ capability: 'stream.output', necessity: 'required' }],
        },
      })
    )

    expect(missing).toMatchObject({
      eligible: false,
      reasons: [{ code: 'REQUIRED_CAPABILITY_MISSING', capability: 'tool.call' }],
    })
    expect(insufficient).toMatchObject({
      eligible: false,
      reasons: [{ code: 'REQUIRED_CAPABILITY_INSUFFICIENT', capability: 'stream.output' }],
    })
  })

  test('rejects offline, stale, revoked, incompatible, and unverified candidates', () => {
    const cases = [
      [{ nodeStatus: 'offline' }, 'RUNTIME_NODE_OFFLINE'],
      [
        { connection: { ...input().candidate.connection, availabilityState: 'stale' } },
        'RUNTIME_STALE',
      ],
      [
        {
          connection: {
            ...input().candidate.connection,
            status: 'revoked',
            health: 'unavailable',
            availabilityState: 'revoked',
            compatibilityState: 'revoked',
          },
        },
        'RUNTIME_REVOKED',
      ],
      [
        {
          connection: {
            ...input().candidate.connection,
            status: 'unavailable',
            health: 'unavailable',
            availabilityState: 'incompatible',
            compatibilityState: 'incompatible',
          },
        },
        'RUNTIME_INCOMPATIBLE',
      ],
      [
        {
          connection: { ...input().candidate.connection, capabilityVerification: 'unverified' },
        },
        'CAPABILITY_SNAPSHOT_UNVERIFIED',
      ],
    ]

    for (const [candidateOverride, reason] of cases) {
      const decision = evaluateRuntimeEligibility(
        input({ candidate: { ...input().candidate, ...candidateOverride } })
      )
      expect(decision.eligible).toBe(false)
      expect(decision.reasons.map(({ code }) => code)).toContain(reason)
    }
  })

  test('does not let a preference override policy, grant, security, or entitlement failures', () => {
    const decision = evaluateRuntimeEligibility(
      input({
        policy: {
          ...input().policy,
          allowedFamilies: ['acp'],
          deniedRuntimeConnectionIds: [connectionId],
          security: { status: 'denied', reasonCode: 'WORKSPACE_RUNTIME_BLOCKED' },
        },
        localProjectGrant: { required: true, status: 'revoked', grantRef: 'grant:project-1' },
        entitlement: { status: 'denied', class: 'workspace' },
      })
    )

    expect(decision.eligible).toBe(false)
    expect(decision.reasons.map(({ code }) => code)).toEqual([
      'ENTITLEMENT_DENIED',
      'LOCAL_PROJECT_GRANT_REVOKED',
      'RUNTIME_CONNECTION_POLICY_DENIED',
      'RUNTIME_FAMILY_POLICY_DENIED',
      'SECURITY_POLICY_DENIED',
    ])
  })

  test('is deterministic for equivalent unordered policy inputs', () => {
    const left = evaluateRuntimeEligibility(input())
    const right = evaluateRuntimeEligibility(
      input({
        policy: {
          ...input().policy,
          allowedFamilies: [...input().policy.allowedFamilies].toReversed(),
        },
      })
    )

    expect(right).toEqual(left)
  })

  test('supports managed-cloud candidates without inventing RuntimeNode health', () => {
    const localConnection = input().candidate.connection
    const managedConnection = {
      ...localConnection,
      runtimeNodeRefId: undefined,
      opaqueNativeRef: undefined,
    }
    const decision = evaluateRuntimeEligibility(
      input({
        candidate: {
          family: 'pi',
          nodeStatus: 'not_applicable',
          connection: {
            ...managedConnection,
            connectionType: 'managed_cloud',
            location: 'agent_hq_cloud',
          },
        },
        policy: { ...input().policy, allowedLocations: ['agent_hq_cloud'] },
        localProjectGrant: { required: false, status: 'not_required' },
      })
    )

    expect(decision).toMatchObject({ eligible: true, mode: 'degraded', reasons: [] })
  })
})
