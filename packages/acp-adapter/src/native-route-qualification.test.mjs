import { describe, expect, test } from 'bun:test'
import { pinnedAcpBuild } from './pinned-codex-build.ts'
import { ExecutorQualificationEvaluator } from './qualification.ts'
import {
  NativeRouteDeniedError,
  QualifiedNativeRoute,
  observationTransportFromConnectionState,
} from './native-route-qualification.ts'

// Deterministic clock; no sleeps, no network, no harness spawns, no credentials.
const NOW = '2026-10-08T12:00:00.000Z'
const now = () => NOW
const validUntil = '2026-10-09T12:00:00.000Z'
const digest = (character) => character.repeat(64)
const commit = (character) => character.repeat(40)

// The codex route anchors to the pinned ACP build from this package.
const pinnedCodexInstallation = {
  repository: pinnedAcpBuild.repository,
  tag: pinnedAcpBuild.tag,
  commit: pinnedAcpBuild.commit,
  bundleSha256: pinnedAcpBuild.bundleSha256,
}

// Every fixture installation uses obviously-fake values (.invalid, zero/one
// digests) so test evidence can never be mistaken for production evidence.
const fixtureInstallations = {
  opencode: {
    repository: 'https://fixture.invalid/opencode-acp.git',
    tag: 'v0.0.0-fixture',
    commit: commit('0'),
    bundleSha256: digest('0'),
  },
  claude: {
    repository: 'https://fixture.invalid/claude-acp.git',
    tag: 'v0.0.0-fixture',
    commit: commit('1'),
    bundleSha256: digest('1'),
  },
}

