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
  if (unpooledUrl === undefined) {
    // A pooled route cannot carry session notifications; the operator supplies
    // the explicit direct endpoint instead of having one inferred here.
    if (isPooledRoute(applicationUrl))
      throw databaseConfigurationError('application', [], ['DATABASE_URL_UNPOOLED'])
    return application
  }
  if (!isPostgresUrl(unpooledUrl))
    throw databaseConfigurationError('application', ['DATABASE_URL_UNPOOLED'], [])
  if (!isValidSessionEndpoint(applicationUrl, new URL(unpooledUrl)))
    throw databaseConfigurationError('application', ['DATABASE_URL_UNPOOLED'], [])
  return { role: 'application', url: unpooledUrl }
}

/**
 * A session endpoint must keep the application principal and logical database,
 * never be a pooled route itself, and preserve the pooled route's TLS
 * verification strength. When the application endpoint is pooled, its direct
 * route is the same endpoint with the shared pooler label removed, so the
 * session connection cannot be redirected to another server.
 */
function isValidSessionEndpoint(applicationUrl: URL, sessionUrl: URL): boolean {
  if (isPooledRoute(sessionUrl)) return false
  if (sessionUrl.username !== applicationUrl.username) return false
  if (sessionUrl.pathname !== applicationUrl.pathname) return false
  if (tlsVerificationRank(sessionUrl) < tlsVerificationRank(applicationUrl)) return false
  if (!isPooledRoute(applicationUrl)) return true
  return (
    sessionUrl.hostname === directRouteHostname(applicationUrl.hostname) &&
    sessionUrl.port === applicationUrl.port
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

const pooledRouteLabelSuffix = '-pooler'

/**
 * A pooled route follows the shared `<endpoint>-pooler` label convention used by
 * transaction poolers. The check is provider-neutral and never trusts a
 * provider hostname suffix such as `.neon.tech`, so a generic pooler is treated
 * the same way as a hosted one.
 */
function isPooledRoute(url: URL): boolean {
  return isPooledEndpointLabel(url.hostname.split('.')[0])
}

function isPooledEndpointLabel(endpoint: string | undefined): endpoint is string {
  return (
    endpoint !== undefined &&
    endpoint.endsWith(pooledRouteLabelSuffix) &&
    endpoint.length > pooledRouteLabelSuffix.length
  )
}

/** The direct route of a pooled endpoint: the same endpoint without its pooler label. */
function directRouteHostname(hostname: string): string {
  const [endpoint, ...rest] = hostname.split('.')
  if (!isPooledEndpointLabel(endpoint)) return hostname
  return [endpoint.slice(0, -pooledRouteLabelSuffix.length), ...rest].join('.')
}

const tlsVerificationRanks: Readonly<Record<string, number>> = {
  require: 1,
  'verify-ca': 2,
  'verify-full': 3,
}

/**
 * Verification strength of a PostgreSQL TLS mode. An unset or non-verifying
 * mode ranks below encrypted `require`, and `verify-full` (certificate and
 * hostname) ranks highest, so a session endpoint can never silently weaken the
 * pooled endpoint's verification.
 */
function tlsVerificationRank(url: URL): number {
  const mode = url.searchParams.get('sslmode')
  return mode === null ? 0 : (tlsVerificationRanks[mode] ?? 0)
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
