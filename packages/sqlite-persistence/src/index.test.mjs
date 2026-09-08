import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceError, SqlitePersistenceProvider } from './index.ts'

const providers = []
const directories = []

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.close()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function provider() {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-'))
  directories.push(directory)
  const instance = new SqlitePersistenceProvider({
    path: join(directory, 'control-plane.sqlite'),
    now: () => new Date('2026-08-29T00:00:00.000Z'),
  })
  providers.push(instance)
  await instance.migrate()
  return { directory, instance }
}

describe('SQLite persistence provider', () => {
  test('scans bounded namespace pages by exclusive storage ID across reopen', async () => {
    const { instance } = await provider()
    for (const id of ['c', 'a', 'b']) {
      await instance.transaction((tx) => tx.put({ namespace: 'scan', id, value: { id } }))
    }
    await instance.transaction((tx) => tx.put({ namespace: 'other', id: 'bb', value: null }))
    const first = await instance.transaction((tx) => tx.scan('scan', { limit: 2 }))
    expect(first.map((row) => row.id)).toEqual(['a', 'b'])
    instance.close()
    await instance.migrate()
    const second = await instance.transaction((tx) =>
      tx.scan('scan', { limit: 2, afterId: first.at(-1).id })
    )
    expect(second.map((row) => row.id)).toEqual(['c'])
    expect(await instance.transaction((tx) => tx.scan('scan', { limit: 2, afterId: 'c' }))).toEqual(
      []
    )
    expect(await instance.transaction((tx) => tx.scan('missing', { limit: 1 }))).toEqual([])
    for (const limit of [0, -1, 1.5, 129, NaN, Infinity]) {
      await expect(instance.transaction((tx) => tx.scan('scan', { limit }))).rejects.toMatchObject({
        code: 'SQLITE_INVALID_RECORD',
      })
    }
    for (const afterId of ['', '\u0000', 'x'.repeat(513)]) {
      await expect(
        instance.transaction((tx) => tx.scan('scan', { limit: 1, afterId }))
      ).rejects.toMatchObject({ code: 'SQLITE_INVALID_RECORD' })
    }
    await expect(
      instance.transaction((tx) => tx.scan('INVALID', { limit: 1 }))
    ).rejects.toMatchObject({ code: 'SQLITE_INVALID_RECORD' })
  })

  test('adopts a legacy file and retains its migration history through backup and reopen', async () => {
    const { directory, instance } = await provider()
    await instance.transaction((transaction) =>
      transaction.put({ namespace: 'commands', id: 'retained', value: { status: 'accepted' } })
    )
    instance.close()
    const native = new DatabaseSync(join(directory, 'control-plane.sqlite'))
    native.exec("DELETE FROM control_plane_metadata WHERE key LIKE 'migration:%'")
    native.close()
    await instance.migrate()
    const snapshot = await instance.backup()
    instance.close()
    await instance.migrate()
    await instance.restore(snapshot)
    await instance.migrate()
    expect(
      await instance.transaction((transaction) => transaction.get('commands', 'retained'))
    ).toMatchObject({ revision: 1, value: { status: 'accepted' } })
    instance.close()
    const check = new DatabaseSync(join(directory, 'control-plane.sqlite'))
    try {
      expect(
        check.prepare("SELECT value FROM control_plane_metadata WHERE key = 'migration:1'").get()
          .value
      ).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      check.close()
    }
  })

  test('rejects a future schema without creating current-version objects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-version-'))
    const path = join(directory, 'state.sqlite')
    const native = new DatabaseSync(path)
    native.exec(
      "CREATE TABLE control_plane_metadata (key TEXT PRIMARY KEY, value TEXT); INSERT INTO control_plane_metadata VALUES ('schema_version', '999')"
    )
    const before = native.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all()
    const instance = new SqlitePersistenceProvider({ path })
    try {
      await expect(instance.migrate()).rejects.toMatchObject({ code: 'SQLITE_SCHEMA_INCOMPATIBLE' })
      expect(native.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all()).toEqual(
        before
      )
    } finally {
      instance.close()
      native.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rolls back schema creation when a migration statement fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-sqlite-migration-'))
    const path = join(directory, 'state.sqlite')
    const native = new DatabaseSync(path)
    native.exec('CREATE TABLE control_plane_records (id TEXT)')
    const before = native.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all()
    const instance = new SqlitePersistenceProvider({ path })
    try {
      await expect(instance.migrate()).rejects.toThrow()
      expect(native.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all()).toEqual(
        before
      )
    } finally {
      instance.close()
      native.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('uses WAL, owner-only files, and optimistic durable records', async () => {
    const { directory, instance } = await provider()
    const created = await instance.transaction((transaction) =>
      transaction.put({ namespace: 'project-state', id: 'item-1', value: { status: 'ready' } })
    )
    expect(created.revision).toBe(1)
    expect(
      await instance.transaction((transaction) => transaction.get('project-state', 'item-1'))
    ).toEqual(created)

    const updated = await instance.transaction((transaction) =>
      transaction.put({
        namespace: 'project-state',
        id: 'item-1',
        expectedRevision: 1,
        value: { status: 'complete' },
      })
    )
    expect(updated.revision).toBe(2)
    expect((await stat(join(directory, 'control-plane.sqlite'))).mode & 0o777).toBe(0o600)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect(await instance.health()).toMatchObject({ ready: true, component: 'sqlite-persistence' })
  })

  test('fails closed on stale revisions and rolls the transaction back', async () => {
    const { instance } = await provider()
    await instance.transaction((transaction) =>
      transaction.put({ namespace: 'executions', id: 'execution-1', value: { state: 'queued' } })
    )

    await expect(
      instance.transaction(async (transaction) => {
        await transaction.put({
          namespace: 'executions',
          id: 'execution-1',
          expectedRevision: 1,
          value: { state: 'running' },
        })
        await transaction.put({
          namespace: 'executions',
          id: 'execution-1',
          expectedRevision: 1,
          value: { state: 'completed' },
        })
      })
    ).rejects.toMatchObject({ code: 'SQLITE_REVISION_CONFLICT' })

    expect(
      await instance.transaction((transaction) => transaction.get('executions', 'execution-1'))
    ).toMatchObject({ revision: 1, value: { state: 'queued' } })
  })

  test('backs up and restores a digest-verified database', async () => {
    const { directory, instance } = await provider()
    await instance.transaction((transaction) =>
      transaction.put({ namespace: 'commands', id: 'command-1', value: { status: 'accepted' } })
    )
    const snapshot = await instance.backup()
    expect(snapshot.bytes.byteLength).toBeGreaterThan(0)

    await instance.transaction((transaction) => transaction.delete('commands', 'command-1', 1))
    await instance.restore(snapshot)
    expect(
      await instance.transaction((transaction) => transaction.get('commands', 'command-1'))
    ).toMatchObject({ revision: 1, value: { status: 'accepted' } })
    expect((await readFile(join(directory, 'control-plane.sqlite'))).byteLength).toBeGreaterThan(0)
  })

  test('rejects in-memory paths and tampered backups', async () => {
    expect(() => new SqlitePersistenceProvider({ path: ':memory:' })).toThrow(
      SqlitePersistenceError
    )
    const { instance } = await provider()
    const snapshot = await instance.backup()
    await expect(
      instance.restore({ ...snapshot, bytes: new Uint8Array([1, 2, 3]) })
    ).rejects.toMatchObject({ code: 'SQLITE_BACKUP_INVALID' })
  })
})
