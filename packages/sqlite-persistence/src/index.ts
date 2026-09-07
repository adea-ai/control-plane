import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  DeploymentComponentHealth,
  JsonValue,
  PersistenceBackup,
  PersistenceProvider,
  PersistenceRecord,
  PersistenceTransaction,
  PersistenceWrite,
} from '@control-plane/deployment'
import { and, eq } from 'drizzle-orm'
import {
  drizzle,
  type AsyncRemoteCallback,
  type SqliteRemoteDatabase,
} from 'drizzle-orm/sqlite-proxy'
import { metadata, records, sqliteSchema } from './schema.js'

export * from './repositories.js'
export * from './repositories-extra.js'
export * from './durability-repositories.js'
export * from './runtime-discovery-repository.js'

const SCHEMA_VERSION = 1
const MAX_RECORD_BYTES = 16 * 1024 * 1024
const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/

export type SqlitePersistenceErrorCode =
  | 'SQLITE_INVALID_PATH'
  | 'SQLITE_INVALID_RECORD'
  | 'SQLITE_REVISION_CONFLICT'
  | 'SQLITE_SCHEMA_INCOMPATIBLE'
  | 'SQLITE_BACKUP_INVALID'
  | 'SQLITE_CLOSED'

export class SqlitePersistenceError extends Error {
  constructor(readonly code: SqlitePersistenceErrorCode) {
    super('SQLite persistence operation failed')
    this.name = 'SqlitePersistenceError'
  }
}

export interface SqlitePersistenceProviderOptions {
  readonly path: string
  readonly profile?: 'local' | 'hosted-simple'
  readonly now?: () => Date
}

type LocalDatabase = SqliteRemoteDatabase<typeof sqliteSchema>

export class SqlitePersistenceProvider implements PersistenceProvider {
  readonly profile: 'local' | 'hosted-simple'
  readonly dialect = 'sqlite' as const
  readonly #path: string
  readonly #now: () => Date
  #native: DatabaseSync | undefined
  #drizzle: LocalDatabase | undefined
  #transactionActive = false
  #transactionTail: Promise<void> = Promise.resolve()

  constructor(options: SqlitePersistenceProviderOptions) {
    if (options.path.length === 0 || options.path === ':memory:') {
      throw new SqlitePersistenceError('SQLITE_INVALID_PATH')
    }
    this.#path = resolve(options.path)
    this.profile = options.profile ?? 'local'
    this.#now = options.now ?? (() => new Date())
  }

  async migrate(): Promise<void> {
    const database = await this.#open()
    database.exec(`
      CREATE TABLE IF NOT EXISTS control_plane_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_plane_records (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        value TEXT NOT NULL CHECK (json_valid(value)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS control_plane_records_namespace_updated
        ON control_plane_records(namespace, updated_at, id);
    `)
    const orm = this.#orm()
    const current = await orm
      .select({ value: metadata.value })
      .from(metadata)
      .where(eq(metadata.key, 'schema_version'))
      .limit(1)
    const version = current[0]?.value
    if (version !== undefined && version !== String(SCHEMA_VERSION)) {
      throw new SqlitePersistenceError('SQLITE_SCHEMA_INCOMPATIBLE')
    }
    if (version === undefined) {
      await orm.insert(metadata).values({ key: 'schema_version', value: String(SCHEMA_VERSION) })
    }
  }

  async health(): Promise<DeploymentComponentHealth> {
    const result = this.#assertOpen().prepare('PRAGMA quick_check').get() as
      | Readonly<Record<string, unknown>>
      | undefined
    return {
      ready: result !== undefined && Object.values(result)[0] === 'ok',
      component: 'sqlite-persistence',
      version: String(SCHEMA_VERSION),
      details: { profile: this.profile, wal: true },
    }
  }

