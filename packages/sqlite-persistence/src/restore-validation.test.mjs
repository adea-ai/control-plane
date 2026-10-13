import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SqlitePersistenceProvider } from './provider.ts'
import {
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
  applyMigrations,
  SQLITE_MIGRATIONS,
} from './migrations.ts'
import {
  MAIN_C538_MIGRATION_CHECKSUMS,
  MAIN_C538_V3_STATEMENTS,
} from './main-c538-v3-migration.fixture.mjs'

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

test('restores a valid v1 backup by staging and applying the current indexes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-restore-v1-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'live.sqlite') })
  resources.push({ directory, provider })
  await provider.migrate()
  const sourcePath = join(directory, 'v1.sqlite')
  const source = new DatabaseSync(sourcePath)
  try {
    source.exec(Object.values(SCHEMA_STATEMENTS).join(';'))
    source.exec("INSERT INTO control_plane_metadata VALUES ('schema_version', '1')")
    source
      .prepare(
        'INSERT INTO control_plane_records(namespace, id, revision, value, updated_at) VALUES (?, ?, 1, ?, ?)'
      )
      .run(
        'command-inbox',
        'legacy',
        JSON.stringify({ retentionExpiresAt: '2026-01-01T00:00:00.000Z' }),
        '2026-01-01'
      )
  } finally {
    source.close()
  }
  const bytes = new Uint8Array(await readFile(sourcePath))
  await provider.restore({
    schemaVersion: 1,
    createdAt: '2026-09-22T00:00:00.000Z',
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes,
  })
  expect(await provider.transaction((tx) => tx.get('command-inbox', 'legacy'))).toMatchObject({
    value: { retentionExpiresAt: '2026-01-01T00:00:00.000Z' },
  })
  expect(await provider.health()).toMatchObject({ version: String(SCHEMA_VERSION) })
})

test('restores a main c538 v3 backup through the additive candidate migrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-restore-main-v3-'))
  const livePath = join(directory, 'live.sqlite')
  const provider = new SqlitePersistenceProvider({ path: livePath })
  resources.push({ directory, provider })
  await provider.migrate()
  const sourcePath = join(directory, 'main-v3.sqlite')
  const source = new DatabaseSync(sourcePath)
  const legacyPlan = {
    schemaVersion: 3,
    correlation: {
      workspaceId: 'wsp_main-v3-fixture',
      projectId: 'prj_main-v3-fixture',
      executionScope: {
        schemaVersion: 1,
        kind: 'project',
        projectId: 'prj_main-v3-fixture',
      },
    },
  }
  try {
    // Main v1/v2 match these frozen checksums; v3 is installed from the
    // independent c538 snapshot below, never candidate SQLITE_MIGRATIONS[2].
    expect(createHash('sha256').update(JSON.stringify(MAIN_C538_V3_STATEMENTS)).digest('hex')).toBe(
      MAIN_C538_MIGRATION_CHECKSUMS[2]
    )
    applyMigrations(source, SQLITE_MIGRATIONS.slice(0, 2))
    for (let version = 1; version <= 2; version++) {
      expect(
        source
          .prepare('SELECT value FROM control_plane_metadata WHERE key = ?')
          .get(`migration:${version}`).value
      ).toBe(MAIN_C538_MIGRATION_CHECKSUMS[version - 1])
    }
    source.exec(MAIN_C538_V3_STATEMENTS.join(';'))
    source
      .prepare('INSERT INTO control_plane_metadata (key, value) VALUES (?, ?)')
      .run('migration:3', MAIN_C538_MIGRATION_CHECKSUMS[2])
    source
      .prepare("UPDATE control_plane_metadata SET value = '3' WHERE key = 'schema_version'")
      .run()
    const insert = source.prepare(
      'INSERT INTO control_plane_records(namespace, id, revision, value, updated_at) VALUES (?, ?, 1, ?, ?)'
    )
    // Both records were accepted by the actual main-v3 triggers.
    insert.run(
      'command-inbox',
      'legacy-main-v3-command',
      JSON.stringify({ legacy: true }),
      '2026-10-13T00:00:00.000Z'
    )
    insert.run(
      'execution-plans',
      'legacy-main-v3-plan',
      JSON.stringify(legacyPlan),
      '2026-10-13T00:00:00.000Z'
    )
  } finally {
    source.close()
  }

  const bytes = new Uint8Array(await readFile(sourcePath))
  await provider.restore({
    schemaVersion: 3,
    createdAt: '2026-10-13T00:00:00.000Z',
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes,
  })
  expect(await provider.health()).toMatchObject({ version: String(SCHEMA_VERSION) })
  expect(
    await provider.transaction((tx) => tx.get('command-inbox', 'legacy-main-v3-command'))
  ).toMatchObject({
    value: { legacy: true },
  })
  expect(
    await provider.transaction((tx) => tx.get('execution-plans', 'legacy-main-v3-plan'))
  ).toMatchObject({
    value: legacyPlan,
  })
  const restored = new DatabaseSync(livePath)
  try {
    expect(() =>
      restored
        .prepare(
          'INSERT INTO control_plane_records(namespace, id, revision, value, updated_at) VALUES (?, ?, 1, ?, ?)'
        )
        .run('command-inbox', 'missing-project', '{"legacy":true}', '2026-10-13T00:00:00.000Z')
    ).toThrow('SQLITE_EXECUTION_SCOPE_INVALID')
    expect(() =>
      restored
        .prepare('UPDATE control_plane_records SET value = ? WHERE namespace = ? AND id = ?')
        .run(JSON.stringify(legacyPlan), 'execution-plans', 'legacy-main-v3-plan')
    ).toThrow('SQLITE_EXECUTION_SCOPE_INVALID')
  } finally {
    restored.close()
  }
})

