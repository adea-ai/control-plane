import { describe, expect, test } from 'bun:test'
import {
  InMemoryRuntimeConnectionRepository,
  RuntimeConnectionRegistry,
  RuntimeConnectionRegistryError,
  RuntimeConnectionSchema,
} from './index.ts'

const at = {
  discovered: '2026-08-24T20:00:00.000Z',
  heartbeat: '2026-08-24T20:01:00.000Z',
  health: '2026-08-24T20:02:00.000Z',
  updated: '2026-08-24T20:03:00.000Z',
  expired: '2026-08-24T20:10:00.000Z',
}

function registration(overrides = {}) {
  return {
    runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
    identityDigest: `sha256:${'1'.repeat(64)}`,
    connectionType: 'managed_local',
    runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
    runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
    location: 'local_device',
    opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFG',
    adapterVersion: '1.0.0',
    driverVersion: '1.0.0',
    harnessVersion: '1.0.0',
    status: 'connected',
    health: 'healthy',
    capabilities: [
      { name: 'stream.output', support: 'supported' },
      { name: 'execution.cancel', support: 'supported' },
    ],
    compatibilityState: 'compatible',
    limitations: [],
    lastDiscoveredAt: at.discovered,
    lastHeartbeatAt: at.heartbeat,
    lastHealthCheckAt: at.health,
    expiresAt: at.expired,
    ...overrides,
  }
}

