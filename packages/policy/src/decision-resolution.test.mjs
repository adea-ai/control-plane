import { describe, expect, test } from 'bun:test'
import { availableRuntimesFromDiscovery } from '@control-plane/contracts'
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

describe('model and harness selection are independent (no silent substitution)', () => {
  const pinnedModel = { modelId: 'pi/sol-1' }

  test('a model pin leaves harness resolution and its trace unchanged', () => {
    const without = resolveDecisionLayer(baseRequest(), {})
    const withModel = resolveDecisionLayer(
      { ...baseRequest(), explicitPins: { model: pinnedModel } },
      {}
    )
    expect(withModel.resolution.harness).toEqual(without.resolution.harness)
    expect(withModel.trace.harness).toEqual(without.trace.harness)
    expect(withModel.resolution.model).toEqual(pinnedModel)
  })

  test('a harness pin leaves model resolution and its trace unchanged', () => {
    const policy = { model: { modelId: 'pi/sol-1' } }
    const without = resolveDecisionLayer(baseRequest(), policy)
    const withHarness = resolveDecisionLayer(
      { ...baseRequest(), explicitPins: { harness: { harnessId: 'claude-code' } } },
      policy
    )
    expect(withHarness.resolution.harness).toEqual({ harnessId: 'claude-code' })
    expect(withHarness.resolution.model).toEqual(without.resolution.model)
    expect(withHarness.trace.model).toEqual(without.trace.model)
  })

  test('a policy default model is not re-bound when a different harness is selected', () => {
    const resolution = resolveDecisionLayer(
      { ...baseRequest(), profileDefaults: { harness: { harnessId: 'claude-code' } } },
      { model: pinnedModel }
    )
    expect(resolution.resolution.harness.harnessId).toBe('claude-code')
    expect(resolution.resolution.model).toEqual(pinnedModel)
    expect(resolution.trace.model.source).toBe('policy-default')
  })

  test('withheld model access does not alter the selected harness', () => {
    const unentitled = {
      ...baseRequest(),
      entitlements: { modelAccess: 'none', grantedCapabilityNames: ['shell.exec'] },
      explicitPins: { harness: { harnessId: 'claude-code' } },
    }
    const resolution = resolveDecisionLayer(unentitled, {})
    expect(resolution.resolution.harness).toEqual({ harnessId: 'claude-code' })
    expect(resolution.resolution.model).toEqual({ withheld: 'MODEL_ACCESS_NOT_ENTITLED' })
  })

  test('an entitled model pin never rescues an unexposed harness pin', () => {
    expectDenied('NO_COMPATIBLE_RUNTIME', () =>
      resolveDecisionLayer(
        {
          ...baseRequest(),
          explicitPins: { harness: { harnessId: 'acp' }, model: pinnedModel },
        },
        { model: { modelId: 'pi/other' } }
      )
    )
  })

  test('an unexposed harness pin denies at any precedence layer instead of using the first exposed harness', () => {
    expectDenied('NO_COMPATIBLE_RUNTIME', () =>
      resolveDecisionLayer(
        { ...baseRequest(), projectDefaults: { harness: { harnessId: 'acp' } } },
        { model: pinnedModel }
      )
    )
    expectDenied('NO_COMPATIBLE_RUNTIME', () =>
      resolveDecisionLayer(
        { ...baseRequest(), profileDefaults: { harness: { harnessId: 'acp' } } },
        { model: pinnedModel }
      )
    )
  })

  test('a harness pin selects the runtime that exposes it when no runtime is pinned', () => {
    const request = {
      ...baseRequest(),
      availableRuntimes: [
        {
          runtimeDefinitionId: ids.runtimeLocal,
          kind: 'local',
          transport: 'direct-local',
          harnessIds: ['managed-pi'],
          capabilities: ['shell.exec'],
        },
        {
          runtimeDefinitionId: ids.runtimeRemote,
          kind: 'self-hosted',
          transport: 'remote-gateway',
          harnessIds: ['managed-pi', 'acp'],
          capabilities: ['shell.exec'],
        },
      ],
      explicitPins: { harness: { harnessId: 'acp' } },
    }
    const resolution = resolveDecisionLayer(request, {})
    expect(resolution.resolution.runtime.runtimeDefinitionId).toBe(ids.runtimeRemote)
    expect(resolution.resolution.harness).toEqual({ harnessId: 'acp' })
    expect(resolution.trace.harness.source).toBe('explicit-pin')
    expect(resolution.trace.runtime.source).toBe('policy-default')
  })

  test('a harness pin is not satisfied by a runtime lacking required capabilities', () => {
    const request = {
      ...baseRequest(),
      requiredCapabilities: ['shell.exec', 'fs.read'],
      availableRuntimes: [
        {
          runtimeDefinitionId: ids.runtimeLocal,
          kind: 'local',
          transport: 'direct-local',
          harnessIds: ['managed-pi'],
          capabilities: ['shell.exec', 'fs.read'],
        },
        {
          runtimeDefinitionId: ids.runtimeRemote,
          kind: 'self-hosted',
          transport: 'remote-gateway',
          harnessIds: ['acp'],
          capabilities: ['shell.exec'],
        },
      ],
      explicitPins: { harness: { harnessId: 'acp' } },
    }
    expectDenied('NO_COMPATIBLE_RUNTIME', () => resolveDecisionLayer(request, {}))
  })
})

