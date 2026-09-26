import type { DatabaseSync } from 'node:sqlite'

/** Auxiliary metadata only: never part of an immutable plan/package digest. */
export const REFERENCE_RETENTION_NAMESPACES = {
  executionPlans: 'retention-plan-reference-windows',
  contextPackages: 'retention-context-reference-windows',
} as const

/** Caller must hold the SQLite writer transaction or own an offline staged copy. */
export function clearReferenceRetentionWindows(database: DatabaseSync): void {
  database
    .prepare('DELETE FROM control_plane_records WHERE namespace IN (?, ?)')
    .run(
      REFERENCE_RETENTION_NAMESPACES.executionPlans,
      REFERENCE_RETENTION_NAMESPACES.contextPackages
    )
}