describe('RuntimeConnection registry', () => {
  test('scans node-scoped history in bounded stable pages', async () => {
    const repository = new InMemoryRuntimeConnectionRepository()
    const registry = new RuntimeConnectionRegistry(repository)
    const records = []
    for (const index of [3, 1, 2, 4])
      records.push(
        await registry.register(
          registration({
            runtimeConnectionId: `rtc_01ZRZ3NDEKTSV4RRFFQ69G5FA${index}`,
            identityDigest: `sha256:${String(index).repeat(64)}`,
            runtimeNodeRefId:
              index === 4 ? 'rnr_01ZRZ3NDEKTSV4RRFFQ69G5FAV' : registration().runtimeNodeRefId,
          })
        )
      )
    const query = { runtimeNodeRefId: registration().runtimeNodeRefId, limit: 2 }
    const first = await repository.scanByRuntimeNode(query)
    expect(first).toEqual([records[1], records[2]])
    const last = await repository.scanByRuntimeNode({
      ...query,
      afterConnectionId: first[1].runtimeConnectionId,
    })
    expect(last).toEqual([records[0]])
    expect(
      await repository.scanByRuntimeNode({
        ...query,
        afterConnectionId: last[0].runtimeConnectionId,
      })
    ).toEqual([])
    for (const invalid of [
      { ...query, limit: 0 },
      { ...query, limit: 129 },
      { ...query, afterConnectionId: 'bad' },
    ])
      await expect(repository.scanByRuntimeNode(invalid)).rejects.toThrow()
  })
  test('stores multiple runtime endpoints on one Agent HQ node without conflating health', async () => {
    const registry = new RuntimeConnectionRegistry(new InMemoryRuntimeConnectionRepository())
    const healthy = await registry.register(registration())
    const degraded = await registry.register(
      registration({
        runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG',
        identityDigest: `sha256:${'2'.repeat(64)}`,
        runtimeDefinitionId: 'rtd_01JBBCDEF0123456789ABCDEFG',
        opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFH',
        status: 'degraded',
        health: 'degraded',
        compatibilityState: 'degraded',
        limitations: ['Structured output is unavailable'],
      })
    )

    expect(healthy.health).toBe('healthy')
    expect(degraded.health).toBe('degraded')
    expect(await registry.listByRuntimeNode(healthy.runtimeNodeRefId)).toEqual([healthy, degraded])
  })

  test('supports managed-cloud, managed-local, and external-local identities', async () => {
    const registry = new RuntimeConnectionRegistry(new InMemoryRuntimeConnectionRepository())
    const managedCloud = await registry.register(
      registration({
        runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFH',
        identityDigest: `sha256:${'3'.repeat(64)}`,
        connectionType: 'managed_cloud',
        runtimeNodeRefId: undefined,
        location: 'agent_hq_cloud',
        opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFJ',
      })
    )
    const externalLocal = await registry.register(
      registration({
        runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFJ',
        identityDigest: `sha256:${'4'.repeat(64)}`,
        connectionType: 'external_local',
        opaqueNativeRef: 'nref_01JABCDEF0123456789ABCDEFK',
      })
    )

    expect(managedCloud.runtimeNodeRefId).toBeUndefined()
    expect(externalLocal.runtimeNodeRefId).toBe('rnr_01JABCDEF0123456789ABCDEFG')
    expect(() =>
      RuntimeConnectionSchema.parse({
        ...managedCloud,
        connectionType: 'external_local',
      })
    ).toThrow()
  })

  test('registers stable runtime identity idempotently under concurrency', async () => {
    const registry = new RuntimeConnectionRegistry(new InMemoryRuntimeConnectionRepository())
    const [first, second] = await Promise.all([
      registry.register(registration()),
      registry.register(registration()),
    ])

    expect(second).toEqual(first)
    expect(first.version).toBe(1)
    expect(await registry.get(first.runtimeConnectionId)).toEqual(first)
    await expect(
      registry.register(
        registration({
          runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFK',
        })
      )
    ).rejects.toMatchObject({ code: 'STABLE_IDENTITY_CONFLICT' })
  })

  test('updates heartbeats and health with optimistic concurrency', async () => {
    const registry = new RuntimeConnectionRegistry(new InMemoryRuntimeConnectionRepository())
    const connection = await registry.register(registration())
    const update = {
      runtimeConnectionId: connection.runtimeConnectionId,
      expectedVersion: connection.version,
      observedAt: at.updated,
      lastHeartbeatAt: at.updated,
      lastHealthCheckAt: at.updated,
      status: 'degraded',
      health: 'degraded',
      capabilities: [{ name: 'stream.output', support: 'degraded' }],
      compatibilityState: 'degraded',
      limitations: ['Heartbeat latency exceeded threshold'],
    }
    const outcomes = await Promise.allSettled([
      registry.update(update),
      registry.update({ ...update, limitations: ['Concurrent conflicting health report'] }),
    ])

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(await registry.get(connection.runtimeConnectionId)).toMatchObject({
      version: 2,
      status: 'degraded',
      health: 'degraded',
      lastHeartbeatAt: at.updated,
    })
  })

  test('disconnects, expires, and revokes without deleting historical identities', async () => {
    const registry = new RuntimeConnectionRegistry(new InMemoryRuntimeConnectionRepository())
    const disconnected = await registry.disconnect({
      runtimeConnectionId: (await registry.register(registration())).runtimeConnectionId,
      expectedVersion: 1,
      observedAt: at.updated,
    })
    expect(disconnected).toMatchObject({
      status: 'disconnected',
      health: 'unavailable',
      version: 2,
    })

    const expired = await registry.expire({
      runtimeConnectionId: disconnected.runtimeConnectionId,
      expectedVersion: disconnected.version,
      observedAt: at.expired,
    })
    expect(expired).toMatchObject({ status: 'expired', version: 3 })

    const revoked = await registry.revoke({
      runtimeConnectionId: expired.runtimeConnectionId,
      expectedVersion: expired.version,
      observedAt: '2026-08-24T20:11:00.000Z',
    })
    expect(revoked).toMatchObject({
      status: 'revoked',
      health: 'unavailable',
      compatibilityState: 'revoked',
      version: 4,
    })
    expect(await registry.get(revoked.runtimeConnectionId)).toEqual(revoked)
    await expect(
      registry.update({
        runtimeConnectionId: revoked.runtimeConnectionId,
        expectedVersion: revoked.version,
        observedAt: '2026-08-24T20:12:00.000Z',
        status: 'connected',
        health: 'healthy',
      })
    ).rejects.toMatchObject({ code: 'CONNECTION_REVOKED' })
  })

  test('rejects stale observations, premature expiry, and sensitive native configuration', async () => {
    const registry = new RuntimeConnectionRegistry(new InMemoryRuntimeConnectionRepository())
    const connection = await registry.register(registration())

    await expect(
      registry.update({
        runtimeConnectionId: connection.runtimeConnectionId,
        expectedVersion: connection.version,
        observedAt: '2026-08-24T19:59:00.000Z',
        status: 'unavailable',
        health: 'unavailable',
      })
    ).rejects.toMatchObject({ code: 'STALE_OBSERVATION' })
    await expect(
      registry.expire({
        runtimeConnectionId: connection.runtimeConnectionId,
        expectedVersion: connection.version,
        observedAt: at.updated,
      })
    ).rejects.toMatchObject({ code: 'CONNECTION_NOT_EXPIRED' })
    await expect(
      registry.register({
        ...registration({ identityDigest: `sha256:${'5'.repeat(64)}` }),
        rawPath: '/Users/operator/private-project',
        credential: 'top-secret',
      })
    ).rejects.toBeInstanceOf(Error)
    expect(() =>
      RuntimeConnectionSchema.parse({
        ...connection,
        opaqueNativeRef: '/Users/operator/private-project',
      })
    ).toThrow()
    expect(RuntimeConnectionRegistryError).toBeDefined()
  })
})
