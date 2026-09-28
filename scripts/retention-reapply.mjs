import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  CommandInboxRecordSchema,
  parseRetentionJournalLine,
  retiredCommandKeyCandidates,
  retiredCommandKeyFromMetadataV2,
} from '@control-plane/domain'
import { loadDatabaseCredentials } from '@control-plane/config'
import { recordId } from '../packages/sqlite-persistence/src/record-storage.ts'

// Restore-time reapplication (#194). A snapshot restored from before a deletion
// pass silently resurrects compacted records and loses the rejection identities
// that keep replays failing closed. This command applies the journal written by
// `retention-apply` to such a copy BEFORE it is exposed.
//
// It is idempotent by construction: inserts are "insert if absent" and deletes
// are by identity, so applying a journal twice — or applying an entry for an
// effect that never happened because the process died between the journal
// append and the storage change — still applies its approved deletion intent.
// Idempotence is not evidence of the original transaction's commit outcome.
// Operations are applied by the
// explicit branch below, never by building SQL from journal content.
const MAXIMUM_JOURNAL_BYTES = 64 * 1024 * 1024

function safeReason(error) {
  const code = error?.code
  if (code === 'ERR_MODULE_NOT_FOUND') {
    // A module specifier is code, not a credential: it is the only way to tell
    // which import a fresh install could not resolve.
    const specifier = /(?:module|package) '([^']{1,80})'/u.exec(String(error?.message))?.[1]
    return specifier === undefined ? ':ERR_MODULE_NOT_FOUND' : `:ERR_MODULE_NOT_FOUND:${specifier}`
  }
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/u.test(code)) return `:${code}`
  const name = error?.constructor?.name
  if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,59}$/u.test(name) && name !== 'Error')
    return `:${name}`
  return ''
}

const optionSchema = {
  backend: { type: 'string' },
  database: { type: 'string' },
  host: { type: 'string' },
  journal: { type: 'string' },
}

/**
 * Applies a deletion journal to a restored copy. Exported with injected
 * environment and output streams so tests exercise it in this process: a
 * spawned runtime per case made the unit lane too slow to fit its budget.
 */
