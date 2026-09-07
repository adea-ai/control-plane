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
    const migrations = [
      ...SQLITE_MIGRATIONS,
      {
        version: 2,
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
        applyMigrations(database, [...SQLITE_MIGRATIONS, { version: 2, statements: ['SELECT 1'] }])
      ).toThrow('SQLITE_MIGRATION_INCOMPATIBLE')
      expect(() => applyMigrations(database)).toThrow('SQLITE_MIGRATION_INCOMPATIBLE')
    } finally {
      database.close()
    }
  })

  test('rolls back a failed upgrade and permits a corrected unapplied step', () => {
    const database = new DatabaseSync(':memory:')
    try {
      applyMigrations(database)
      expect(() =>
        applyMigrations(database, [
          ...SQLITE_MIGRATIONS,
          { version: 2, statements: ['CREATE TABLE upgrade_fixture (id TEXT)', 'INVALID SQL'] },
        ])
      ).toThrow()
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name = 'upgrade_fixture'").get()
      ).toBeUndefined()
      expect(
        database
          .prepare("SELECT value FROM control_plane_metadata WHERE key = 'schema_version'")
          .get().value
      ).toBe('1')
      applyMigrations(database, [
        ...SQLITE_MIGRATIONS,
        { version: 2, statements: ['CREATE TABLE upgrade_fixture (id TEXT)'] },
      ])
      expect(
        database
          .prepare("SELECT value FROM control_plane_metadata WHERE key = 'schema_version'")
          .get().value
      ).toBe('2')
    } finally {
      database.close()
    }
  })
})
