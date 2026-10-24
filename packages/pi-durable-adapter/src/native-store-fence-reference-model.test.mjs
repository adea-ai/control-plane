import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PiCancellationRegistrationCoordinator } from './cancellation-registration.ts'

// REFERENCE MODEL, test-only. A disposable SQLite "native store" with a C2-style fence, used to show
// that the dormant registration coordinator only needs the native port's fence ACK to be a real
// store-level fence for the closure to cover writers that never registered. This is not the SDK, not
// the candidate patch, and grants no authority.
const resources = []
afterEach(() => {
  for (const { databases, directory } of resources.splice(0)) {
    for (const database of databases) database.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
const generation = { lineageId: 'lineage:one', restoreGeneration: 'G:one', revision: 1 }
const owner = {
  ownerId: 'owner:one',
  processClaimId: 'process:one',
  ownerEpoch: 1,
  generation,
  scopes: ['scope:a'],
}
const mutation = { mutationId: 'mutation:one', generation, scopes: ['scope:a'] }

function nativeStore(directory, databases) {
  const database = new DatabaseSync(join(directory, 'native.sqlite'))
  databases.push(database)
  database.exec(`
    CREATE TABLE writes (id INTEGER PRIMARY KEY, writer TEXT NOT NULL);
    CREATE TABLE fence (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), epoch INTEGER NOT NULL);
    INSERT INTO fence (singleton, epoch) VALUES (1, 0);
    CREATE TABLE installs (request_digest TEXT PRIMARY KEY, store_epoch INTEGER NOT NULL);
  `)
  const epoch = () => database.prepare('SELECT epoch FROM fence').get().epoch
  return {
    database,
    epoch,
    /** A writer carries the epoch it last saw; the check and the write share one transaction. */
    write(writer, seenEpoch) {
      database.exec('BEGIN IMMEDIATE')
      try {
        if (epoch() !== seenEpoch) throw new Error('PI_STORE_FENCED')
        database.prepare('INSERT INTO writes (writer) VALUES (?)').run(writer)
        database.exec('COMMIT')
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    writes: () =>
      database
        .prepare('SELECT writer FROM writes ORDER BY id')
        .all()
        .map((row) => row.writer),
    /** F: dedupe by exact request, otherwise bump the store epoch once. */
    installFence(request) {
      const key = JSON.stringify(request)
      database.exec('BEGIN IMMEDIATE')
      try {
        let row = database
          .prepare('SELECT store_epoch FROM installs WHERE request_digest = ?')
          .get(key)
        if (!row) {
          database.prepare('UPDATE fence SET epoch = epoch + 1').run()
          row = { store_epoch: epoch() }
          database
            .prepare('INSERT INTO installs (request_digest, store_epoch) VALUES (?, ?)')
            .run(key, row.store_epoch)
        }
        database.exec('COMMIT')
        return row.store_epoch
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}

function fixture({ loseFirstResponse = false, unsupported = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-fence-model-'))
  const databases = []
  resources.push({ directory, databases })
  const store = nativeStore(directory, databases)
  const registry = new DatabaseSync(join(directory, 'registry.sqlite'))
  databases.push(registry)
  const authority = {
    async readCurrent() {
      return { ...generation, state: 'open' }
    },
  }
  let lost = loseFirstResponse
  const native = {
    async installFence(request) {
      if (unsupported) throw new Error('PI_STORE_FENCE_UNSUPPORTED')
      const storeEpoch = store.installFence(request)
      if (lost) {
        lost = false
        throw new Error('lost native response')
      }
      return {
        ...request,
        schemaVersion: 'pi-native-cancellation-fence-receipt/v1',
        installationReceiptId: `receipt:${storeEpoch}`,
        nativeCommitSequence: storeEpoch,
        installedAt: '2026-10-24T12:00:00.000Z',
      }
    },
  }
  return {
    store,
    coordinator: new PiCancellationRegistrationCoordinator(registry, authority, native),
  }
}

test('before F nothing stops an unregistered writer: the registry alone has no power', async () => {
  const f = fixture()
  await f.coordinator.register(owner)
  f.store.write('registered', 0)
  f.store.write('stranger', 0)
  expect(f.store.writes()).toEqual(['registered', 'stranger'])
})

test('a fenced closure also stops a writer that never registered', async () => {
  const f = fixture()
  await f.coordinator.register(owner)
  await f.coordinator.beginMutation(mutation)
  const evidence = await f.coordinator.installFences('mutation:one')
  expect(evidence.status).toBe('fenced')
  expect(evidence.qualifiedAuthorization).toBe(false)
  expect(f.store.epoch()).toBe(1)
  expect(() => f.store.write('stranger', 0)).toThrow('PI_STORE_FENCED')
  expect(() => f.store.write('registered', 0)).toThrow('PI_STORE_FENCED')
  expect(f.store.writes()).toEqual([])
})

test('a lost native response replays the same fence without bumping the store epoch twice', async () => {
  const f = fixture({ loseFirstResponse: true })
  await f.coordinator.register(owner)
  await f.coordinator.beginMutation(mutation)
  await expect(f.coordinator.installFences('mutation:one')).rejects.toThrow('lost native response')
  expect(f.store.epoch()).toBe(1)
  const evidence = await f.coordinator.installFences('mutation:one')
  expect(evidence.status).toBe('fenced')
  expect(f.store.epoch()).toBe(1)
})

test('a store that cannot fence never yields fenced evidence, and writers stay unfenced', async () => {
  const f = fixture({ unsupported: true })
  await f.coordinator.register(owner)
  const pending = await f.coordinator.beginMutation(mutation)
  expect(pending.status).toBe('pending')
  await expect(f.coordinator.installFences('mutation:one')).rejects.toThrow(
    'PI_STORE_FENCE_UNSUPPORTED'
  )
  expect((await f.coordinator.readEvidence('mutation:one')).status).toBe('pending')
  f.store.write('stranger', 0)
  expect(f.store.writes()).toEqual(['stranger'])
})
