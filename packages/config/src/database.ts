import { ConfigurationError } from './service.js'
import type { RawEnvironment } from './environment.js'

export const databaseCredentialRoles = ['application', 'migration', 'administration'] as const

export type DatabaseCredentialRole = (typeof databaseCredentialRoles)[number]

export interface DatabaseCredentials<Role extends DatabaseCredentialRole = DatabaseCredentialRole> {
  readonly role: Role
  readonly url: string
}

const variables = {
  application: 'DATABASE_URL',
  migration: 'DATABASE_MIGRATION_URL',
  administration: 'DATABASE_ADMIN_URL',
} as const satisfies Record<DatabaseCredentialRole, string>

export function loadDatabaseCredentials<Role extends DatabaseCredentialRole>(
  environment: RawEnvironment,
  role: Role
): DatabaseCredentials<Role> {
  const variable = variables[role]
  const value = environment[variable]
  if (!value) throw databaseConfigurationError(role, [], [variable])
  if (!isPostgresUrl(value)) throw databaseConfigurationError(role, [variable], [])
  return { role, url: value }
}

/** Session features use the application principal on a direct connection. */
export function databaseSessionCredentials(
  application: DatabaseCredentials<'application'>,
  unpooledUrl?: string
): DatabaseCredentials<'application'> {
  if (application.role !== 'application' || !isPostgresUrl(application.url))
    throw databaseConfigurationError('application', ['DATABASE_URL'], [])
  const applicationUrl = new URL(application.url)
  if (unpooledUrl === undefined) return application
  if (!isPostgresUrl(unpooledUrl))
    throw databaseConfigurationError('application', ['DATABASE_URL_UNPOOLED'], [])
  if (!isValidSessionEndpoint(applicationUrl, new URL(unpooledUrl)))
    throw databaseConfigurationError('application', ['DATABASE_URL_UNPOOLED'], [])
  return { role: 'application', url: unpooledUrl }
}

/** Session connections preserve the exact direct endpoint and application principal. */
function isValidSessionEndpoint(applicationUrl: URL, sessionUrl: URL): boolean {
  const sessionTls = effectiveTlsRank(sessionUrl)
  const applicationTls = effectiveTlsRank(applicationUrl)
  return (
    sessionUrl.username === applicationUrl.username &&
    sessionUrl.password === applicationUrl.password &&
    sessionUrl.pathname === applicationUrl.pathname &&
    sessionUrl.hostname === applicationUrl.hostname &&
    (sessionUrl.port || '5432') === (applicationUrl.port || '5432') &&
    sessionTls !== undefined &&
    applicationTls !== undefined &&
    sessionTls >= applicationTls
  )
}

export function loadDatabaseSessionCredentials(
  environment: RawEnvironment
): DatabaseCredentials<'application'> {
  return databaseSessionCredentials(
    loadDatabaseCredentials(environment, 'application'),
    environment['DATABASE_URL_UNPOOLED']
  )
}

/** What a PostgreSQL URL's TLS parameters resolve to: no TLS requested, encrypted, or verified. */
export type PostgresTlsMode = 'unset' | 'require' | 'verify-full'

const postgresTlsRanks: Readonly<Record<PostgresTlsMode, number>> = {
  unset: 0,
  require: 1,
  'verify-full': 2,
}

/**
 * The effective TLS mode of a PostgreSQL URL, or `undefined` when its TLS
 * parameters are invalid. This is the single definition shared by the
 * connection resolver in `@control-plane/database` and the session-endpoint
 * comparison here, so the endpoint a process connects with and the endpoint it
 * is compared against can never be read differently.
 *
 * - `sslrootcert=system` escalates any valid mode, including an unset one, to
 *   `verify-full`: the driver verifies the certificate and hostname against
 *   the system trust store.
 * - `verify-ca` resolves to `verify-full`; the driver cannot express it
 *   distinctly, so it keeps certificate and hostname verification.
 * - A repeated or unknown `sslmode`, and the unverified `disable`, `allow` and
 *   `prefer` modes (with or without the system root), are invalid.
 */
export function effectivePostgresTlsMode(url: URL): PostgresTlsMode | undefined {
  const systemTrustRoot = url.searchParams.getAll('sslrootcert').includes('system')
  const modes = url.searchParams.getAll('sslmode')
  if (modes.length > 1) return undefined
  const [mode] = modes
  const resolved = resolveSslMode(mode)
  if (resolved === undefined) return undefined
  return systemTrustRoot ? 'verify-full' : resolved
}

function resolveSslMode(mode: string | undefined): PostgresTlsMode | undefined {
  switch (mode) {
    case undefined:
      return 'unset'
    case 'require':
      return 'require'
    case 'verify-ca':
    case 'verify-full':
      return 'verify-full'
    default:
      return undefined
  }
}

function effectiveTlsRank(url: URL): number | undefined {
  const mode = effectivePostgresTlsMode(url)
  return mode === undefined ? undefined : postgresTlsRanks[mode]
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.hostname.length > 0 &&
      url.username.length > 0 &&
      url.pathname.length > 1
    )
  } catch {
    return false
  }
}

function databaseConfigurationError(
  role: DatabaseCredentialRole,
  invalid: readonly string[],
  missing: readonly string[]
): ConfigurationError {
  return new ConfigurationError({
    code: 'INVALID_DATABASE_CONFIGURATION',
    invalid: [...invalid].toSorted(),
    missing: [...missing].toSorted(),
    role,
  })
}
