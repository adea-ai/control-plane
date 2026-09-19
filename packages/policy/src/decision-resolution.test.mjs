import { describe, expect, test } from 'bun:test'
import { resolveDecisionLayer, DecisionResolutionDeniedError } from './index.ts'

const ids = {
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  runtimeLocal: 'rtd_01JABCDEF0123456789ABCDEFG',
  runtimeRemote: 'rtd_01JABCDEF0123456789BBCDEFG',
}

const baseRequest = () => ({
  contractVersion: { major: 1, minor: 0 },
  caller: { servicePrincipalId: 'svc_agent-hq' },
  requestId: ids.requestId,
  workspaceId: ids.workspaceId,
  correlation: { traceId: 'trc_01JABCDEF0123456789ABCDEFG' },
  requestedAt: '2026-09-19T00:00:00.000Z',
  objective: 'Fix the flaky sort-order test in the table view.',
  agentProfile: { profileId: ids.profileId },
  availableRuntimes: [
    {
      runtimeDefinitionId: ids.runtimeLocal,
      kind: 'local',
      transport: 'direct-local',
      harnessIds: ['managed-pi', 'claude-code'],
      capabilities: ['shell.exec', 'fs.read'],
    },
    {
      runtimeDefinitionId: ids.runtimeRemote,
      kind: 'self-hosted',
      transport: 'remote-gateway',
      harnessIds: ['managed-pi'],
      capabilities: ['shell.exec'],
    },
  ],
  entitlements: {
    modelAccess: 'byok',
    grantedCapabilityNames: ['shell.exec', 'fs.read', 'net.denied'],
  },
  requiredCapabilities: ['shell.exec'],
  costLatencyPreference: 'balanced',
  projectDefaults: {},
  profileDefaults: {},
  explicitPins: {},
})

const noPins = () => ({ harness: undefined, model: undefined, skills: undefined, capabilities: undefined, runtime: undefined, sandbox: undefined, contextPackage: undefined, delegation: undefined })

