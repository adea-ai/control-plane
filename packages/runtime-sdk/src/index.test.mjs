import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import {
  RuntimeConnectionSchema,
  RuntimeDefinitionSchema,
  RuntimeFixtures,
  RuntimeNodeRefSchema,
  assessRuntimeCompatibility,
  evaluateCapabilities,
  runtimeCapabilitiesEqual,
  runtimeDefinitionsEqual,
} from './index.ts'

describe('runtime capability vocabulary', () => {
  test('keeps normalized fixtures independent from concrete runtime SDKs', async () => {
    for (const fixture of Object.values(RuntimeFixtures)) {
      expect(RuntimeDefinitionSchema.parse(fixture)).toBeDefined()
    }
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.dependencies).toEqual({
      '@control-plane/contracts': 'workspace:*',
      zod: '4.5.4',
    })
    expect(JSON.stringify(manifest).toLowerCase()).not.toContain('pi-sdk')
    expect(JSON.stringify(manifest).toLowerCase()).not.toContain('acp-sdk')
  })

  test('evaluates required and optional capabilities deterministically', () => {
    const requirements = [
      { capability: 'tool.call', necessity: 'required' },
      { capability: 'output.structured', necessity: 'optional' },
      { capability: 'session.history', necessity: 'optional', minimumSupport: 'degraded' },
    ]
    const capabilities = [
      { name: 'session.history', support: 'degraded' },
      { name: 'tool.call', support: 'supported' },
    ]

    expect(evaluateCapabilities(capabilities, requirements)).toEqual({
      eligible: true,
      mode: 'degraded',
      missingRequired: [],
      insufficientRequired: [],
      missingOptional: ['output.structured'],
      degradedOptional: ['session.history'],
    })
    expect(
      evaluateCapabilities([...capabilities].toReversed(), [...requirements].toReversed())
    ).toEqual(evaluateCapabilities(capabilities, requirements))
    expect(
      evaluateCapabilities([], [{ capability: 'tool.call', necessity: 'required' }])
    ).toMatchObject({ eligible: false, mode: 'ineligible', missingRequired: ['tool.call'] })
    expect(() =>
      evaluateCapabilities(
        [],
        [
          { capability: 'tool.call', necessity: 'required' },
          { capability: 'tool.call', necessity: 'optional' },
        ]
      )
    ).toThrow('Capability requirements must be unique')
  })

  test('keeps every session operation independently representable', () => {
    const sessionCapabilities = [
      'session.create',
      'session.list',
      'session.resume',
      'session.close',
      'session.history',
      'session.load',
    ]
    const acpCapabilities = new Set(
      RuntimeFixtures.futureAcp.capabilities.map((capability) => capability.name)
    )

    expect(sessionCapabilities).toHaveLength(6)
    expect(acpCapabilities.has('session.list')).toBe(true)
    expect(acpCapabilities.has('session.resume')).toBe(true)
    expect(acpCapabilities.has('session.history')).toBe(false)
    expect(acpCapabilities.has('session.close')).toBe(false)
    expect(acpCapabilities.has('session.load')).toBe(true)
  })

  test('models Agent HQ node identity separately from Control Plane connections', () => {
    const node = RuntimeNodeRefSchema.parse({
      runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
      authority: 'agent_hq',
      displayName: 'Local Mac',
      location: 'local_device',
      status: 'online',
      observedAt: '2026-08-23T12:00:00.000Z',
      rawPath: '/private/project',
      credential: 'secret',
    })
    const connectionInput = {
      runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
      identityDigest: `sha256:${'a'.repeat(64)}`,
      connectionType: 'managed_local',
      runtimeNodeRefId: node.runtimeNodeRefId,
      runtimeDefinitionId: RuntimeFixtures.mock.runtimeDefinitionId,
      location: 'local_device',
      opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFG',
      adapterVersion: '1.0.0',
      driverVersion: '1.0.0',
      harnessVersion: '1.0.0',
      status: 'connected',
      health: 'healthy',
      capabilities: RuntimeFixtures.mock.capabilities,
      compatibilityState: 'compatible',
      limitations: [],
      lastDiscoveredAt: '2026-08-23T12:00:00.000Z',
      lastHeartbeatAt: '2026-08-23T12:00:00.000Z',
      lastHealthCheckAt: '2026-08-23T12:00:00.000Z',
      version: 1,
      createdAt: '2026-08-23T12:00:00.000Z',
      updatedAt: '2026-08-23T12:00:00.000Z',
    }
    const connection = RuntimeConnectionSchema.parse(connectionInput)

    expect(connection.runtimeNodeRefId).toBe(node.runtimeNodeRefId)
    expect(JSON.stringify({ node, connection })).not.toContain('/private/project')
    expect(JSON.stringify({ node, connection })).not.toContain('secret')
    expect(() =>
      RuntimeConnectionSchema.parse({ ...connectionInput, processHandle: 1234 })
    ).toThrow()
  })
})

