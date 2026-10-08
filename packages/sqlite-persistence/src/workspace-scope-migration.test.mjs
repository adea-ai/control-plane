import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations, SQLITE_MIGRATIONS } from './migrations.ts'

const workspace = { schemaVersion: 1, kind: 'workspace' }
const project = { schemaVersion: 1, kind: 'project', projectId: 'prj_test' }
const command = {
  workspaceId: 'wsp_test',
  callerPrincipalId: 'svc_test',
  operation: 'execution.accept',
  idempotencyKey: 'stable-key',
  executionScope: workspace,
}
const insert = (database, namespace, id, value) =>
  database
    .prepare('INSERT INTO control_plane_records VALUES (?, ?, 1, ?, ?)')
    .run(namespace, id, JSON.stringify(value), '2026-10-08T00:00:00.000Z')

test('scope upgrade preserves historical bytes and immutable migration checksums', () => {
  const database = new DatabaseSync(':memory:')
  try {
    applyMigrations(database, SQLITE_MIGRATIONS.slice(0, 2))
    const legacy = { ...command, projectId: project.projectId }
    delete legacy.executionScope
    insert(database, 'command-inbox', 'historical', legacy)
    const before = database.prepare('SELECT * FROM control_plane_records').all()
    const checksums = SQLITE_MIGRATIONS.slice(0, 2).map((migration) =>
      createHash('sha256').update(JSON.stringify(migration.statements)).digest('hex')
    )
    expect(checksums).toEqual([
      '7b263b70e45d05f616eb26bb9e7d29046ebf3af321b1000490735a802393e288',
      '11889c134c7b5279a4295675688cd8bad73f72a602dc34118d4f54926c5a1804',
    ])
    applyMigrations(database)
    expect(database.prepare('SELECT * FROM control_plane_records').all()).toEqual(before)
    for (let index = 0; index < 2; index++)
      expect(
        database
          .prepare('SELECT value FROM control_plane_metadata WHERE key = ?')
          .get(`migration:${index + 1}`).value
      ).toBe(checksums[index])
  } finally {
    database.close()
  }
})

test('workspace command identity is unique without relying on nullable project columns', () => {
  const database = new DatabaseSync(':memory:')
  try {
    applyMigrations(database)
    insert(database, 'command-inbox', 'workspace-one', command)
    expect(() => insert(database, 'command-inbox', 'workspace-two', command)).toThrow()
    insert(database, 'command-inbox', 'other-workspace', { ...command, workspaceId: 'wsp_other' })
    insert(database, 'command-inbox', 'real-project', {
      ...command,
      projectId: project.projectId,
      executionScope: project,
    })
    expect(
      database.prepare('SELECT count(*) AS count FROM control_plane_records').get().count
    ).toBe(3)
  } finally {
    database.close()
  }
})

test('explicit scope constraints reject project-null ambiguity and mismatched project owners', () => {
  const database = new DatabaseSync(':memory:')
  try {
    applyMigrations(database)
    for (const scope of [
      { executionScope: workspace, projectId: null },
      { executionScope: workspace, projectId: 'prj_test' },
      { executionScope: project },
      { executionScope: project, projectId: 'prj_other' },
      { executionScope: { schemaVersion: 2, kind: 'workspace' } },
      { executionScope: { schemaVersion: 1, kind: 'unknown' } },
    ]) {
      expect(() =>
        insert(database, 'command-inbox', JSON.stringify(scope), { ...command, ...scope })
      ).toThrow('SQLITE_EXECUTION_SCOPE_INVALID')
      expect(() =>
        insert(database, 'executions', JSON.stringify(scope), {
          correlation: { workspaceId: command.workspaceId, ...scope },
        })
      ).toThrow('SQLITE_EXECUTION_SCOPE_INVALID')
    }
    insert(database, 'executions', 'valid', {
      correlation: { workspaceId: command.workspaceId, executionScope: workspace },
    })
    expect(() =>
      database.prepare('UPDATE control_plane_records SET value = ? WHERE id = ?').run(
        JSON.stringify({
          correlation: {
            workspaceId: command.workspaceId,
            executionScope: workspace,
            projectId: null,
          },
        }),
        'valid'
      )
    ).toThrow('SQLITE_EXECUTION_SCOPE_INVALID')
    expect(() =>
      insert(database, 'execution-plans', 'v2-without-scope', {
        schemaVersion: 2,
        correlation: { workspaceId: command.workspaceId, projectId: 'prj_test' },
      })
    ).toThrow('SQLITE_EXECUTION_SCOPE_INVALID')
  } finally {
    database.close()
  }
})

