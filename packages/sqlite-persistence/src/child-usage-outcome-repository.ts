import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type { PersistenceProvider } from '@control-plane/deployment'
import {
  ChildUsageLedgerSnapshotSchema,
  type ChildUsageLedgerSnapshot,
} from '@control-plane/orchestration'
import { json, recordId } from './record-storage.js'

const namespace = 'child-usage-outcomes'

export type ChildUsageOutcomeErrorCode =
  | 'CHILD_USAGE_OUTCOME_SCOPE_MISMATCH'
  | 'CHILD_USAGE_OUTCOME_STALE_REVISION'
  | 'CHILD_USAGE_OUTCOME_CONFLICT'

export class ChildUsageOutcomeError extends Error {
  constructor(
    readonly code: ChildUsageOutcomeErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChildUsageOutcomeError'
  }
}

export interface ChildUsageOutcomeSnapshotRecord {
  /** Owner-monotonic revision of the persisted projection. */
  readonly revision: number
  readonly snapshot: ChildUsageLedgerSnapshot
}

/**
 * Durable home for the child usage cost-state projection (M13.04.2, refs
 * adea-ai/control-plane#1019). The money stays in the canonical
 * `@control-plane/usage-ledger` durable store; this repository persists only
 * the correlated evidence snapshot (identity, stages, dedup horizons) so a
 * restart restores cost states instead of resetting them.
 *
 * Writes are strictly forward-only: a save at or below the stored revision is
 * rejected, so an old in-memory snapshot can never overwrite a newer durable
 * one after a restart or concurrent owner. Loads always return the newest
 * revision with its snapshot.
 */
export class SqliteChildUsageOutcomeRepository {
  readonly #delegationId: string

  constructor(
    readonly provider: Pick<PersistenceProvider, 'transaction'>,
    delegationId: string
  ) {
    this.#delegationId = IdentifierSchemas.delegationId.parse(delegationId)
  }

  #recordId(): string {
    return recordId(canonicalJsonStringify([namespace, this.#delegationId]))
  }

  async save(record: ChildUsageOutcomeSnapshotRecord): Promise<{ readonly revision: number }> {
    const revision = parseRevision(record.revision)
    const snapshot = ChildUsageLedgerSnapshotSchema.parse(record.snapshot)
    for (const entry of snapshot.entries) {
      if (entry.outcome.identity.delegationId !== this.#delegationId) {
        throw new ChildUsageOutcomeError(
          'CHILD_USAGE_OUTCOME_SCOPE_MISMATCH',
          'Snapshot holds outcomes for a different delegation'
        )
      }
    }
    const id = this.#recordId()
    await this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(namespace, id)
      if (existing !== undefined) {
        const stored = parseSnapshotRecord(existing.value)
        if (revision <= stored.revision) {
          // Forward-only: a stale in-memory owner must never clobber the
          // newer durable projection.
          throw new ChildUsageOutcomeError(
            'CHILD_USAGE_OUTCOME_STALE_REVISION',
            'A newer usage-outcome revision is already durable'
          )
        }
        if (canonicalJsonStringify(stored.snapshot) === canonicalJsonStringify(snapshot)) {
          throw new ChildUsageOutcomeError(
            'CHILD_USAGE_OUTCOME_CONFLICT',
            'Identical snapshot already stored under a different revision'
          )
        }
      }
      await transaction.put({
        namespace,
        id,
        value: json({ revision, snapshot }),
      })
    })
    return { revision }
  }

  async load(): Promise<ChildUsageOutcomeSnapshotRecord | undefined> {
    const id = this.#recordId()
    return this.provider.transaction(async (transaction) => {
      const existing = await transaction.get(namespace, id)
      if (existing === undefined) return undefined
      return parseSnapshotRecord(existing.value)
    })
  }
}

function parseRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ChildUsageOutcomeError(
      'CHILD_USAGE_OUTCOME_CONFLICT',
      'Snapshot revision must be a positive safe integer'
    )
  return value
}

function parseSnapshotRecord(value: unknown): ChildUsageOutcomeSnapshotRecord {
  const record = value as { revision?: unknown; snapshot?: unknown } | null
  if (record === null || typeof record !== 'object')
    throw new ChildUsageOutcomeError(
      'CHILD_USAGE_OUTCOME_CONFLICT',
      'Stored usage-outcome record is not an object'
    )
  return {
    revision: parseRevision(record.revision),
    snapshot: ChildUsageLedgerSnapshotSchema.parse(record.snapshot),
  }
}
