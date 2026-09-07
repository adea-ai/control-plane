import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export const SCHEMA_STATEMENTS = {
  control_plane_metadata: `CREATE TABLE IF NOT EXISTS control_plane_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT`,
  control_plane_records: `CREATE TABLE IF NOT EXISTS control_plane_records (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    value TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (namespace, id)
  ) STRICT`,
  control_plane_records_namespace_updated: `CREATE INDEX IF NOT EXISTS control_plane_records_namespace_updated
    ON control_plane_records(namespace, updated_at, id)`,
}

interface SqliteMigration {
  readonly version: number
  readonly statements: readonly string[]
}

// Append new versions. Never edit a migration that has shipped.
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  { version: 1, statements: Object.values(SCHEMA_STATEMENTS) },
]
export const SCHEMA_VERSION = SQLITE_MIGRATIONS.length

export class SqliteMigrationError extends Error {
  constructor() {
    super('SQLITE_MIGRATION_INCOMPATIBLE')
  }
}

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS
): void {
  if (
    migrations.length === 0 ||
    migrations.some(
      (migration, index) => migration.version !== index + 1 || migration.statements.length === 0
    )
  )
    throw new SqliteMigrationError()
  database.exec('BEGIN IMMEDIATE')
  try {
    const hasMetadata = database
      .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'control_plane_metadata'")
      .get()
    const stored = hasMetadata
      ? database
          .prepare("SELECT value FROM control_plane_metadata WHERE key = 'schema_version'")
          .get()?.['value']
      : undefined
    const version = stored === undefined ? 0 : Number(stored)
    if (
      !Number.isSafeInteger(version) ||
      version < 0 ||
      version > migrations.length ||
      (stored !== undefined && String(version) !== stored)
    )
      throw new SqliteMigrationError()
    for (const migration of migrations) {
      const key = `migration:${migration.version}`
      const checksum = createHash('sha256')
        .update(JSON.stringify(migration.statements))
        .digest('hex')
      if (migration.version <= version) {
        const recorded = database
          .prepare('SELECT value FROM control_plane_metadata WHERE key = ?')
          .get(key)?.['value']
        if (recorded === undefined && version === 1 && migration.version === 1) {
          // Only the released, unjournaled v1 schema can be adopted without a checksum.
          for (const [name, expected] of Object.entries(SCHEMA_STATEMENTS)) {
            const actual = database
              .prepare('SELECT sql FROM sqlite_schema WHERE name = ?')
              .get(name)?.['sql']
            const normalize = (sql: string) =>
              sql
                .replace(/IF NOT EXISTS/gi, '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase()
            if (typeof actual !== 'string' || normalize(actual) !== normalize(expected))
              throw new SqliteMigrationError()
          }
          database
            .prepare('INSERT INTO control_plane_metadata (key, value) VALUES (?, ?)')
            .run(key, checksum)
        } else if (recorded !== checksum) throw new SqliteMigrationError()
        continue
      }
      for (const statement of migration.statements) database.exec(statement)
      database
        .prepare('INSERT INTO control_plane_metadata (key, value) VALUES (?, ?)')
        .run(key, checksum)
      database
        .prepare(
          "INSERT INTO control_plane_metadata (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        )
        .run(String(migration.version))
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
