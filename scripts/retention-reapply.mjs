import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseRetentionJournalLine } from '@control-plane/domain'
import { loadDatabaseCredentials } from '@control-plane/config'

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
    // Source imports resolve relative to this script, so the command does not
    // depend on a root-level workspace symlink that a fresh install may not
    // create; the driver dependency resolves from the package itself.
    const [{ createPostgresConnection }, { PostgresRetentionReapplication }] = await Promise.all([
      import('../packages/database/src/connection.ts'),
      import('../packages/database/src/retention-reapplication.ts'),
    ])
    const connection = createPostgresConnection(credentials)
    close = () => connection.close()
    // SQL for each operation kind lives in the package that declares the
    // driver dependency; this command stays a thin operator wrapper.
    const reapplication = new PostgresRetentionReapplication(connection.database)
    for (const record of operations) {
      const outcome = await reapplication.apply(record.operations)
      applied += outcome.applied
      skipped += outcome.skipped
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
} catch (error) {
  // The code stays fixed and never carries a URL, a query parameter or an
  // underlying message; a whitelisted error code or the class name is the one
  // safe discriminator an operator needs to tell "bad target" from "database".
  process.stderr.write(`RETENTION_REAPPLY_FAILED${safeReason(error)}\n`)
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch {
    process.stderr.write('RETENTION_REAPPLY_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}
