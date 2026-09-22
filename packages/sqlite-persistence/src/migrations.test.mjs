import { describe, expect, test } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations, SQLITE_MIGRATIONS, SCHEMA_STATEMENTS } from './migrations.ts'

describe('versioned SQLite forward migrations', () => {
  test('adopts legacy version one without changing retained records', () => {
    const database = new DatabaseSync(':memory:')
    try {
      database.exec(Object.values(SCHEMA_STATEMENTS).join(';'))
      database.exec(
        "INSERT INTO control_plane_metadata VALUES ('schema_version', '1'); INSERT INTO control_plane_records VALUES ('commands', 'original', 1, '{}', '2026-09-07')"
      )
      applyMigrations(database)
      applyMigrations(database)
      expect(database.prepare('SELECT id, revision FROM control_plane_records').all()).toEqual([
        { id: 'original', revision: 1 },
      ])
      expect(
        database.prepare("SELECT value FROM control_plane_metadata WHERE key = 'migration:1'").get()
          .value
      ).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      database.close()
    }
  })

  test('applies ordered forward steps once and rejects changed history', () => {
    const database = new DatabaseSync(':memory:')
    const nextVersion = SQLITE_MIGRATIONS.at(-1).version + 1
    const migrations = [
      ...SQLITE_MIGRATIONS,
      {
        version: nextVersion,
        statements: [
          'CREATE TABLE forward_fixture (id TEXT PRIMARY KEY)',
          "INSERT INTO forward_fixture VALUES ('once')",
        ],
      },
    ]
    try {
      applyMigrations(database)
      applyMigrations(database, migrations)
      applyMigrations(database, migrations)
      expect(database.prepare('SELECT * FROM forward_fixture').all()).toEqual([{ id: 'once' }])
      expect(() =>
        applyMigrations(database, [
          ...SQLITE_MIGRATIONS,
          { version: nextVersion, statements: ['SELECT 1'] },
        ])
      ).toThrow('SQLITE_MIGRATION_INCOMPATIBLE')
      expect(() => applyMigrations(database)).toThrow('SQLITE_MIGRATION_INCOMPATIBLE')
    } finally {
      database.close()
    }
  })

  test('rolls back a failed upgrade and permits a corrected unapplied step', () => {
    const database = new DatabaseSync(':memory:')
    const nextVersion = SQLITE_MIGRATIONS.at(-1).version + 1
    try {
      applyMigrations(database)
      expect(() =>
        applyMigrations(database, [
          ...SQLITE_MIGRATIONS,
          {
            version: nextVersion,
            statements: ['CREATE TABLE upgrade_fixture (id TEXT)', 'INVALID SQL'],
          },
        ])
      ).toThrow()
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = 'upgrade_fixture'").get()
      ).toBeUndefined()
      expect(
        database
          .prepare("SELECT value FROM control_plane_metadata WHERE key = 'schema_version'")
          .get().value
      ).toBe(String(SQLITE_MIGRATIONS.length))
      applyMigrations(database, [
        ...SQLITE_MIGRATIONS,
        { version: nextVersion, statements: ['CREATE TABLE upgrade_fixture (id TEXT)'] },
      ])
      expect(
        database
          .prepare("SELECT value FROM control_plane_metadata WHERE key = 'schema_version'")
          .get().value
      ).toBe(String(nextVersion))
    } finally {
      database.close()
    }
  })

  for (const [namespace, index] of [
    ['command-inbox', 'control_plane_records_command_expiry'],
    ['execution-events', 'control_plane_records_event_expiry'],
  ]) {
    test(`indexes legacy and updated ${namespace} expiry candidates deterministically`, () => {
      const database = new DatabaseSync(':memory:')
      try {
        applyMigrations(database, SQLITE_MIGRATIONS.slice(0, 1))
        const insert = database.prepare(
          'INSERT INTO control_plane_records(namespace, id, revision, value, updated_at) VALUES (?, ?, 1, ?, ?)'
        )
        const put = (id, expiry) =>
          insert.run(
            namespace,
            id,
            JSON.stringify(expiry === undefined ? {} : { retentionExpiresAt: expiry }),
            '2026-01-01'
          )
        put('a', '2026-01-01T00:00:00.000Z')
        put('b', '2027-01-01T00:00:00.000Z')
        applyMigrations(database)
        put('c', '2026-01-01T00:00:00.000Z')
        put('future', '2030-01-01T00:00:00.000Z')
        put('invalid', 'not-a-date')
        put('impossible', '2023-02-29T00:00:00.000Z')
        put('missing', undefined)
        put('wrong-type', 123)
        database
          .prepare('UPDATE control_plane_records SET value = ? WHERE namespace = ? AND id = ?')
          .run(JSON.stringify({ retentionExpiresAt: '2025-01-01T00:00:00.000Z' }), namespace, 'b')
        // Index membership is only a coarse candidate filter. Exact calendar validation
        // remains mandatory; neither this query nor the index authorizes deletion.
        const query = `SELECT id FROM control_plane_records INDEXED BY ${index}
          WHERE namespace = '${namespace}'
            AND json_type(value, '$.retentionExpiresAt') = 'text'
            AND json_extract(value, '$.retentionExpiresAt') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(value, '$.retentionExpiresAt')) = json_extract(value, '$.retentionExpiresAt')
            AND json_extract(value, '$.retentionExpiresAt') <= ?
          ORDER BY json_extract(value, '$.retentionExpiresAt'), id LIMIT ?`
        const plan = database
          .prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all('2026-06-01T00:00:00.000Z', 2)
        expect(plan.some((row) => String(row.detail).includes(index))).toBe(true)
        expect(database.prepare(query).all('2026-06-01T00:00:00.000Z', 2)).toEqual([
          { id: 'b' },
          { id: 'a' },
        ])
        expect(database.prepare(query).all('2026-06-01T00:00:00.000Z', 10)).toEqual([
          { id: 'b' },
          { id: 'a' },
          { id: 'c' },
        ])
        expect(
          database.prepare('SELECT count(*) AS count FROM control_plane_records').get().count
        ).toBe(8)
      } finally {
        database.close()
      }
    })
  }
})
