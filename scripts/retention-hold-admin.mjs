import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import {
  RetentionHoldAdministration,
  RetentionHoldAdministrationRequestSchema,
} from '@control-plane/domain'
import { loadDatabaseCredentials } from '../packages/config/src/database.ts'
import {
  loadRetentionHoldOperatorPolicy,
  readBoundedRetentionHoldJson,
  readVerifiedRetentionHoldSession,
} from './retention-hold-operator.mjs'

const options = {
  backend: { type: 'string' },
  database: { type: 'string' },
  host: { type: 'string' },
  'hold-policy': { type: 'string' },
  input: { type: 'string' },
}

export async function retentionHoldAdmin({
  argv = [],
  environment = process.env,
  writeOut = (text) => process.stdout.write(text),
  writeErr = (text) => process.stderr.write(text),
} = {}) {
  let close = async () => {}
  let exitCode = 1
  try {
    const { values } = parseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: false,
    })
    if (
      !values.backend ||
      !values.database ||
      !values.input ||
      !isAbsolute(values.input) ||
      !values['hold-policy'] ||
      !isAbsolute(values['hold-policy'])
    )
      throw new Error('INVALID_ARGUMENTS')

    let target
    let repository
    let databaseForSession
    if (values.backend === 'sqlite') {
      if (values.host || !isAbsolute(values.database)) throw new Error('INVALID_TARGET')
      const stat = await lstat(values.database)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_TARGET')
      target = { backend: 'sqlite', database: await realpath(values.database) }
    } else if (values.backend === 'postgres') {
      const credentials = loadDatabaseCredentials(environment, 'application')
      const connectionTarget = new URL(credentials.url)
      if (
        !values.host ||
        connectionTarget.hostname !== values.host ||
        decodeURIComponent(connectionTarget.pathname.slice(1)) !== values.database
      )
        throw new Error('INVALID_TARGET')
      target = {
        backend: 'postgres',
        database: values.database,
        host: values.host,
        port: connectionTarget.port === '' ? 5432 : Number(connectionTarget.port),
      }
    } else {
      throw new Error('INVALID_BACKEND')
    }

    const operatorPolicy = await loadRetentionHoldOperatorPolicy({
      path: values['hold-policy'],
      target,
    })
    const request = RetentionHoldAdministrationRequestSchema.parse(
      await readBoundedRetentionHoldJson(values.input)
    )
    if (values.backend === 'postgres') {
      const credentials = loadDatabaseCredentials(environment, 'application')
      const [{ createPostgresConnection }, postgresAdapter] = await Promise.all([
        import('../packages/database/src/connection.ts'),
        import('@control-plane/database'),
      ])
      const connection = createPostgresConnection(credentials)
      close = () => connection.close()
      databaseForSession = connection.database
      repository = new postgresAdapter.PostgresRetentionHoldRepository(
        connection.database,
        operatorPolicy.policy
      )
    } else {
      const sqlite = await import('@control-plane/sqlite-persistence')
      const provider = new sqlite.SqlitePersistenceProvider({ path: target.database })
      close = () => provider.close()
      await provider.migrate()
      repository = new sqlite.SqliteRetentionHoldRepository(provider, operatorPolicy.policy)
    }

    const result = await new RetentionHoldAdministration({
      repository,
      policy: operatorPolicy.policy,
      verifiedSession: () => readVerifiedRetentionHoldSession({ database: databaseForSession }),
      authorizeOwner: operatorPolicy.authorizeOwner,
    }).apply(request)
    writeOut(
      `${JSON.stringify({
        status: result.status,
        operation: result.operation,
        holdId: result.hold.holdId,
        revision: result.hold.revision,
      })}\n`
    )
    exitCode = 0
  } catch {
    writeErr('RETENTION_HOLD_ADMIN_FAILED\n')
  } finally {
    try {
      await close()
    } catch {
      writeErr('RETENTION_HOLD_ADMIN_CLOSE_FAILED\n')
      exitCode = 1
    }
  }
  return exitCode
}

if (import.meta.main) {
  process.exitCode = await retentionHoldAdmin({ argv: process.argv.slice(2) })
}