  transaction<Result>(
    operation: (transaction: PersistenceTransaction) => Promise<Result>
  ): Promise<Result> {
    const result = this.#transactionTail.then(
      () => this.#runTransaction(operation),
      () => this.#runTransaction(operation)
    )
    this.#transactionTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async #runTransaction<Result>(
    operation: (transaction: PersistenceTransaction) => Promise<Result>
  ): Promise<Result> {
    const database = this.#assertOpen()
    database.exec('BEGIN IMMEDIATE')
    this.#transactionActive = true
    try {
      const result = await operation(new SqliteRecordTransaction(this.#orm(), this.#now))
      database.exec('COMMIT')
      return result
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    } finally {
      this.#transactionActive = false
    }
  }

  async backup(): Promise<PersistenceBackup> {
    const database = this.#assertOpen()
    const temporaryPath = `${this.#path}.backup-${randomUUID()}`
    await backup(database, temporaryPath)
    try {
      const bytes = new Uint8Array(await readFile(temporaryPath))
      return {
        schemaVersion: SCHEMA_VERSION,
        createdAt: this.#now().toISOString(),
        digest: digest(bytes),
        bytes,
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  async restore(snapshot: PersistenceBackup): Promise<void> {
    if (
      snapshot.schemaVersion !== SCHEMA_VERSION ||
      snapshot.bytes.byteLength === 0 ||
      digest(snapshot.bytes) !== snapshot.digest
    ) {
      throw new SqlitePersistenceError('SQLITE_BACKUP_INVALID')
    }
    if (this.#transactionActive) throw new SqlitePersistenceError('SQLITE_REVISION_CONFLICT')
    this.#native?.close()
    this.#native = undefined
    this.#drizzle = undefined
    const temporaryPath = `${this.#path}.restore-${randomUUID()}`
    await writeFile(temporaryPath, snapshot.bytes, { mode: 0o600, flag: 'wx' })
    await unlink(`${this.#path}-wal`).catch(() => undefined)
    await unlink(`${this.#path}-shm`).catch(() => undefined)
    await rename(temporaryPath, this.#path)
    await chmod(this.#path, 0o600)
    await this.#open()
    await this.migrate()
    const health = await this.health()
    if (!health.ready) throw new SqlitePersistenceError('SQLITE_BACKUP_INVALID')
  }

  close(): void {
    if (this.#transactionActive) throw new SqlitePersistenceError('SQLITE_REVISION_CONFLICT')
    this.#native?.close()
    this.#native = undefined
    this.#drizzle = undefined
  }

  async #open(): Promise<DatabaseSync> {
    if (this.#native !== undefined) return this.#native
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.#path), 0o700)
    const database = new DatabaseSync(this.#path)
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
    `)
    await chmod(this.#path, 0o600)
    this.#native = database
    this.#drizzle = drizzle(createRemoteCallback(database), { schema: sqliteSchema })
    return database
  }

  #orm(): LocalDatabase {
    if (this.#drizzle === undefined) throw new SqlitePersistenceError('SQLITE_CLOSED')
    return this.#drizzle
  }

  #assertOpen(): DatabaseSync {
    if (this.#native === undefined) throw new SqlitePersistenceError('SQLITE_CLOSED')
    return this.#native
  }
}

class SqliteRecordTransaction implements PersistenceTransaction {
  constructor(
    readonly database: LocalDatabase,
    readonly now: () => Date
  ) {}

  async get(namespace: string, id: string): Promise<PersistenceRecord | undefined> {
    validIdentity(namespace, id)
    const result = await this.database
      .select()
      .from(records)
      .where(and(eq(records.namespace, namespace), eq(records.id, id)))
      .limit(1)
    return result[0] === undefined ? undefined : decodeRecord(result[0])
  }

  async put(write: PersistenceWrite): Promise<PersistenceRecord> {
    validIdentity(write.namespace, write.id)
    const encoded = encodeValue(write.value)
    const existing = await this.get(write.namespace, write.id)
    if (write.expectedRevision !== undefined && existing?.revision !== write.expectedRevision) {
      throw new SqlitePersistenceError('SQLITE_REVISION_CONFLICT')
    }
    if (write.expectedRevision === undefined && existing !== undefined) {
      throw new SqlitePersistenceError('SQLITE_REVISION_CONFLICT')
    }
    const next = {
      namespace: write.namespace,
      id: write.id,
      revision: (existing?.revision ?? 0) + 1,
      value: encoded,
      updatedAt: this.now().toISOString(),
    }
    if (existing === undefined) {
      await this.database.insert(records).values(next)
    } else {
      await this.database
        .update(records)
        .set({ revision: next.revision, value: next.value, updatedAt: next.updatedAt })
        .where(
          and(
            eq(records.namespace, next.namespace),
            eq(records.id, next.id),
            eq(records.revision, existing.revision)
          )
        )
    }
    return decodeRecord(next)
  }

  async delete(namespace: string, id: string, expectedRevision?: number): Promise<boolean> {
    validIdentity(namespace, id)
    const existing = await this.get(namespace, id)
    if (existing === undefined) return false
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      throw new SqlitePersistenceError('SQLITE_REVISION_CONFLICT')
    }
    await this.database
      .delete(records)
      .where(
        and(
          eq(records.namespace, namespace),
          eq(records.id, id),
          eq(records.revision, existing.revision)
        )
      )
    return true
  }

  async list(namespace: string): Promise<readonly PersistenceRecord[]> {
    validName(namespace)
    const result = await this.database
      .select()
      .from(records)
      .where(eq(records.namespace, namespace))
      .orderBy(records.updatedAt, records.id)
    return result.map(decodeRecord)
  }
}

function createRemoteCallback(database: DatabaseSync): AsyncRemoteCallback {
  return async (query: string, params: unknown[], method: 'run' | 'all' | 'values' | 'get') => {
    const statement = database.prepare(query)
    const values = params.map(sqliteInput)
    if (method === 'run') {
      statement.run(...values)
      return { rows: [] }
    }
    statement.setReturnArrays(true)
    if (method === 'get') {
      return { rows: (statement.get(...values) ?? []) as unknown[] }
    }
    return { rows: statement.all(...values) as unknown as unknown[][] }
  }
}

function sqliteInput(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    ArrayBuffer.isView(value)
  ) {
    return value as SQLInputValue
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  throw new SqlitePersistenceError('SQLITE_INVALID_RECORD')
}

function validIdentity(namespace: string, id: string): void {
  validName(namespace)
  if (
    id.length === 0 ||
    id.length > 512 ||
    Array.from(id).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new SqlitePersistenceError('SQLITE_INVALID_RECORD')
  }
}

function validName(namespace: string): void {
  if (!NAME_PATTERN.test(namespace)) throw new SqlitePersistenceError('SQLITE_INVALID_RECORD')
}

function encodeValue(value: JsonValue): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > MAX_RECORD_BYTES) {
    throw new SqlitePersistenceError('SQLITE_INVALID_RECORD')
  }
  return encoded
}

function decodeRecord(record: typeof records.$inferSelect): PersistenceRecord {
  return {
    namespace: record.namespace,
    id: record.id,
    revision: record.revision,
    value: JSON.parse(record.value) as JsonValue,
    updatedAt: record.updatedAt,
  }
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export { sqliteSchema }
