// Hosted PostgreSQL durable-state qualification for the secure ACP device route (#1023/#1040):
// the real `PersistenceProvider` record-store contract over PostgreSQL and the device fence/ledger
// store's atomic claim semantics, revocation persistence, restart behavior, and per-route
// namespacing on that provider. Every case derives a disposable isolated database through the
// repository's supported fixture (createIsolatedTestDatabase); no shared container, server, or port
// is touched by this file, and only the fixture writes.
import { describe, expect, test } from 'bun:test'
import { createIsolatedTestDatabase } from '@control-plane/database/testing'
import {
  PersistenceProviderAcpRemoteDeviceStateStore,
  acpRemoteDeviceStateScope,
} from '@control-plane/acp-adapter'
import { PostgresPersistenceProvider } from '@control-plane/profile-portability'
import { loadDatabaseCredentials } from '@control-plane/config'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'

const route = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
  deviceKeyId: 'dev_sig_0000000001',
}
const routeOther = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  nodeId: 'rnr_01JABCDEF0123456789ABCDEFH',
  runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFH',
  deviceKeyId: 'dev_sig_0000000002',
}

const COMMAND_A = 'cmd_01JABCDEF0123456789ABCDEFG'
const COMMAND_B = 'cmd_01JBBCDEF0123456789ABCDEFG'
const COMMAND_C = 'cmd_01JDBCDEF0123456789ABCDEFG'
const captured = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  )

async function withPostgresProvider(run) {
  const database = await createIsolatedTestDatabase({
    administration: loadDatabaseCredentials(process.env, 'administration'),
    application: loadDatabaseCredentials(process.env, 'application'),
    migration: loadDatabaseCredentials(process.env, 'migration'),
  })
  try {
    await database.migrate()
    const provider = new PostgresPersistenceProvider({ database: database.application })
    await provider.migrate()
    await provider.migrate() // idempotent, mirrors the SQLite provider's schema guard
    await run(provider, database)
    await provider.close()
  } finally {
    await database.dispose()
  }
}

