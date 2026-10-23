// Frozen v3 migration recipe captured from main at c5387139. Do not derive
// this fixture from the candidate's SQLITE_MIGRATIONS: it guards the released
// migration checksum and upgrade path.
export const MAIN_C538_MIGRATION_CHECKSUMS = Object.freeze([
  '7b263b70e45d05f616eb26bb9e7d29046ebf3af321b1000490735a802393e288',
  '11889c134c7b5279a4295675688cd8bad73f72a602dc34118d4f54926c5a1804',
  '5e7fa996cd415786f505e92525377dee6d43b659d689c3c13d0e63d13f6e5e1a',
])

function executionScopeTrigger(action, suffix, path, namespaces) {
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
      ))
    )
    BEGIN SELECT RAISE(ABORT, 'SQLITE_EXECUTION_SCOPE_INVALID'); END`
}

export const MAIN_C538_V3_STATEMENTS = Object.freeze([
  `CREATE UNIQUE INDEX IF NOT EXISTS control_plane_records_workspace_command_identity
    ON control_plane_records(
      json_extract(value, '$.callerPrincipalId'), json_extract(value, '$.operation'),
      json_extract(value, '$.workspaceId'), json_extract(value, '$.idempotencyKey')
    ) WHERE namespace = 'command-inbox'
      AND json_extract(value, '$.executionScope.kind') = 'workspace'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS control_plane_records_project_command_identity
    ON control_plane_records(
      json_extract(value, '$.callerPrincipalId'), json_extract(value, '$.operation'),
      json_extract(value, '$.workspaceId'), json_extract(value, '$.projectId'), json_extract(value, '$.idempotencyKey')
    ) WHERE namespace = 'command-inbox' AND json_type(value, '$.projectId') = 'text'`,
  ...['INSERT', 'UPDATE'].flatMap((action) =>
    [
      ['command', '$', "'command-inbox'"],
      ['correlation', '$.correlation', "'executions', 'execution-plans', 'execution-events'"],
      ['cancellation', '$.request', "'execution-cancellation-receipts'"],
      ['context', '$.projectState', "'context-packages'"],
    ].map(([suffix, path, namespaces]) => executionScopeTrigger(action, suffix, path, namespaces))
  ),
])
