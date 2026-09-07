import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqlitePersistenceProvider } from './index.ts'

const resources = []
afterEach(async () => {
  for (const { directory, provider } of resources.splice(0)) {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('removes a partially written staging file and preserves live data on write failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-restore-validation-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'live.sqlite') })
  resources.push({ directory, provider })
  await provider.migrate()
  await provider.transaction((tx) =>
    tx.put({ namespace: 'commands', id: 'preserved', value: { accepted: true } })
  )
  const snapshot = await provider.backup()
  const sample = await open(join(directory, 'handle-sample'), 'wx')
  const prototype = Object.getPrototypeOf(sample)
  await sample.close()
  const originalWrite = prototype.writeFile
  const write = spyOn(prototype, 'writeFile').mockImplementation(async function (bytes) {
    await originalWrite.call(this, bytes.subarray(0, 8))
    throw Object.assign(new Error('Synthetic disk exhaustion'), { code: 'ENOSPC' })
  })
  try {
    await expect(provider.restore(snapshot)).rejects.toMatchObject({ code: 'ENOSPC' })
  } finally {
    write.mockRestore()
  }
  expect((await readdir(directory)).filter((name) => name.includes('.restore-'))).toEqual([])
  expect(await provider.transaction((tx) => tx.get('commands', 'preserved'))).toMatchObject({
    value: { accepted: true },
  })
})

for (const fixture of [
  'corrupt',
  'future-schema',
  'unrelated-database',
  'missing-record-columns',
  'missing-record-constraints',
  'missing-index',
  'changed-migration-history',
]) {
  test(`rejects a digest-valid ${fixture} backup without replacing live records`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sqlite-restore-validation-'))
    const provider = new SqlitePersistenceProvider({ path: join(directory, 'live.sqlite') })
    resources.push({ directory, provider })
    await provider.migrate()
    await provider.transaction((tx) =>
      tx.put({ namespace: 'commands', id: 'preserved', value: { accepted: true } })
    )
    let bytes = new Uint8Array([1, 2, 3])
    if (fixture !== 'corrupt') {
      const path = join(directory, 'fixture.sqlite')
      const database = new DatabaseSync(path)
      try {
        if (
          fixture === 'missing-record-constraints' ||
          fixture === 'missing-index' ||
          fixture === 'changed-migration-history'
        ) {
          const source = new DatabaseSync(join(directory, 'live.sqlite'))
          try {
            for (const row of source
              .prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type DESC')
              .all()) {
              database.exec(row.sql)
            }
          } finally {
            source.close()
          }
          database.exec("INSERT INTO control_plane_metadata VALUES ('schema_version', '1')")
          if (fixture === 'changed-migration-history') {
            database.exec(
              "INSERT INTO control_plane_metadata VALUES ('migration:1', 'incorrect-checksum')"
            )
          } else if (fixture === 'missing-index') {
            database.exec('DROP INDEX control_plane_records_namespace_updated')
          } else {
            database.exec(
              'DROP TABLE control_plane_records; CREATE TABLE control_plane_records (namespace TEXT, id TEXT, revision INTEGER, value TEXT, updated_at TEXT)'
            )
          }
        } else if (fixture === 'missing-record-columns') {
          database.exec(
            "CREATE TABLE control_plane_metadata (key TEXT PRIMARY KEY, value TEXT); INSERT INTO control_plane_metadata VALUES ('schema_version', '1'); CREATE TABLE control_plane_records (id TEXT);"
          )
        } else if (fixture === 'future-schema') {
          database.exec(
            "CREATE TABLE control_plane_metadata (key TEXT PRIMARY KEY, value TEXT); INSERT INTO control_plane_metadata VALUES ('schema_version', '999');"
          )
        } else {
          database.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)')
        }
      } finally {
        database.close()
      }
      bytes = new Uint8Array(await readFile(path))
    }
    const snapshot = {
      schemaVersion: 1,
      createdAt: '2026-09-07T00:00:00.000Z',
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      bytes,
    }
    await expect(provider.restore(snapshot)).rejects.toMatchObject({
      code: 'SQLITE_BACKUP_INVALID',
    })
    expect(await provider.transaction((tx) => tx.get('commands', 'preserved'))).toMatchObject({
      value: { accepted: true },
    })
    expect(await provider.health()).toMatchObject({ ready: true })
    provider.close()
    await provider.migrate()
    expect(await provider.transaction((tx) => tx.get('commands', 'preserved'))).toMatchObject({
      value: { accepted: true },
    })
    expect((await readdir(directory)).filter((name) => name.includes('.restore-'))).toEqual([])
  })
}
