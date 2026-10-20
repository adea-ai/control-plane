import { effectivePostgresTlsMode, type DatabaseCredentials } from '@control-plane/config'
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

/**
 * The seconds a pool teardown may spend draining before the driver terminates
 * the pool instead. The driver resolves its end promise either way.
 */
export const poolEndTimeoutSeconds = 5

const defaultConnectionsPerProcess = 10
const defaultIdleTimeoutSeconds = 20

export interface ResolvedPostgresClientOptions {
  readonly max: number
  readonly idle_timeout: number
  readonly prepare: false
  /**
   * Present only when the URL requests TLS. It is always the verified mode:
   * certificate and hostname verification.
   */
  readonly ssl?: 'verify-full'
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
    close: async () => {
      // A release that did not happen is surfaced, never discarded: a caller
      // that owns the pool must be able to see that the connections were not
      // released. Use runWithPoolTeardown when the close accompanies an
      // operation, so the operation's own failure is retained.
      const outcome = await teardownPostgresPool(client, {
        timeoutSeconds: poolEndTimeoutSeconds,
      })
      if (!outcome.released) {
        throw new DatabasePoolTeardownError(outcome.reason)
      }
    },
  }
}

/** The outcome of a pool teardown. */
export type PoolTeardownOutcome = {
  /** True when the pool released its connections. */
  readonly released: boolean
  /** Why the teardown did not release the pool, when it did not. */
  readonly reason?: string
}

/** A pool teardown that did not release the connections it owned. */
export class DatabasePoolTeardownError extends Error {
  readonly reason: string

  constructor(reason: string | undefined) {
    super('the PostgreSQL pool did not release its connections')
    this.name = 'DatabasePoolTeardownError'
    this.reason = reason ?? 'the pool did not end within the teardown bound'
  }
}

/** Removes the credentials from a URL inside a teardown reason. */
function scrubTeardownReason(reason: string): string {
  return reason.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s]*@/gi, '$1[redacted]@')
}

/** The part of a postgres.js pool a teardown needs. */
export interface PostgresPoolEnd {
  end(options: { timeout: number }): Promise<unknown>
}

/**
 * Ends a pool within a bounded time and reports what happened.
 *
 * The driver drains the pool, and a pool that does not drain within the
 * timeout it is given is terminated: the driver rejects the pending queries and
 * resolves its end promise. That resolution is awaited, so the release is
 * proven before the caller continues, and it is not an unhandled rejection. A
 * pool that still has not settled when the bound expires is reported as not
 * released instead of hanging the teardown, and a late settlement is observed
 * rather than left to surface on its own.
 */
