import { describe, expect, test } from 'bun:test'
import { ExecutorQualificationEvaluator } from './qualification.ts'
import { NativeRouteGate, mapNativeTransportState } from './native-route-gate.ts'
import { normalizeSnapshot } from './acp-helpers.ts'
import { pinnedAcpBuild } from './pinned-codex-build.ts'

// Deterministic clock; no sleeps, no network, no harness spawns, no credentials.
const NOW = '2026-10-08T12:00:00.000Z'
const now = () => NOW
const validUntil = '2026-10-09T12:00:00.000Z'
const digest = (character) => character.repeat(64)
const commit = (character) => character.repeat(40)

// The codex route anchors to the pinned ACP build from this package; every other
// fixture installation is obviously fake so test evidence can never be mistaken
// for production evidence.
const fixtureInstallation = {
  repository: 'https://fixture.invalid/opencode-acp.git',
  tag: 'v0.0.0-fixture',
  commit: commit('0'),
  bundleSha256: digest('0'),
}

function evidence(overrides = {}) {
  return {
    harness: 'opencode',
    harnessVersion: '1.0.0',
    location: 'local_device',
    authentication: 'native_owned',
    deploymentAuthorized: true,
    nativeInstallation: fixtureInstallation,
    configurationDigest: digest('c'),
    capabilities: ['session.create', 'stream.output', 'stream.events', 'tool.call'],
    usageReporting: true,
    governedPaths: [
      { path: 'shell', policyEnforced: true },
      { path: 'mcp', policyEnforced: true },
    ],
    validUntil,
    ...overrides,
  }
}

function observation(overrides = {}) {
  const record = evidence()
  return {
    harness: 'opencode',
    harnessVersion: record.harnessVersion,
    location: record.location,
    authentication: record.authentication,
    nativeInstallation: record.nativeInstallation,
    configurationDigest: record.configurationDigest,
    transport: 'online',
    nativePaths: ['shell', 'mcp'],
    ...overrides,
  }
}

function gateFor(recordOverrides = {}, observationOverrides = {}) {
  return new NativeRouteGate({
    evaluator: new ExecutorQualificationEvaluator([evidence(recordOverrides)], now),
    observation: observation(observationOverrides),
  })
}

const allowedPolicy = { policyEnforced: true, allowed: true }
const deniedPolicy = { policyEnforced: true, allowed: false }
const unenforcedPolicy = { policyEnforced: false, allowed: true }

