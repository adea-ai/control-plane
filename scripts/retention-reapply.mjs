import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseRetentionJournalLine } from '../packages/domain/src/retention-journal.ts'
import { loadDatabaseCredentials } from '../packages/config/src/database.ts'

// Restore-time reapplication (#194). A snapshot restored from before a deletion
// pass silently resurrects compacted records and loses the rejection identities
// that keep replays failing closed. This command applies the journal written by
// `retention-apply` to such a copy BEFORE it is exposed.
//
// It is idempotent by construction: inserts are "insert if absent" and deletes
// are by identity, so applying a journal twice — or applying an entry for an
// effect that never happened because the process died between the journal
// append and the storage change — is a no-op. Operations are applied by the
// explicit branch below, never by building SQL from journal content.
const MAXIMUM_JOURNAL_BYTES = 64 * 1024 * 1024

let close = async () => {}

try {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string' },
      database: { type: 'string' },
      host: { type: 'string' },
      journal: { type: 'string' },
    },
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
    for (const record of operations) {
      for (const operation of record.operations) {
        if (operation.kind === 'sqlite.put') {
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
    const credentials = loadDatabaseCredentials(process.env, 'application')
    const target = new URL(credentials.url)
    if (
      !values.host ||
      target.hostname !== values.host ||
      decodeURIComponent(target.pathname.slice(1)) !== values.database
    )
      throw new Error('INVALID_TARGET')
    const [{ createPostgresConnection }, { sql }, schema] = await Promise.all([
      import('../packages/database/src/connection.ts'),
      import('drizzle-orm'),
      import('../packages/database/src/schema/index.ts'),
    ])
    const connection = createPostgresConnection(credentials)
    close = () => connection.close()
    const database = connection.database
    for (const record of operations) {
      for (const operation of record.operations) {
        if (operation.kind === 'postgres.retireCommandKey') {
          const inserted = await database
            .insert(schema.retiredCommandKeys)
            .values({
              scopeKey: operation.scopeKey,
              commandId: operation.commandId,
              executionId: operation.executionId,
              retiredAt: new Date(operation.retiredAt),
            })
            .onConflictDoNothing()
            .returning({ scopeKey: schema.retiredCommandKeys.scopeKey })
          if (inserted.length === 1) applied += 1
          else skipped += 1
        } else if (operation.kind === 'postgres.deleteCommand') {
          const removed = await database
            .delete(schema.commandInbox)
            .where(sql`${schema.commandInbox.commandId} = ${operation.commandId}`)
            .returning({ commandId: schema.commandInbox.commandId })
          if (removed.length > 0) applied += 1
          else skipped += 1
        } else if (operation.kind === 'postgres.retireEventId') {
          const inserted = await database
            .insert(schema.retiredExecutionEventIds)
            .values({
              eventId: operation.eventId,
              executionId: operation.executionId,
              sequence: operation.sequence,
              retiredAt: new Date(operation.retiredAt),
            })
            .onConflictDoNothing()
            .returning({ eventId: schema.retiredExecutionEventIds.eventId })
          if (inserted.length === 1) applied += 1
          else skipped += 1
        } else if (operation.kind === 'postgres.deleteEvent') {
          const removed = await database
            .delete(schema.executionEvents)
            .where(sql`${schema.executionEvents.eventId} = ${operation.eventId}`)
            .returning({ eventId: schema.executionEvents.eventId })
          if (removed.length > 0) applied += 1
          else skipped += 1
        } else skipped += 1
      }
    }
  } else throw new Error('INVALID_BACKEND')

  process.stdout.write(
    `${JSON.stringify({
      report: 'retention-reapply',
      backend: values.backend,
      journal: journalPath,
      records: operations.length,
      applied,
      skipped,
    })}\n`
  )
} catch {
  process.stderr.write('RETENTION_REAPPLY_FAILED\n')
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch {
    process.stderr.write('RETENTION_REAPPLY_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}
