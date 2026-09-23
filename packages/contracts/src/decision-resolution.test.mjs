import { describe, expect, test } from 'bun:test'
import { availableRuntimesFromDiscovery } from './decision-resolution.ts'

const base = {
  runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
  family: 'pi',
  connectionType: 'managed_local',
  location: 'local_device',
  status: 'available',
  connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
  freshness: { state: 'fresh', observedAt: '2026-09-22T12:00:00.000Z' },
  versions: { adapter: '1.0.0', driver: '1.0.0', harness: '0.52.1' },
  capabilities: ['stream.output', 'tool.call'],
  capabilityDetails: [],
}

describe('available runtimes from discovery', () => {
  test('maps harness families onto the decision layer runtime view', () => {
    const [pi, acp] = availableRuntimesFromDiscovery([
      base,
      {
        ...base,
        runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFH',
        family: 'acp',
        connectionType: 'external_local',
        location: 'agent_hq_cloud',
      },
    ])
    expect(pi).toEqual({
      runtimeDefinitionId: base.runtimeDefinitionId,
      kind: 'local',
      transport: 'remote-gateway',
      harnessIds: ['pi'],
      capabilities: ['stream.output', 'tool.call'],
    })
    expect(acp).toMatchObject({ kind: 'self-hosted', harnessIds: ['acp'] })
  })

  test('offers degraded runtimes but never unavailable or revoked ones', () => {
    const mapped = availableRuntimesFromDiscovery([
      { ...base, status: 'degraded' },
      { ...base, runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFH', status: 'unavailable' },
      { ...base, runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFJ', status: 'revoked' },
    ])
    expect(mapped.map((runtime) => runtime.runtimeDefinitionId)).toEqual([base.runtimeDefinitionId])
  })

  test('every family maps to a valid harness id for the resolver', () => {
    const mapped = availableRuntimesFromDiscovery([{ ...base, family: 'reference-runtime' }])
    expect(mapped[0].harnessIds).toEqual(['reference-runtime'])
  })
})
