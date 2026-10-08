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

// Added in v2; never fold these into SCHEMA_STATEMENTS because v1's checksum is immutable.
export const EXPIRY_INDEX_STATEMENTS = {
  control_plane_records_command_expiry: `CREATE INDEX IF NOT EXISTS control_plane_records_command_expiry
    ON control_plane_records(namespace, json_extract(value, '$.retentionExpiresAt'), id)
    WHERE namespace = 'command-inbox'
      AND json_type(value, '$.retentionExpiresAt') = 'text'
      AND json_extract(value, '$.retentionExpiresAt') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`,
  control_plane_records_event_expiry: `CREATE INDEX IF NOT EXISTS control_plane_records_event_expiry
    ON control_plane_records(namespace, json_extract(value, '$.retentionExpiresAt'), id)
    WHERE namespace = 'execution-events'
      AND json_type(value, '$.retentionExpiresAt') = 'text'
      AND json_extract(value, '$.retentionExpiresAt') GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'`,
} as const

// Added in v3. Scope is validated at the JSON ownership boundary; no retained
// payload is rewritten, so signed legacy project records keep their bytes.
function executionScopeTrigger(
  action: 'INSERT' | 'UPDATE',
  suffix: string,
  path: string,
  namespaces: string
): string {
  const scope = `${path}.executionScope`
  const project = `${path}.projectId`
  const valid = `json_type(NEW.value, '${scope}') = 'object'
    AND json_type(NEW.value, '${path}.workspaceId') = 'text'
    AND length(json_extract(NEW.value, '${path}.workspaceId')) > 0
    AND json_type(NEW.value, '${scope}.schemaVersion') = 'integer'
    AND json_extract(NEW.value, '${scope}.schemaVersion') = 1
    AND (SELECT count(*) FROM json_each(NEW.value, '${scope}')) = CASE json_extract(NEW.value, '${scope}.kind') WHEN 'workspace' THEN 2 WHEN 'project' THEN 3 ELSE 0 END
    AND (NEW.namespace <> 'command-inbox' OR (
      json_type(NEW.value, '$.callerPrincipalId') = 'text'
      AND json_type(NEW.value, '$.operation') = 'text'
      AND json_type(NEW.value, '$.idempotencyKey') = 'text'
    ))
    AND (
      (json_extract(NEW.value, '${scope}.kind') = 'workspace'
        AND json_type(NEW.value, '${project}') IS NULL
        AND json_type(NEW.value, '${scope}.projectId') IS NULL)
      OR (json_extract(NEW.value, '${scope}.kind') = 'project'
        AND json_type(NEW.value, '${project}') = 'text'
        AND length(json_extract(NEW.value, '${project}')) > 0
        AND json_extract(NEW.value, '${scope}.projectId') = json_extract(NEW.value, '${project}'))
    )`
  return `CREATE TRIGGER IF NOT EXISTS control_plane_records_scope_${suffix}_${action.toLowerCase()}
    BEFORE ${action} ON control_plane_records
    WHEN NEW.namespace IN (${namespaces}) AND (
      (json_type(NEW.value, '${scope}') IS NOT NULL AND NOT coalesce((${valid}), 0))
      OR (NEW.namespace IN ('execution-plans', 'context-packages') AND (
        (json_extract(NEW.value, '$.schemaVersion') = 2 AND json_type(NEW.value, '${scope}') IS NULL)
        OR (json_extract(NEW.value, '$.schemaVersion') = 1 AND json_type(NEW.value, '${scope}') IS NOT NULL)
      ))
      OR (NEW.namespace = 'context-packages' AND (
        json_type(NEW.value, '$.executionScope') IS NOT NULL
        OR (json_type(NEW.value, '${scope}') IS NULL AND NOT coalesce((json_type(NEW.value, '${project}') = 'text' AND length(json_extract(NEW.value, '${project}')) > 0), 0))
        OR (json_extract(NEW.value, '$.schemaVersion') = 2 AND json_extract(NEW.value, '${scope}.kind') <> 'workspace')
      ))
    )
    BEGIN SELECT RAISE(ABORT, 'SQLITE_EXECUTION_SCOPE_INVALID'); END`
}

export const EXECUTION_SCOPE_STATEMENTS = {
  control_plane_records_workspace_command_identity: `CREATE UNIQUE INDEX IF NOT EXISTS control_plane_records_workspace_command_identity
    ON control_plane_records(
      json_extract(value, '$.callerPrincipalId'), json_extract(value, '$.operation'),
      json_extract(value, '$.workspaceId'), json_extract(value, '$.idempotencyKey')
    ) WHERE namespace = 'command-inbox'
      AND json_extract(value, '$.executionScope.kind') = 'workspace'`,
  control_plane_records_project_command_identity: `CREATE UNIQUE INDEX IF NOT EXISTS control_plane_records_project_command_identity
    ON control_plane_records(
      json_extract(value, '$.callerPrincipalId'), json_extract(value, '$.operation'),
      json_extract(value, '$.workspaceId'), json_extract(value, '$.projectId'), json_extract(value, '$.idempotencyKey')
    ) WHERE namespace = 'command-inbox' AND json_type(value, '$.projectId') = 'text'`,
  ...Object.fromEntries(
    (['INSERT', 'UPDATE'] as const).flatMap((action) =>
      [
        ['command', '$', "'command-inbox'"],
        ['correlation', '$.correlation', "'executions', 'execution-plans', 'execution-events'"],
        ['cancellation', '$.request', "'execution-cancellation-receipts'"],
        ['context', '$.projectState', "'context-packages'"],
      ].map(([suffix, path, namespaces]) => [
        `control_plane_records_scope_${suffix}_${action.toLowerCase()}`,
        executionScopeTrigger(action, suffix!, path!, namespaces!),
      ])
    )
  ),
} as const

interface SqliteMigration {
  readonly version: number
  readonly statements: readonly string[]
}

// Append new versions. Never edit a migration that has shipped.
export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  { version: 1, statements: Object.values(SCHEMA_STATEMENTS) },
  { version: 2, statements: Object.values(EXPIRY_INDEX_STATEMENTS) },
  { version: 3, statements: Object.values(EXECUTION_SCOPE_STATEMENTS) },
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
