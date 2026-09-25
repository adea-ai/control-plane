import { Database } from 'bun:sqlite'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
// Source imports keep CLI startup fast: the Postgres driver is loaded only
// when that backend is selected.
import {
  decidedRetentionPolicy,
  loadRetentionPolicy,
} from '../packages/config/src/retention-policy.ts'
import { loadDatabaseCredentials } from '../packages/config/src/database.ts'
import { retentionClasses } from './retention-classes.mjs'

// Read-only retention report (#194). Physical deletion stays fail-closed
// (COMMAND_RETENTION_ELIGIBILITY_REQUIRED / EVENT_RETENTION_ELIGIBILITY_REQUIRED),
// so operators need visibility into retained growth instead of a sweep. This
// tool opens the target read-only, counts candidates per class, and prints a
// payload-free report. It never deletes, never prints variables or database
// URLs, and reports one sanitized failure code.
//
// Candidate = a record whose stored expiry is already in the past. That is a
// monitoring signal, not deletion authority: terminal-state, reference, hold
// and publication checks are still outstanding for every class.
const namespaces = {
  commandInbox: 'command-inbox',
  executionEvents: 'execution-events',
  retiredCommands: 'retired-command-keys',
}

let close = async () => {}

function parseInstant(value, label) {
  if (value === undefined) return new Date()
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`INVALID_INSTANT:${label}`)
  return parsed
}

try {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string' },
      classes: { type: 'boolean' },
      database: { type: 'string' },
      host: { type: 'string' },
      now: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (values.classes === true) {
    // Policy and implementation side by side: a class the owner's decision keeps
    // reference-governed has no age deadline, so no candidate can ever be
    // eligible for it, while a bounded class without an entry here still needs
    // its deletion path built.
    const policy = loadRetentionPolicy()
    process.stdout.write(
      `${JSON.stringify({
        report: 'retention-classes',
        policy: { schemaVersion: policy.schemaVersion, effectiveAt: policy.effectiveAt },
        classes: policy.classes.map((entry) => ({
          id: entry.id,
          retainMs: entry.retainMs,
          governance: entry.retainMs === null ? 'reference-governed' : 'bounded',
          holdOwner: entry.holdOwner,
          deletionPath: retentionClasses[entry.id] ?? null,
        })),
      })}\n`
    )
    process.exit(0)
  }
  if (!values.database) throw new Error('INVALID_ARGUMENTS')
  const now = parseInstant(values.now, 'now')
  const policy = loadRetentionPolicy()
  const classes = {}

  if (values.backend === 'sqlite') {
    if (values.host || !isAbsolute(values.database)) throw new Error('INVALID_TARGET')
    const stat = await lstat(values.database)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_TARGET')
    const database = new Database(values.database, { readonly: true })
    close = () => database.close()
    const countExpired = (namespace) =>
      database
        .query(
          `select count(*) as count from control_plane_records
           where namespace = ?1
             and json_type(value, '$.retentionExpiresAt') = 'text'
             and json_extract(value, '$.retentionExpiresAt') GLOB
               '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
             and json_extract(value, '$.retentionExpiresAt') < ?2`
        )
        .get(namespace, now.toISOString()).count
    const countRetained = (namespace) =>
      database
        .query('select count(*) as count from control_plane_records where namespace = ?1')
        .get(namespace).count
    for (const [label, namespace] of [
      ['commandInbox', namespaces.commandInbox],
      ['executionEvents', namespaces.executionEvents],
    ]) {
      classes[label] = {
        expiredCandidates: countExpired(namespace),
        retained: countRetained(namespace),
      }
    }
    classes.retiredCommandKeys = { retained: countRetained(namespaces.retiredCommands) }
  } else if (values.backend === 'postgres') {
    const [{ sql }, { createPostgresConnection }] = await Promise.all([
      import('drizzle-orm'),
      import('../packages/database/src/connection.ts'),
    ])
    const credentials = loadDatabaseCredentials(process.env, 'application')
    const target = new URL(credentials.url)
    if (
      !values.host ||
      target.hostname !== values.host ||
      decodeURIComponent(target.pathname.slice(1)) !== values.database
    )
      throw new Error('INVALID_TARGET')
    const connection = createPostgresConnection(credentials)
    close = () => connection.close()
    const countExpired = async (table) => {
      const rows = await connection.database.execute(
        sql`select count(*)::int as count from ${sql.identifier(table)} where retention_expires_at < ${now.toISOString()}`
      )
      return rows[0].count
    }
    const countRetained = async (table) => {
      const rows = await connection.database.execute(
        sql`select count(*)::int as count from ${sql.identifier(table)}`
      )
      return rows[0].count
    }
    for (const [label, table] of [
      ['commandInbox', 'command_inbox'],
      ['executionEvents', 'execution_events'],
    ]) {
      classes[label] = {
        expiredCandidates: await countExpired(table),
        retained: await countRetained(table),
      }
    }
    classes.retiredCommandKeys = { retained: await countRetained('retired_command_keys') }
  } else throw new Error('INVALID_BACKEND')

  process.stdout.write(
    `${JSON.stringify({
      report: 'retention',
      generatedAt: now.toISOString(),
      deletion: 'fail_closed',
      policy: {
        schemaVersion: policy.schemaVersion,
        effectiveAt: policy.effectiveAt,
        provenance: policy.provenance,
      },
      decidedAt: decidedRetentionPolicy.effectiveAt,
      classes,
    })}\n`
  )
} catch {
  process.stderr.write('RETENTION_REPORT_FAILED\n')
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch {
    process.stderr.write('RETENTION_REPORT_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}