describe('production discovery consumer: exact harness identity, no alias', () => {
  const discovered = (runtimeDefinitionId, family, overrides = {}) => ({
    runtimeDefinitionId,
    family,
    connectionType: 'managed_local',
    location: 'local_device',
    status: 'available',
    connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
    freshness: { state: 'fresh', observedAt: '2026-09-22T12:00:00.000Z' },
    versions: { adapter: '1.0.0', driver: '1.0.0', harness: '0.52.1' },
    capabilities: ['shell.exec'],
    capabilityDetails: [],
    ...overrides,
  })
  const managedPiLocal = discovered(ids.runtimeLocal, 'managed-pi')
  const acpRemote = discovered(ids.runtimeRemote, 'acp', {
    connectionType: 'external_local',
    location: 'agent_hq_cloud',
  })
  const request = (models, pins = {}) => ({
    ...baseRequest(),
    availableRuntimes: availableRuntimesFromDiscovery(models),
    explicitPins: pins,
  })

  test('a pinned harness selects the discovered runtime that exposes that exact id', () => {
    const resolution = resolveDecisionLayer(
      request([managedPiLocal, acpRemote], { harness: { harnessId: 'acp' } }),
      {}
    )
    expect(resolution.resolution.runtime.runtimeDefinitionId).toBe(ids.runtimeRemote)
    expect(resolution.resolution.harness).toEqual({ harnessId: 'acp' })
  })

  test('a managed-pi runtime is not satisfied by a pin for pi (no alias)', () => {
    expectDenied('NO_COMPATIBLE_RUNTIME', () =>
      resolveDecisionLayer(request([managedPiLocal], { harness: { harnessId: 'pi' } }), {})
    )
  })

  test('a managed-pi runtime is selected only by its exact id', () => {
    const resolution = resolveDecisionLayer(
      request([managedPiLocal], { harness: { harnessId: 'managed-pi' } }),
      {}
    )
    expect(resolution.resolution.harness).toEqual({ harnessId: 'managed-pi' })
  })

  test('without any harness pin, the hard filter is inert and never denies with NO_COMPATIBLE_RUNTIME', () => {
    const resolution = resolveDecisionLayer(request([managedPiLocal, acpRemote]), {})
    expect(resolution.resolution.runtime.runtimeDefinitionId).toBe(ids.runtimeLocal)
    expect(resolution.resolution.harness).toEqual({ harnessId: 'managed-pi' })
    expect(resolution.diagnostics).not.toContain('NO_COMPATIBLE_RUNTIME')
  })

  test('unavailable or revoked discovered runtimes are never hard-filter candidates', () => {
    const resolution = resolveDecisionLayer(
      request([discovered(ids.runtimeLocal, 'acp', { status: 'unavailable' }), acpRemote], {
        harness: { harnessId: 'acp' },
      }),
      {}
    )
    expect(resolution.resolution.runtime.runtimeDefinitionId).toBe(ids.runtimeRemote)
    expectDenied('NO_COMPATIBLE_RUNTIME', () =>
      resolveDecisionLayer(
        request([discovered(ids.runtimeLocal, 'acp', { status: 'revoked' })], {
          harness: { harnessId: 'acp' },
        }),
        {}
      )
    )
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
