import type { DatabaseCredentials } from '@control-plane/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { assertPostgresUrl, DatabaseConnectionError } from './connection.js'

export interface MigrationOptions {
  readonly migrationsFolder?: string
  readonly connectTimeoutSeconds?: number
  readonly statementTimeoutMs?: number
  readonly lockTimeoutMs?: number
  readonly verifyTls?: boolean
  readonly tls?: {
    readonly rejectUnauthorized: true
    readonly servername: string
    readonly ca?: string
  }
}

function assertBoundedTimeout(name: string, value: number | undefined, maximum: number): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > maximum)) {
    throw new Error(`Invalid migration ${name} timeout`)
  }
}

export async function migrateDatabase(
  credentials: DatabaseCredentials<'migration'>,
  options: MigrationOptions = {}
): Promise<void> {
  if (credentials.role !== 'migration') throw new DatabaseConnectionError('INVALID_CREDENTIAL_ROLE')
  assertPostgresUrl(credentials.url)
  assertBoundedTimeout('connection', options.connectTimeoutSeconds, 60)
  assertBoundedTimeout('statement', options.statementTimeoutMs, 300_000)
  assertBoundedTimeout('lock', options.lockTimeoutMs, 30_000)
  if (
    options.tls !== undefined &&
    (options.verifyTls !== true ||
      Object.keys(options.tls).some(
        (key) => !['ca', 'rejectUnauthorized', 'servername'].includes(key)
      ) ||
      options.tls.rejectUnauthorized !== true ||
      typeof options.tls.servername !== 'string' ||
      !/^[a-z0-9.-]+$/.test(options.tls.servername) ||
      (options.tls.ca !== undefined &&
        (typeof options.tls.ca !== 'string' ||
          !options.tls.ca.includes('-----BEGIN CERTIFICATE-----'))))
  )
    throw new DatabaseConnectionError('INVALID_DATABASE_TLS')
  const client = postgres(credentials.url, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
    ...(options.connectTimeoutSeconds === undefined
      ? {}
      : { connect_timeout: options.connectTimeoutSeconds }),
    ...(options.verifyTls === true ? { ssl: options.tls ?? { rejectUnauthorized: true } } : {}),
    connection: {
      ...(options.statementTimeoutMs === undefined
        ? {}
        : { statement_timeout: options.statementTimeoutMs }),
      ...(options.lockTimeoutMs === undefined ? {} : { lock_timeout: options.lockTimeoutMs }),
    },
  })
  try {
    await migrate(drizzle(client), {
      migrationsFolder:
        options.migrationsFolder ?? fileURLToPath(new URL('../drizzle', import.meta.url)),
    })
  } finally {
    await client.end({ timeout: 5 })
  }
}