export async function retentionReapply({
  argv = [],
  environment = process.env,
  writeOut = (text) => process.stdout.write(text),
  writeErr = (text) => process.stderr.write(text),
} = {}) {
  let close = async () => {}
  let closeFailed = false
  try {
    const { values } = parseArgs({
      args: argv,
      options: optionSchema,
      strict: true,
      allowPositionals: false,
    })
    if (!values.database || !values.journal || !isAbsolute(values.journal))
      throw new Error('INVALID_ARGUMENTS')
    const journalPath = resolve(values.journal)
    if (!existsSync(journalPath)) throw new Error('INVALID_ARGUMENTS')
    if (statSync(journalPath).size > MAXIMUM_JOURNAL_BYTES) throw new Error('INVALID_ARGUMENTS')
    const descriptor = openSync(journalPath, 'r')
    let text
    try {
      const buffer = Buffer.alloc(MAXIMUM_JOURNAL_BYTES)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        const chunk = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (chunk === 0) break
        bytesRead += chunk
      }
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
    } finally {
      closeSync(descriptor)
    }
    const operations = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => parseRetentionJournalLine(line))
      .filter((record) => record.backend === values.backend)

    let applied = 0
    let skipped = 0
    if (values.backend === 'sqlite') {
      if (values.host || !isAbsolute(values.database)) throw new Error('INVALID_TARGET')
      const { SqlitePersistenceProvider } = await import('@control-plane/sqlite-persistence')
      const provider = new SqlitePersistenceProvider({ path: values.database })
      close = async () => provider.close()
      // Opens the database and applies any pending migration to the restored
      // copy before the journal is replayed onto it.
      await provider.migrate()
      // Do this even for an empty journal: restored metadata may precede a
      // reference cycle, making an old release clock unsafe to reuse.
      await provider.resetReferenceRetentionWindows()
      for (const record of operations) {
        for (const operation of record.operations) {
          if (operation.kind === 'sqlite.put') {
            if (operation.namespace === 'retired-command-keys') {
              const tombstone = await restoreSqliteRetiredCommandKey(provider, operation)
              if (tombstone === 'inserted') applied += 1
              else skipped += 1
              continue
            }
            const existing = await provider.transaction((transaction) =>
              transaction.get(operation.namespace, operation.id)
            )
            if (existing !== undefined) {
              skipped += 1
              continue
            }
            await provider.transaction((transaction) =>
              transaction.put({
                namespace: operation.namespace,
                id: operation.id,
                value: operation.value,
              })
            )
            applied += 1
          } else if (operation.kind === 'sqlite.delete') {
            const removed = await provider.transaction((transaction) =>
              transaction.delete(operation.namespace, operation.id)
            )
            if (removed) applied += 1
            else skipped += 1
          } else skipped += 1
        }
      }
    } else if (values.backend === 'postgres') {
      // Application credentials can insert replay tombstones but cannot delete
      // them. Select the explicit migration role for any journal that removes
      // one; never fall back to DATABASE_URL when that role is missing.
      const requiresMigrationRole = operations.some((record) =>
        record.operations.some((operation) => operation.kind === 'postgres.deleteRetiredCommandKey')
      )
      const credentialRole = requiresMigrationRole ? 'migration' : 'application'
      const credentials = loadDatabaseCredentials(environment, credentialRole)
      const target = new URL(credentials.url)
      if (
        !values.host ||
        target.hostname !== values.host ||
        decodeURIComponent(target.pathname.slice(1)) !== values.database
      )
        throw new Error('INVALID_TARGET')
      // Source imports resolve relative to this script, so the command does not
      // depend on a root-level workspace symlink that a fresh install may not
      // create; the driver dependency resolves from the package itself.
      const [connectionModule, { PostgresRetentionReapplication }] = await Promise.all([
        import('../packages/database/src/connection.ts'),
        import('../packages/database/src/retention-reapplication.ts'),
      ])
      const connection =
        credentialRole === 'migration'
          ? connectionModule.createPostgresMigrationConnection(credentials)
          : connectionModule.createPostgresConnection(credentials)
      close = () => connection.close()
      // SQL for each operation kind lives in the package that declares the
      // driver dependency; this command stays a thin operator wrapper.
      const reapplication = new PostgresRetentionReapplication(connection.database)
      await reapplication.resetReferenceRetentionWindows()
      for (const record of operations) {
        const outcome = await reapplication.apply(record.operations)
        applied += outcome.applied
        skipped += outcome.skipped
      }
    } else throw new Error('INVALID_BACKEND')

    writeOut(
      `${JSON.stringify({
        report: 'retention-reapply',
        backend: values.backend,
        journal: journalPath,
        records: operations.length,
        applied,
        skipped,
      })}\n`
    )
  } catch (error) {
    // The code stays fixed and never carries a URL, a query parameter or an
    // underlying message; a whitelisted error code or the class name is the one
    // safe discriminator an operator needs to tell "bad target" from "database".
    writeErr(`RETENTION_REAPPLY_FAILED${safeReason(error)}\n`)
    return 1
  } finally {
    try {
      await close()
    } catch {
      writeErr('RETENTION_REAPPLY_CLOSE_FAILED\n')
      closeFailed = true
    }
  }
  return closeFailed ? 1 : 0
}

