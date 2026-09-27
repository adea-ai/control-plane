import type { DatabaseSync } from 'node:sqlite'
import type { PersistenceTransaction } from '@control-plane/deployment'

/** Auxiliary metadata only: never part of an immutable plan/package digest. */
export const REFERENCE_RETENTION_NAMESPACES = {
  executionPlans: 'retention-plan-reference-windows',
  contextPackages: 'retention-context-reference-windows',
} as const

export type ReferenceRetentionClass = keyof typeof REFERENCE_RETENTION_NAMESPACES

const canonicalInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function parseReferenceRetentionWindow(value: unknown): string {
  const unreferencedSince =
    value !== null && typeof value === 'object'
      ? (value as { unreferencedSince?: unknown }).unreferencedSince
      : undefined
  if (
    typeof unreferencedSince !== 'string' ||
    !canonicalInstant.test(unreferencedSince) ||
    !Number.isFinite(Date.parse(unreferencedSince)) ||
    new Date(unreferencedSince).toISOString() !== unreferencedSince
  ) {
    throw new Error('SQLITE_REFERENCE_RETENTION_METADATA_INVALID')
  }
  return unreferencedSince
}

/** Read the durable first-unreferenced instant for an exact backend record ID. */
export async function getReferenceRetentionWindow(
  transaction: PersistenceTransaction,
  retentionClass: ReferenceRetentionClass,
  targetRecordId: string
): Promise<string | null> {
  const record = await transaction.get(
    REFERENCE_RETENTION_NAMESPACES[retentionClass],
    targetRecordId
  )
  if (record === undefined) return null
  return parseReferenceRetentionWindow(record.value)
}

/** Persist an observation in the caller's target-claim transaction. */
export async function setReferenceRetentionWindow(
  transaction: PersistenceTransaction,
  retentionClass: ReferenceRetentionClass,
  targetRecordId: string,
  unreferencedSince: string | null
): Promise<void> {
  const namespace = REFERENCE_RETENTION_NAMESPACES[retentionClass]
  if (unreferencedSince === null) {
    await transaction.delete(namespace, targetRecordId)
    return
  }
  parseReferenceRetentionWindow({ unreferencedSince })
  const value = { unreferencedSince }
  await transaction.put({ namespace, id: targetRecordId, value })
}

/** Clear one target clock when a new reference or target identity is written. */
export async function clearReferenceRetentionWindow(
  transaction: PersistenceTransaction,
  retentionClass: ReferenceRetentionClass,
  targetRecordId: string
): Promise<void> {
  await transaction.delete(REFERENCE_RETENTION_NAMESPACES[retentionClass], targetRecordId)
}

/** Caller must hold the SQLite writer transaction or own an offline staged copy. */
export function clearReferenceRetentionWindows(database: DatabaseSync): void {
  database
    .prepare('DELETE FROM control_plane_records WHERE namespace IN (?, ?)')
    .run(
      REFERENCE_RETENTION_NAMESPACES.executionPlans,
      REFERENCE_RETENTION_NAMESPACES.contextPackages
    )
}
