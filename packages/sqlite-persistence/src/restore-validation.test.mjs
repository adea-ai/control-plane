import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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

for (const fixture of [
  'corrupt',
  'future-schema',
  'unrelated-database',
  'missing-record-columns',
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
        if (fixture === 'missing-record-columns') {
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
