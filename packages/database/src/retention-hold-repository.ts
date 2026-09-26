import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  RetentionHoldError,
  RetentionHoldIdSchema,
  RetentionHoldReleaseSchema,
  RetentionHoldSchema,
  countMatchingActiveRetentionHolds,
  parseRetentionHoldPolicy,
  retentionHoldClassLockKey,
  sameRetentionHoldIdentity,
  validateStoredHold,
  type RetentionHold,
  type RetentionHoldPolicy,
  type RetentionHoldRepository,
  type RetentionHoldRelease,
  type RetentionHoldTarget,
} from '@control-plane/domain'
import type { ControlPlaneDatabase } from './connection.js'
import type { DomainTransaction } from './transaction.js'
import { retentionHolds } from './schema/retention-holds.js'

export class PostgresRetentionHoldRepository implements RetentionHoldRepository {
  readonly #policy: RetentionHoldPolicy

  constructor(
    readonly database: ControlPlaneDatabase,
    policy: RetentionHoldPolicy
  ) {
    this.#policy = parseRetentionHoldPolicy(policy)
  }

  async get(holdIdInput: string): Promise<RetentionHold | undefined> {
    const holdId = parseHoldId(holdIdInput)
    const [row] = await this.database
      .select()
      .from(retentionHolds)
      .where(eq(retentionHolds.holdId, holdId))
      .limit(1)
    return row === undefined ? undefined : parseRow(row, this.#policy)
  }

  async create(
    input: RetentionHold
  ): Promise<{ readonly created: boolean; readonly hold: RetentionHold }> {
    const hold = parseCreate(input, this.#policy)
    return this.database.transaction(async (transaction) => {
      await acquirePostgresRetentionHoldClassMutex(transaction, hold.classId)
      const [existing] = await transaction
        .select()
        .from(retentionHolds)
        .where(eq(retentionHolds.holdId, hold.holdId))
        .limit(1)
        .for('update')
      if (existing !== undefined) return replayOrConflict(parseRow(existing, this.#policy), hold)
      validateStoredHold(hold, this.#policy)

      const [inserted] = await transaction
        .insert(retentionHolds)
        .values(toColumns(hold))
        .onConflictDoNothing()
        .returning()
      if (inserted !== undefined) return { created: true, hold: parseRow(inserted, this.#policy) }

      // A create using the same ID but a different class takes a different
      // class mutex. The unique primary key remains the cross-class fence.
      const [conflict] = await transaction
        .select()
        .from(retentionHolds)
        .where(eq(retentionHolds.holdId, hold.holdId))
        .limit(1)
        .for('update')
      if (conflict === undefined)
        throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
      return replayOrConflict(parseRow(conflict, this.#policy), hold)
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

    return this.database.transaction(async (transaction) => {
      // This unlocked read determines the class mutex only. The row is re-read
      // and claimed after the class mutex, matching the deletion lock order.
      const [observed] = await transaction
        .select()
        .from(retentionHolds)
        .where(eq(retentionHolds.holdId, holdId))
        .limit(1)
      if (observed === undefined) throw new RetentionHoldError('RETENTION_HOLD_NOT_FOUND')
      const observedHold = parseRow(observed, this.#policy)
      await acquirePostgresRetentionHoldClassMutex(transaction, observedHold.classId)
      const [stored] = await transaction
        .select()
        .from(retentionHolds)
        .where(eq(retentionHolds.holdId, holdId))
        .limit(1)
        .for('update')
      if (stored === undefined) throw new RetentionHoldError('RETENTION_HOLD_NOT_FOUND')
      const current = parseRow(stored, this.#policy)
      if (current.classId !== observedHold.classId)
        throw new RetentionHoldError('RETENTION_HOLD_STORAGE_INCONSISTENT')
      if (current.release !== undefined) return replayReleaseOrConflict(current, release)
      if (current.revision !== input.expectedRevision)
        throw new RetentionHoldError('RETENTION_HOLD_REVISION_CONFLICT')

      const [updated] = await transaction
        .update(retentionHolds)
        .set({
          releaseRequestId: release.requestId,
          releasedAt: new Date(release.releasedAt),
          releasedByPrincipalRef: release.releasedBy.actorPrincipalRef,
          releaseAuthorityRef: release.releasedBy.authorityRef,
          revision: current.revision + 1,
        })
        .where(
          and(
            eq(retentionHolds.holdId, holdId),
            eq(retentionHolds.revision, input.expectedRevision),
            isNull(retentionHolds.releasedAt)
          )
        )
        .returning()
      if (updated === undefined) throw new RetentionHoldError('RETENTION_HOLD_REVISION_CONFLICT')
      return { released: true, hold: parseRow(updated, this.#policy) }
    })
  }
}

/** Acquire this before any target-row claim in a PostgreSQL hold-aware delete. */
export async function acquirePostgresRetentionHoldClassMutex(
  transaction: DomainTransaction,
  classId: string
): Promise<void> {
  const key = retentionHoldClassLockKey(classId)
  await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}

/** Read using the caller's transaction; deletion callers must already hold the class mutex. */
export async function countPostgresMatchingActiveRetentionHolds(
  transaction: DomainTransaction,
  target: RetentionHoldTarget,
  policyInput: RetentionHoldPolicy
): Promise<number> {
  const policy = parseRetentionHoldPolicy(policyInput)
  const rows = await transaction.select().from(retentionHolds)
  const holds = rows.map((row) => parseRow(row, policy))
  return countMatchingActiveRetentionHolds({
    holds,
    target,
    policy,
    recordIds: rows.map((row) => row.holdId),
  })
}

function parseCreate(input: unknown, policy: RetentionHoldPolicy): RetentionHold {
  let parsed: RetentionHold
  try {
    parsed = RetentionHoldSchema.parse(input)
  } catch {
    throw new RetentionHoldError('RETENTION_HOLD_INPUT_INVALID')
  }
  if (parsed.release !== undefined || parsed.revision !== 0)
    throw new RetentionHoldError('RETENTION_HOLD_INPUT_INVALID')
  if (!Object.hasOwn(policy, parsed.classId) || policy[parsed.classId] === undefined)
    throw new RetentionHoldError('RETENTION_HOLD_CLASS_UNCONFIGURED')
  return parsed
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

function toColumns(hold: RetentionHold) {
  return {
    holdId: hold.holdId,
    classId: hold.classId,
    scopeKind: hold.scope.kind,
    workspaceId: hold.scope.kind === 'class' ? null : hold.scope.workspaceId,
    projectId: hold.scope.kind === 'project' ? hold.scope.projectId : null,
    owner: hold.owner,
    reasonCode: hold.reasonCode,
    createdAt: new Date(hold.createdAt),
    createdByPrincipalRef: hold.createdBy.actorPrincipalRef,
    createdAuthorityRef: hold.createdBy.authorityRef,
    revision: hold.revision,
    releaseRequestId: hold.release?.requestId ?? null,
    releasedAt: hold.release === undefined ? null : new Date(hold.release.releasedAt),
    releasedByPrincipalRef: hold.release?.releasedBy.actorPrincipalRef ?? null,
    releaseAuthorityRef: hold.release?.releasedBy.authorityRef ?? null,
  }
}

function parseRow(
  row: typeof retentionHolds.$inferSelect,
  policy: RetentionHoldPolicy
): RetentionHold {
  const rawScope =
    row.scopeKind === 'class'
      ? { kind: 'class' }
      : row.scopeKind === 'workspace'
        ? { kind: 'workspace', workspaceId: row.workspaceId }
        : row.scopeKind === 'project'
          ? { kind: 'project', workspaceId: row.workspaceId, projectId: row.projectId }
          : { kind: row.scopeKind }
  const releaseFields = [
    row.releaseRequestId,
    row.releasedAt,
    row.releasedByPrincipalRef,
    row.releaseAuthorityRef,
  ]
  const hasRelease = releaseFields.some((value) => value !== null)
  const rawRelease = hasRelease
    ? {
        requestId: row.releaseRequestId,
        releasedAt: row.releasedAt instanceof Date ? row.releasedAt.toISOString() : row.releasedAt,
        releasedBy: {
          actorPrincipalRef: row.releasedByPrincipalRef,
          authorityRef: row.releaseAuthorityRef,
        },
      }
    : undefined
  const raw = {
    holdId: row.holdId,
    classId: row.classId,
    scope: rawScope,
    owner: row.owner,
    reasonCode: row.reasonCode,
    createdAt: row.createdAt.toISOString(),
    createdBy: {
      actorPrincipalRef: row.createdByPrincipalRef,
      authorityRef: row.createdAuthorityRef,
    },
    revision: row.revision,
    ...(rawRelease === undefined ? {} : { release: rawRelease }),
  }
  const parsed = RetentionHoldSchema.safeParse(raw)
  if (!parsed.success) throw new RetentionHoldError('RETENTION_HOLD_STORED_RECORD_INVALID')
  return validateStoredHold(parsed.data, policy)
}

function replayOrConflict(current: RetentionHold, requested: RetentionHold) {
  if (!sameRetentionHoldIdentity(current, requested))
    throw new RetentionHoldError('RETENTION_HOLD_ID_CONFLICT')
  return { created: false, hold: current }
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
