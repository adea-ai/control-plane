import { describe, expect, test } from 'bun:test'
import {
  DecisionResolutionDeniedError,
  resolveDecisionLayer,
  resolveRuntimeHarness,
} from './index.ts'

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

function expectDenied(code, run) {
  try {
    run()
  } catch (error) {
    expect(error?.name).toBe('DecisionResolutionDeniedError')
    expect(error?.code).toBe(code)
    return
  }
  throw new Error(`expected denial ${code} but resolution succeeded`)
}

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
    expect(resolution.resolution.delegation).toEqual({
      fanOut: 'none',
      promotion: 'review-required',
    })
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

    const noProfile = {
      ...baseRequest(),
      projectDefaults: { harness: { harnessId: 'claude-code' } },
    }
    const viaProject = resolveDecisionLayer(noProfile, {})
    expect(viaProject.trace.harness.source).toBe('project-default')
  })

  test('skill pins resolve through every layer and default to empty', () => {
    const pinned = resolveDecisionLayer(
      {
        ...baseRequest(),
        explicitPins: { skills: { skillVersionIds: [ids.skillVersionId] } },
      },
      {}
    )
    expect(pinned.resolution.skills.skillVersionIds).toEqual([ids.skillVersionId])
    expect(pinned.trace.skills.source).toBe('explicit-pin')
    expect(resolveDecisionLayer(baseRequest(), {}).resolution.skills.skillVersionIds).toEqual([])
  })

  test('runtime pin to an unavailable runtime denies UNSUPPORTED_RUNTIME_PIN', () => {
    expectDenied('UNSUPPORTED_RUNTIME_PIN', () =>
      resolveDecisionLayer(
        {
          ...baseRequest(),
          explicitPins: { runtime: { runtimeDefinitionId: 'rtd_01JABCDEF0123456789XYZDEFG' } },
        },
        {}
      )
    )
  })

  test('runtime pin missing a required capability denies UNSUPPORTED_RUNTIME_PIN', () => {
    expectDenied('UNSUPPORTED_RUNTIME_PIN', () =>
      resolveDecisionLayer(
        {
          ...baseRequest(),
          requiredCapabilities: ['shell.exec', 'fs.read'],
          explicitPins: { runtime: { runtimeDefinitionId: ids.runtimeRemote } },
        },
        {}
      )
    )
  })

  test('automatic runtime selection denies when no runtime supplies every required capability', () => {
    expectDenied('UNSUPPORTED_RUNTIME_PIN', () =>
      resolveDecisionLayer(
        {
          ...baseRequest(),
          requiredCapabilities: ['shell.exec', 'fs.read', 'net.denied'],
        },
        {}
      )
    )
  })

  test('harness pin unavailable on the selected runtime denies', () => {
    // claude-code exists only on the local runtime; pin the remote runtime.
    expectDenied('HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME', () =>
      resolveDecisionLayer(
        {
          ...baseRequest(),
          explicitPins: {
            runtime: { runtimeDefinitionId: ids.runtimeRemote },
            harness: { harnessId: 'claude-code' },
          },
        },
        {}
      )
    )
  })

  test('model pin without entitlement denies; unentitled without pin withholds', () => {
    const unentitled = {
      ...baseRequest(),
      entitlements: { modelAccess: 'none', grantedCapabilityNames: ['shell.exec'] },
    }
    expectDenied('MODEL_ACCESS_NOT_ENTITLED', () =>
      resolveDecisionLayer({ ...unentitled, explicitPins: { model: { modelId: 'pi/sol-1' } } }, {})
    )
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
    expectDenied('CAPABILITY_BEYOND_GRANT', () =>
      resolveDecisionLayer(
        { ...baseRequest(), explicitPins: { capabilities: { capabilityNames: ['net.free'] } } },
        {}
      )
    )
    // Required capability 'fs.read' is granted; the sandbox only ever sees the
    // intersection of resolved capabilities with grants — never 'net.denied'.
    const resolution = resolveDecisionLayer(
      { ...baseRequest(), requiredCapabilities: ['shell.exec', 'fs.read'] },
      {}
    )
    expect(resolution.resolution.capabilities.capabilityNames).toEqual(['shell.exec', 'fs.read'])
    expect(resolution.resolution.sandbox.effectiveCapabilities).toEqual(['shell.exec', 'fs.read'])
  })

  test('required capability beyond grants denies even without pins', () => {
    expectDenied('CAPABILITY_BEYOND_GRANT', () =>
      resolveDecisionLayer({ ...baseRequest(), requiredCapabilities: ['net.free'] }, {})
    )
  })

  test('rejects unsupported decision-resolution contract major versions', () => {
    expect(() =>
      resolveDecisionLayer({ ...baseRequest(), contractVersion: { major: 2, minor: 0 } }, {})
    ).toThrow('UNSUPPORTED_DECISION_RESOLUTION_CONTRACT_VERSION')
  })

  test('context package pin requires the id; resolutions are deterministic per input', () => {
    expectDenied('CONTEXT_PACKAGE_PIN_MISMATCH', () =>
      resolveDecisionLayer(
        { ...baseRequest(), explicitPins: { contextPackage: { mode: 'existing' } } },
        {}
      )
    )
    const input = {
      ...baseRequest(),
      explicitPins: {
        contextPackage: { mode: 'existing', contextPackageId: 'ctx_01JABCDEF0123456789ABCDEFG' },
      },
    }
    const first = resolveDecisionLayer(input, { model: { modelId: 'pi/sol-1' } })
    const second = resolveDecisionLayer(input, { model: { modelId: 'pi/sol-1' } })
    expect(first.resolutionDigest).toBe(second.resolutionDigest)
  })
})

describe('narrow runtime harness resolution', () => {
  const piRuntime = {
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    kind: 'local',
    transport: 'direct-local',
    harnessIds: ['pi', 'acp'],
    capabilities: ['stream.output'],
  }

  test('resolves the first exposed harness without a pin', () => {
    expect(resolveRuntimeHarness(piRuntime)).toEqual({ harnessId: 'pi', source: 'policy-default' })
  })

  test('accepts an exposed pin and rejects an unexposed one', () => {
    expect(resolveRuntimeHarness(piRuntime, 'acp')).toEqual({
      harnessId: 'acp',
      source: 'explicit-pin',
    })
    try {
      resolveRuntimeHarness(piRuntime, 'deepseek')
      throw new Error('expected denial')
    } catch (error) {
      expect(error).toBeInstanceOf(DecisionResolutionDeniedError)
      expect(error.code).toBe('HARNESS_UNAVAILABLE_ON_PINNED_RUNTIME')
    }
  })

  test('denies runtimes exposing no harness at all', () => {
    expect(() => resolveRuntimeHarness({ ...piRuntime, harnessIds: [] })).toThrow(
      DecisionResolutionDeniedError
    )
  })
})
