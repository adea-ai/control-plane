import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  RuntimeCompatibilityMatrixSchema,
  applyRuntimeCompatibilityCertification,
  evaluateRuntimeEligibility,
  projectRuntimeConnectionDiscovery,
} from './index.ts'

const matrixUrl = new URL(
  '../../../docs/runtime-compatibility/runtime-certifications.v1.json',
  import.meta.url
)

async function matrix() {
  return RuntimeCompatibilityMatrixSchema.parse(JSON.parse(await readFile(matrixUrl, 'utf8')))
}

describe('runtime compatibility certification', () => {
  test('validates exact managed Pi and ACP transport certification evidence', async () => {
    const parsed = await matrix()

    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.classifications).toEqual([
      'supported',
      'preview',
      'degraded',
      'incompatible',
      'revoked',
      'untested',
    ])
    expect(
      parsed.certifications
        .map(({ runtimeFamily, versions }) => `${runtimeFamily}:${versions.protocol}`)
        .sort()
    ).toEqual(['acp:1.5.0', 'acp:1.6.0', 'pi:1.5.0', 'pi:1.6.0'])
    for (const certification of parsed.certifications) {
      expect(certification.classification).toBe('supported')
      expect(certification.verifiedCapabilities.length).toBeGreaterThan(0)
      expect(certification.evidence.map(({ suite }) => suite)).toContain(
        'runtime-adapter-conformance'
      )
      expect(certification.evidence.map(({ suite }) => suite)).toContain(
        'direct-local-transport-integration'
      )
      expect(certification.evidence.map(({ suite }) => suite)).toContain(
        'runtime-gateway-integration'
      )
    }
  })

  test('certifies only an exact version and platform combination', async () => {
    const supported = applyRuntimeCompatibilityCertification({
      matrix: await matrix(),
      runtimeFamily: 'pi',
      connection: connection(),
    })
    const upgraded = applyRuntimeCompatibilityCertification({
      matrix: await matrix(),
      runtimeFamily: 'pi',
      connection: connection({ adapterVersion: '1.0.1' }),
    })
    const decision = evaluateRuntimeEligibility(eligibilityInput(upgraded))

    expect(supported).toMatchObject({
      compatibilityState: 'compatible',
      health: 'healthy',
      status: 'connected',
    })
    expect(upgraded).toMatchObject({
      compatibilityState: 'untested',
      health: 'degraded',
      status: 'degraded',
    })
    expect(upgraded.limitations).toContain('COMPATIBILITY_UNTESTED')
    expect(decision).toMatchObject({
      eligible: true,
      mode: 'degraded',
      degradations: expect.arrayContaining([{ code: 'COMPATIBILITY_UNTESTED' }]),
    })
  })

  test('does not retain capability claims beyond passing certification evidence', async () => {
    const certified = applyRuntimeCompatibilityCertification({
      matrix: await matrix(),
      runtimeFamily: 'pi',
      connection: connection({
        capabilities: [
          ...connection().capabilities,
          { name: 'session.history', support: 'supported' },
        ],
      }),
    })
    const missing = applyRuntimeCompatibilityCertification({
      matrix: await matrix(),
      runtimeFamily: 'pi',
      connection: connection({ capabilities: [{ name: 'stream.output', support: 'supported' }] }),
    })

    expect(certified).toMatchObject({
      compatibilityState: 'degraded',
      health: 'degraded',
    })
    expect(certified.capabilities.find(({ name }) => name === 'session.history')).toEqual({
      name: 'session.history',
      support: 'unsupported',
      limitations: ['UNCERTIFIED_CAPABILITY'],
    })
    expect(missing).toMatchObject({
      compatibilityState: 'capability_missing',
      health: 'unavailable',
      status: 'unavailable',
      limitations: expect.arrayContaining(['CERTIFIED_CAPABILITY_MISSING']),
    })
  })

  test('feeds incompatible and revoked certification into health, eligibility, and read models', async () => {
    const base = await matrix()
    const certification = base.certifications.find(
      ({ certificationId }) => certificationId === 'managed-pi-reference-1-0-0'
    )
    const incompatible = applyRuntimeCompatibilityCertification({
      matrix: {
        ...base,
        certifications: [{ ...certification, classification: 'incompatible' }],
      },
      runtimeFamily: certification.runtimeFamily,
      connection: connection(),
    })
    const revoked = applyRuntimeCompatibilityCertification({
      matrix: {
        ...base,
        certifications: [{ ...certification, classification: 'revoked' }],
      },
      runtimeFamily: certification.runtimeFamily,
      connection: connection(),
    })

    expect(evaluateRuntimeEligibility(eligibilityInput(incompatible))).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([{ code: 'RUNTIME_INCOMPATIBLE' }]),
    })
    expect(revoked).toMatchObject({
      compatibilityState: 'revoked',
      availabilityState: 'revoked',
      status: 'revoked',
      health: 'unavailable',
    })
    const model = projectRuntimeConnectionDiscovery({
      connection: incompatible,
      family: 'pi',
      node: {
        runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
        authority: 'agent_hq',
        displayName: 'Reference node',
        location: 'local_device',
        status: 'online',
        observedAt: '2026-08-25T12:00:00.000Z',
      },
      nodeHealth: 'online',
      evaluatedAt: '2026-08-25T12:00:30.000Z',
      localProjectGrant: { required: true, state: 'granted' },
      entitlement: { state: 'allowed', class: 'test' },
    })
    expect(model.compatibility.limitations).toEqual(
      expect.arrayContaining(['CERTIFICATION_INCOMPATIBLE'])
    )
  })
})

