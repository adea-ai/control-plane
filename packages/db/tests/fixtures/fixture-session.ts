import postgres from 'postgres'

// Session-local fixtures (TEMP tables, pg_temp copies) are only safe on one server backend for the
// whole body. Neon's pooled endpoint runs PgBouncer in transaction mode, and Neon documents that
// temporary tables are not supported on pooled connections, so fixtures must use the direct
// endpoint that CI passes as DATABASE_URL_UNPOOLED. The guard below fails closed if the client
// ever lands on a different backend (a reconnect would silently lose every temp table).

export type FixtureSql = postgres.Sql

export function directFixtureUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const url = environment.DATABASE_URL_UNPOOLED
  if (!url) {
    throw new Error('DATABASE_URL_UNPOOLED is required for session-local migration fixtures')
  }
  return url
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

async function backendPid(sql: FixtureSql): Promise<number> {
  const [row] = await sql`select pg_backend_pid() as pid`
  const pid = Number(row?.pid)
  if (!Number.isInteger(pid)) throw new Error('could not read the fixture backend pid')
  return pid
}

// Runs body on one dedicated connection and always closes it. A failure in the body is the primary
// result and is rethrown unchanged, even when closing also fails. A close failure is surfaced only
// when the body succeeded, so cleanup can never hide the original test failure.
export async function withFixtureSession<T>(
  url: string,
  body: (sql: FixtureSql) => Promise<T>,
  open: (url: string) => FixtureSql = (target) => postgres(target, { max: 1 })
): Promise<T> {
  const sql = open(url)
  let outcome: Outcome<T>
  try {
    const before = await backendPid(sql)
    const value = await body(sql)
    const after = await backendPid(sql)
    if (after !== before) {
      throw new Error(
        `fixture session moved from backend ${before} to ${after}; temp fixtures are lost`
      )
    }
    outcome = { ok: true, value }
  } catch (error) {
    outcome = { ok: false, error }
  }
  try {
    await sql.end()
  } catch (closeError) {
    if (outcome.ok) throw closeError
    // The body failure is the provenance to keep; a close error after it is not reported in its place.
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}
