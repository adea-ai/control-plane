import type { DatabaseCredentials } from '@control-plane/config'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'

export type ControlPlaneDatabase = PostgresJsDatabase<typeof schema>

export interface PostgresConnectionOptions {
  readonly maxConnections?: number
  readonly idleTimeoutSeconds?: number
}

/**
 * Bounded per-process connection budget. A Cloud process composes a small
 * number of pools (the Runtime Gateway opens an application pool plus a
 * single-connection notification pool), so each pool must stay well below the
 * shared PostgreSQL server's `max_connections` instead of exhausting it.
 */
export const maximumConnectionsPerProcess = 32

/** Upper bound for an idle connection timeout, in seconds. */
export const maximumIdleTimeoutSeconds = 3600

const defaultConnectionsPerProcess = 10
const defaultIdleTimeoutSeconds = 20

export interface ResolvedPostgresClientOptions {
  readonly max: number
  readonly idle_timeout: number
  readonly prepare: false
  /** Present only when the URL requests TLS; `verify-full` is certificate and hostname verification. */
  readonly ssl?: 'require' | 'verify-full'
}

export type DatabaseConnectionErrorCode =
  | 'INVALID_CREDENTIAL_ROLE'
  | 'INVALID_DATABASE_URL'
  | 'INVALID_POOL_BUDGET'
  | 'INVALID_IDLE_TIMEOUT'
  | 'INVALID_DATABASE_TLS'

export interface PostgresConnection {
  readonly database: ControlPlaneDatabase
  check(): Promise<void>
  close(): Promise<void>
}

export class DatabaseConnectionError extends Error {
  readonly diagnostic: Readonly<Record<string, unknown>>

  constructor(code: DatabaseConnectionErrorCode) {
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
  return createConnection(credentials.url, options)
}

/** Operator connection profile; database privileges, not this label, grant authority. */
export function createPostgresMigrationConnection(
  credentials: DatabaseCredentials<'migration'>,
  options: PostgresConnectionOptions = {}
): PostgresConnection {
  if (credentials.role !== 'migration') throw new DatabaseConnectionError('INVALID_CREDENTIAL_ROLE')
  return createConnection(credentials.url, options)
}

function createConnection(url: string, options: PostgresConnectionOptions): PostgresConnection {
  const client = postgres(url, resolvePostgresClientOptions(url, options))
  return {
    database: drizzle(client, { schema }),
    check: async () => {
      await client`select 1`
    },
    close: () => client.end({ timeout: 5 }),
  }
}

/**
 * Resolves the bounded client options for a PostgreSQL URL. Pool budgets are
 * validated before a client exists, and TLS is preserved exactly as the URL
 * requests it: strict `verify-full` (certificate and hostname) is never
 * silently downgraded, and an explicitly unverified mode fails closed.
 */
export function resolvePostgresClientOptions(
  url: string,
  options: PostgresConnectionOptions = {}
): ResolvedPostgresClientOptions {
  assertPostgresUrl(url)
  const maxConnections = options.maxConnections ?? defaultConnectionsPerProcess
  const idleTimeoutSeconds = options.idleTimeoutSeconds ?? defaultIdleTimeoutSeconds
  assertBoundedInteger(maxConnections, 1, maximumConnectionsPerProcess, 'INVALID_POOL_BUDGET')
  assertBoundedInteger(idleTimeoutSeconds, 1, maximumIdleTimeoutSeconds, 'INVALID_IDLE_TIMEOUT')
  const ssl = resolveVerifiedTlsMode(new URL(url))
  return {
    max: maxConnections,
    idle_timeout: idleTimeoutSeconds,
    prepare: false,
    ...(ssl === undefined ? {} : { ssl }),
  }
}

function assertBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: 'INVALID_POOL_BUDGET' | 'INVALID_IDLE_TIMEOUT'
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DatabaseConnectionError(code)
  }
}

/**
 * Preserves certificate verification by mapping every accepted `sslmode` onto
 * the strictest equivalent the driver exposes; `verify-ca` cannot be expressed
 * distinctly, so it keeps certificate and hostname verification. Modes that
 * would skip verification (`disable`, `allow`, `prefer`) or repeat the
 * parameter fail closed.
 *
 * `sslrootcert=system` makes the driver escalate to `verify-full`. Passing an
 * explicit `ssl` option (which this function does for a resolved `sslmode`)
 * would otherwise suppress that escalation, so the system trust root always
 * wins over a weaker `sslmode` and certificate/hostname verification is never
 * silently disabled.
 */
function resolveVerifiedTlsMode(url: URL): 'require' | 'verify-full' | undefined {
  const systemTrustRoot = url.searchParams.getAll('sslrootcert').includes('system')
  const modes = url.searchParams.getAll('sslmode')
  if (modes.length > 1) throw new DatabaseConnectionError('INVALID_DATABASE_TLS')
  const [mode] = modes
  if (mode === 'disable' || mode === 'allow' || mode === 'prefer') {
    throw new DatabaseConnectionError('INVALID_DATABASE_TLS')
  }
  if (systemTrustRoot) return 'verify-full'
  if (mode === undefined) return undefined
  if (mode === 'require') return 'require'
  if (mode === 'verify-ca' || mode === 'verify-full') return 'verify-full'
  throw new DatabaseConnectionError('INVALID_DATABASE_TLS')
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
