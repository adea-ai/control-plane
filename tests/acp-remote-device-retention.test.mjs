// Replay-ledger retention and claim release for the durable device state, proven on both the in-memory
// store and the real SQLite PersistenceProvider store the Local profile runs. Capacity is a bound on
// live replay protection, not a lifetime cap: entries whose delivery window has closed are pruned
// inside the claim transaction, and a claim whose effect provably never started can be released.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '../packages/sqlite-persistence/src/provider.ts'
import {
  InMemoryAcpRemoteDeviceStateStore,
  PersistenceProviderAcpRemoteDeviceStateStore,
  acpRemoteDeviceStateScope,
} from '../packages/acp-adapter/src/acp-remote-device-state.ts'
import { routeRecord } from '../packages/acp-adapter/src/acp-remote-fixtures.mjs'

const T0 = Date.parse('2026-08-25T12:00:00.000Z')
const WINDOW_MS = 60_000
const cmd = (n) => `cmd_01JABCDEF0123456789ABCDEF${String(n)}`
const claim = (n, overrides = {}) => ({
  commandId: cmd(n),
  identity: `identity-${n}`,
  channelGeneration: 1,
  capacity: 2,
  expiresAtMs: T0 + WINDOW_MS,
  pruneExpiredAtOrBeforeMs: T0 - 30_000,
  ...overrides,
})

async function withStores(run) {
  const route = await routeRecord()
  await run('in-memory', () => new InMemoryAcpRemoteDeviceStateStore())
  const directory = await mkdtemp(join(tmpdir(), 'acp-device-retention-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    await run(
      'sqlite',
      () =>
        new PersistenceProviderAcpRemoteDeviceStateStore(provider, acpRemoteDeviceStateScope(route))
    )
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('replay ledger retention', () => {
  test('capacity admits live windows only, and closed windows are pruned at the bound', async () => {
    await withStores(async (name, create) => {
      const store = create()
      expect(await store.claim(claim(1)), name).toBe('claimed')
      expect(await store.claim(claim(2)), name).toBe('claimed')
      // Windows still open: the bound holds and nothing is pruned.
      expect(await store.claim(claim(3)), name).toBe('replay_ledger_full')
      expect(await store.countLedger(), name).toBe(2)

      // Past both windows plus skew: the third claim prunes them and is admitted.
      const later = T0 + WINDOW_MS + 31_000
      expect(
        await store.claim(
          claim(3, { expiresAtMs: later + WINDOW_MS, pruneExpiredAtOrBeforeMs: later - 30_000 })
        ),
        name
      ).toBe('claimed')
      expect(await store.countLedger(), name).toBe(1)
      expect(await store.readLedger(cmd(1)), name).toBeUndefined()
      expect(await store.readLedger(cmd(3)), name).toMatchObject({ identity: 'identity-3' })
    })
  })

  test('a window still inside the skew bound is retained', async () => {
    await withStores(async (name, create) => {
      const store = create()
      await store.claim(claim(1))
      await store.claim(claim(2))
      // Windows ended 10s ago but the skew bound reaches back 30s: not prunable yet.
      const now = T0 + WINDOW_MS + 10_000
      expect(
        await store.claim(
          claim(3, { expiresAtMs: now + WINDOW_MS, pruneExpiredAtOrBeforeMs: now - 30_000 })
        ),
        name
      ).toBe('replay_ledger_full')
    })
  })

  test('a recorded outcome keeps its retention window and survives until it closes', async () => {
    await withStores(async (name, create) => {
      const store = create()
      await store.claim(claim(1))
      await store.recordOutcome(cmd(1), { kind: 'denial', reason: 'device_revoked' })
      expect(await store.readLedger(cmd(1)), name).toEqual({
        identity: 'identity-1',
        expiresAtMs: T0 + WINDOW_MS,
        outcome: { kind: 'denial', reason: 'device_revoked' },
      })
    })
  })
})

describe('claim release', () => {
  test('abandonClaim removes only an unrecorded claim with the same identity', async () => {
    await withStores(async (name, create) => {
      const store = create()
      await store.claim(claim(1))
      // A different identity never removes someone else's claim.
      await store.abandonClaim(cmd(1), 'identity-other')
      expect(await store.readLedger(cmd(1)), name).toMatchObject({ identity: 'identity-1' })

      await store.abandonClaim(cmd(1), 'identity-1')
      expect(await store.readLedger(cmd(1)), name).toBeUndefined()
      expect(await store.claim(claim(1)), name).toBe('claimed')

      // A recorded outcome is never erased: the effect may have run.
      await store.recordOutcome(cmd(1), { kind: 'denial', reason: 'device_revoked' })
      await store.abandonClaim(cmd(1), 'identity-1')
      expect(await store.readLedger(cmd(1)), name).toMatchObject({
        outcome: { kind: 'denial', reason: 'device_revoked' },
      })
      // Abandoning an absent claim is a no-op.
      await store.abandonClaim(cmd(2), 'identity-2')
    })
  })
})
