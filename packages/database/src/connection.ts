import type { DatabaseCredentials } from '@control-plane/config'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'

export type ControlPlaneDatabase = PostgresJsDatabase<typeof schema>

export interface PostgresConnectionOptions {
  readonly maxConnections?: number
  readonly idleTimeoutSeconds?: number
}

export interface PostgresConnection {
  readonly database: ControlPlaneDatabase
  check(): Promise<void>
  close(): Promise<void>
}

export class DatabaseConnectionError extends Error {
  readonly diagnostic: Readonly<Record<string, unknown>>

  constructor(code: 'INVALID_CREDENTIAL_ROLE' | 'INVALID_DATABASE_URL') {
    super('PostgreSQL connection configuration is invalid')
    this.name = 'DatabaseConnectionError'
    this.diagnostic = { code }
  }

  toJSON(): Readonly<Record<string, unknown>> {
    return { name: this.name, message: this.message, diagnostic: this.diagnostic }
  }
}

export function createPostgresConnection(
  credentials: DatabaseCredentials<'application'>,
  options: PostgresConnectionOptions = {}
): PostgresConnection {
  if (credentials.role !== 'application')
    throw new DatabaseConnectionError('INVALID_CREDENTIAL_ROLE')
  assertPostgresUrl(credentials.url)
  const client = postgres(credentials.url, {
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    max: options.maxConnections ?? 10,
    prepare: false,
  })
  return {
    database: drizzle(client, { schema }),
    check: async () => {
      await client`select 1`
    },
    close: () => client.end({ timeout: 5 }),
  }
}

const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 3000

/**
 * Bounded database probe for /ready-style dependency checks: resolves false
 * when check() rejects or does not settle within the timeout budget, so an
 * unreachable database can neither hang the readiness endpoint nor silently
 * pass it. A losing probe attempt is left to the pool's own connect timeout.
 */
export async function databaseReadinessProbe(
  connection: PostgresConnection,
  timeoutMs = DEFAULT_READINESS_PROBE_TIMEOUT_MS
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      connection.check().then(
        () => true,
        () => false
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      }),
    ])
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function assertPostgresUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new DatabaseConnectionError('INVALID_DATABASE_URL')
  }
  if (
    (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
    url.hostname &&
    url.username &&
    url.pathname.length > 1
  ) {
    return
  }
  throw new DatabaseConnectionError('INVALID_DATABASE_URL')
}
