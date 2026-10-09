import { and, eq, gt, sql } from 'drizzle-orm'
import { persistenceRecords, type ControlPlaneDatabase } from '@control-plane/database'
import {
  DeploymentProfiles,
  type DeploymentComponentHealth,
  type PersistenceProvider,
  type PersistenceRecord,
  type PersistenceScan,
  type PersistenceTransaction,
  type PersistenceWrite,
} from '@control-plane/deployment'

/**
 * `PersistenceProvider` over the Hosted `hosted-server` (PostgreSQL) profile's
 * `persistence_records` table.
 *
 * It preserves the exact provider contract the SQLite implementation provides: unconditional puts
 * over an existing record and optimistic puts whose `expectedRevision` no longer matches both fail
 * with a message containing `REVISION_CONFLICT`, deletes are revision-guarded, `scan` is a bounded
 * keyset over storage ids, and every mutation runs inside one database transaction so concurrent
 * writers resolve through conflicts and retries rather than lost updates. The provider does not
 * own the injected `ControlPlaneDatabase` connection and never closes it.
 */

type TransactionContext = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]

const CONFLICT = 'POSTGRES_PERSISTENCE_REVISION_CONFLICT'

function recordOf(row: {
  namespace: string
  id: string
  revision: number
  value: unknown
  updatedAt: string
}): PersistenceRecord {
  return {
    namespace: row.namespace,
    id: row.id,
    revision: row.revision,
    value: row.value as PersistenceRecord['value'],
    updatedAt: row.updatedAt,
  }
}

class PostgresPersistenceTransaction implements PersistenceTransaction {
  readonly #transaction: TransactionContext
  readonly #now: () => string

  constructor(transaction: TransactionContext, now: () => string) {
    this.#transaction = transaction
    this.#now = now
  }

  async get(namespace: string, id: string): Promise<PersistenceRecord | undefined> {
    const rows = await this.#transaction
      .select()
      .from(persistenceRecords)
      .where(and(eq(persistenceRecords.namespace, namespace), eq(persistenceRecords.id, id)))
      .limit(1)
    const [row] = rows
    return row === undefined ? undefined : recordOf(row)
  }

  async put(write: PersistenceWrite): Promise<PersistenceRecord> {
    const updatedAt = this.#now()
    if (write.expectedRevision === undefined) {
      // Create-only, matching the SQLite provider: an unconditional put over an existing record is
      // a revision conflict, never a silent overwrite.
      const rows = await this.#transaction
        .insert(persistenceRecords)
        .values({
          namespace: write.namespace,
          id: write.id,
          revision: 1,
          value: write.value,
          updatedAt,
        })
        .onConflictDoNothing()
        .returning()
      const [created] = rows
      if (created === undefined) throw new Error(CONFLICT)
      return recordOf(created)
    }
    const rows = await this.#transaction
      .update(persistenceRecords)
      .set({ revision: sql`${persistenceRecords.revision} + 1`, value: write.value, updatedAt })
      .where(
        and(
          eq(persistenceRecords.namespace, write.namespace),
          eq(persistenceRecords.id, write.id),
          eq(persistenceRecords.revision, write.expectedRevision)
        )
      )
      .returning()
    const [updated] = rows
    if (updated === undefined) throw new Error(CONFLICT)
    return recordOf(updated)
  }

  async delete(namespace: string, id: string, expectedRevision?: number): Promise<boolean> {
    const rows = await this.#transaction
      .select()
      .from(persistenceRecords)
      .where(and(eq(persistenceRecords.namespace, namespace), eq(persistenceRecords.id, id)))
      .limit(1)
    const [existing] = rows
    if (existing === undefined) return false
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      throw new Error(CONFLICT)
    }
    const removed = await this.#transaction
      .delete(persistenceRecords)
      .where(
        and(
          eq(persistenceRecords.namespace, namespace),
          eq(persistenceRecords.id, id),
          eq(persistenceRecords.revision, existing.revision)
        )
      )
      .returning({ id: persistenceRecords.id })
    // Canonical contract: the observed revision was checked above, so a row that no longer matches
    // it lost to a concurrent update between the read and the DELETE — that is a revision conflict,
    // never a silent "deleted nothing".
    if (removed.length === 0) throw new Error(CONFLICT)
    return true
  }

  async list(namespace: string): Promise<readonly PersistenceRecord[]> {
    const rows = await this.#transaction
      .select()
      .from(persistenceRecords)
      .where(eq(persistenceRecords.namespace, namespace))
      .orderBy(persistenceRecords.id)
    return rows.map(recordOf)
  }

  async scan(namespace: string, options: PersistenceScan): Promise<readonly PersistenceRecord[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 128) {
      throw new Error('POSTGRES_PERSISTENCE_INVALID_RECORD')
    }
    const rows = await this.#transaction
      .select()
      .from(persistenceRecords)
      .where(
        and(
          eq(persistenceRecords.namespace, namespace),
          options.afterId === undefined ? undefined : gt(persistenceRecords.id, options.afterId)
        )
      )
      .orderBy(persistenceRecords.id)
      .limit(options.limit)
    return rows.map(recordOf)
  }
}

export interface PostgresPersistenceProviderOptions {
  readonly database: ControlPlaneDatabase
  readonly now?: () => string
}

export class PostgresPersistenceProvider implements PersistenceProvider {
  readonly profile = DeploymentProfiles.hostedServer
  readonly dialect = 'postgresql' as const
  readonly #database: ControlPlaneDatabase
  readonly #now: () => string

  constructor(options: PostgresPersistenceProviderOptions) {
    this.#database = options.database
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  /**
   * Schema guard. The canonical dependency for DDL is the hosted-server migration chain
   * (`packages/database` drizzle migrations, 0069_persistence_records, applied by the migration
   * role before the application starts): the application role must never create tables, so this
   * method verifies presence and fails typed when the chain has not run instead of issuing DDL.
   */
  async migrate(): Promise<void> {
    try {
      await this.#database.execute(sql`select 1 from persistence_records limit 1`)
    } catch {
      throw new Error('PERSISTENCE_RECORDS_SCHEMA_MISSING')
    }
  }

  async health(): Promise<DeploymentComponentHealth> {
    try {
      const rows = await this.#database
        .select({ count: sql<string>`count(*)` })
        .from(persistenceRecords)
        .limit(1)
      return {
        ready: rows.length >= 0,
        component: 'persistence-records',
        version: '1',
        details: { profile: this.profile, dialect: this.dialect },
      }
    } catch {
      return {
        ready: false,
        component: 'persistence-records',
        version: '1',
        details: { profile: this.profile, dialect: this.dialect },
      }
    }
  }

  async transaction<Result>(operation: (transaction: PersistenceTransaction) => Promise<Result>) {
    return this.#database.transaction(async (transaction) =>
      operation(new PostgresPersistenceTransaction(transaction, this.#now))
    )
  }

  /** The injected connection belongs to the caller (profile composition); this is a no-op. */
  close(): void {}
}
