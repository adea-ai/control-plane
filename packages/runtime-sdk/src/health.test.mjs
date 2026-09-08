import { describe, expect, test } from 'bun:test'
import {
  InMemoryRuntimeConnectionRepository,
  RecordingRuntimeAvailabilityChangePublisher,
  RuntimeConnectionRegistry,
  RuntimeHealthIngestionError,
  RuntimeHealthIngestionService,
  runtimeAvailabilityIsExecutable,
} from './index.ts'

const connectionId = 'rtc_01JABCDEF0123456789ABCDEFG'
const nodeId = 'rnr_01JABCDEF0123456789ABCDEFG'

async function createHarness() {
  const registry = new RuntimeConnectionRegistry(new InMemoryRuntimeConnectionRepository())
  await registry.register({
    runtimeConnectionId: connectionId,
    identityDigest: `sha256:${'1'.repeat(64)}`,
    connectionType: 'managed_local',
    runtimeNodeRefId: nodeId,
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    location: 'local_device',
    opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFG',
    adapterVersion: '1.0.0',
    driverVersion: '1.0.0',
    harnessVersion: '1.0.0',
    status: 'connected',
    health: 'healthy',
    capabilities: [],
    compatibilityState: 'untested',
    limitations: [],
    lastDiscoveredAt: '2026-08-24T20:00:00.000Z',
    lastHeartbeatAt: '2026-08-24T20:00:00.000Z',
    lastHealthCheckAt: '2026-08-24T20:00:00.000Z',
    expiresAt: '2026-08-24T20:10:00.000Z',
  })
  const changes = new RecordingRuntimeAvailabilityChangePublisher()
  const service = new RuntimeHealthIngestionService({
    registry,
    changes,
    policy: {
      adapterMajor: 1,
      driverMajor: 1,
      harnessMajor: 1,
      protocolMajor: 1,
      healthTtlMs: 60_000,
      maximumCapabilityTtlMs: 120_000,
    },
  })
  return { changes, registry, service }
}

function report(overrides = {}) {
  return {
    runtimeConnectionId: connectionId,
    reportSequence: 2,
    observedAt: '2026-08-24T20:01:00.000Z',
    discoveredAt: '2026-08-24T20:00:30.000Z',
    nodeStatus: 'online',
    runtimeState: 'healthy',
    versions: {
      adapter: '1.0.0',
      driver: '1.0.0',
      harness: '1.0.0',
      protocol: '1.0.0',
    },
    capabilitySnapshot: {
      version: 1,
      observedAt: '2026-08-24T20:01:00.000Z',
      ttlMs: 60_000,
      verification: 'verified',
      source: 'adapter_driver_negotiation',
      capabilities: [
        { name: 'stream.output', support: 'supported' },
        { name: 'execution.cancel', support: 'supported' },
      ],
    },
    limitations: [],
    diagnostics: [],
    ...overrides,
  }
}

