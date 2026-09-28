import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import {
  RetentionHoldError,
  RetentionHoldIdSchema,
  RetentionHoldReleaseSchema,
  RetentionHoldSchema,
  countMatchingActiveRetentionHolds,
  parseRetentionHoldPolicy,
  sameRetentionHoldIdentity,
  validateStoredHold,
  type RetentionHold,
  type RetentionHoldPolicy,
  type RetentionHoldRepository,
  type RetentionHoldRelease,
  type RetentionHoldTarget,
} from '@control-plane/domain'

const namespace = 'retention-holds'

export class SqliteRetentionHoldRepository implements RetentionHoldRepository {
  readonly #policy: RetentionHoldPolicy

  constructor(
    readonly provider: PersistenceProvider,
    policy: RetentionHoldPolicy
  ) {
    this.#policy = parseRetentionHoldPolicy(policy)
  }

  async get(holdIdInput: string): Promise<RetentionHold | undefined> {
    const holdId = parseHoldId(holdIdInput)
    return this.provider.transaction(async (transaction) => {
      const stored = await transaction.get(namespace, holdId)
      if (stored === undefined) return undefined
      return parseStoredRecord(stored, this.#policy)
    })
  }

  async create(
    input: RetentionHold
  ): Promise<{ readonly created: boolean; readonly hold: RetentionHold }> {
    const hold = parseCreate(input, this.#policy)
    return this.provider.transaction(async (transaction) => {
      const stored = await transaction.get(namespace, hold.holdId)
      if (stored !== undefined) {
        const current = parseStoredRecord(stored, this.#policy)
        if (!sameRetentionHoldIdentity(current, hold))
          throw new RetentionHoldError('RETENTION_HOLD_ID_CONFLICT')
        return { created: false, hold: current }
      }
      const validHold = validateStoredHold(hold, this.#policy)
      await transaction.put({ namespace, id: hold.holdId, value: validHold as JsonValue })
      return { created: true, hold: validHold }
    })
  }

  async release(input: {
    readonly holdId: string
    readonly expectedRevision: number
    readonly release: RetentionHoldRelease
  }): Promise<{ readonly released: boolean; readonly hold: RetentionHold }> {
    const holdId = parseHoldId(input.holdId)
    const release = parseRelease(input.release)
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw new RetentionHoldError('RETENTION_HOLD_INPUT_INVALID')

    return this.provider.transaction(async (transaction) => {
      const stored = await transaction.get(namespace, holdId)
      if (stored === undefined) throw new RetentionHoldError('RETENTION_HOLD_NOT_FOUND')
      const current = parseStoredRecord(stored, this.#policy)
      if (current.release !== undefined) return replayReleaseOrConflict(current, release)
      if (current.revision !== input.expectedRevision)
        throw new RetentionHoldError('RETENTION_HOLD_REVISION_CONFLICT')
      const next = validateStoredHold(
        { ...current, revision: current.revision + 1, release },
        this.#policy
      )
      await transaction.put({
        namespace,
        id: holdId,
        expectedRevision: stored.revision,
        value: next as JsonValue,
      })
      return { released: true, hold: next }
    })
  }
}

/** Read using the caller's transaction, normally the same BEGIN IMMEDIATE claim transaction. */
export async function countSqliteMatchingActiveRetentionHolds(
  transaction: PersistenceTransaction,
  target: RetentionHoldTarget,
  policyInput?: RetentionHoldPolicy
): Promise<number> {
  const policy = policyInput === undefined ? undefined : parseRetentionHoldPolicy(policyInput)
  const records = await transaction.list(namespace)
  if (policy === undefined) {
    if (records.length > 0) throw new RetentionHoldError('RETENTION_HOLD_POLICY_INVALID')
    return 0
  }
  return countMatchingActiveRetentionHolds({
    holds: records.map((record) => record.value),
    target,
    policy,
    recordIds: records.map((record) => record.id),
  })
}

function parseCreate(input: unknown, policy: RetentionHoldPolicy): RetentionHold {
  const parsed = RetentionHoldSchema.safeParse(input)
  if (!parsed.success || parsed.data.release !== undefined || parsed.data.revision !== 0)
    throw new RetentionHoldError('RETENTION_HOLD_INPUT_INVALID')
  if (!Object.hasOwn(policy, parsed.data.classId) || policy[parsed.data.classId] === undefined)
    throw new RetentionHoldError('RETENTION_HOLD_CLASS_UNCONFIGURED')
  return parsed.data
}

function parseRelease(input: unknown): RetentionHoldRelease {
  const parsed = RetentionHoldReleaseSchema.safeParse(input)
  if (!parsed.success) throw new RetentionHoldError('RETENTION_HOLD_INPUT_INVALID')
  return parsed.data
}

function parseHoldId(input: unknown): string {
  const parsed = RetentionHoldIdSchema.safeParse(input)
  if (!parsed.success) throw new RetentionHoldError('RETENTION_HOLD_INPUT_INVALID')
  return parsed.data
}

function parseStoredRecord(
  record: { readonly id: string; readonly value: unknown },
  policy: RetentionHoldPolicy
): RetentionHold {
  if (record.id !== (record.value as { holdId?: unknown } | null)?.holdId)
    throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
  const parsed = RetentionHoldSchema.safeParse(record.value)
  if (!parsed.success) throw new RetentionHoldError('RETENTION_HOLD_STORED_RECORD_INVALID')
  return validateStoredHold(parsed.data, policy)
}

function replayReleaseOrConflict(current: RetentionHold, requested: RetentionHoldRelease) {
  const release = current.release
  if (
    release !== undefined &&
    release.requestId === requested.requestId &&
    release.releasedBy.actorPrincipalRef === requested.releasedBy.actorPrincipalRef &&
    release.releasedBy.authorityRef === requested.releasedBy.authorityRef
  ) {
    return { released: false, hold: current }
  }
  throw new RetentionHoldError('RETENTION_HOLD_ALREADY_RELEASED')
}