function evidence(harness, overrides = {}) {
  const nativeInstallation =
    harness === 'codex' ? pinnedCodexInstallation : fixtureInstallations[harness]
  return {
    harness,
    harnessVersion: harness === 'codex' ? pinnedAcpBuild.codexVersion : '1.0.0',
    location: 'local_device',
    authentication: 'native_owned',
    deploymentAuthorized: true,
    nativeInstallation,
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

function observation(harness, overrides = {}) {
  const record = evidence(harness)
  return {
    harness,
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

/** A qualified route over the given evidence and observation. */
function route(records, observed) {
  return new QualifiedNativeRoute({
    evaluator: new ExecutorQualificationEvaluator(records, now),
    observation: () => observed,
  })
}

describe('qualified native route (M13.03, #1021)', () => {
  test('advertises exactly the qualified allow-list and nothing else', () => {
    const qualified = route([evidence('opencode')], observation('opencode'))
    expect(qualified.evaluate().qualified).toBe(true)
    expect(qualified.advertisedCapabilities()).toEqual([
      'session.create',
      'stream.events',
      'stream.output',
      'tool.call',
    ])
    // Resume, cancellation and every other claim the allow-list omits stay
    // disabled, and claiming them is refused rather than assumed.
    expect(() => qualified.assertCapabilityAllowed('session.resume')).toThrow(
      NativeRouteDeniedError
    )
    expect(() => qualified.assertCapabilityAllowed('execution.cancel')).toThrow(
      NativeRouteDeniedError
    )
    qualified.assertCapabilityAllowed('session.create')
  })

  test('an allow-listed resume or cancellation claim is permitted', () => {
    const qualified = route(
      [
        evidence('opencode', {
          capabilities: ['session.create', 'session.resume', 'execution.cancel'],
        }),
      ],
      observation('opencode')
    )
    qualified.assertCapabilityAllowed('session.resume')
    qualified.assertCapabilityAllowed('execution.cancel')
    expect(qualified.advertisedCapabilities()).toContain('session.resume')
  })

  test('an unqualified route advertises nothing and refuses every claim locally', () => {
    const unqualified = route([], observation('opencode'))
    expect(unqualified.evaluate().qualified).toBe(false)
    expect(unqualified.advertisedCapabilities()).toEqual([])
    expect(unqualified.usageReportingEnabled()).toBe(false)
    let denial
    try {
      unqualified.assertCapabilityAllowed('session.resume')
    } catch (error) {
      denial = error
    }
    expect(denial).toBeInstanceOf(NativeRouteDeniedError)
    const refused = denial
    // A local denial: it names the fence and never offers another route.
    expect(refused.fallback).toBe('none')
    expect(refused.retryable).toBe(false)
    expect(refused.classification).toBe('unsupported')
    expect(refused.failure?.reason).toBe('evidence_missing')
  })

  test('an offline device is a local denial and never a fallback route', () => {
    const offline = route([evidence('opencode')], observation('opencode', { transport: 'offline' }))
    expect(offline.evaluate().failure?.reason).toBe('transport_offline')
    expect(offline.advertisedCapabilities()).toEqual([])
    let denial
    try {
      offline.assertCapabilityAllowed('session.create')
    } catch (error) {
      denial = error
    }
    const refused = denial
    expect(refused.fallback).toBe('none')
    expect(refused.retryable).toBe(false)
    // An offline device is unavailable, not unsupported, and still not a route.
    expect(refused.classification).toBe('unavailable')
  })

  test('a revoked device is a local denial', () => {
    const revoked = route([evidence('opencode')], observation('opencode', { transport: 'revoked' }))
    expect(revoked.evaluate().failure?.reason).toBe('transport_revoked')
    expect(revoked.advertisedCapabilities()).toEqual([])
  })

  test('a changed native configuration is detected and denies the route', () => {
    const changed = route(
      [evidence('opencode')],
      observation('opencode', { configurationDigest: digest('d') })
    )
    const failure = changed.evaluate().failure
    expect(failure?.reason).toBe('evidence_mismatch')
    expect(failure).toMatchObject({ field: 'configurationDigest' })
    expect(changed.advertisedCapabilities()).toEqual([])
  })

  test('a route outside the deployment authorization is refused', () => {
    const unauthorized = route(
      [evidence('opencode', { deploymentAuthorized: false })],
      observation('opencode')
    )
    expect(unauthorized.evaluate().failure?.reason).toBe('location_unauthorized')
    expect(unauthorized.advertisedCapabilities()).toEqual([])
  })

  test('the cloud location never qualifies a native executor route', () => {
    const cloud = route(
      [evidence('opencode', { location: 'agent_hq_cloud' })],
      observation('opencode', { location: 'agent_hq_cloud' })
    )
    expect(cloud.evaluate().failure?.reason).toBe('location_unauthorized')
  })

  test('only executor-owned credentials qualify a native route', () => {
    for (const authentication of ['cloud_vault', 'delegated_session']) {
      const vault = route(
        [evidence('opencode', { authentication })],
        observation('opencode', { authentication })
      )
      expect(vault.evaluate().failure?.reason).toBe('auth_unsupported')
      expect(vault.advertisedCapabilities()).toEqual([])
    }
  })

  test('usage is reported only when the evidence opts in', () => {
    const reporting = route([evidence('opencode')], observation('opencode'))
    expect(reporting.usageReportingEnabled()).toBe(true)
    const silent = route([evidence('opencode', { usageReporting: false })], observation('opencode'))
    expect(silent.usageReportingEnabled()).toBe(false)
  })

  test('a governed native path is open only with proven pre-effect policy', () => {
    const qualified = route([evidence('opencode')], observation('opencode'))
    expect(qualified.governedPathDecision('shell')).toEqual({ allowed: true, path: 'shell' })
    expect(qualified.governedPathDecision('mcp')).toEqual({ allowed: true, path: 'mcp' })
    // Observed but not evidenced: closed.
    expect(qualified.governedPathDecision('network')).toEqual({
      allowed: false,
      path: 'network',
      reason: 'not_evidenced',
    })
    qualified.assertGovernedPathAllowed('shell')
    expect(() => qualified.assertGovernedPathAllowed('network')).toThrow(NativeRouteDeniedError)
  })

  test('a governed path without proven pre-effect policy stays closed', () => {
    const uncontrolled = route(
      [
        evidence('opencode', {
          governedPaths: [
            { path: 'shell', policyEnforced: false },
            { path: 'mcp', policyEnforced: true },
          ],
        }),
      ],
      observation('opencode')
    )
    expect(uncontrolled.governedPathDecision('shell')).toEqual({
      allowed: false,
      path: 'shell',
      reason: 'controls_missing',
    })
    expect(uncontrolled.governedPathDecision('mcp')).toEqual({ allowed: true, path: 'mcp' })
    expect(() => uncontrolled.assertGovernedPathAllowed('shell')).toThrow(NativeRouteDeniedError)
  })

  test('Pi is not a qualifiable native harness', () => {
    // Pi dispatch is not native checkpointing or subscription entitlement, so
    // no deployment evidence can qualify a Pi route.
    expect(() => new ExecutorQualificationEvaluator([evidence('pi')], now)).toThrow()
  })

  test('the codex route must match the pinned ACP build', () => {
    const qualified = route([evidence('codex')], observation('codex'))
    expect(qualified.evaluate().qualified).toBe(true)
    const drifted = route(
      [evidence('codex')],
      observation('codex', {
        nativeInstallation: { ...pinnedCodexInstallation, commit: commit('9') },
      })
    )
    expect(drifted.evaluate().failure).toMatchObject({ reason: 'evidence_mismatch' })
  })

  test('the transport mapping never turns an absent device into a route', () => {
    expect(observationTransportFromConnectionState('online')).toBe('online')
    expect(observationTransportFromConnectionState('offline')).toBe('offline')
    expect(observationTransportFromConnectionState('revoked')).toBe('revoked')
  })
})