describe('decision-layer resolution (#558)', () => {
  test('resolves all eight outputs with policy defaults and local-runtime preference', () => {
    const resolution = resolveDecisionLayer(baseRequest(), {
      model: { modelId: 'pi/sol-1' },
    })
    expect(resolution.resolution.harness.harnessId).toBe('managed-pi')
    expect(resolution.resolution.model).toEqual({ modelId: 'pi/sol-1' })
    expect(resolution.resolution.runtime.runtimeDefinitionId).toBe(ids.runtimeLocal)
    expect(resolution.resolution.capabilities.capabilityNames).toEqual(['shell.exec'])
    expect(resolution.resolution.sandbox).toEqual({
      mode: 'managed',
      effectiveCapabilities: ['shell.exec'],
    })
    expect(resolution.resolution.contextPackage).toEqual({ mode: 'none' })
    expect(resolution.resolution.delegation).toEqual({ fanOut: 'none', promotion: 'review-required' })
    expect(resolution.diagnostics).toEqual([])
    expect(resolution.resolutionDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(resolution.trace.harness.source).toBe('policy-default')
  })

  test('precedence: explicit pin beats project default beats profile default beats policy default', () => {
    const request = {
      ...baseRequest(),
      projectDefaults: { harness: { harnessId: 'claude-code' } },
      profileDefaults: { harness: { harnessId: 'managed-pi' } },
      explicitPins: { harness: { harnessId: 'claude-code' } },
    }
    const resolution = resolveDecisionLayer(request, {})
    expect(resolution.resolution.harness.harnessId).toBe('claude-code')
    expect(resolution.trace.harness.source).toBe('explicit-pin')

    const noPin = { ...baseRequest(), profileDefaults: { harness: { harnessId: 'claude-code' } } }
    const viaProfile = resolveDecisionLayer(noPin, {})
    expect(viaProfile.trace.harness.source).toBe('profile-default')

    const noProfile = { ...baseRequest(), projectDefaults: { harness: { harnessId: 'claude-code' } } }
    const viaProject = resolveDecisionLayer(noProfile, {})
    expect(viaProject.trace.harness.source).toBe('project-default')
  })

  test('skill pins resolve through every layer and default to empty', () => {
    const pinned = resolveDecisionLayer(
      {
        ...baseRequest(),
        explicitPins: { skills: { skillVersionIds: [ids.skillVersionId] } },
      },
      {},
    )
    expect(pinned.resolution.skills.skillVersionIds).toEqual([ids.skillVersionId])
    expect(pinned.trace.skills.source).toBe('explicit-pin')
    expect(resolveDecisionLayer(baseRequest(), {}).resolution.skills.skillVersionIds).toEqual([])
  })

  test('runtime pin to an unavailable runtime denies UNSUPPORTED_RUNTIME_PIN', () => {
    expect(() =>
      resolveDecisionLayer(
        {
          ...baseRequest(),
          explicitPins: { runtime: { runtimeDefinitionId: 'rtd_01JABCDEF0123456789XYZDEFG' } },
        },
        {},
      ),
    ).toThrow((error) => error instanceof DecisionResolutionDeniedError && error.code === 'UNSUPPORTED_RUNTIME_PIN')
  })

  test('harness pin unavailable on the selected runtime denies', () => {
    // claude-code exists only on the local runtime; pin the remote runtime.
    expect(() =>
      resolveDecisionLayer(
        {
          ...baseRequest(),
          explicitPins: {
            runtime: { runtimeDefinitionId: ids.runtimeRemote },
            harness: { harnessId: 'claude-code' },
          },
        },
        {},
      ),
    ).toThrow((error) => error instanceof DecisionResolutionDeniedError && error.code === 'HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME')
  })

  test('model pin without entitlement denies; unentitled without pin withholds', () => {
    const unentitled = { ...baseRequest(), entitlements: { modelAccess: 'none', grantedCapabilityNames: ['shell.exec'] } }
    expect(() =>
      resolveDecisionLayer(
        { ...unentitled, explicitPins: { model: { modelId: 'pi/sol-1' } } },
        {},
      ),
    ).toThrow((error) => error instanceof DecisionResolutionDeniedError && error.code === 'MODEL_ACCESS_NOT_ENTITLED')
    const withheld = resolveDecisionLayer(unentitled, {})
    expect(withheld.resolution.model).toEqual({ withheld: 'MODEL_ACCESS_NOT_ENTITLED' })
    expect(withheld.diagnostics).toEqual(['MODEL_ACCESS_NOT_ENTITLED'])
  })

  test('entitled with no default model resolves NO_DEFAULT_MODEL diagnostic', () => {
    const resolution = resolveDecisionLayer(baseRequest(), {})
    expect(resolution.resolution.model).toEqual({ withheld: 'NO_DEFAULT_MODEL' })
    expect(resolution.diagnostics).toEqual(['NO_DEFAULT_MODEL'])
  })

  test('capability pin beyond grants denies CAPABILITY_BEYOND_GRANT; grants bound the sandbox', () => {
    expect(() =>
      resolveDecisionLayer(
        { ...baseRequest(), explicitPins: { capabilities: { capabilityNames: ['net.free'] } } },
        {},
      ),
    ).toThrow((error) => error instanceof DecisionResolutionDeniedError && error.code === 'CAPABILITY_BEYOND_GRANT')
    // Required capability 'fs.read' is granted; the sandbox only ever sees the
    // intersection of resolved capabilities with grants — never 'net.denied'.
    const resolution = resolveDecisionLayer(
      { ...baseRequest(), requiredCapabilities: ['shell.exec', 'fs.read'] },
      {},
    )
    expect(resolution.resolution.capabilities.capabilityNames).toEqual(['shell.exec', 'fs.read'])
    expect(resolution.resolution.sandbox.effectiveCapabilities).toEqual(['shell.exec', 'fs.read'])
  })

  test('required capability beyond grants denies even without pins', () => {
    expect(() =>
      resolveDecisionLayer(
        { ...baseRequest(), requiredCapabilities: ['net.free'] },
        {},
      ),
    ).toThrow((error) => error instanceof DecisionResolutionDeniedError && error.code === 'CAPABILITY_BEYOND_GRANT')
  })

  test('context package pin requires the id; resolutions are deterministic per input', () => {
    expect(() =>
      resolveDecisionLayer(
        { ...baseRequest(), explicitPins: { contextPackage: { mode: 'existing' } } },
        {},
      ),
    ).toThrow((error) => error instanceof DecisionResolutionDeniedError && error.code === 'CONTEXT_PACKAGE_PIN_MISMATCH')
    const input = {
      ...baseRequest(),
      explicitPins: { contextPackage: { mode: 'existing', contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG' } },
    }
    const first = resolveDecisionLayer(input, { model: { modelId: 'pi/sol-1' } })
    const second = resolveDecisionLayer(input, { model: { modelId: 'pi/sol-1' } })
    expect(first.resolutionDigest).toBe(second.resolutionDigest)
  })
})
