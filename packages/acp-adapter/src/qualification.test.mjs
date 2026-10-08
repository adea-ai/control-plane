import { describe, expect, test } from 'bun:test'
import { pinnedAcpBuild } from './pinned-codex-build.ts'
import { ExecutorQualificationEvaluator } from './qualification.ts'

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
    configurationDigest: digest(harness === 'codex' ? 'c' : 'e'),
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

function evaluatorFor(harness, overrides = {}) {
  return new ExecutorQualificationEvaluator([evidence(harness, overrides)], now)
}

describe('executor qualification', () => {
  test('qualifies supported codex, opencode and claude routes only from matching evidence', () => {
    for (const harness of ['codex', 'opencode', 'claude']) {
      const result = evaluatorFor(harness).evaluate(observation(harness))
      expect(result.qualified).toBe(true)
      expect(result.failure).toBeNull()
      expect(result.capabilities).toEqual([
        'session.create',
        'stream.events',
        'stream.output',
        'tool.call',
      ])
      expect(result.governedNativePaths).toEqual(['mcp', 'shell'])
      expect(result.disabledGovernedNativePaths).toEqual([])
      expect(result.usageReporting).toBe(true)
    }
  })

  test('keeps resume, cancellation and usage claims disabled unless the evidence allow-lists them', () => {
    const result = evaluatorFor('codex').evaluate(observation('codex'))
    expect(result.capabilities).not.toContain('session.resume')
    expect(result.capabilities).not.toContain('execution.cancel')
    expect(result.usageReporting).toBe(true)

    const disabled = evaluatorFor('codex', {
      capabilities: ['session.create', 'stream.output'],
      usageReporting: false,
      governedPaths: [],
    }).evaluate(observation('codex', { nativePaths: [] }))
    expect(disabled.qualified).toBe(true)
    expect(disabled.capabilities).toEqual(['session.create', 'stream.output'])
    expect(disabled.capabilities).not.toContain('session.resume')
    expect(disabled.capabilities).not.toContain('execution.cancel')
    expect(disabled.usageReporting).toBe(false)
    expect(disabled.governedNativePaths).toEqual([])

    const allowed = evaluatorFor('codex', {
      capabilities: ['session.create', 'stream.output', 'session.resume', 'execution.cancel'],
    }).evaluate(observation('codex'))
    expect(allowed.capabilities).toContain('session.resume')
    expect(allowed.capabilities).toContain('execution.cancel')
  })

  test('version and configuration drift fail closed as mismatched evidence', () => {
    for (const drift of [
      { overrides: { harnessVersion: '9.99.9' }, field: 'harnessVersion' },
      { overrides: { configurationDigest: digest('d') }, field: 'configurationDigest' },
      {
        overrides: {
          nativeInstallation: { ...fixtureInstallations.opencode, commit: commit('2') },
        },
        field: 'nativeInstallation',
      },
      { overrides: { location: 'remote_host' }, field: 'location' },
    ]) {
      const result = evaluatorFor('opencode').evaluate(observation('opencode', drift.overrides))
      expect(result.qualified).toBe(false)
      expect(result.failure).toEqual({
        reason: 'evidence_mismatch',
        field: drift.field,
        detail: expect.any(String),
      })
      expect(result.capabilities).toEqual([])
      expect(result.governedNativePaths).toEqual([])
      expect(result.usageReporting).toBe(false)
    }
  })

  test('stale evidence fails closed as expired, including the exact expiry boundary', () => {
    const stale = evaluatorFor('codex', { validUntil: '2026-10-08T11:59:59.999Z' })
    const result = stale.evaluate(observation('codex'))
    expect(result.qualified).toBe(false)
    expect(result.failure).toEqual({
      reason: 'evidence_expired',
      expiredAt: '2026-10-08T11:59:59.999Z',
    })

    const boundary = new ExecutorQualificationEvaluator(
      [evidence('codex', { validUntil: NOW })],
      now
    ).evaluate(observation('codex'))
    expect(boundary.qualified).toBe(false)
    expect(boundary.failure?.reason).toBe('evidence_expired')
  })

  test('missing evidence fails closed with a typed reason per harness', () => {
    const result = new ExecutorQualificationEvaluator([], now).evaluate(observation('codex'))
    expect(result.qualified).toBe(false)
    expect(result.failure).toEqual({ reason: 'evidence_missing', harness: 'codex' })
    expect(result.capabilities).toEqual([])
    expect(result.usageReporting).toBe(false)
  })

  test('revoked evidence fails closed even while otherwise fresh', () => {
    const result = evaluatorFor('codex', {
      revokedAt: '2026-10-08T00:00:00.000Z',
      validUntil: '2026-10-07T00:00:00.000Z',
    }).evaluate(observation('codex'))
    expect(result.qualified).toBe(false)
    expect(result.failure).toEqual({
      reason: 'evidence_revoked',
      revokedAt: '2026-10-08T00:00:00.000Z',
    })
  })

  test('unsupported authentication modes fail closed on the executor and evidence side', () => {
    const cloudVault = evaluatorFor('codex').evaluate(
      observation('codex', { authentication: 'cloud_vault' })
    )
    expect(cloudVault.qualified).toBe(false)
    expect(cloudVault.failure).toEqual({
      reason: 'auth_unsupported',
      authentication: 'cloud_vault',
    })

    const delegated = evaluatorFor('codex', { authentication: 'delegated_session' }).evaluate(
      observation('codex', { authentication: 'delegated_session' })
    )
    expect(delegated.qualified).toBe(false)
    expect(delegated.failure?.reason).toBe('auth_unsupported')
  })

  test('unauthorized execution locations fail closed, including the cloud reroute path', () => {
    const cloud = evaluatorFor('codex').evaluate(
      observation('codex', { location: 'agent_hq_cloud' })
    )
    expect(cloud.qualified).toBe(false)
    expect(cloud.failure).toEqual({ reason: 'location_unauthorized', location: 'agent_hq_cloud' })

    const unauthorized = evaluatorFor('codex', { deploymentAuthorized: false }).evaluate(
      observation('codex')
    )
    expect(unauthorized.qualified).toBe(false)
    expect(unauthorized.failure).toEqual({
      reason: 'location_unauthorized',
      location: 'local_device',
    })
  })

  test('governed paths stay disabled when pre-effect policy enforcement is not evidenced', () => {
    const withoutControls = evaluatorFor('codex', {
      governedPaths: [{ path: 'shell', policyEnforced: false }],
    }).evaluate(observation('codex'))
    expect(withoutControls.qualified).toBe(true)
    expect(withoutControls.governedNativePaths).toEqual([])
    expect(withoutControls.disabledGovernedNativePaths).toEqual([
      { path: 'mcp', reason: 'not_evidenced' },
      { path: 'shell', reason: 'controls_missing' },
    ])

    const mixed = evaluatorFor('codex', {
      governedPaths: [
        { path: 'shell', policyEnforced: false },
        { path: 'mcp', policyEnforced: true },
      ],
    }).evaluate(observation('codex'))
    expect(mixed.governedNativePaths).toEqual(['mcp'])
    expect(mixed.disabledGovernedNativePaths).toEqual([
      { path: 'shell', reason: 'controls_missing' },
    ])
  })

  test('offline and revoked transport fail closed locally and never suggest a cloud reroute', () => {
    for (const transport of ['offline', 'revoked']) {
      const reason = transport === 'offline' ? 'transport_offline' : 'transport_revoked'
      // Denial happens before evidence is even consulted: nothing qualified exists to reroute.
      const bare = new ExecutorQualificationEvaluator([], now).evaluate(
        observation('codex', { transport })
      )
      expect(bare.qualified).toBe(false)
      expect(bare.failure).toEqual({ reason, fallback: 'none' })
      expect(bare.capabilities).toEqual([])
      expect(bare.governedNativePaths).toEqual([])
      expect(bare.usageReporting).toBe(false)

      const qualified = evaluatorFor('codex').evaluate(observation('codex', { transport }))
      expect(qualified.qualified).toBe(false)
      expect(qualified.failure).toEqual({ reason, fallback: 'none' })
      expect(JSON.stringify(qualified)).not.toMatch(/cloud|reroute/i)
    }
  })

  test('fixture evidence cannot activate production capabilities', () => {
    // Obviously-fake codex installation never matches the pinned production build.
    const fakeCodex = evaluatorFor('codex', {
      nativeInstallation: {
        repository: 'https://fixture.invalid/codex-acp.git',
        tag: 'v0.0.0-fixture',
        commit: commit('0'),
        bundleSha256: digest('0'),
      },
    }).evaluate(
      observation('codex', {
        nativeInstallation: {
          repository: 'https://fixture.invalid/codex-acp.git',
          tag: 'v0.0.0-fixture',
          commit: commit('0'),
          bundleSha256: digest('0'),
        },
      })
    )
    expect(fakeCodex.qualified).toBe(false)
    expect(fakeCodex.failure).toEqual({
      reason: 'evidence_mismatch',
      field: 'deploymentPin',
      detail: 'DEPLOYMENT_PIN_CHANGED',
    })
    expect(fakeCodex.capabilities).toEqual([])

    // Evidence has no credential fields and rejects unknown keys, so
    // credentials cannot enter, store, or return through the evaluator.
    expect(
      () =>
        new ExecutorQualificationEvaluator([evidence('codex', { apiKey: 'fixture-secret' })], now)
    ).toThrow()
    const serialized = JSON.stringify(evaluatorFor('codex').evaluate(observation('codex')))
    expect(serialized).not.toMatch(/secret|apikey|token|password/i)
  })

  test('unqualifiable harnesses and malformed observations fail closed as invalid evidence', () => {
    // Pi is not a supported ACP route and can never be qualified here.
    for (const malformed of [
      observation('pi'),
      observation('codex', { harnessVersion: 'not-a-version' }),
      observation('codex', { transport: 'degraded' }),
      observation('codex', { nativeInstallation: { ...pinnedCodexInstallation, commit: 'zz' } }),
      null,
    ]) {
      const result = evaluatorFor('codex').evaluate(malformed)
      expect(result.qualified).toBe(false)
      expect(result.failure?.reason).toBe('evidence_invalid')
      expect(result.capabilities).toEqual([])
    }
  })
})
