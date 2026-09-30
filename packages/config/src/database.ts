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
  const pooled = isNeonPooledUrl(applicationUrl)
  if (unpooledUrl === undefined) {
    if (pooled) throw databaseConfigurationError('application', [], ['DATABASE_URL_UNPOOLED'])
    return application
  }
  if (!isPostgresUrl(unpooledUrl))
    throw databaseConfigurationError('application', ['DATABASE_URL_UNPOOLED'], [])
  const directUrl = new URL(unpooledUrl)
  if (
    isNeonPooledUrl(directUrl) ||
    directUrl.username !== applicationUrl.username ||
    directUrl.pathname !== applicationUrl.pathname ||
    (applicationUrl.hostname.endsWith('.neon.tech') &&
      (directUrl.hostname !== applicationUrl.hostname.replace('-pooler.', '.') ||
        directUrl.port !== applicationUrl.port))
  )
    throw databaseConfigurationError('application', ['DATABASE_URL_UNPOOLED'], [])
  return { role: 'application', url: unpooledUrl }
}

export function loadDatabaseSessionCredentials(
  environment: RawEnvironment
): DatabaseCredentials<'application'> {
  return databaseSessionCredentials(
    loadDatabaseCredentials(environment, 'application'),
    environment['DATABASE_URL_UNPOOLED']
  )
}

function isNeonPooledUrl(url: URL): boolean {
  return (
    url.hostname.endsWith('.neon.tech') && url.hostname.split('.')[0]?.endsWith('-pooler') === true
  )
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
