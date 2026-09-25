import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  decidedRetentionPolicy,
  retentionClassPolicy,
} from '../packages/config/src/retention-policy.ts'
import { loadDatabaseCredentials } from '../packages/config/src/database.ts'

// Operator-invoked retention deletion (#194). Physical deletion stays out of
// the running services: nothing deletes unless an operator runs this command
// with --apply --confirm <class> against an explicit target.
//
// Dry-run is the default. Every pass revalidates the shared eligibility
// predicate per candidate at deletion time, reserves nothing it cannot prove,
// and keeps the reserved rejection key so a replay of the same scoped
// idempotency key still fails closed. The command prints a payload-free JSON
// result and one sanitized failure code — never database URLs, query
// parameters or underlying errors.
const SUPPORTED_CLASSES = new Set(['command-inbox', 'execution-events', 'executions'])

let close = async () => {}

try {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string' },
      class: { type: 'string' },
      database: { type: 'string' },
      host: { type: 'string' },
      bound: { type: 'string' },
      journal: { type: 'string' },
      now: { type: 'string' },
      apply: { type: 'boolean' },
      confirm: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (!values.database || !values.class || !SUPPORTED_CLASSES.has(values.class))
    throw new Error('INVALID_ARGUMENTS')
  const dryRun = values.apply !== true
  if (!dryRun && values.confirm !== values.class) throw new Error('CONFIRMATION_REQUIRED')
  const now = values.now === undefined ? new Date() : new Date(values.now)
  if (Number.isNaN(now.getTime())) throw new Error('INVALID_INSTANT')
  const bound = values.bound === undefined ? undefined : Number.parseInt(values.bound, 10)
  if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 1))
    throw new Error('INVALID_BOUND')
  const policy = decidedRetentionPolicy
  const policyRetainMs = retentionClassPolicy(policy, values.class).retainMs
  const apply = {
    'command-inbox': 'deleteEligibleInbox',
    'execution-events': 'deleteEligibleEvents',
    executions: 'deleteEligibleExecutions',
  }[values.class]
  const repositoryFor = {
    'command-inbox': 'SqliteCommandAcceptanceRepository',
    'execution-events': 'SqliteExecutionEventRepository',
    executions: 'SqliteExecutionRepository',
  }[values.class]
  const postgresRepositoryFor = {
    'command-inbox': 'PostgresCommandAcceptanceRepository',
    'execution-events': 'PostgresExecutionEventRepository',
    executions: 'PostgresExecutionRepository',
  }[values.class]
  // Deletion effects are journalled before they apply, so a restored snapshot
  // can be brought forward with `retention-reapply` before it is exposed.
  const journalPath = resolve(
    values.journal ??
      (values.backend === 'sqlite'
        ? `${values.database}.retention-journal.jsonl`
        : 'retention-journal.jsonl')
  )
  const journal = async (operations) => {
    if (dryRun) return
    const record = {
      version: 1,
      at: new Date().toISOString(),
      backend: values.backend,
      classId: values.class,
      operations,
    }
    const descriptor = openSync(journalPath, 'a')
    try {
      writeSync(descriptor, `${JSON.stringify(record)}\n`)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
  }
  const options = {
    policyRetainMs,
    dryRun,
    journal,
    ...(bound === undefined ? {} : { bound }),
  }

  let result
  if (values.backend === 'sqlite') {
    if (values.host || !isAbsolute(values.database)) throw new Error('INVALID_TARGET')
    const stat = await lstat(values.database)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_TARGET')
    const sqlite = await import('@control-plane/sqlite-persistence')
    const provider = new sqlite.SqlitePersistenceProvider({ path: values.database })
    close = async () => provider.close()
    await provider.migrate()
    result = await new sqlite[repositoryFor](provider)[apply](now, options)
  } else if (values.backend === 'postgres') {
    const credentials = loadDatabaseCredentials(process.env, 'application')
    const target = new URL(credentials.url)
    if (
      !values.host ||
      target.hostname !== values.host ||
      decodeURIComponent(target.pathname.slice(1)) !== values.database
    )
      throw new Error('INVALID_TARGET')
    const [{ createPostgresConnection }, commandInbox, eventRepository, executionRepository] =
      await Promise.all([
        import('../packages/database/src/connection.ts'),
        import('../packages/database/src/command-inbox-repository.ts'),
        import('../packages/database/src/execution-event-repository.ts'),
        import('../packages/database/src/execution-repository.ts'),
      ])
    const connection = createPostgresConnection(credentials)
    close = () => connection.close()
    const repositories = {
      PostgresCommandAcceptanceRepository: commandInbox.PostgresCommandAcceptanceRepository,
      PostgresExecutionEventRepository: eventRepository.PostgresExecutionEventRepository,
      PostgresExecutionRepository: executionRepository.PostgresExecutionRepository,
    }
    result = await new repositories[postgresRepositoryFor](connection.database)[apply](now, options)
  } else throw new Error('INVALID_BACKEND')

  process.stdout.write(
    `${JSON.stringify({
      report: 'retention-apply',
      class: values.class,
      backend: values.backend,
      dryRun,
      journal: dryRun ? null : journalPath,
      policy: {
        schemaVersion: policy.schemaVersion,
        effectiveAt: policy.effectiveAt,
        retainMs: policyRetainMs,
      },
      result,
    })}\n`
  )
} catch {
  process.stderr.write('RETENTION_APPLY_FAILED\n')
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch {
    process.stderr.write('RETENTION_APPLY_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}
