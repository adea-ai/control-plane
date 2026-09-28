import { parseArgs } from 'node:util'
import { loadDatabaseCredentials } from '../packages/config/src/database.ts'

async function openMigrationService(credentials) {
  const [{ createPostgresMigrationConnection }, { PostgresAdmissionRolloutService }] =
    await Promise.all([
      import('../packages/database/src/connection.ts'),
      import('../packages/database/src/admission-rollout.ts'),
    ])
  const connection = createPostgresMigrationConnection(credentials, { maxConnections: 1 })
  return {
    service: new PostgresAdmissionRolloutService(connection.database),
    close: () => connection.close(),
  }
}

/** Operator-only entry point. The service verifies actual database authority. */
export async function admissionRolloutAdmin({
  argv = [],
  environment = process.env,
  openService = openMigrationService,
  writeOut = (text) => process.stdout.write(text),
  writeErr = (text) => process.stderr.write(text),
} = {}) {
  let close = async () => {}
  let exitCode = 1
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        database: { type: 'string' },
        confirm: { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    })
    const [verb] = positionals
    if (positionals.length !== 1 || !['status', 'audit', 'pause', 'resume'].includes(verb))
      throw new Error('INVALID_OPERATION')
    const mutation = verb === 'pause' || verb === 'resume'
    if (mutation ? values.confirm !== verb : values.confirm !== undefined)
      throw new Error('INVALID_CONFIRMATION')
    const credentials = loadDatabaseCredentials(environment, 'migration')
    const target = new URL(credentials.url)
    if (
      !values.host ||
      !values.database ||
      !values.port ||
      !/^[1-9]\d{0,4}$/.test(values.port) ||
      Number(values.port) > 65535 ||
      target.hostname !== values.host ||
      (target.port || '5432') !== values.port ||
      decodeURIComponent(target.pathname.slice(1)) !== values.database
    )
      throw new Error('INVALID_TARGET')
    const opened = await openService(credentials)
    close = () => opened.close()
    const result = await opened.service[verb === 'status' ? 'getStatus' : verb]()
    writeOut(`${JSON.stringify(result)}\n`)
    exitCode = verb === 'audit' && (result.complete !== true || result.canResume !== true) ? 2 : 0
  } catch {
    // Neither URL credentials nor query errors or caller input belong in operator logs.
    writeErr('ADMISSION_ROLLOUT_ADMIN_FAILED\n')
  } finally {
    try {
      await close()
    } catch {
      writeErr('ADMISSION_ROLLOUT_ADMIN_CLOSE_FAILED\n')
      exitCode = 1
    }
  }
  return exitCode
}

if (import.meta.main) {
  process.exitCode = await admissionRolloutAdmin({ argv: process.argv.slice(2) })
}
