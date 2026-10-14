// Replay-ledger retention and claim release for the durable device state, proven on both the in-memory
// store and the real SQLite PersistenceProvider store the Local profile runs. Capacity bounds LIVE
// entries, not the route's lifetime: entries whose delivery window has closed are compacted inside the
// claim transaction, but compaction never deletes duplicate protection, because a retry of the same
// command id with a fresh window passes the window fence. A claim whose effect provably never started
// can be released.
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
  compactExpiredAtOrBeforeMs: T0 - 30_000,
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

const exchange = { kind: 'exchange', exchange: { ack: { kind: 'ack' }, progress: [] } }
const later = T0 + WINDOW_MS + 31_000
/** A claim made after every earlier window (and the skew bound) has closed. */
const afterWindows = (n, overrides = {}) =>
  claim(n, {
    expiresAtMs: later + WINDOW_MS,
    compactExpiredAtOrBeforeMs: later - 30_000,
    ...overrides,
  })

describe('replay ledger retention', () => {
  test('capacity admits live windows only, and closed windows are compacted at the bound', async () => {
    await withStores(async (name, create) => {
      const store = create()
      expect(await store.claim(claim(1)), name).toBe('claimed')
      expect(await store.claim(claim(2)), name).toBe('claimed')
      // Windows still open: the bound holds and nothing is compacted.
      expect(await store.claim(claim(3)), name).toBe('replay_ledger_full')
      expect(await store.countLedger(), name).toBe(2)

      // Past both windows plus skew: the third claim compacts them and is admitted.
      expect(await store.claim(afterWindows(3)), name).toBe('claimed')
      expect(await store.countLedger(), name).toBe(1)
      expect(await store.readLedger(cmd(3)), name).toMatchObject({ identity: 'identity-3' })
      // The compacted claims keep their identity: nothing was deleted.
      expect(await store.readLedger(cmd(1)), name).toMatchObject({ identity: 'identity-1' })
      expect(await store.readLedger(cmd(2)), name).toMatchObject({ identity: 'identity-2' })
    })
  })

  test('a same-command retry with a fresh window after compaction is still a duplicate', async () => {
    await withStores(async (name, create) => {
      const store = create()
      // 1: pending (effect started, no outcome). 2: recorded exchange. 3 and 4 fill the live set.
      await store.claim(claim(1))
      await store.claim(claim(2))
      await store.recordOutcome(cmd(2), exchange)
      expect(await store.claim(afterWindows(3)), name).toBe('claimed')

      // Retrying the compacted commands with a fresh window never yields 'claimed'.
      expect(await store.claim(afterWindows(1)), name).toBe('already_claimed')
      expect(await store.claim(afterWindows(2)), name).toBe('already_claimed')
      // Pending stays pending (replays as outcome_uncertain); a recorded exchange, whose sealed
      // output is no longer retained, becomes outcome_uncertain. Neither can be re-executed.
      expect(await store.readLedger(cmd(1)), name).toEqual({
        identity: 'identity-1',
        expiresAtMs: T0 + WINDOW_MS,
      })
      expect(await store.readLedger(cmd(2)), name).toEqual({
        identity: 'identity-2',
        expiresAtMs: T0 + WINDOW_MS,
        outcome: { kind: 'denial', reason: 'outcome_uncertain' },
      })
    })
  })

  test('compaction keeps a recorded denial and accepts an outcome recorded after compaction', async () => {
    await withStores(async (name, create) => {
      const store = create()
      await store.claim(claim(1))
      await store.recordOutcome(cmd(1), { kind: 'denial', reason: 'device_revoked' })
      await store.claim(claim(2))
      expect(await store.claim(afterWindows(3)), name).toBe('claimed')
      expect(await store.readLedger(cmd(1)), name).toMatchObject({
        outcome: { kind: 'denial', reason: 'device_revoked' },
      })
      // A slow effect finishes after its entry was compacted: the exchange cannot be replayed.
      await store.recordOutcome(cmd(2), exchange)
      expect(await store.readLedger(cmd(2)), name).toMatchObject({
        outcome: { kind: 'denial', reason: 'outcome_uncertain' },
      })
      expect(await store.claim(afterWindows(2)), name).toBe('already_claimed')
    })
  })

  test('a window still inside the skew bound is retained live', async () => {
    await withStores(async (name, create) => {
      const store = create()
      await store.claim(claim(1))
      await store.claim(claim(2))
      // Windows ended 10s ago but the skew bound reaches back 30s: not compactable yet.
      const now = T0 + WINDOW_MS + 10_000
      expect(
        await store.claim(
          claim(3, { expiresAtMs: now + WINDOW_MS, compactExpiredAtOrBeforeMs: now - 30_000 })
        ),
        name
      ).toBe('replay_ledger_full')
    })
  })

  test('a recorded outcome keeps its retention window until it is compacted', async () => {
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

      // A claim compacted before its release is still released for the same identity only.
      await store.claim(claim(4))
      await store.claim(claim(5))
      expect(await store.claim(afterWindows(6)), name).toBe('claimed')
      await store.abandonClaim(cmd(4), 'identity-other')
      expect(await store.readLedger(cmd(4)), name).toMatchObject({ identity: 'identity-4' })
      await store.abandonClaim(cmd(4), 'identity-4')
      expect(await store.readLedger(cmd(4)), name).toBeUndefined()
    })
  })
})
