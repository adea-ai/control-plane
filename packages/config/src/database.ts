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