test('rejects a tampered v2 index without replacing live data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-restore-v2-index-'))
  const livePath = join(directory, 'live.sqlite')
  const provider = new SqlitePersistenceProvider({ path: livePath })
  resources.push({ directory, provider })
  await provider.migrate()
  await provider.transaction((tx) =>
    tx.put({ namespace: 'commands', id: 'preserved', value: { ok: true } })
  )
  const snapshot = await provider.backup()
  const tamperedPath = join(directory, 'tampered.sqlite')
  await writeFile(tamperedPath, snapshot.bytes, { mode: 0o600 })
  const tampered = new DatabaseSync(tamperedPath)
  try {
    tampered.exec('DROP INDEX control_plane_records_command_expiry')
  } finally {
    tampered.close()
  }
  const bytes = new Uint8Array(await readFile(tamperedPath))
  await expect(
    provider.restore({
      ...snapshot,
      bytes,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    })
  ).rejects.toMatchObject({ code: 'SQLITE_BACKUP_INVALID' })
  expect(await provider.transaction((tx) => tx.get('commands', 'preserved'))).toMatchObject({
    value: { ok: true },
  })
})

test('rejects a v2 database presented with a v1 envelope without replacing live data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-restore-version-mismatch-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'live.sqlite') })
  resources.push({ directory, provider })
  await provider.migrate()
  await provider.transaction((tx) =>
    tx.put({ namespace: 'commands', id: 'preserved', value: { ok: true } })
  )
  const snapshot = await provider.backup()
  await expect(provider.restore({ ...snapshot, schemaVersion: 1 })).rejects.toMatchObject({
    code: 'SQLITE_BACKUP_INVALID',
  })
  expect(await provider.transaction((tx) => tx.get('commands', 'preserved'))).toMatchObject({
    value: { ok: true },
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
              .prepare(
                "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END"
              )
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

test('restores a released v2 backup without rehashing retained payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-restore-v2-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'live.sqlite') })
  resources.push({ directory, provider })
  await provider.migrate()
  const sourcePath = join(directory, 'v2.sqlite')
  const source = new DatabaseSync(sourcePath)
  try {
    applyMigrations(source, SQLITE_MIGRATIONS.slice(0, 2))
    source
      .prepare('INSERT INTO control_plane_records VALUES (?, ?, 1, ?, ?)')
      .run('commands', 'historical', '{"signed":"original"}', '2026-09-22')
  } finally {
    source.close()
  }
  const bytes = new Uint8Array(await readFile(sourcePath))
  await provider.restore({
    schemaVersion: 2,
    createdAt: '2026-09-22T00:00:00.000Z',
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes,
  })
  expect(await provider.transaction((tx) => tx.get('commands', 'historical'))).toMatchObject({
    value: { signed: 'original' },
    revision: 1,
  })
  expect(await provider.health()).toMatchObject({ version: String(SCHEMA_VERSION) })
})

for (const name of [
  'control_plane_records_workspace_command_identity',
  'control_plane_records_scope_correlation_insert',
]) {
  test(`restore rejects a missing workspace scope constraint: ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sqlite-restore-scope-'))
    const provider = new SqlitePersistenceProvider({ path: join(directory, 'live.sqlite') })
    resources.push({ directory, provider })
    await provider.migrate()
    const snapshot = await provider.backup()
    const path = join(directory, 'tampered.sqlite')
    await writeFile(path, snapshot.bytes)
    const database = new DatabaseSync(path)
    try {
      database.exec(`${name.includes('identity') ? 'DROP INDEX' : 'DROP TRIGGER'} ${name}`)
    } finally {
      database.close()
    }
    const bytes = new Uint8Array(await readFile(path))
    await expect(
      provider.restore({
        ...snapshot,
        bytes,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      })
    ).rejects.toMatchObject({ code: 'SQLITE_BACKUP_INVALID' })
  })
}
