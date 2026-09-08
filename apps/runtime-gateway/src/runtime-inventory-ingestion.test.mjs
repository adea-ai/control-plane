import { describe, expect, test } from 'bun:test'
import {
  InMemoryRuntimeConnectionRepository,
  InMemoryRuntimeInventoryCheckpointRepository,
  RecordingRuntimeAvailabilityChangePublisher,
  RuntimeConnectionRegistry,
  RuntimeHealthIngestionService,
} from '@control-plane/runtime-sdk'
import {
  DefaultRuntimeInventoryNormalizer,
  RecordingGatewayMetrics,
  RuntimeInventoryMessageHandler,
  RuntimeInventoryIngestionError,
  RuntimeInventoryIngestionService,
} from './index.js'

const nodeId = 'rnr_01JABCDEF0123456789ABCDEFG'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const runtimeA = 'nref_01JABCDEF0123456789ABCDEFG'
const runtimeB = 'nref_01JBBCDEF0123456789ABCDEFG'

describe('Runtime Gateway inventory ingestion', () => {
  test('preserves a shorter advertised capability TTL during normalization', async () => {
    const frame = inventory(1, [{ ...driver(runtimeA), capabilityTtlMs: 5_000 }], {
      protocolVersion: { major: 1, minor: 6 },
    })
    const normalizer = new DefaultRuntimeInventoryNormalizer()
    expect(
      (
        await normalizer.normalize({
          driver: frame.runtimeDrivers[0],
          inventory: frame,
          nodeStatus: 'online',
        })
      ).healthReport.capabilitySnapshot.ttlMs
    ).toBe(5_000)
    const legacy = inventory(1, [driver(runtimeA)])
    expect(
      (
        await normalizer.normalize({
          driver: legacy.runtimeDrivers[0],
          inventory: legacy,
          nodeStatus: 'online',
        })
      ).healthReport.capabilitySnapshot.ttlMs
    ).toBe(60_000)
    const fixture = createFixture({ normalizer })
    const result = await fixture.service.ingest(frame, {
      ...source(),
      protocolVersion: { major: 1, minor: 6 },
    })
    const connection = result.updated[0]
    expect(connection.capabilitySnapshotExpiresAt).toBe(
      new Date(Date.parse(frame.observedAt) + 5_000).toISOString()
    )
    const refreshed = await fixture.health.refresh({
      runtimeConnectionId: connection.runtimeConnectionId,
      nodeStatus: 'online',
      evaluatedAt: new Date(Date.parse(frame.observedAt) + 5_001).toISOString(),
    })
    expect(refreshed.connection.availabilityState).toBe('stale')
  })

  test('normalizes and routes a live inventory frame through the production handler', async () => {
    const frame = inventory(1, [driver(runtimeA)])
    const normalizer = new DefaultRuntimeInventoryNormalizer()
    const normalized = await normalizer.normalize({
      driver: frame.runtimeDrivers[0],
      inventory: frame,
      nodeStatus: 'online',
    })

    expect(normalized).toMatchObject({
      registration: {
        connectionType: 'managed_local',
        runtimeNodeRefId: nodeId,
        opaqueNativeRef: runtimeA,
        adapterVersion: '1.0.0',
        status: 'connected',
      },
      healthReport: {
        reportSequence: 1,
        nodeStatus: 'online',
        runtimeState: 'healthy',
      },
    })
    expect(normalized.registration.runtimeConnectionId).toMatch(/^rtc_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(normalized.registration.runtimeDefinitionId).toMatch(/^rtd_[0-9A-HJKMNP-TV-Z]{26}$/)

    const calls = []
    const handler = new RuntimeInventoryMessageHandler({
      inventory: { ingest: async (...input) => calls.push(input) },
    })
    await handler.handle(source(), frame)
    expect(calls).toEqual([[frame, source(), 'online']])
    await expect(handler.handle(source(), { ...frame, type: 'heartbeat' })).rejects.toThrow(
      'RUNTIME_GATEWAY_FRAME_UNSUPPORTED'
    )
  })

  test('applies snapshots idempotently while keeping node and runtime health separate', async () => {
    const fixture = createFixture()
    const unhealthy = inventory(1, [driver(runtimeA, 'unavailable')])
    const first = await fixture.service.ingest(unhealthy, source(), 'online')
    expect(first).toMatchObject({ outcome: 'applied', updated: [{ health: 'unavailable' }] })
    expect(first.updated[0].availabilityState).toBe('offline')
    expect(fixture.changes.events.at(-1)).toMatchObject({
      nodeStatus: 'online',
      currentState: 'offline',
    })
    expect(fixture.projections.runtimeConnections).toHaveLength(1)
    expect(fixture.projections.runtimeConnections[0]).toMatchObject({
      workspaceId,
      model: {
        runtimeConnectionId: first.updated[0].runtimeConnectionId,
        family: 'reference-runtime',
        node: { runtimeNodeRefId: nodeId, health: 'online' },
        connection: { availability: 'offline' },
      },
    })

    const replay = await fixture.service.ingest(unhealthy, source(), 'online')
    expect(replay).toEqual({
      outcome: 'duplicate',
      snapshotVersion: 1,
      updated: [],
      disappeared: [],
    })
    expect(await fixture.registry.listByRuntimeNode(nodeId)).toHaveLength(1)
  })

  test('canonicalizes inventory ordering for semantic replay identity', async () => {
    const fixture = createFixture()
    await fixture.service.ingest(inventory(1, [driver(runtimeA), driver(runtimeB)]), source())
    const replay = await fixture.service.ingest(
      inventory(1, [driver(runtimeB), driver(runtimeA)]),
      source()
    )
    expect(replay.outcome).toBe('duplicate')
  })

  test('marks runtimes omitted from a snapshot unavailable without deleting history', async () => {
    const fixture = createFixture()
    await fixture.service.ingest(inventory(1, [driver(runtimeA), driver(runtimeB)]), source())
    const result = await fixture.service.ingest(inventory(2, [driver(runtimeB)]), source())
    expect(result.disappeared).toHaveLength(1)
    expect(result.disappeared[0]).toMatchObject({
      opaqueNativeRef: runtimeA,
      status: 'unavailable',
      health: 'unavailable',
      availabilityState: 'offline',
      diagnostics: ['RUNTIME_DISAPPEARED'],
    })
    expect(await fixture.registry.listByRuntimeNode(nodeId)).toHaveLength(2)
    expect(
      await fixture.service.expireDisappeared(nodeId, '2026-08-25T12:00:31.000Z')
    ).toHaveLength(0)
    const expired = await fixture.service.expireDisappeared(nodeId, '2026-08-25T12:00:32.000Z')
    expect(expired).toHaveLength(1)
    expect(expired[0].status).toBe('expired')
    expect(await fixture.registry.listByRuntimeNode(nodeId)).toHaveLength(2)
  })

  test('applies deltas against the exact durable base and handles explicit removal', async () => {
    const fixture = createFixture()
    await fixture.service.ingest(inventory(1, [driver(runtimeA)]), source())
    const delta = inventory(2, [driver(runtimeB)], {
      mode: 'delta',
      baseSnapshotVersion: 1,
      removedRuntimeRefs: [runtimeA],
    })
    const result = await fixture.service.ingest(delta, source())
    expect(result).toMatchObject({ outcome: 'applied', updated: [{ opaqueNativeRef: runtimeB }] })
    expect(result.disappeared[0].opaqueNativeRef).toBe(runtimeA)
    await expect(
      fixture.service.ingest(inventory(3, [], { mode: 'delta', baseSnapshotVersion: 1 }), source())
    ).rejects.toMatchObject({ code: 'INVENTORY_DELTA_BASE_MISMATCH' })
  })

  test('survives reconnect through a shared checkpoint and ignores stale reports', async () => {
    const fixture = createFixture()
    await fixture.service.ingest(inventory(2, [driver(runtimeA)]), source())
    const reconnected = createFixture({
      repository: fixture.repository,
      checkpoints: fixture.checkpoints,
    })
    const stale = await reconnected.service.ingest(
      inventory(1, [], { channelGeneration: 2 }),
      source(2)
    )
    expect(stale.outcome).toBe('stale')
    expect((await reconnected.registry.listByRuntimeNode(nodeId))[0].status).toBe('connected')
    const current = await reconnected.service.ingest(
      inventory(3, [driver(runtimeA)], { channelGeneration: 2 }),
      source(2)
    )
    expect(current.outcome).toBe('applied')
  })

  test('fails closed for wrong scope, version reuse, and normalization correlation', async () => {
    const fixture = createFixture()
    await expect(
      fixture.service.ingest(inventory(1, [driver(runtimeA)]), {
        ...source(),
        workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG',
      })
    ).rejects.toMatchObject({ code: 'INVENTORY_SCOPE_MISMATCH' })

    await fixture.service.ingest(inventory(1, [driver(runtimeA)]), source())
    await expect(
      fixture.service.ingest(inventory(1, [driver(runtimeB)]), source())
    ).rejects.toMatchObject({ code: 'INVENTORY_VERSION_CONFLICT' })

    const mismatched = createFixture({ mismatched: true })
    await expect(
      mismatched.service.ingest(inventory(1, [driver(runtimeA)]), source())
    ).rejects.toBeInstanceOf(RuntimeInventoryIngestionError)
    await expect(
      mismatched.service.ingest(inventory(1, [driver(runtimeA)]), source())
    ).rejects.toMatchObject({ code: 'INVENTORY_CORRELATION_MISMATCH' })
  })

  test('rejects invalid v1.2 delta and version metadata at the protocol boundary', async () => {
    const fixture = createFixture()
    await expect(
      fixture.service.ingest(
        inventory(1, [driver(runtimeA)], { mode: 'delta', baseSnapshotVersion: undefined }),
        source()
      )
    ).rejects.toThrow()
    const missingAdapter = inventory(1, [driver(runtimeA)])
    delete missingAdapter.runtimeDrivers[0].adapterVersion
    await expect(fixture.service.ingest(missingAdapter, source())).rejects.toThrow()
  })
})

function createFixture(options = {}) {
  const repository = options.repository ?? new InMemoryRuntimeConnectionRepository()
  const checkpoints = options.checkpoints ?? new InMemoryRuntimeInventoryCheckpointRepository()
  const registry = new RuntimeConnectionRegistry(repository)
  const changes = new RecordingRuntimeAvailabilityChangePublisher()
  const health = new RuntimeHealthIngestionService({
    registry,
    changes,
    policy: {
      adapterMajor: 1,
      driverMajor: 1,
      harnessMajor: 1,
      protocolMajor: 1,
      healthTtlMs: 60_000,
      maximumCapabilityTtlMs: 60_000,
    },
  })
  const metrics = new RecordingGatewayMetrics()
  const normalizer = {
    async normalize({ driver: input, inventory: report, nodeStatus }) {
      const suffix = input.opaqueRef === runtimeA ? 'A' : 'B'
      const runtimeConnectionId = `rtc_01J${suffix}BCDEF0123456789ABCDEFG`
      const observedBefore = new Date(Date.parse(report.observedAt) - 1).toISOString()
      const registration = {
        runtimeConnectionId,
        identityDigest: `sha256:${suffix.toLowerCase().repeat(64)}`,
        connectionType: 'managed_local',
        runtimeNodeRefId: options.mismatched ? 'rnr_01JBBCDEF0123456789ABCDEFG' : report.nodeId,
        runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
        location: 'local_device',
        opaqueNativeRef: input.opaqueRef,
        adapterVersion: input.adapterVersion,
        driverVersion: input.driverVersion,
        harnessVersion: input.harnessVersion,
        status:
          input.health === 'healthy'
            ? 'connected'
            : input.health === 'degraded'
              ? 'degraded'
              : 'unavailable',
        health: input.health,
        capabilities: [],
        compatibilityState: 'untested',
        limitations: input.limitations,
        lastDiscoveredAt: observedBefore,
        lastHeartbeatAt: observedBefore,
        lastHealthCheckAt: observedBefore,
      }
      return {
        registration,
        healthReport: {
          runtimeConnectionId,
          reportSequence: report.snapshotVersion,
          observedAt: report.observedAt,
          discoveredAt: report.observedAt,
          nodeStatus,
          runtimeState: input.health === 'unavailable' ? 'offline' : input.health,
          versions: {
            adapter: input.adapterVersion,
            driver: input.driverVersion,
            harness: input.harnessVersion,
            protocol: `${input.protocolVersion.major}.${input.protocolVersion.minor}.0`,
          },
          capabilitySnapshot: {
            version: report.snapshotVersion,
            observedAt: report.observedAt,
            ttlMs: 60_000,
            verification: 'verified',
            source: 'adapter_driver_negotiation',
            capabilities: [],
          },
          limitations: input.limitations,
          diagnostics: [],
        },
      }
    },
  }
  const projections = {
    runtimeConnections: [],
    async putRuntimeConnection(workspaceId, model) {
      this.runtimeConnections.push({ workspaceId, model })
    },
  }
  return {
    repository,
    checkpoints,
    registry,
    changes,
    projections,
    health,
    service: new RuntimeInventoryIngestionService({
      registry,
      health,
      checkpoints,
      changes,
      normalizer: options.normalizer ?? normalizer,
      projections,
      metrics,
      disappearanceTtlMs: 30_000,
    }),
  }
}

function source(channelGeneration = 1) {
  return {
    nodeId,
    workspaceId,
    gatewayInstanceId: 'gateway-a',
    connectionId: `connection-${channelGeneration}`,
    channelGeneration,
    protocolVersion: { major: 1, minor: 2 },
    connectedAt: '2026-08-25T11:59:00.000Z',
    lastHeartbeatAt: '2026-08-25T12:00:00.000Z',
  }
}

function driver(opaqueRef, health = 'healthy') {
  return {
    opaqueRef,
    driverFamily: 'reference-runtime',
    adapterVersion: '1.0.0',
    driverVersion: '1.0.0',
    harnessVersion: '1.0.0',
    protocolVersion: { major: 1, minor: 2 },
    health,
    capabilities: ['runtime.execute'],
    limitations: [],
  }
}

function inventory(snapshotVersion, runtimeDrivers, extra = {}) {
  return {
    type: 'inventory',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 2 },
    sequence: snapshotVersion,
    nodeId,
    workspaceId,
    traceId: 'trc_01JABCDEF0123456789ABCDEFG',
    sentAt: new Date(
      Date.parse('2026-08-25T12:00:00.000Z') + snapshotVersion * 1_000
    ).toISOString(),
    channelGeneration: 1,
    mode: 'snapshot',
    snapshotVersion,
    observedAt: new Date(
      Date.parse('2026-08-25T12:00:00.000Z') + snapshotVersion * 1_000
    ).toISOString(),
    runtimeDrivers,
    contextProviders: [],
    removedRuntimeRefs: [],
    ...extra,
  }
}
