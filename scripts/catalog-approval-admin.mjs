import { open, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute } from 'node:path'
import { parseArgs } from 'node:util'
import { userInfo } from 'node:os'
import {
  CatalogApprovalAdministration,
  CatalogApprovalAdministrationRequestSchema,
} from '@control-plane/domain'
import {
  SqliteCatalogApprovalRepository,
  SqlitePersistenceProvider,
  SqliteVersionedCatalogRepository,
} from '@control-plane/sqlite-persistence'
import {
  createPostgresConnection,
  catalogApprovalDatabaseAuthority,
  PostgresCatalogApprovalRepository,
  PostgresCatalogRepository,
} from '@control-plane/database'
import { loadDatabaseCredentials } from '@control-plane/config'

// Scoped catalog-approval administration (#188). Authority is OS/database
// access — never an unauthenticated endpoint — and the process never prints
// input documents, database URLs, query parameters or underlying errors.
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
    request = CatalogApprovalAdministrationRequestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)))
    )
  } finally {
    await file.close()
  }
  let administration
  const actorPrincipalRef = `operator:os-user:${encodeURIComponent(userInfo().username)}`
  let operator
  if (values.backend === 'sqlite') {
    if (values.host || !isAbsolute(values.database)) throw new Error('INVALID_TARGET')
    const stat = await lstat(values.database)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INVALID_TARGET')
    const provider = new SqlitePersistenceProvider({ path: values.database })
    close = async () => provider.close()
    await provider.migrate()
    const versions = new SqliteVersionedCatalogRepository(provider)
    operator = { actorPrincipalRef, authorityRef: 'authority:sqlite:local-os' }
    administration = new CatalogApprovalAdministration({
      approvals: new SqliteCatalogApprovalRepository(provider),
      versions,
      operator,
    })
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
    operator = {
      actorPrincipalRef,
      authorityRef: await catalogApprovalDatabaseAuthority(connection.database),
    }
    administration = new CatalogApprovalAdministration({
      approvals: new PostgresCatalogApprovalRepository(connection.database),
      versions: new PostgresCatalogRepository(connection.database),
      operator,
    })
  } else throw new Error('INVALID_BACKEND')
  // Request attribution is descriptive input, not identity proof. Persist only
  // the OS account and authenticated database authority of this adapter.
  const result = await administration.apply(
    request.operation === 'approvals.record'
      ? { ...request, decision: { ...request.decision, ...operator } }
      : request
  )
  process.stdout.write(JSON.stringify(result) + '\n')
} catch {
  // Never print input documents, database URLs, query parameters or underlying errors.
  process.stderr.write('CATALOG_APPROVAL_ADMIN_FAILED\n')
  process.exitCode = 1
} finally {
  try {
    await close()
  } catch {
    process.stderr.write('CATALOG_APPROVAL_ADMIN_CLOSE_FAILED\n')
    process.exitCode = 1
  }
}
