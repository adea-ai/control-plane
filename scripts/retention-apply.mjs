import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
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
const SUPPORTED_CLASSES = new Set(['command-inbox'])

let close = async () => {}

try {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string' },
      class: { type: 'string' },
      database: { type: 'string' },
      host: { type: 'string' },
      bound: { type: 'string' },
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
  const policyRetainMs = retentionClassPolicy(policy, 'command-inbox').retainMs
  const options = {
    policyRetainMs,
    dryRun,
    ...(bound === undefined ? {} : { bound }),
  }

  let result
  if (values.backend === 'sqlite') {
    if (values.host || !isAbsolute(values.database)) throw new Error('INVALID_TARGET')
    const stat = await lstat(values.database)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_TARGET')
    const { SqliteCommandAcceptanceRepository, SqlitePersistenceProvider } =
      await import('@control-plane/sqlite-persistence')
    const provider = new SqlitePersistenceProvider({ path: values.database })
    close = async () => provider.close()
    await provider.migrate()
    result = await new SqliteCommandAcceptanceRepository(provider).deleteEligibleInbox(now, options)
  } else if (values.backend === 'postgres') {
    const credentials = loadDatabaseCredentials(process.env, 'application')
    const target = new URL(credentials.url)
    if (
      !values.host ||
      target.hostname !== values.host ||
      decodeURIComponent(target.pathname.slice(1)) !== values.database
    )
      throw new Error('INVALID_TARGET')
    const [{ createPostgresConnection }, { PostgresCommandAcceptanceRepository }] =
      await Promise.all([
        import('../packages/database/src/connection.ts'),
        import('../packages/database/src/command-inbox-repository.ts'),
      ])
    const connection = createPostgresConnection(credentials)
    close = () => connection.close()
    result = await new PostgresCommandAcceptanceRepository(connection.database).deleteEligibleInbox(
      now,
      options
    )
  } else throw new Error('INVALID_BACKEND')

  process.stdout.write(
    `${JSON.stringify({
      report: 'retention-apply',
      class: values.class,
      backend: values.backend,
      dryRun,
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
