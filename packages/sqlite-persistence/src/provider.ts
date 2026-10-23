import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { backup, DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import type {
  DeploymentComponentHealth,
  JsonValue,
  PersistenceBackup,
  PersistenceProvider,
  PersistenceRecord,
  PersistenceScan,
  PersistenceTransaction,
  PersistenceWrite,
} from '@control-plane/deployment'
import { sqliteSchema } from './schema.js'
import { clearReferenceRetentionWindows } from './retention-reference-metadata.js'
import {
  applyMigrations,
  EXPIRY_INDEX_STATEMENTS,
  EXECUTION_SCOPE_STATEMENTS,
  PROJECT_REQUIRED_STATEMENTS,
  SCOPE_SCHEMA_VERSION_STATEMENTS,
  SCHEMA_STATEMENTS,
  SCHEMA_VERSION,
  SqliteMigrationError,
} from './migrations.js'

const MAX_RECORD_BYTES = 16 * 1024 * 1024
const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/

export type SqlitePersistenceErrorCode =
  | 'SQLITE_INVALID_PATH'
  | 'SQLITE_INVALID_RECORD'
  | 'SQLITE_REVISION_CONFLICT'
  | 'SQLITE_SCHEMA_INCOMPATIBLE'
  | 'SQLITE_BACKUP_INVALID'
  | 'SQLITE_CHECKPOINT_BUSY'
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

export class SqlitePersistenceProvider implements PersistenceProvider {
  readonly profile: 'local' | 'hosted-simple'
  readonly dialect = 'sqlite' as const
  readonly #path: string
  readonly #now: () => Date
  #native: DatabaseSync | undefined
  #statements: StatementCache | undefined
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
    try {
      applyMigrations(database)
    } catch (error) {
      if (error instanceof SqliteMigrationError)
        throw new SqlitePersistenceError('SQLITE_SCHEMA_INCOMPATIBLE')
      throw error
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
      const result = await operation(new SqliteRecordTransaction(this.#records(), this.#now))
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

  /** Restore maintenance only; normal migrate/reopen deliberately preserves clocks. */
  async resetReferenceRetentionWindows(): Promise<void> {
    await this.transaction(async () => clearReferenceRetentionWindows(this.#assertOpen()))
  }

  async restore(snapshot: PersistenceBackup): Promise<void> {
    if (
      !Number.isSafeInteger(snapshot.schemaVersion) ||
      snapshot.schemaVersion < 1 ||
      snapshot.schemaVersion > SCHEMA_VERSION ||
      snapshot.bytes.byteLength === 0 ||
      digest(snapshot.bytes) !== snapshot.digest
    ) {
      throw new SqlitePersistenceError('SQLITE_BACKUP_INVALID')
    }
    if (this.#transactionActive) throw new SqlitePersistenceError('SQLITE_REVISION_CONFLICT')
    const temporaryPath = `${this.#path}.restore-${randomUUID()}`
    const stagedFile = await open(temporaryPath, 'wx', 0o600)
    try {
      try {
        await stagedFile.writeFile(snapshot.bytes)
      } finally {
        await stagedFile.close()
      }
      validateRestoreDatabase(temporaryPath, snapshot.schemaVersion)
      // Staging is asynchronous; recheck before touching the live connection.
      if (this.#transactionActive) throw new SqlitePersistenceError('SQLITE_REVISION_CONFLICT')
      this.#native?.close()
      this.#native = undefined
      this.#statements = undefined
      await unlink(`${this.#path}-wal`).catch(() => undefined)
      await unlink(`${this.#path}-shm`).catch(() => undefined)
      await rename(temporaryPath, this.#path)
      await chmod(this.#path, 0o600)
      await this.#open()
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  close(options: { readonly checkpoint?: boolean } = {}): void {
    if (this.#transactionActive) throw new SqlitePersistenceError('SQLITE_REVISION_CONFLICT')
    const database = this.#native
    try {
      if (database && options.checkpoint) {
        // A cold directory checkpoint must not depend on deferred statement GC
        // removing WAL sidecars after the caller starts copying files.
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        const mode = database.prepare('PRAGMA journal_mode = DELETE').get() as
          | Readonly<Record<string, unknown>>
          | undefined
        if (mode?.['journal_mode'] !== 'delete')
          throw new SqlitePersistenceError('SQLITE_CHECKPOINT_BUSY')
      }
    } catch {
      throw new SqlitePersistenceError('SQLITE_CHECKPOINT_BUSY')
    } finally {
      database?.close()
      this.#native = undefined
      this.#statements = undefined
    }
  }

  async #open(): Promise<DatabaseSync> {
    if (this.#native !== undefined) return this.#native
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    await chmod(dirname(this.#path), 0o700)
    const database = new DatabaseSync(this.#path)
    // WAL configuration can acquire a lock before migrations begin.
    // Install the bounded busy handler before any lock-taking pragma.
    database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
    `)
    await chmod(this.#path, 0o600)
    this.#native = database
    this.#statements = new StatementCache(database)
    return database
  }

  #records(): StatementCache {
    if (this.#statements === undefined) throw new SqlitePersistenceError('SQLITE_CLOSED')
    return this.#statements
  }

  #assertOpen(): DatabaseSync {
    if (this.#native === undefined) throw new SqlitePersistenceError('SQLITE_CLOSED')
    return this.#native
  }
}

function validateRestoreDatabase(path: string, expectedSnapshotVersion: number): void {
  let database: DatabaseSync | undefined
  try {
    // A WAL-mode backup may need sidecars even for reads. Only the disposable
    // staged copy is opened here; normalize it to a standalone file before rename.
    database = new DatabaseSync(path)
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA journal_mode = DELETE')
    const checks = database.prepare('PRAGMA quick_check').all()
    if (checks.length !== 1 || Object.values(checks[0] ?? {})[0] !== 'ok') {
      throw new Error('Invalid SQLite integrity')
    }
    const version = database
      .prepare("SELECT value FROM control_plane_metadata WHERE key = 'schema_version'")
      .get()
    if (version?.['value'] !== String(expectedSnapshotVersion)) {
      throw new Error('Incompatible SQLite schema')
    }
    for (const [name, expected] of Object.entries(SCHEMA_STATEMENTS)) {
      const actual = database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name)
      if (
        typeof actual?.['sql'] !== 'string' ||
        normalizeSchema(actual['sql']) !== normalizeSchema(expected)
      ) {
        throw new Error('Incompatible SQLite schema definition')
      }
    }
    database
      .prepare(
        'SELECT namespace, id, revision, value, updated_at FROM control_plane_records LIMIT 0'
      )
      .all()
    // Validate history (or adopt legacy v1) on the disposable copy, never after replacement.
    applyMigrations(database)
    for (const [name, expected] of Object.entries({
      ...EXPIRY_INDEX_STATEMENTS,
      ...EXECUTION_SCOPE_STATEMENTS,
      ...PROJECT_REQUIRED_STATEMENTS,
      ...SCOPE_SCHEMA_VERSION_STATEMENTS,
    })) {
      const actual = database.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name)
      if (
        typeof actual?.['sql'] !== 'string' ||
        normalizeSchema(actual['sql']) !== normalizeSchema(expected)
      ) {
        throw new Error('Incompatible SQLite index or scope constraint')
      }
    }
    // A backup can predate a reference cycle that reset these clocks in the
    // source database. Invalidate the staged copy before it can be exposed.
    clearReferenceRetentionWindows(database)
  } catch {
    throw new SqlitePersistenceError('SQLITE_BACKUP_INVALID')
  } finally {
    database?.close()
  }
}

function normalizeSchema(sql: string): string {
  return sql
    .replace(/IF NOT EXISTS/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Prepared statements are cached per connection: the cache is created with
 * each native connection and dropped with it (`close()`/`restore()`), so a
 * cached statement never outlives or crosses the connection that prepared it.
 * SQLite re-prepares a statement itself when the schema changes.
 */
const MAX_CACHED_STATEMENTS = 256

class StatementCache {
  readonly #statements = new Map<string, StatementSync>()

  constructor(readonly database: DatabaseSync) {}

  get(query: string, ...params: unknown[]): Record<string, unknown> | undefined {
    return this.#prepare(query).get(...params.map(sqliteInput))
  }

  all(query: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.#prepare(query).all(...params.map(sqliteInput))
  }

  run(query: string, ...params: unknown[]): void {
    this.#prepare(query).run(...params.map(sqliteInput))
  }

  #prepare(query: string): StatementSync {
    const cached = this.#statements.get(query)
    if (cached !== undefined) return cached
    const statement = this.database.prepare(query)
    if (this.#statements.size >= MAX_CACHED_STATEMENTS) {
      const oldest = this.#statements.keys().next()
      if (!oldest.done) this.#statements.delete(oldest.value)
    }
    this.#statements.set(query, statement)
    return statement
  }
}

const RECORD_COLUMNS = 'namespace, id, revision, value, updated_at'
const SELECT_RECORD = `SELECT ${RECORD_COLUMNS} FROM control_plane_records WHERE namespace = ? AND id = ? LIMIT 1`
const INSERT_RECORD = `INSERT INTO control_plane_records (${RECORD_COLUMNS}) VALUES (?, ?, ?, ?, ?)`
const UPDATE_RECORD =
  'UPDATE control_plane_records SET revision = ?, value = ?, updated_at = ? WHERE namespace = ? AND id = ? AND revision = ?'
const DELETE_RECORD =
  'DELETE FROM control_plane_records WHERE namespace = ? AND id = ? AND revision = ?'
const LIST_RECORDS = `SELECT ${RECORD_COLUMNS} FROM control_plane_records WHERE namespace = ? ORDER BY updated_at, id`
const SCAN_RECORDS = `SELECT ${RECORD_COLUMNS} FROM control_plane_records WHERE namespace = ? ORDER BY id LIMIT ?`
const SCAN_RECORDS_AFTER = `SELECT ${RECORD_COLUMNS} FROM control_plane_records WHERE namespace = ? AND id > ? ORDER BY id LIMIT ?`

interface StoredRecord {
  readonly namespace: string
  readonly id: string
  readonly revision: number
  readonly value: string
  readonly updatedAt: string
}

class SqliteRecordTransaction implements PersistenceTransaction {
  constructor(
    readonly statements: StatementCache,
    readonly now: () => Date
  ) {}

  async get(namespace: string, id: string): Promise<PersistenceRecord | undefined> {
    validIdentity(namespace, id)
    return this.#read(namespace, id)
  }

  #read(namespace: string, id: string): PersistenceRecord | undefined {
    const row = this.statements.get(SELECT_RECORD, namespace, id)
    return row === undefined ? undefined : decodeRecord(storedRecord(row))
  }

  async put(write: PersistenceWrite): Promise<PersistenceRecord> {
    validIdentity(write.namespace, write.id)
    const encoded = encodeValue(write.value)
    const existing = this.#read(write.namespace, write.id)
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
      this.statements.run(
        INSERT_RECORD,
        next.namespace,
        next.id,
        next.revision,
        next.value,
        next.updatedAt
      )
    } else {
      this.statements.run(
        UPDATE_RECORD,
        next.revision,
        next.value,
        next.updatedAt,
        next.namespace,
        next.id,
        existing.revision
      )
    }
    return decodeRecord(next)
  }

  async delete(namespace: string, id: string, expectedRevision?: number): Promise<boolean> {
    validIdentity(namespace, id)
    const existing = this.#read(namespace, id)
    if (existing === undefined) return false
    if (expectedRevision !== undefined && existing.revision !== expectedRevision) {
      throw new SqlitePersistenceError('SQLITE_REVISION_CONFLICT')
    }
    this.statements.run(DELETE_RECORD, namespace, id, existing.revision)
    return true
  }

  async list(namespace: string): Promise<readonly PersistenceRecord[]> {
    validName(namespace)
    return this.statements
      .all(LIST_RECORDS, namespace)
      .map((row) => decodeRecord(storedRecord(row)))
  }

  async scan(namespace: string, options: PersistenceScan): Promise<readonly PersistenceRecord[]> {
    validName(namespace)
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 128) {
      throw new SqlitePersistenceError('SQLITE_INVALID_RECORD')
    }
    if (options.afterId !== undefined) validIdentity(namespace, options.afterId)
    const rows =
      options.afterId === undefined
        ? this.statements.all(SCAN_RECORDS, namespace, options.limit)
        : this.statements.all(SCAN_RECORDS_AFTER, namespace, options.afterId, options.limit)
    return rows.map((row) => decodeRecord(storedRecord(row)))
  }
}

function storedRecord(row: Record<string, unknown>): StoredRecord {
  return {
    namespace: row['namespace'] as string,
    id: row['id'] as string,
    revision: row['revision'] as number,
    value: row['value'] as string,
    updatedAt: row['updated_at'] as string,
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

function decodeRecord(record: StoredRecord): PersistenceRecord {
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