describe('runtime compatibility', () => {
  const expected = {
    contractMajor: 1,
    adapterMajor: 1,
    driverMajor: 1,
    capabilities: [{ capability: 'tool.call', necessity: 'required' }],
  }

  test('returns explicit version, capability, health, and lifecycle states', () => {
    expect(assessRuntimeCompatibility(RuntimeFixtures.futurePi, expected)).toEqual({
      state: 'compatible',
      reasons: [],
    })
    expect(
      assessRuntimeCompatibility(RuntimeFixtures.mock, {
        ...expected,
        capabilities: [{ capability: 'tool.call', necessity: 'required' }],
      })
    ).toEqual({ state: 'capability_missing', reasons: ['MISSING_REQUIRED:tool.call'] })
    expect(
      assessRuntimeCompatibility(
        { ...RuntimeFixtures.futurePi, adapterVersion: '2.0.0', driverVersion: '3.0.0' },
        expected
      )
    ).toEqual({
      state: 'incompatible',
      reasons: ['ADAPTER_MAJOR_MISMATCH', 'DRIVER_MAJOR_MISMATCH'],
    })
    expect(
      assessRuntimeCompatibility({ ...RuntimeFixtures.futurePi, health: 'unavailable' }, expected)
        .state
    ).toBe('unavailable')
    expect(
      assessRuntimeCompatibility({ ...RuntimeFixtures.futurePi, lifecycle: 'deprecated' }, expected)
        .state
    ).toBe('deprecated')
    expect(
      assessRuntimeCompatibility({ ...RuntimeFixtures.futurePi, lifecycle: 'revoked' }, expected)
        .state
    ).toBe('revoked')
  })

  test('reports optional absence and untested combinations without making them fully compatible', () => {
    expect(
      assessRuntimeCompatibility(RuntimeFixtures.mock, {
        contractMajor: 1,
        adapterMajor: 1,
        driverMajor: 1,
        capabilities: [{ capability: 'session.close', necessity: 'optional' }],
      })
    ).toEqual({ state: 'degraded', reasons: ['MISSING_OPTIONAL:session.close'] })
    expect(
      assessRuntimeCompatibility(
        {
          ...RuntimeFixtures.futurePi,
          compatibility: { ...RuntimeFixtures.futurePi.compatibility, status: 'untested' },
        },
        expected
      )
    ).toEqual({ state: 'untested', reasons: ['VERSION_COMBINATION_UNTESTED'] })
  })

  test('compares normalized capability sets and definitions independent of capability order', () => {
    const reversed = {
      ...RuntimeFixtures.futurePi,
      capabilities: [...RuntimeFixtures.futurePi.capabilities].toReversed(),
    }
    expect(
      runtimeCapabilitiesEqual(RuntimeFixtures.futurePi.capabilities, reversed.capabilities)
    ).toBe(true)
    expect(runtimeDefinitionsEqual(RuntimeFixtures.futurePi, reversed)).toBe(true)
    expect(
      runtimeDefinitionsEqual(RuntimeFixtures.futurePi, {
        ...RuntimeFixtures.futurePi,
        driverVersion: '1.1.0',
      })
    ).toBe(false)
  })
})
