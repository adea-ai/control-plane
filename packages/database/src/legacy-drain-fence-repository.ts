import { and, eq } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'
import { langgraphLegacyDrainFences } from './schema/langgraph-legacy-drain-fences.js'

export type LegacyDrainFenceRepositoryErrorCode =
  | 'LEGACY_DRAIN_FENCE_HELD'
  | 'LEGACY_DRAIN_FENCE_NOT_OWNED'
  | 'LEGACY_DRAIN_FENCE_STALE'
  | 'LEGACY_DRAIN_FENCE_STATE_INVALID'
  | 'LEGACY_FENCE_INVALID'

export class LegacyDrainFenceRepositoryError extends Error {
  readonly code: LegacyDrainFenceRepositoryErrorCode

  constructor(code: LegacyDrainFenceRepositoryErrorCode) {
    super(code)
    this.name = 'LegacyDrainFenceRepositoryError'
    this.code = code
  }
}

/** A claim handle. A release must present the exact generation and revision it was issued against. */
export interface LegacyDrainFenceHandle {
  readonly storageThreadId: string
  readonly owner: string
  readonly generation: number
  readonly revision: number
}

const MAXIMUM_IDENTIFIER_LENGTH = 256
const MAXIMUM_COUNTER = Number.MAX_SAFE_INTEGER

function identifier(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAXIMUM_IDENTIFIER_LENGTH) {
    throw new LegacyDrainFenceRepositoryError('LEGACY_FENCE_INVALID')
  }
  return value
}

function counter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= MAXIMUM_COUNTER) {
    throw new LegacyDrainFenceRepositoryError('LEGACY_FENCE_INVALID')
  }
  return value
}

function nextCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= MAXIMUM_COUNTER) {
    throw new LegacyDrainFenceRepositoryError('LEGACY_DRAIN_FENCE_STATE_INVALID')
  }
  return value + 1
}

function handleOf(row: {
  readonly storageThreadId: string
  readonly owner: string | null
  readonly generation: number
  readonly revision: number
}): LegacyDrainFenceHandle {
  if (row.owner === null)
    throw new LegacyDrainFenceRepositoryError('LEGACY_DRAIN_FENCE_STATE_INVALID')
  return {
    storageThreadId: row.storageThreadId,
    owner: row.owner,
    generation: row.generation,
    revision: row.revision,
  }
}

/**
 * Hosted fence for retained legacy LangGraph threads, in the existing PostgreSQL transaction pattern. Rows are
 * never deleted: a release clears the owner and advances the revision, so a generation or revision cannot be
 * reused. Every write is serialized by a row lock or a revision check, and a store error propagates, so a
 * resume that cannot read the fence is refused.
 */
export class PostgresLegacyDrainFenceRepository {
  constructor(
    readonly database: Pick<ControlPlaneDatabase, 'select' | 'insert' | 'update' | 'transaction'>
  ) {}

  /**
   * Claims the thread for owner. A second owner is refused while the fence is held. Re-claiming by the holder is
   * idempotent: it returns the held handle and does not advance the generation.
   */
  async claim(input: {
    readonly storageThreadId: string
    readonly owner: string
    readonly now?: () => string
  }): Promise<LegacyDrainFenceHandle> {
    const storageThreadId = identifier(input.storageThreadId)
    const owner = identifier(input.owner)
    const updatedAt = new Date((input.now ?? (() => new Date().toISOString()))())
    return this.database.transaction(async (transaction) => {
      const [created] = await transaction
        .insert(langgraphLegacyDrainFences)
        .values({ storageThreadId, owner, generation: 1, revision: 1, updatedAt })
        .onConflictDoNothing({ target: langgraphLegacyDrainFences.storageThreadId })
        .returning()
      if (created !== undefined) return handleOf(created)
      const [row] = await transaction
        .select()
        .from(langgraphLegacyDrainFences)
        .where(eq(langgraphLegacyDrainFences.storageThreadId, storageThreadId))
        .for('update')
      if (row === undefined)
        throw new LegacyDrainFenceRepositoryError('LEGACY_DRAIN_FENCE_STATE_INVALID')
      if (row.owner === owner) return handleOf(row)
      if (row.owner !== null) throw new LegacyDrainFenceRepositoryError('LEGACY_DRAIN_FENCE_HELD')
      const [reclaimed] = await transaction
        .update(langgraphLegacyDrainFences)
        .set({
          owner,
          generation: nextCounter(row.generation),
          revision: nextCounter(row.revision),
          updatedAt,
        })
        .where(
          and(
            eq(langgraphLegacyDrainFences.storageThreadId, storageThreadId),
            eq(langgraphLegacyDrainFences.revision, row.revision)
          )
        )
        .returning()
      if (reclaimed === undefined) {
        throw new LegacyDrainFenceRepositoryError('LEGACY_DRAIN_FENCE_STATE_INVALID')
      }
      return handleOf(reclaimed)
    })
  }

  /**
   * Releases only the exact handle that claimed the thread. Returns false when nothing is held. A handle for
   * another owner is refused with LEGACY_DRAIN_FENCE_NOT_OWNED, and a stale generation or revision with
   * LEGACY_DRAIN_FENCE_STALE. Neither refusal changes the row.
   */
  async release(handle: LegacyDrainFenceHandle): Promise<boolean> {
    const storageThreadId = identifier(handle.storageThreadId)
    const owner = identifier(handle.owner)
    const generation = counter(handle.generation)
    const revision = counter(handle.revision)
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(langgraphLegacyDrainFences)
        .where(eq(langgraphLegacyDrainFences.storageThreadId, storageThreadId))
        .for('update')
      if (row === undefined || row.owner === null) return false
      if (row.owner !== owner)
        throw new LegacyDrainFenceRepositoryError('LEGACY_DRAIN_FENCE_NOT_OWNED')
      if (row.generation !== generation || row.revision !== revision) {
        throw new LegacyDrainFenceRepositoryError('LEGACY_DRAIN_FENCE_STALE')
      }
      const [released] = await transaction
        .update(langgraphLegacyDrainFences)
        .set({ owner: null, revision: nextCounter(row.revision), updatedAt: new Date() })
        .where(
          and(
            eq(langgraphLegacyDrainFences.storageThreadId, storageThreadId),
            eq(langgraphLegacyDrainFences.revision, row.revision)
          )
        )
        .returning()
      return released !== undefined
    })
  }

  /** Refuses resume while a claim is held. A store error propagates and refuses the resume (fail closed). */
  async assertResumeAllowed(storageThreadId: string): Promise<void> {
    const [row] = await this.database
      .select({ owner: langgraphLegacyDrainFences.owner })
      .from(langgraphLegacyDrainFences)
      .where(eq(langgraphLegacyDrainFences.storageThreadId, identifier(storageThreadId)))
      .limit(1)
    if (row !== undefined && row.owner !== null) {
      throw new LegacyDrainFenceRepositoryError('LEGACY_DRAIN_FENCE_HELD')
    }
  }
}
