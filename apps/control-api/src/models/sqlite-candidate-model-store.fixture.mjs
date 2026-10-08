import { createHash } from 'node:crypto'
import {
  ModelConnectionSchema,
  RuntimeProviderSelectionSchema,
  WorkspaceModelDefaultsSchema,
} from '@control-plane/contracts'
import { PersistentModelSelectionRepository } from '@control-plane/model-gateway'

/** Test-host read port over the SAME canonical durable metadata rows. Every call
 * executes a fresh SELECT and validates identity; no cache or readiness shortcut.
 * All writes retain the existing repository's transactional CAS/validation.
 * The host owns the supplied read-only DatabaseSync connection's lifetime.
 */
export function createSqliteCandidateModelStore(persistence, readOnlyDatabase) {
  const writes = new PersistentModelSelectionRepository(persistence)
  const namespace = (kind, workspaceId) =>
    `model-${kind}-${createHash('sha256').update(workspaceId).digest('hex')}`
  const read = readOnlyDatabase.prepare(
    'SELECT id, value FROM control_plane_records WHERE namespace = ? AND id = ?'
  )
  const list = readOnlyDatabase.prepare(
    'SELECT id, value FROM control_plane_records WHERE namespace = ? ORDER BY id LIMIT 128'
  )
  const value = (row, schema, workspaceId, field) => {
    if (!row) return undefined
    const parsed = schema.parse(JSON.parse(row.value))
    if (parsed.workspaceId !== workspaceId || (field && parsed[field] !== row.id))
      throw new Error('MODEL_STORE_SCOPE_MISMATCH')
    return parsed
  }
  return {
    async getConnection(workspaceId, ref) {
      return value(
        read.get(namespace('connections', workspaceId), ref),
        ModelConnectionSchema,
        workspaceId,
        'connectionRef'
      )
    },
    async listConnections(workspaceId) {
      return list
        .all(namespace('connections', workspaceId))
        .map((row) => value(row, ModelConnectionSchema, workspaceId, 'connectionRef'))
    },
    async getDefaults(workspaceId) {
      return value(
        read.get('workspace-model-defaults', workspaceId),
        WorkspaceModelDefaultsSchema,
        workspaceId
      )
    },
    async getSelection(workspaceId, ref) {
      return value(
        read.get(namespace('selections', workspaceId), ref),
        RuntimeProviderSelectionSchema,
        workspaceId,
        'selectionRef'
      )
    },
    saveConnection: writes.saveConnection.bind(writes),
    saveDefaults: writes.saveDefaults.bind(writes),
    insertSelection: writes.insertSelection.bind(writes),
  }
}