describe('runtime health ingestion', () => {
  test('keeps node-online state distinct from degraded runtime health', async () => {
    const { changes, service } = await createHarness()
    const result = await service.ingest(
      report({
        runtimeState: 'degraded',
        limitations: ['Runtime response latency exceeds the healthy threshold'],
        diagnostics: ['RUNTIME_LATENCY_HIGH'],
      }),
      '2026-08-24T20:01:10.000Z'
    )

    expect(result).toMatchObject({
      applied: true,
      assessment: {
        nodeStatus: 'online',
        availabilityState: 'degraded',
        executable: true,
      },
      connection: {
        status: 'degraded',
        health: 'degraded',
        availabilityState: 'degraded',
        compatibilityState: 'degraded',
        lastDiscoveredAt: '2026-08-24T20:00:30.000Z',
      },
    })
    expect(changes.events).toHaveLength(1)
    expect(changes.events[0]).toMatchObject({
      type: 'runtime.availability_changed',
      runtimeConnectionId: connectionId,
      nodeStatus: 'online',
      currentState: 'degraded',
    })
  })

  test('distinguishes node-offline from freshness-bound stale runtime capability state', async () => {
    const { service } = await createHarness()
    const result = await service.ingest(
      report({ nodeStatus: 'offline' }),
      '2026-08-24T20:02:01.000Z'
    )

    expect(result.assessment).toMatchObject({
      nodeStatus: 'offline',
      availabilityState: 'stale',
      executable: false,
      diagnostics: expect.arrayContaining(['CAPABILITY_SNAPSHOT_STALE', 'NODE_OFFLINE']),
    })
    expect(result.connection).toMatchObject({
      status: 'unavailable',
      expiresAt: '2026-08-24T20:10:00.000Z',
    })
    expect(runtimeAvailabilityIsExecutable('stale')).toBe(false)
  })

  test('classifies unsupported adapter, driver, harness, and protocol versions explicitly', async () => {
    const { service } = await createHarness()
    const result = await service.ingest(
      report({
        versions: {
          adapter: '2.0.0',
          driver: '3.0.0',
          harness: '4.0.0',
          protocol: '5.0.0',
        },
      }),
      '2026-08-24T20:01:10.000Z'
    )

    expect(result.assessment).toEqual({
      nodeStatus: 'online',
      availabilityState: 'incompatible',
      executable: false,
      capabilitySnapshotExpiresAt: '2026-08-24T20:02:00.000Z',
      diagnostics: [
        'ADAPTER_MAJOR_MISMATCH',
        'DRIVER_MAJOR_MISMATCH',
        'HARNESS_MAJOR_MISMATCH',
        'PROTOCOL_MAJOR_MISMATCH',
      ],
    })
    expect(result.connection).toMatchObject({
      availabilityState: 'incompatible',
      compatibilityState: 'incompatible',
      status: 'unavailable',
      health: 'unavailable',
    })
  })

  test('is idempotent and ignores out-of-order stale reports without duplicate changes', async () => {
    const { changes, service } = await createHarness()
    const first = await service.ingest(report(), '2026-08-24T20:01:10.000Z')
    const replay = await service.ingest(report(), '2026-08-24T20:01:11.000Z')
    const stale = await service.ingest(
      report({
        reportSequence: 1,
        observedAt: '2026-08-24T20:00:30.000Z',
        runtimeState: 'offline',
        capabilitySnapshot: {
          ...report().capabilitySnapshot,
          observedAt: '2026-08-24T20:00:30.000Z',
        },
      }),
      '2026-08-24T20:01:12.000Z'
    )

    expect(first.applied).toBe(true)
    expect(replay).toMatchObject({ applied: false, reason: 'replayed_report' })
    expect(stale).toMatchObject({ applied: false, reason: 'stale_report' })
    expect(changes.events).toHaveLength(1)
    await expect(
      service.ingest(
        report({ reportSequence: 2, runtimeState: 'offline' }),
        '2026-08-24T20:01:12.000Z'
      )
    ).rejects.toMatchObject({ code: 'HEALTH_REPORT_CONFLICT' })
    expect(RuntimeHealthIngestionError).toBeDefined()
  })

  test('does not retain unverified supported capability claims as executable', async () => {
    const { service } = await createHarness()
    const result = await service.ingest(
      report({
        capabilitySnapshot: {
          ...report().capabilitySnapshot,
          verification: 'unverified',
          source: 'runtime_declaration',
        },
      }),
      '2026-08-24T20:01:10.000Z'
    )

    expect(result.assessment).toMatchObject({
      availabilityState: 'degraded',
      diagnostics: ['CAPABILITIES_UNVERIFIED'],
    })
    expect(result.connection.capabilities).toEqual([
      { name: 'execution.cancel', support: 'unsupported', limitations: ['UNVERIFIED_CAPABILITY'] },
      { name: 'stream.output', support: 'unsupported', limitations: ['UNVERIFIED_CAPABILITY'] },
    ])
  })

  test('rejects runtime-declared capability claims mislabeled as verified', async () => {
    const { service } = await createHarness()

    await expect(
      service.ingest(
        report({
          capabilitySnapshot: {
            ...report().capabilitySnapshot,
            verification: 'verified',
            source: 'runtime_declaration',
          },
        }),
        '2026-08-24T20:01:10.000Z'
      )
    ).rejects.toThrow('Only negotiated capability claims can be verified')
  })

  test.each([5_000, 120_000])(
    'expires the first freshness deadline exactly (capability TTL %i)',
    async (ttlMs) => {
      const { service, changes } = await createHarness()
      const input = report()
      input.capabilitySnapshot.ttlMs = ttlMs
      await service.ingest(input, input.observedAt)
      const deadline = Date.parse(input.observedAt) + Math.min(ttlMs, 60_000)
      const before = await service.refresh({
        runtimeConnectionId: connectionId,
        nodeStatus: 'online',
        evaluatedAt: new Date(deadline - 1).toISOString(),
      })
      expect(before.assessment.availabilityState).toBe('healthy')
      const expired = await service.refresh({
        runtimeConnectionId: connectionId,
        nodeStatus: 'online',
        evaluatedAt: new Date(deadline).toISOString(),
      })
      expect(expired.assessment).toMatchObject({ availabilityState: 'stale', executable: false })
      expect(expired.connection.diagnostics).toContain(
        ttlMs < 60_000 ? 'CAPABILITY_SNAPSHOT_STALE' : 'HEALTH_REPORT_STALE'
      )
      expect(changes.events.map(({ currentState }) => currentState)).toEqual(['healthy', 'stale'])
    }
  )

  test('refreshes previously healthy inventory to stale after its TTL', async () => {
    const { changes, service } = await createHarness()
    await service.ingest(report(), '2026-08-24T20:01:10.000Z')
    const refreshed = await service.refresh({
      runtimeConnectionId: connectionId,
      nodeStatus: 'online',
      evaluatedAt: '2026-08-24T20:02:01.000Z',
    })

    expect(refreshed).toMatchObject({
      applied: true,
      assessment: { availabilityState: 'stale', executable: false },
      connection: {
        availabilityState: 'stale',
        status: 'unavailable',
        expiresAt: '2026-08-24T20:10:00.000Z',
      },
    })
    expect(changes.events.map(({ currentState }) => currentState)).toEqual(['healthy', 'stale'])
  })

  test('rejects unsafe display limitations and free-form diagnostics', async () => {
    const { service } = await createHarness()
    await expect(
      service.ingest(
        report({ limitations: ['unsafe\nmultiline value'] }),
        '2026-08-24T20:01:10.000Z'
      )
    ).rejects.toBeInstanceOf(Error)
    await expect(
      service.ingest(
        report({ diagnostics: ['native path: /private/runtime'] }),
        '2026-08-24T20:01:10.000Z'
      )
    ).rejects.toBeInstanceOf(Error)
  })

  test('classifies reconnecting, offline, unknown, and revoked reports explicitly', async () => {
    for (const [runtimeState, nodeStatus, expectedStatus] of [
      ['reconnecting', 'online', 'degraded'],
      ['offline', 'online', 'disconnected'],
      ['unknown', 'online', 'unavailable'],
      ['healthy', 'revoked', 'revoked'],
    ]) {
      const { service } = await createHarness()
      const result = await service.ingest(
        report({ runtimeState, nodeStatus }),
        '2026-08-24T20:01:10.000Z'
      )
      const expectedState = nodeStatus === 'revoked' ? 'revoked' : runtimeState
      expect(result.assessment.availabilityState).toBe(expectedState)
      expect(result.connection.status).toBe(expectedStatus)
      expect(result.connection.availabilityState).toBe(expectedState)
      expect(runtimeAvailabilityIsExecutable(expectedState)).toBe(false)
    }
  })
})