describe('native route gate', () => {
  test('advertises exactly the evidenced capability allow-list', () => {
    const gate = gateFor()
    expect(gate.qualified).toBe(true)
    expect(gate.capabilities).toEqual([
      'session.create',
      'stream.events',
      'stream.output',
      'tool.call',
    ])
    expect(gate.supports('session.create')).toBe(true)
    expect(gate.supports('session.resume')).toBe(false)
    expect(gate.supports('execution.cancel')).toBe(false)
  })

  test('keeps unsupported resume, cancellation and usage claims disabled', () => {
    const gate = gateFor({
      capabilities: ['session.create', 'session.resume', 'execution.cancel'],
      usageReporting: false,
    })
    expect(gate.capabilities).toEqual(['execution.cancel', 'session.create', 'session.resume'])
    expect(gate.usageReporting).toBe(false)
  })

  test('an unqualified route disables every capability, usage claim and governed path', () => {
    const gate = new NativeRouteGate({
      evaluator: new ExecutorQualificationEvaluator([], now),
      observation: observation(),
    })
    expect(gate.qualified).toBe(false)
    expect(gate.failure).toMatchObject({ reason: 'evidence_missing' })
    expect(gate.capabilities).toEqual([])
    expect(gate.usageReporting).toBe(false)
    expect(gate.governedNativePaths).toEqual([])
    expect(gate.authorizeNativeEffect('shell', allowedPolicy)).toMatchObject({
      allowed: false,
      reason: 'route_unqualified',
    })
  })

  test('drifted native configuration fails the route closed', () => {
    const gate = gateFor({}, { configurationDigest: digest('d') })
    expect(gate.qualified).toBe(false)
    expect(gate.failure).toMatchObject({
      reason: 'evidence_mismatch',
      field: 'configurationDigest',
    })
    expect(gate.capabilities).toEqual([])
  })

  test('usage reporting is opt-in evidence and never defaults on', () => {
    expect(gateFor({ usageReporting: false }).usageReporting).toBe(false)
    expect(gateFor({ usageReporting: true }).usageReporting).toBe(true)
  })

  test('governed native effects require an evidenced, policy-enforced channel', () => {
    const gate = gateFor()
    expect(gate.governedNativePaths).toEqual(['mcp', 'shell'])
    expect(gate.authorizeNativeEffect('shell', allowedPolicy)).toMatchObject({ allowed: true })
    expect(gate.authorizeNativeEffect('mcp', allowedPolicy)).toMatchObject({ allowed: true })
  })

  test('unevidenced and unenforced governed native effects are refused with reasons', () => {
    const gate = gateFor()
    expect(gate.authorizeNativeEffect('network', allowedPolicy)).toMatchObject({
      allowed: false,
      reason: 'not_evidenced',
    })
    expect(gate.authorizeNativeEffect('hooks', allowedPolicy)).toMatchObject({
      allowed: false,
      reason: 'not_evidenced',
    })
    expect(gate.authorizeNativeEffect('extensions', allowedPolicy)).toMatchObject({
      allowed: false,
      reason: 'not_evidenced',
    })
    const unenforced = gateFor({
      governedPaths: [{ path: 'shell', policyEnforced: false }],
    })
    expect(unenforced.governedNativePaths).toEqual([])
    expect(unenforced.authorizeNativeEffect('shell', allowedPolicy)).toMatchObject({
      allowed: false,
      reason: 'controls_missing',
    })
  })

  test('a governed effect is refused unless the per-effect policy allowed it', () => {
    const gate = gateFor()
    expect(gate.authorizeNativeEffect('shell', deniedPolicy)).toMatchObject({
      allowed: false,
      reason: 'effect_policy_denied',
    })
    expect(gate.authorizeNativeEffect('shell', unenforcedPolicy)).toMatchObject({
      allowed: false,
      reason: 'effect_policy_denied',
    })
  })

  test('offline and revoked transports are local denials that never suggest a reroute', () => {
    expect(mapNativeTransportState('online')).toBe('online')
    expect(mapNativeTransportState('offline')).toBe('offline')
    expect(mapNativeTransportState('revoked')).toBe('revoked')
    for (const transport of ['offline', 'revoked']) {
      const gate = gateFor({}, { transport })
      expect(gate.qualified).toBe(false)
      expect(gate.failure).toMatchObject({
        reason: transport === 'offline' ? 'transport_offline' : 'transport_revoked',
        fallback: 'none',
      })
      expect(gate.capabilities).toEqual([])
    }
  })

  test('an unauthorized deployment location never qualifies the route', () => {
    const gate = gateFor({ deploymentAuthorized: false })
    expect(gate.qualified).toBe(false)
    expect(gate.failure).toMatchObject({ reason: 'location_unauthorized' })
    expect(gate.capabilities).toEqual([])
  })

  test('cloud authentication never qualifies a native executor route', () => {
    const gate = gateFor({ authentication: 'cloud_vault' }, { authentication: 'cloud_vault' })
    expect(gate.qualified).toBe(false)
    expect(gate.failure).toMatchObject({ reason: 'auth_unsupported' })
  })

  test('the codex route still requires the pinned ACP build', () => {
    const pinnedInstallation = {
      repository: pinnedAcpBuild.repository,
      tag: pinnedAcpBuild.tag,
      commit: pinnedAcpBuild.commit,
      bundleSha256: pinnedAcpBuild.bundleSha256,
    }
    const qualified = new NativeRouteGate({
      evaluator: new ExecutorQualificationEvaluator(
        [
          evidence({
            harness: 'codex',
            harnessVersion: pinnedAcpBuild.codexVersion,
            nativeInstallation: pinnedInstallation,
          }),
        ],
        now
      ),
      observation: observation({
        harness: 'codex',
        harnessVersion: pinnedAcpBuild.codexVersion,
        nativeInstallation: pinnedInstallation,
      }),
    })
    expect(qualified.qualified).toBe(true)
    const unpinned = new NativeRouteGate({
      evaluator: new ExecutorQualificationEvaluator(
        [evidence({ harness: 'codex', harnessVersion: '9.9.9' })],
        now
      ),
      observation: observation({ harness: 'codex', harnessVersion: '9.9.9' }),
    })
    expect(unpinned.qualified).toBe(false)
    expect(unpinned.failure).toMatchObject({ reason: 'evidence_mismatch', field: 'deploymentPin' })
  })
})

describe('native route gate driver wiring', () => {
  const handle = {
    handleId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    startedAt: NOW,
  }

  test('usage is dropped from a status when the route does not report usage', () => {
    const snapshot = {
      state: 'completed',
      observedAt: NOW,
      output: { saved: true },
      artifacts: [],
      usage: { inputTokens: 10, outputTokens: 5, durationMs: 42 },
    }
    // `result.usage` is a mandatory part of the completed execution result
    // contract, not a route claim: an unauthorized route cannot complete an
    // execution at all because the capability gate leaves it with none.
    const withUsage = normalizeSnapshot(handle, snapshot, true)
    expect(withUsage.result).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5 } })
    expect(normalizeSnapshot(handle, snapshot, false).result).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  test('terminal usage is dropped from a cancelled status when usage is not reported', () => {
    const snapshot = {
      state: 'cancelled',
      observedAt: NOW,
      usage: { inputTokens: 3, outputTokens: 1, durationMs: 7 },
    }
    expect(normalizeSnapshot(handle, snapshot, true)).toHaveProperty('terminalUsage')
    expect(normalizeSnapshot(handle, snapshot, false)).not.toHaveProperty('terminalUsage')
  })
})