function connection(overrides = {}) {
  return {
    runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
    identityDigest: `sha256:${'1'.repeat(64)}`,
    connectionType: 'managed_local',
    runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    location: 'local_device',
    opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFG',
    adapterVersion: '1.0.0',
    driverVersion: '1.0.0',
    harnessVersion: '0.52.1',
    protocolVersion: '1.5.0',
    status: 'connected',
    health: 'healthy',
    availabilityState: 'healthy',
    capabilities: [
      { name: 'execution.cancel', support: 'supported' },
      { name: 'interaction.approval', support: 'supported' },
      { name: 'interaction.user-input', support: 'supported' },
      { name: 'stream.events', support: 'supported' },
      { name: 'stream.output', support: 'supported' },
      { name: 'tool.call', support: 'supported' },
    ],
    capabilitySnapshotVersion: 1,
    capabilitySnapshotObservedAt: '2026-08-25T12:00:00.000Z',
    capabilitySnapshotExpiresAt: '2026-08-25T12:01:00.000Z',
    capabilityVerification: 'verified',
    compatibilityState: 'untested',
    limitations: [],
    diagnostics: [],
    lastDiscoveredAt: '2026-08-25T12:00:00.000Z',
    lastHeartbeatAt: '2026-08-25T12:00:00.000Z',
    lastHealthCheckAt: '2026-08-25T12:00:00.000Z',
    version: 1,
    createdAt: '2026-08-25T12:00:00.000Z',
    updatedAt: '2026-08-25T12:00:00.000Z',
    ...overrides,
  }
}

function eligibilityInput(candidate) {
  return {
    eligibilityVersion: 1,
    evaluatedAt: '2026-08-25T12:00:30.000Z',
    executionPlan: {
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      runtimeRequirements: [{ capability: 'stream.output', necessity: 'required' }],
    },
    candidate: { family: 'pi', nodeStatus: 'online', connection: candidate },
    policy: {
      snapshot: { policyId: 'certification', version: 1, digest: `sha256:${'b'.repeat(64)}` },
      allowedFamilies: ['pi'],
      allowedLocations: ['local_device'],
      deniedRuntimeConnectionIds: [],
      requireVerifiedCapabilities: true,
      security: { status: 'allowed' },
    },
    localProjectGrant: { required: true, status: 'granted', grantRef: 'grant:test' },
    entitlement: { status: 'allowed', class: 'test' },
  }
}