describe.skipIf(!enabled)('hosted PostgreSQL durable state qualification', () => {
  test('the record-store contract holds over PostgreSQL with SQLite-identical conflict semantics', async () => {
    await withPostgresProvider(async (provider) => {
      const health = await provider.health()
      expect(health).toMatchObject({ ready: true, component: 'persistence-records' })

      const created = await provider.transaction((transaction) =>
        transaction.put({ namespace: 'n1', id: 'r1', value: { a: 1 } })
      )
      expect(created).toMatchObject({ namespace: 'n1', id: 'r1', revision: 1 })

      // Unconditional put over an existing record is a conflict, never a silent overwrite.
      await expect(
        provider.transaction((transaction) =>
          transaction.put({ namespace: 'n1', id: 'r1', value: { a: 2 } })
        )
      ).rejects.toThrow('REVISION_CONFLICT')
      // Optimistic CAS follows the recorded revision.
      const updated = await provider.transaction((transaction) =>
        transaction.put({ namespace: 'n1', id: 'r1', expectedRevision: 1, value: { a: 3 } })
      )
      expect(updated.revision).toBe(2)
      await expect(
        provider.transaction((transaction) =>
          transaction.put({ namespace: 'n1', id: 'r1', expectedRevision: 1, value: { a: 4 } })
        )
      ).rejects.toThrow('REVISION_CONFLICT')

      const read = await provider.transaction((transaction) => transaction.get('n1', 'r1'))
      expect(read).toMatchObject({ revision: 2, value: { a: 3 } })

      const listed = await provider.transaction((transaction) => transaction.list('n1'))
      expect(listed.map(({ id }) => id)).toEqual(['r1'])

      await provider.transaction((transaction) =>
        transaction.put({ namespace: 'n1', id: 'r2', value: { b: 1 } })
      )
      const page1 = await provider.transaction((transaction) =>
        transaction.scan('n1', { afterId: 'r1', limit: 128 })
      )
      expect(page1.map(({ id }) => id)).toEqual(['r2'])
      await expect(
        provider.transaction((transaction) => transaction.scan('n1', { limit: 0 }))
      ).rejects.toThrow('INVALID_RECORD')

      // Concurrent writers on one key: exactly one create wins; the loser conflicts.
      const [first, second] = await Promise.all([
        captured(
          provider.transaction((transaction) =>
            transaction.put({ namespace: 'race', id: 'k', value: { winner: 'a' } })
          )
        ),
        captured(
          provider.transaction((transaction) =>
            transaction.put({ namespace: 'race', id: 'k', value: { winner: 'b' } })
          )
        ),
      ])
      expect([first, second].filter(({ error }) => error === undefined)).toHaveLength(1)
      const loser = [first, second].find(({ error }) => error !== undefined)
      expect(String(loser?.error)).toContain('REVISION_CONFLICT')

      expect(await provider.transaction((transaction) => transaction.delete('n1', 'r1', 2))).toBe(
        true
      )
      expect(
        await provider.transaction((transaction) => transaction.get('n1', 'r1'))
      ).toBeUndefined()
      expect(await provider.transaction((transaction) => transaction.delete('n1', 'r1'))).toBe(
        false
      )
    })
  })

  test('device fence/ledger claims are atomic, reject revoked and superseded deliveries, and survive a restart', async () => {
    await withPostgresProvider(async (provider, database) => {
      const store = new PersistenceProviderAcpRemoteDeviceStateStore(
        provider,
        acpRemoteDeviceStateScope(route)
      )
      expect(
        await store.claim({ commandId: COMMAND_A, identity: 'identity-a', channelGeneration: 2 })
      ).toBe('claimed')
      expect(
        await store.claim({ commandId: COMMAND_A, identity: 'identity-a', channelGeneration: 2 })
      ).toBe('already_claimed')
      expect(
        await store.claim({ commandId: COMMAND_B, identity: 'identity-b', channelGeneration: 1 })
      ).toBe('stale_channel_generation')
      expect(await store.readLedger(COMMAND_B)).toBeUndefined()
      await store.recordOutcome(COMMAND_A, { kind: 'denial', reason: 'executor_failed' })
      expect(await store.readLedger(COMMAND_A)).toMatchObject({
        outcome: { kind: 'denial', reason: 'executor_failed' },
      })

      // Two store instances over one PostgreSQL store racing the same command: exactly one claim.
      const concurrent = new PersistenceProviderAcpRemoteDeviceStateStore(
        provider,
        acpRemoteDeviceStateScope(route)
      )
      const [left, right] = await Promise.all([
        captured(
          concurrent.claim({ commandId: COMMAND_C, identity: 'race-c', channelGeneration: 2 })
        ),
        captured(store.claim({ commandId: COMMAND_C, identity: 'race-c', channelGeneration: 2 })),
      ])
      const results = [left, right].map(
        (result) => result.value ?? String(result.error?.message ?? result.error)
      )
      expect(results.filter((value) => value === 'claimed')).toHaveLength(1)
      expect(results.filter((value) => value === 'already_claimed')).toHaveLength(1)

      // Restart: a fresh provider and store over the same database must read the persisted fence
      // before anything can claim again.
      await store.applyRevocation('2026-08-25T12:00:10.000Z')
      const restartedProvider = new PostgresPersistenceProvider({ database: database.application })
      const restarted = new PersistenceProviderAcpRemoteDeviceStateStore(
        restartedProvider,
        acpRemoteDeviceStateScope(route)
      )
      expect(await restarted.loadFence()).toMatchObject({
        highestGeneration: 2,
        revokedAt: '2026-08-25T12:00:10.000Z',
      })
      expect(
        await restarted.claim({
          commandId: COMMAND_B,
          identity: 'identity-b',
          channelGeneration: 3,
        })
      ).toBe('device_revoked')
      expect(await restarted.readLedger(COMMAND_B)).toBeUndefined()
      expect(await restarted.countLedger()).toBe(2) // COMMAND_A and COMMAND_C
    })
  })

  test('fence and ledger records stay namespaced per authenticated route in one PostgreSQL store', async () => {
    await withPostgresProvider(async (provider) => {
      const storeA = new PersistenceProviderAcpRemoteDeviceStateStore(
        provider,
        acpRemoteDeviceStateScope(route)
      )
      const storeB = new PersistenceProviderAcpRemoteDeviceStateStore(
        provider,
        acpRemoteDeviceStateScope(routeOther)
      )
      expect(
        await storeA.claim({ commandId: COMMAND_A, identity: 'route-a', channelGeneration: 4 })
      ).toBe('claimed')
      expect(await storeB.loadFence()).toEqual({ highestGeneration: 0 })
      expect(
        await storeB.claim({ commandId: COMMAND_A, identity: 'route-b', channelGeneration: 1 })
      ).toBe('claimed')
      await storeA.recordOutcome(COMMAND_A, { kind: 'denial', reason: 'executor_failed' })
      expect(await storeB.readLedger(COMMAND_A)).toEqual({ identity: 'route-b' })
      await storeA.applyRevocation('2026-08-25T12:00:10.000Z')
      expect(await storeB.loadFence()).toEqual({ highestGeneration: 1 })
      expect(
        await storeB.claim({ commandId: COMMAND_B, identity: 'route-b', channelGeneration: 2 })
      ).toBe('claimed')
      expect(
        await storeA.claim({ commandId: COMMAND_B, identity: 'route-a', channelGeneration: 2 })
      ).toBe('device_revoked')
    })
  })

  function parkingGate() {
    let announce
    const reached = new Promise((resolve) => {
      announce = resolve
    })
    let release
    const barrier = new Promise((resolve) => {
      release = resolve
    })
    return { reached, announce, release: () => release(), barrier }
  }

  /**
   * Wraps the REAL database so the first awaited `.limit(...)` SELECT — the claim's persisted
   * fence read, or the delete's observed read — pauses before its rows are handed back. The
   * competing writer commits on a DIFFERENT pool connection while the parked transaction holds no
   * row locks; provider, SQL, and isolation are the real ones, only the pause point is injected.
   */
  function parkingDatabase(database, gate) {
    let armed = true
    const proxiedSelect = (builder) =>
      new Proxy(builder, {
        get(target, property) {
          const value = target[property]
          if (typeof value !== 'function') return value
          if (property === 'then') return value.bind(target)
          return (...args) => {
            const result = value.apply(target, args)
            if (property === 'limit') {
              return (async () => {
                const rows = await result
                if (armed) {
                  armed = false
                  gate.announce()
                  await gate.barrier
                }
                return rows
              })()
            }
            if (result && typeof result === 'object' && typeof result.then === 'function') {
              return proxiedSelect(result)
            }
            return result
          }
        },
      })
    const wrapContext = (context) =>
      new Proxy(context, {
        get(target, property) {
          const value = target[property]
          if (property === 'select' && typeof value === 'function') {
            return (...args) => proxiedSelect(value.apply(target, args))
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    return new Proxy(database, {
      get(target, property) {
        const value = target[property]
        if (property === 'select' && typeof value === 'function') {
          return (...args) => proxiedSelect(value.apply(target, args))
        }
        if (property === 'transaction' && typeof value === 'function') {
          return async (callback) =>
            target.transaction(async (context) => callback(wrapContext(context)))
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  test('a revocation committing after the claim fence read wins and leaves no ledger reservation', async () => {
    await withPostgresProvider(async (provider, database) => {
      const gate = parkingGate()
      const claimant = new PersistenceProviderAcpRemoteDeviceStateStore(
        new PostgresPersistenceProvider({ database: parkingDatabase(database.application, gate) }),
        acpRemoteDeviceStateScope(route)
      )
      const other = new PersistenceProviderAcpRemoteDeviceStateStore(
        provider,
        acpRemoteDeviceStateScope(route)
      )
      // Seed the fence at generation 1 so the raced claim (also generation 1) reads an
      // UNCHANGED generation — exactly the path that used to skip fence participation.
      expect(
        await other.claim({ commandId: COMMAND_B, identity: 'seed', channelGeneration: 1 })
      ).toBe('claimed')

      const pending = captured(
        claimant.claim({ commandId: COMMAND_A, identity: 'race-a', channelGeneration: 1 })
      )
      // The claim is parked immediately after reading the persisted fence, on this connection.
      await gate.reached
      // The revocation commits on a DIFFERENT pool connection while the claim is parked.
      await other.applyRevocation('2026-08-25T12:00:10.000Z')
      gate.release()

      expect(await pending).toEqual({ value: 'device_revoked' })
      expect(await other.readLedger(COMMAND_A)).toBeUndefined()
      expect(await other.countLedger()).toBe(1)
      expect(await other.loadFence()).toMatchObject({
        highestGeneration: 1,
        revokedAt: '2026-08-25T12:00:10.000Z',
      })
    })
  })

  test('a higher-generation claim committing after the fence read supersedes the parked claim', async () => {
    await withPostgresProvider(async (provider, database) => {
      const gate = parkingGate()
      const claimant = new PersistenceProviderAcpRemoteDeviceStateStore(
        new PostgresPersistenceProvider({ database: parkingDatabase(database.application, gate) }),
        acpRemoteDeviceStateScope(route)
      )
      const other = new PersistenceProviderAcpRemoteDeviceStateStore(
        provider,
        acpRemoteDeviceStateScope(route)
      )
      // Fence seeded at generation 1 (COMMAND_C) so the raced generation-1 claim skips the fence
      // write it would otherwise perform against generation 0.
      expect(
        await other.claim({ commandId: COMMAND_C, identity: 'seed', channelGeneration: 1 })
      ).toBe('claimed')

      const pending = captured(
        claimant.claim({ commandId: COMMAND_A, identity: 'race-a', channelGeneration: 1 })
      )
      await gate.reached
      // A superseding generation commits on a DIFFERENT pool connection mid-claim.
      expect(
        await other.claim({ commandId: COMMAND_B, identity: 'race-b', channelGeneration: 2 })
      ).toBe('claimed')
      gate.release()

      expect(await pending).toEqual({ value: 'stale_channel_generation' })
      expect(await other.readLedger(COMMAND_A)).toBeUndefined()
      expect(await other.countLedger()).toBe(2)
      expect(await other.loadFence()).toMatchObject({ highestGeneration: 2 })
    })
  })

  test('a delete whose observed revision is replaced by a concurrent update reports revision-conflict', async () => {
    await withPostgresProvider(async (provider, database) => {
      await provider.transaction((transaction) =>
        transaction.put({ namespace: 'delete-race', id: 'r', value: { v: 1 } })
      )
      const gate = parkingGate()
      const parkedProvider = new PostgresPersistenceProvider({
        database: parkingDatabase(database.application, gate),
      })
      // Parks between the delete's observed read and its DELETE statement: the canonical contract
      // requires revision-conflict when that observed revision loses to a concurrent update.
      const parkedDelete = parkedProvider.transaction((transaction) =>
        transaction.delete('delete-race', 'r', 1)
      )
      await gate.reached
      await provider.transaction((transaction) =>
        transaction.put({ namespace: 'delete-race', id: 'r', expectedRevision: 1, value: { v: 2 } })
      )
      gate.release()

      await expect(parkedDelete).rejects.toThrow('REVISION_CONFLICT')
    })
  })
})