export async function teardownPostgresPool(
  pool: PostgresPoolEnd,
  options: { readonly timeoutSeconds?: number; readonly boundSeconds?: number } = {}
): Promise<PoolTeardownOutcome> {
  const timeoutSeconds = options.timeoutSeconds ?? poolEndTimeoutSeconds
  const boundSeconds = options.boundSeconds ?? timeoutSeconds * 2 + 5
  let failure: unknown
  let ended = false
  // The driver's end promise is observed here, so a rejection or a late
  // resolution never becomes an unhandled rejection.
  const settled = (async () => {
    try {
      await pool.end({ timeout: timeoutSeconds })
      ended = true
    } catch (error) {
      failure = error
    }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, boundSeconds * 1000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (failure !== undefined) {
    return {
      released: false,
      reason: scrubTeardownReason(failure instanceof Error ? failure.message : String(failure)),
    }
  }
  if (!ended) {
    return { released: false, reason: 'the pool did not end within the teardown bound' }
  }
  return { released: true }
}

/**
 * Runs an operation and then releases the pool it used.
 *
 * The operation's own failure is retained: when both the operation and the
 * teardown fail, the two are aggregated and the operation's error stays the
 * first one, so a cleanup failure never replaces it.
 */
export async function runWithPoolTeardown<Result>(
  pool: PostgresPoolEnd,
  operation: () => Promise<Result>,
  options: { readonly timeoutSeconds?: number; readonly boundSeconds?: number } = {}
): Promise<Result> {
  let value: Result | undefined
  let operationFailed = false
  let operationError: unknown
  try {
    value = await operation()
  } catch (error) {
    // The failure is flagged, not inferred from the value: an operation that
    // rejects with undefined has still failed.
    operationFailed = true
    operationError = error
  }
  const outcome = await teardownPostgresPool(pool, options)
  if (operationFailed) {
    if (!outcome.released) {
      throw new AggregateError(
        [operationError, new DatabasePoolTeardownError(outcome.reason)],
        'the operation and the pool teardown both failed'
      )
    }
    throw operationError
  }
  if (!outcome.released) {
    throw new DatabasePoolTeardownError(outcome.reason)
  }
  return value as Result
}

/**
 * Resolves the bounded client options for a PostgreSQL URL. Pool budgets are
 * validated before a client exists, and TLS is never weaker than the URL
 * requests: a URL that asks for TLS is connected with strict `verify-full`
 * (certificate and hostname), and an explicitly unverified mode fails closed.
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
 * wins over a weaker `sslmode`.
 *
 * What the driver receives for a bare `sslmode=require` is the verified mode.
 * postgres 3.4.9 maps the driver option `require` to an encrypted connection
 * that does not verify the certificate: `rejectUnauthorized` is false for
 * `require`, `allow` and `prefer`. Every accepted mode that asks for TLS is
 * therefore connected with certificate and hostname verification, and so is the
 * system trust root. The only connection that carries no TLS at all is one
 * whose URL asks for none, which is the local disposable test target.
 */
function resolveVerifiedTlsMode(url: URL): 'verify-full' | undefined {
  const mode = effectivePostgresTlsMode(url)
  if (mode === undefined) throw new DatabaseConnectionError('INVALID_DATABASE_TLS')
  // A URL that asks for TLS is connected with the verified mode. postgres 3.4.9
  // maps the driver option `require` to an encrypted connection that does not
  // verify the certificate, so `require` would silently drop the strict
  // certificate and hostname verification the resolver approves. The shared
  // definition still ranks the modes as the URL declares them; the driver
  // never connects with less than the strictest mode the driver can express.
  // The one connection that carries no TLS is a URL that asks for none, which
  // is the local disposable test target.
  return mode === 'unset' ? undefined : 'verify-full'
}

const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 3000

/** The default total budget for one readiness evaluation, in milliseconds. */
export const defaultReadinessBudgetMs = 3000

/** The time one readiness evaluation may still spend. */
export interface ReadinessBudget {
  /** The milliseconds still available in the budget. */
  remainingMs(): number
  /** True when the budget is exhausted. */
  expired(): boolean
}

/** Creates the budget one readiness evaluation shares. */
export function createReadinessBudget(totalMs: number): ReadinessBudget {
  const deadline = Date.now() + Math.max(0, totalMs)
  return {
    remainingMs: () => Math.max(0, deadline - Date.now()),
    expired: () => Date.now() >= deadline,
  }
}

/**
 * Evaluates readiness steps inside one bounded, fail-closed budget.
 *
 * The budget covers every step, so an unbounded step cannot hang a readiness
 * endpoint and two bounded steps cannot add up to more than the budget the
 * caller asked for. When the budget expires the result is incomplete and the
 * caller fails closed. The timer is released on every path, and a step that
 * settles after the budget expired is observed rather than left to surface on
 * its own.
 */
export async function evaluateWithinReadinessBudget<Result>(
  steps: (budget: ReadinessBudget) => Promise<Result>,
  totalMs: number = defaultReadinessBudgetMs,
  onWork?: (work: Promise<unknown>) => void
): Promise<{ completed: true; value: Result } | { completed: false }> {
  const budget = createReadinessBudget(totalMs)
  // The budget is absolute: an evaluation that starts after the deadline, or
  // that completes after it, never reports a result. The work is not even
  // invoked when the budget is already spent.
  if (budget.expired()) return { completed: false }
  let timer: ReturnType<typeof setTimeout> | undefined
  let observed: Promise<{ settled: true; value?: Result; error?: unknown }>
  try {
    observed = Promise.resolve(steps(budget)).then(
      (value) => ({ settled: true as const, value }),
      (error: unknown) => ({ settled: true as const, error })
    )
  } catch {
    // A step that throws synchronously is a failed readiness, not a crash.
    return { completed: false }
  }
  // The work is handed to the caller, so a caller that owns the underlying
  // operation can hold that ownership until the work settles rather than until
  // the response budget expires.
  onWork?.(
    observed.then(
      () => undefined,
      () => undefined
    )
  )
  try {
    return await Promise.race([
      observed.then((outcome) => {
        if ('error' in outcome) throw outcome.error
        // A result that arrives after the deadline is not accepted.
        if (budget.expired()) return { completed: false as const }
        return { completed: true as const, value: outcome.value as Result }
      }),
      new Promise<{ completed: false }>((resolve) => {
        timer = setTimeout(() => resolve({ completed: false }), budget.remainingMs())
      }),
    ])
  } catch {
    // A step that failed is a failed readiness, not a crash.
    return { completed: false }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Bounded database probe for /ready-style dependency checks: resolves false
 * when check() rejects or does not settle within the timeout budget, so an
 * unreachable database can neither hang the readiness endpoint nor silently
 * pass it. A losing probe attempt is left to the pool's own connect timeout.
 *
 * The optional `onWork` seam hands the raw check promise to the caller. The
 * probe's own promise settles when the budget expires, while the check it
 * started may still be pending, so a caller that owns the surface has to see
 * the raw promise to know when the underlying work actually settled.
 */
export async function databaseReadinessProbe(
  connection: PostgresConnection,
  timeoutMs = DEFAULT_READINESS_PROBE_TIMEOUT_MS,
  onWork?: (work: Promise<unknown>) => void
): Promise<boolean> {
  const outcome = await evaluateWithinReadinessBudget(
    async () => {
      await connection.check()
      return true
    },
    timeoutMs,
    onWork
  )
  return outcome.completed ? outcome.value : false
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