test('workspace admission index cannot be bypassed with missing identity fields', () => {
  const database = new DatabaseSync(':memory:')
  try {
    applyMigrations(database)
    for (const field of ['callerPrincipalId', 'operation', 'idempotencyKey']) {
      const invalid = { ...command }
      delete invalid[field]
      expect(() => insert(database, 'command-inbox', field, invalid)).toThrow(
        'SQLITE_EXECUTION_SCOPE_INVALID'
      )
    }
  } finally {
    database.close()
  }
})

test('repair: raw context package scope constraints reject version, flat and owner mismatches', () => {
  const database = new DatabaseSync(':memory:')
  try {
    applyMigrations(database)
    const valid = {
      schemaVersion: 2,
      projectState: { workspaceId: command.workspaceId, executionScope: workspace, revision: 4 },
    }
    insert(database, 'context-packages', 'valid-context', valid)
    const legacy = {
      schemaVersion: 1,
      projectState: { workspaceId: command.workspaceId, projectId: project.projectId, revision: 4 },
    }
    insert(database, 'context-packages', 'legacy-context', legacy)
    const explicitProject = {
      ...legacy,
      schemaVersion: 2,
      projectState: { ...legacy.projectState, executionScope: project },
    }
    insert(database, 'context-packages', 'project-context', explicitProject)
    expect(
      JSON.parse(
        database
          .prepare('SELECT value FROM control_plane_records WHERE id = ?')
          .get('project-context').value
      )
    ).toEqual(explicitProject)
    database
      .prepare('UPDATE control_plane_records SET value = ? WHERE id = ?')
      .run(JSON.stringify(explicitProject), 'valid-context')
    expect(
      JSON.parse(
        database
          .prepare('SELECT value FROM control_plane_records WHERE id = ?')
          .get('valid-context').value
      )
    ).toEqual(explicitProject)
    for (const invalid of [
      { ...valid, schemaVersion: 1 },
      { ...valid, projectState: { ...valid.projectState, workspaceId: null } },
      { ...legacy, schemaVersion: 2 },
      { ...legacy, executionScope: workspace },
      { ...legacy, projectState: { ...legacy.projectState, projectId: null } },
      { ...valid, projectState: { ...valid.projectState, projectId: null } },
      { ...valid, projectState: { ...valid.projectState, projectId: project.projectId } },
      {
        ...valid,
        projectState: { ...valid.projectState, executionScope: { ...workspace, schemaVersion: 2 } },
      },
      {
        ...valid,
        projectState: { ...valid.projectState, executionScope: { ...workspace, extra: true } },
      },
      {
        ...valid,
        projectState: { ...valid.projectState, projectId: 'prj_other', executionScope: project },
      },
    ]) {
      expect(() => insert(database, 'context-packages', JSON.stringify(invalid), invalid)).toThrow(
        'SQLITE_EXECUTION_SCOPE_INVALID'
      )
      expect(() =>
        database
          .prepare('UPDATE control_plane_records SET value = ? WHERE id = ?')
          .run(JSON.stringify(invalid), 'valid-context')
      ).toThrow('SQLITE_EXECUTION_SCOPE_INVALID')
    }
  } finally {
    database.close()
  }
})
