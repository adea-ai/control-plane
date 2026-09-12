import { open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import {
  ContextProviderAdministration,
  ContextProviderAdministrationRequestSchema,
} from '@control-plane/domain'
import {
  SqlitePersistenceProvider,
  SqliteContextCommandGrantRepository,
  SqliteContextProviderRegistrationRepository,
} from '@control-plane/sqlite-persistence'
import {
  createPostgresConnection,
  PostgresContextCommandGrantRepository,
  PostgresContextProviderRegistrationRepository,
} from '@control-plane/database'
import { loadDatabaseCredentials } from '@control-plane/config'

let close = async () => {}
try {
  const { values } = parseArgs({
    options: {
      backend: { type: 'string' },
      database: { type: 'string' },
      host: { type: 'string' },
      input: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  if (!values.input || !isAbsolute(values.input) || !values.database)
    throw new Error('INVALID_ARGUMENTS')
  const file = await open(values.input, constants.O_RDONLY | constants.O_NOFOLLOW)
  let request
  try {
    if (!(await file.stat()).isFile()) throw new Error('INVALID_INPUT')
    const bytes = Buffer.alloc(262145)
    let bytesRead = 0
    while (bytesRead < bytes.length) {
      const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
      if (chunk.bytesRead === 0) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead > 262144) throw new Error('INVALID_INPUT')
    request = ContextProviderAdministrationRequestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)))
    )
  } finally {
    await file.close()
  }
  let grants, registrations
  if (values.backend === 'sqlite') {
    if (values.host || !isAbsolute(values.database)) throw new Error('INVALID_TARGET')
    const stat = await lstat(values.database)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_TARGET')
    const provider = new SqlitePersistenceProvider({ path: values.database })
    close = async () => provider.close()
    await provider.migrate()
    grants = new SqliteContextCommandGrantRepository(provider)
    registrations = new SqliteContextProviderRegistrationRepository(provider)
  } else if (values.backend === 'postgres') {
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
    grants = new PostgresContextCommandGrantRepository(connection.database)
    registrations = new PostgresContextProviderRegistrationRepository(connection.database)
  } else throw new Error('INVALID_BACKEND')
  await new ContextProviderAdministration(grants, registrations).apply(request)
  process.stdout.write(JSON.stringify({ status: 'applied', operation: request.operation }) + '\n')
} catch {
  // Never print input documents, database URLs, query parameters or underlying errors.
  process.stderr.write('CONTEXT_PROVIDER_ADMIN_FAILED\n')
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch {
    process.stderr.write('CONTEXT_PROVIDER_ADMIN_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}