async function restoreSqliteRetiredCommandKey(provider, operation) {
  const journalValue = operation.value
  if (journalValue === null || typeof journalValue !== 'object' || Array.isArray(journalValue))
    throw new Error('RETENTION_RETIRED_COMMAND_JOURNAL_INVALID')
  const commandId = CommandInboxRecordSchema.shape.commandId.parse(journalValue.commandId)
  const executionId = CommandInboxRecordSchema.shape.executionId.parse(journalValue.executionId)
  if (
    journalValue.metadataVersion === 2 &&
    typeof journalValue.scopeKey === 'string' &&
    typeof journalValue.identityDigest === 'string' &&
    operation.id === recordId(journalValue.scopeKey) &&
    retiredCommandKeyFromMetadataV2(journalValue.identityDigest) === journalValue.scopeKey
  ) {
    const existing = await provider.transaction((transaction) =>
      transaction.get('retired-command-keys', operation.id)
    )
    if (existing !== undefined) {
      const stored = existing.value
      if (
        stored === null ||
        typeof stored !== 'object' ||
        stored.scopeKey !== journalValue.scopeKey ||
        stored.metadataVersion !== 2 ||
        stored.identityDigest !== journalValue.identityDigest ||
        stored.retiredAt !== journalValue.retiredAt ||
        stored.commandId !== commandId ||
        stored.executionId !== executionId ||
        retiredCommandKeyFromMetadataV2(stored.identityDigest) !== stored.scopeKey
      )
        throw new Error('RETENTION_RETIRED_COMMAND_STORED_MISMATCH')
      return 'existing'
    }
  }
  const restored = await provider.transaction(async (transaction) => {
    const index = await transaction.get('command-by-execution', recordId(executionId))
    if (index === undefined || typeof index.value !== 'string') return undefined
    const source = await transaction.get('command-inbox', index.value)
    return source === undefined ? undefined : CommandInboxRecordSchema.parse(source.value)
  })
  if (
    restored === undefined ||
    restored.commandId !== commandId ||
    restored.executionId !== executionId
  )
    throw new Error('RETENTION_RETIRED_COMMAND_SOURCE_MISSING')
  const keys = retiredCommandKeyCandidates(restored)
  const legacyId = recordId(keys.legacyScope)
  const currentId = recordId(keys.metadata.scopeKey)
  if (operation.id !== legacyId && operation.id !== currentId)
    throw new Error('RETENTION_RETIRED_COMMAND_JOURNAL_MISMATCH')
  if (
    typeof journalValue.retiredAt !== 'string' ||
    !Number.isFinite(Date.parse(journalValue.retiredAt)) ||
    new Date(journalValue.retiredAt).toISOString() !== journalValue.retiredAt ||
    (journalValue.metadataVersion !== undefined && journalValue.metadataVersion !== 2) ||
    (journalValue.scopeKey !== undefined && journalValue.scopeKey !== keys.metadata.scopeKey) ||
    (journalValue.identityDigest !== undefined &&
      journalValue.identityDigest !== keys.metadata.identityDigest)
  )
    throw new Error('RETENTION_RETIRED_COMMAND_JOURNAL_MISMATCH')
  const value = {
    scopeKey: keys.metadata.scopeKey,
    metadataVersion: keys.metadata.metadataVersion,
    identityDigest: keys.metadata.identityDigest,
    retiredAt: journalValue.retiredAt,
    commandId,
    executionId,
  }
  return provider.transaction(async (transaction) => {
    const existing = await transaction.get('retired-command-keys', currentId)
    if (existing !== undefined) {
      const stored = existing.value
      if (
        stored === null ||
        typeof stored !== 'object' ||
        stored.scopeKey !== value.scopeKey ||
        stored.metadataVersion !== value.metadataVersion ||
        stored.identityDigest !== value.identityDigest ||
        stored.retiredAt !== value.retiredAt ||
        stored.commandId !== value.commandId ||
        stored.executionId !== value.executionId ||
        retiredCommandKeyFromMetadataV2(stored.identityDigest) !== stored.scopeKey
      )
        throw new Error('RETENTION_RETIRED_COMMAND_STORED_MISMATCH')
      return 'existing'
    }
    await transaction.put({ namespace: 'retired-command-keys', id: currentId, value })
    return 'inserted'
  })
}

if (import.meta.main) {
  process.exitCode = await retentionReapply({ argv: process.argv.slice(2) })
}
