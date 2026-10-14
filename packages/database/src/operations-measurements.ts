import { IdentifierSchemas } from '@control-plane/contracts'
import {
  OperationsMeasurementLifecycle,
  operationsMetricNames,
  operationsStorageNamespaces,
  type MetricAdapter,
  type OperationsMetricPoint,
} from '@control-plane/telemetry'
import { sql, type SQL } from 'drizzle-orm'
import type { ControlPlaneDatabase } from './connection.js'

/**
 * Hosted PostgreSQL operations measurement producer (#1030).
 *
 * Feeds the shared `OperationsMeasurementLifecycle` with the same cataloged,
 * label-bounded operations points the SQLite producer emits, measured over the
 * relational Hosted schema instead of the SQLite record store. The producer is
 * a contract for the Hosted composition root (#1048); it neither starts itself,
 * installs an exporter nor reads configuration.
 *
 * Boundaries this module preserves:
 * - Read only. Every pass is one `READ ONLY`, `REPEATABLE READ` transaction, so
 *   all sources describe a single snapshot and nothing can be written. Statement,
 *   lock and idle-in-transaction timeouts are set per transaction.
 * - Workspace scope. Every source is anchored on the selected workspace id —
 *   either on its own `workspace_id` column or through that workspace's
 *   executions — and never scans another tenant's rows to find its own.
 * - Bounded. Each source examines at most `maxScanRows + 1` rows (and, for
 *   sources joined through executions, at most that many executions). A source
 *   that reaches the bound is reported incomplete and every point derived from
 *   it is suppressed rather than emitted as a lower bound.
 * - Honest. A source that cannot be read (timeout, lock, permission, damaged
 *   JSON, overflow) is `unavailable` or `incomplete`; dependent points are
 *   suppressed, never zero-filled. A pass where nothing could be read returns
 *   `undefined` so the lifecycle emits nothing.
 * - Secret free. Only aggregates leave the database: counts, millisecond
 *   latencies, byte totals and microunit sums. Payload columns are never
 *   selected (row size comes from `pg_column_size`), and identifiers, payloads
 *   and driver errors never reach a metric attribute, a result or a thrown
 *   error. Source failures are reduced to a fixed reason code.
 */

/** Rows examined per source before the source reports itself incomplete. */
export const DEFAULT_POSTGRES_MEASUREMENT_MAX_SCAN_ROWS = 10_000
export const MAX_POSTGRES_MEASUREMENT_SCAN_ROWS = 1_000_000
export const DEFAULT_POSTGRES_MEASUREMENT_WINDOW_SECONDS = 86_400
export const DEFAULT_POSTGRES_MEASUREMENT_STATEMENT_TIMEOUT_MS = 5000
export const DEFAULT_POSTGRES_MEASUREMENT_LOCK_TIMEOUT_MS = 1000
/** Upper bound on how long an abandoned measurement transaction may sit idle. */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 15_000

const BYTES_PER_GIB = 1024 * 1024 * 1024
const MICROUNITS_PER_USD = 1_000_000
const TERMINAL_STATES = sql.raw(`('completed','failed','cancelled','timed_out')`)
const ACTIVE_JOB_STATUSES = sql.raw(`('queued','dispatched','acknowledged')`)

/**
 * PostgreSQL storage namespaces this producer measures, named like the SQLite
 * producer's so labels stay comparable. `runtime-channel-sequences` (workspace
 * is only inside a text identity, so scoping it would scan other tenants) and
 * `usage-entry-sequences` (a column here, not a store) are deliberately
 * unmeasured; `total` is the measured-set total.
 */
export const postgresMeasuredNamespaces = [
  'execution-attempts',
  'execution-events',
  'execution-plans',
  'executions',
  'interaction-requests',
  'runtime-commands',
  'runtime-discovery-connections',
  'runtime-discovery-sessions',
  'usage-budgets',
  'usage-effects',
  'usage-ledger-entries',
] as const satisfies readonly (typeof operationsStorageNamespaces)[number][]

export type PostgresMeasuredNamespace = (typeof postgresMeasuredNamespaces)[number]

/** Why a source produced no trustworthy numbers; never a driver message. */
export type PostgresMeasurementSourceReason =
  | 'row_budget_reached'
  | 'malformed_records'
  | 'unsafe_total'
  | 'timeout'
  | 'lock_timeout'
  | 'permission_denied'
  | 'query_failed'

export type PostgresMeasurementSourceStatus =
  | { readonly status: 'complete' }
  | { readonly status: 'incomplete'; readonly reason: PostgresMeasurementSourceReason }
  | { readonly status: 'unavailable'; readonly reason: PostgresMeasurementSourceReason }

/**
 * The only database surface the producer uses: a drizzle database whose
 * transactions accept an access mode and isolation level. `ControlPlaneDatabase`
 * satisfies it.
 */
export type PostgresMeasurementDatabase = Pick<ControlPlaneDatabase, 'transaction'>

export interface PostgresOperationsMeasurementOptions {
  readonly database: PostgresMeasurementDatabase
  readonly workspaceId: string
  /** Windowed usage and rewritten-byte accounting; 60 seconds to one year. */
  readonly windowSeconds?: number
  /** Rows examined per source (1 to 1,000,000). */
  readonly maxScanRows?: number
  readonly statementTimeoutMs?: number
  readonly lockTimeoutMs?: number
  /** Explicit USD per GiB-month storage price; omitted means unpriced. */
  readonly storageUsdPerGiBMonth?: number
  /** Deterministic clock for tests; defaults to wall time. */
  readonly now?: () => Date
}

export interface PostgresOperationsMeasurementResult {
  /** Already-filtered, cataloged points; empty when every source was degraded. */
  readonly points: readonly OperationsMetricPoint[]
  readonly sources: Readonly<Record<PostgresMeasuredNamespace, PostgresMeasurementSourceStatus>>
  /** True when this pass was a complete storage snapshot and became the baseline. */
  readonly baselineCommitted: boolean
}

export interface PostgresOperationsMeasurementProducer {
  /**
   * One scoped pass. Resolves `undefined` when the substrate is unavailable
   * (no transaction, nothing readable); never rejects and never throws driver
   * errors. Concurrent callers share the in-flight pass.
   */
  measureDetailed(): Promise<PostgresOperationsMeasurementResult | undefined>
  /** The `OperationsMeasurementLifecycle` producer contract. */
  measure(): Promise<readonly OperationsMetricPoint[] | undefined>
}

interface ResolvedOptions {
  readonly database: PostgresMeasurementDatabase
  readonly workspaceId: string
  readonly windowSeconds: number
  readonly maxScanRows: number
  readonly statementTimeoutMs: number
  readonly lockTimeoutMs: number
  readonly storageUsdPerGiBMonth: number | undefined
  readonly now: () => Date
}

function integerOption(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  code: string
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(code)
  return resolved
}

function resolveOptions(options: PostgresOperationsMeasurementOptions): ResolvedOptions {
  if (!IdentifierSchemas.workspaceId.safeParse(options.workspaceId).success)
    throw new Error('POSTGRES_MEASUREMENT_WORKSPACE_INVALID')
  const rate = options.storageUsdPerGiBMonth
  if (rate !== undefined && (!Number.isFinite(rate) || rate < 0 || rate > 100_000))
    throw new Error('POSTGRES_MEASUREMENT_STORAGE_RATE_INVALID')
  return {
    database: options.database,
    workspaceId: options.workspaceId,
    windowSeconds: integerOption(
      options.windowSeconds,
      DEFAULT_POSTGRES_MEASUREMENT_WINDOW_SECONDS,
      60,
      31_536_000,
      'POSTGRES_MEASUREMENT_WINDOW_INVALID'
    ),
    maxScanRows: integerOption(
      options.maxScanRows,
      DEFAULT_POSTGRES_MEASUREMENT_MAX_SCAN_ROWS,
      1,
      MAX_POSTGRES_MEASUREMENT_SCAN_ROWS,
      'POSTGRES_MEASUREMENT_SCAN_BOUND_INVALID'
    ),
    statementTimeoutMs: integerOption(
      options.statementTimeoutMs,
      DEFAULT_POSTGRES_MEASUREMENT_STATEMENT_TIMEOUT_MS,
      10,
      60_000,
      'POSTGRES_MEASUREMENT_STATEMENT_TIMEOUT_INVALID'
    ),
    lockTimeoutMs: integerOption(
      options.lockTimeoutMs,
      DEFAULT_POSTGRES_MEASUREMENT_LOCK_TIMEOUT_MS,
      10,
      10_000,
      'POSTGRES_MEASUREMENT_LOCK_TIMEOUT_INVALID'
    ),
    storageUsdPerGiBMonth: rate,
    now: options.now ?? (() => new Date()),
  }
}

// ---- Parsed facts per source -------------------------------------------------

interface LatencyStats {
  readonly min: number
  readonly median: number
  readonly max: number
}

interface StorageFacts {
  readonly bytes: number
  /** Null when the table has no trustworthy last-write timestamp. */
  readonly rewritten: number | null
}

interface SourceFacts {
  readonly executions: {
    readonly active: number
    readonly reconciliation: LatencyStats | null
    readonly storage: StorageFacts
  }
  readonly 'execution-attempts': {
    readonly active: number
    readonly gap: LatencyStats | null
    readonly current: LatencyStats | null
    readonly storage: StorageFacts
  }
  readonly 'interaction-requests': {
    readonly pending: number
    readonly responded: LatencyStats | null
    readonly waiting: LatencyStats | null
    readonly storage: StorageFacts
  }
  readonly 'runtime-commands': {
    readonly active: number
    readonly dispatch: LatencyStats | null
    readonly waiting: LatencyStats | null
    readonly storage: StorageFacts
  }
  readonly 'execution-events': { readonly active: number; readonly storage: StorageFacts }
  readonly 'runtime-discovery-sessions': {
    readonly active: number
    readonly storage: StorageFacts
  }
  readonly 'runtime-discovery-connections': { readonly storage: StorageFacts }
  readonly 'execution-plans': { readonly storage: StorageFacts }
  readonly 'usage-ledger-entries': {
    readonly usd: { readonly exact: number; readonly inexact: number } | null
    readonly storage: StorageFacts
  }
  readonly 'usage-budgets': {
    readonly records: number
    readonly currencies: readonly string[]
    readonly usdSpentMicrounits: number | null
    readonly storage: StorageFacts
  }
  readonly 'usage-effects': { readonly storage: StorageFacts }
}

type Outcome<T> =
  | { readonly status: 'complete'; readonly facts: T }
  | { readonly status: 'incomplete'; readonly reason: PostgresMeasurementSourceReason }
  | { readonly status: 'unavailable'; readonly reason: PostgresMeasurementSourceReason }

type SourceOutcomes = { readonly [K in PostgresMeasuredNamespace]: Outcome<SourceFacts[K]> }

// ---- Row parsing -------------------------------------------------------------

type Row = Readonly<Record<string, unknown>>

class UnsafeTotal extends Error {}
class MalformedRow extends Error {}

function wholeNumber(value: unknown): number {
  if (value === null || value === undefined) throw new MalformedRow()
  const text = typeof value === 'bigint' ? value.toString() : String(value)
  if (!/^-?\d+$/.test(text)) throw new MalformedRow()
  const parsed = BigInt(text)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER))
    throw new UnsafeTotal()
  return Number(parsed)
}

function stats(row: Row, alias: string): LatencyStats | null {
  const samples = wholeNumber(row[`${alias}_n`])
  if (samples === 0) return null
  return {
    min: wholeNumber(row[`${alias}_min`]),
    median: wholeNumber(row[`${alias}_median`]),
    max: wholeNumber(row[`${alias}_max`]),
  }
}

function storage(row: Row, rewrittenBasis: boolean): StorageFacts {
  return {
    bytes: wholeNumber(row['bytes']),
    rewritten: rewrittenBasis ? wholeNumber(row['rewritten']) : null,
  }
}

// ---- SQL fragments (static identifiers only; every value is a bound parameter) ---

interface QueryContext {
  readonly workspaceId: string
  readonly now: string
  readonly since: string
  readonly maxRows: number
}

/** Non-negative whole milliseconds between two timestamps. */
function elapsedMs(from: SQL, to: SQL): SQL {
  return sql`greatest(0, floor(extract(epoch from (${to} - ${from})) * 1000))`
}

function ageMs(context: QueryContext, column: SQL): SQL {
  return elapsedMs(column, sql`${context.now}::timestamptz`)
}

/** Sample count plus min, lower median and max of a nullable millisecond column. */
function statsSelect(alias: string, column: string): SQL {
  const ref = sql.raw(column)
  return sql`count(${ref})::text as ${sql.raw(`${alias}_n`)},
    min(${ref})::text as ${sql.raw(`${alias}_min`)},
    (percentile_disc(0.5) within group (order by ${ref}))::text as ${sql.raw(`${alias}_median`)},
    max(${ref})::text as ${sql.raw(`${alias}_max`)}`
}

function bytesSelect(context: QueryContext, rewrittenBasis: boolean): SQL {
  return rewrittenBasis
    ? sql`coalesce(sum(bytes), 0)::text as bytes,
      coalesce(sum(bytes) filter (where written_at >= ${context.since}::timestamptz), 0)::text as rewritten`
    : sql`coalesce(sum(bytes), 0)::text as bytes`
}

/**
 * Bounded executions of the selected workspace. The join sources below start
 * here so they never examine more than `maxRows` executions, and report
 * `executions_truncated` when the workspace holds more.
 */
function boundedExecutions(context: QueryContext): SQL {
  return sql`ex as (
      select execution_id from executions where workspace_id = ${context.workspaceId} limit ${context.maxRows + 1}
    ),
    exb as (select execution_id from ex limit ${context.maxRows})`
}

const executionsTruncated = (context: QueryContext): SQL =>
  sql`(select count(*) > ${context.maxRows}::int from ex) as executions_truncated`

// ---- Sources -----------------------------------------------------------------

interface SourceSpec<K extends PostgresMeasuredNamespace> {
  readonly namespace: K
  readonly query: (context: QueryContext) => SQL
  /** Convert the single aggregate row; throw when the data is not trustworthy. */
  readonly parse: (row: Row) => SourceFacts[K]
  /** Sources joined through executions also depend on the executions bound. */
  readonly joined: boolean
}

const sources: { readonly [K in PostgresMeasuredNamespace]: SourceSpec<K> } = {
  executions: {
    namespace: 'executions',
    joined: false,
    query: (context) => sql`
      select count(*)::text as scanned,
        count(*) filter (where state::text not in ${TERMINAL_STATES})::text as active,
        ${statsSelect('reconciliation', 'reconciliation_ms')},
        ${bytesSelect(context, true)}
      from (
        select e.state, pg_column_size(e.*) as bytes, e.updated_at as written_at,
          case when e.state::text not in ${TERMINAL_STATES} then ${ageMs(context, sql`e.updated_at`)} end as reconciliation_ms
        from executions e
        where e.workspace_id = ${context.workspaceId}
        limit ${context.maxRows + 1}
      ) scoped`,
    parse: (row) => ({
      active: wholeNumber(row['active']),
      reconciliation: stats(row, 'reconciliation'),
      storage: storage(row, true),
    }),
  },
  'execution-attempts': {
    namespace: 'execution-attempts',
    joined: true,
    query: (context) => sql`
      with ${boundedExecutions(context)},
      scoped as (
        select exb.execution_id, a.sequence, a.state, a.accepted_at, a.queued_at, a.terminal_at, a.bytes, a.written_at
        from exb
        cross join lateral (
          select a.sequence, a.state::text as state, a.accepted_at, a.queued_at, a.terminal_at,
            pg_column_size(a.*) as bytes, a.updated_at as written_at
          from execution_attempts a
          where a.execution_id = exb.execution_id
          limit ${context.maxRows + 1}
        ) a
        limit ${context.maxRows + 1}
      ),
      lagged as (
        select scoped.*,
          lag(terminal_at) over (partition by execution_id order by sequence) as previous_terminal_at
        from scoped
      ),
      measured as (
        select state, bytes, written_at,
          case when previous_terminal_at is not null
            then ${elapsedMs(sql`previous_terminal_at`, sql`coalesce(queued_at, accepted_at)`)} end as gap_ms,
          case when sequence >= 2 and state not in ${TERMINAL_STATES}
            then ${ageMs(context, sql`coalesce(queued_at, accepted_at)`)} end as current_ms
        from lagged
      )
      select ${executionsTruncated(context)},
        count(*)::text as scanned,
        count(*) filter (where state not in ${TERMINAL_STATES})::text as active,
        ${statsSelect('gap', 'gap_ms')},
        ${statsSelect('current', 'current_ms')},
        ${bytesSelect(context, true)}
      from measured`,
    parse: (row) => ({
      active: wholeNumber(row['active']),
      gap: stats(row, 'gap'),
      current: stats(row, 'current'),
      storage: storage(row, true),
    }),
  },
  'interaction-requests': {
    namespace: 'interaction-requests',
    joined: true,
    query: (context) => sql`
      with ${boundedExecutions(context)},
      scoped as (
        select i.state, i.bytes, i.written_at, i.responded_ms, i.waiting_ms
        from exb
        cross join lateral (
          select i.state::text as state, pg_column_size(i.*) as bytes,
            greatest(i.requested_at, i.resolved_at) as written_at,
            case when i.state::text = 'responded' and i.resolved_at is not null
              then ${elapsedMs(sql`i.requested_at`, sql`i.resolved_at`)} end as responded_ms,
            case when i.state::text = 'pending' then ${ageMs(context, sql`i.requested_at`)} end as waiting_ms
          from interaction_requests i
          where i.execution_id = exb.execution_id
          limit ${context.maxRows + 1}
        ) i
        limit ${context.maxRows + 1}
      )
      select ${executionsTruncated(context)},
        count(*)::text as scanned,
        count(*) filter (where state = 'pending')::text as pending,
        ${statsSelect('responded', 'responded_ms')},
        ${statsSelect('waiting', 'waiting_ms')},
        ${bytesSelect(context, true)}
      from scoped`,
    parse: (row) => ({
      pending: wholeNumber(row['pending']),
      responded: stats(row, 'responded'),
      waiting: stats(row, 'waiting'),
      storage: storage(row, true),
    }),
  },
  'runtime-commands': {
    namespace: 'runtime-commands',
    joined: true,
    query: (context) => sql`
      with ${boundedExecutions(context)},
      scoped as (
        select c.status, c.bytes, c.written_at, c.dispatch_ms, c.waiting_ms
        from exb
        cross join lateral (
          select c.status::text as status, pg_column_size(c.*) as bytes, c.updated_at as written_at,
            case when c.first_dispatched_at is not null
              then ${elapsedMs(sql`c.issued_at`, sql`c.first_dispatched_at`)} end as dispatch_ms,
            case when c.status::text = 'queued' then ${ageMs(context, sql`c.issued_at`)} end as waiting_ms
          from runtime_commands c
          where c.execution_id = exb.execution_id and c.workspace_id = ${context.workspaceId}
          limit ${context.maxRows + 1}
        ) c
        limit ${context.maxRows + 1}
      )
      select ${executionsTruncated(context)},
        count(*)::text as scanned,
        count(*) filter (where status in ${ACTIVE_JOB_STATUSES})::text as active,
        ${statsSelect('dispatch', 'dispatch_ms')},
        ${statsSelect('waiting', 'waiting_ms')},
        ${bytesSelect(context, true)}
      from scoped`,
    parse: (row) => ({
      active: wholeNumber(row['active']),
      dispatch: stats(row, 'dispatch'),
      waiting: stats(row, 'waiting'),
      storage: storage(row, true),
    }),
  },
  'execution-events': {
    namespace: 'execution-events',
    joined: true,
    query: (context) => sql`
      with ${boundedExecutions(context)},
      scoped as (
        select ev.active, ev.bytes, ev.written_at
        from exb
        cross join lateral (
          select (ev.archived_at is null and ev.publication_status::text <> 'published') as active,
            pg_column_size(ev.*) as bytes,
            greatest(ev.recorded_at, ev.last_attempt_at, ev.published_at, ev.quarantined_at, ev.archived_at) as written_at
          from execution_events ev
          where ev.execution_id = exb.execution_id and ev.workspace_id = ${context.workspaceId}
          limit ${context.maxRows + 1}
        ) ev
        limit ${context.maxRows + 1}
      )
      select ${executionsTruncated(context)},
        count(*)::text as scanned,
        count(*) filter (where active)::text as active,
        ${bytesSelect(context, true)}
      from scoped`,
    parse: (row) => ({ active: wholeNumber(row['active']), storage: storage(row, true) }),
  },
  'runtime-discovery-sessions': {
    namespace: 'runtime-discovery-sessions',
    joined: false,
    query: (context) => sql`
      select count(*)::text as scanned,
        count(*) filter (where active)::text as active,
        ${bytesSelect(context, true)}
      from (
        select (p.model ->> 'state' = 'active') as active, pg_column_size(p.*) as bytes, p.updated_at as written_at
        from runtime_discovery_projections p
        where p.workspace_id = ${context.workspaceId} and p.kind::text = 'external_session'
        limit ${context.maxRows + 1}
      ) scoped`,
    parse: (row) => ({ active: wholeNumber(row['active']), storage: storage(row, true) }),
  },
  'runtime-discovery-connections': {
    namespace: 'runtime-discovery-connections',
    joined: false,
    query: (context) => sql`
      select count(*)::text as scanned, ${bytesSelect(context, true)}
      from (
        select pg_column_size(p.*) as bytes, p.updated_at as written_at
        from runtime_discovery_projections p
        where p.workspace_id = ${context.workspaceId} and p.kind::text = 'runtime_connection'
        limit ${context.maxRows + 1}
      ) scoped`,
    parse: (row) => ({ storage: storage(row, true) }),
  },
  'execution-plans': {
    namespace: 'execution-plans',
    joined: false,
    query: (context) => sql`
      select count(*)::text as scanned, ${bytesSelect(context, true)}
      from (
        select pg_column_size(p.*) as bytes, greatest(p.created_at, p.unreferenced_since) as written_at
        from execution_plans p
        where p.workspace_id = ${context.workspaceId}
        limit ${context.maxRows + 1}
      ) scoped`,
    parse: (row) => ({ storage: storage(row, true) }),
  },
  'usage-ledger-entries': {
    namespace: 'usage-ledger-entries',
    joined: false,
    query: (context) => sql`
      select count(*)::text as scanned,
        count(*) filter (where in_window and currency = 'USD')::text as usd_entries,
        count(*) filter (where cost_microunits < 0)::text as negative_entries,
        coalesce(sum(cost_microunits) filter (where in_window and currency = 'USD' and cost_exact), 0)::text as usd_exact,
        coalesce(sum(cost_microunits) filter (where in_window and currency = 'USD' and not cost_exact), 0)::text as usd_inexact,
        ${bytesSelect(context, true)}
      from (
        select l.currency, l.cost_exact, l.cost_microunits, pg_column_size(l.*) as bytes,
          l.recorded_at as written_at, (l.recorded_at >= ${context.since}::timestamptz) as in_window
        from usage_ledger_entries l
        where l.workspace_id = ${context.workspaceId}
        limit ${context.maxRows + 1}
      ) scoped`,
    parse: (row) => {
      // Ledger amounts are nonnegative by contract; a negative row is damage, not a credit.
      if (wholeNumber(row['negative_entries']) > 0) throw new MalformedRow()
      return {
        usd:
          wholeNumber(row['usd_entries']) === 0
            ? null
            : { exact: wholeNumber(row['usd_exact']), inexact: wholeNumber(row['usd_inexact']) },
        storage: storage(row, true),
      }
    },
  },
  'usage-budgets': {
    namespace: 'usage-budgets',
    joined: false,
    // Spent microunits are the charged microunits across every reservation, the
    // `calculateTotals` rule the SQLite report mirrors. Numeric sums cannot
    // overflow in SQL; the safe-integer check happens on the way out.
    query: (context) => sql`
      select count(*)::text as scanned,
        count(*) filter (where malformed)::text as malformed,
        coalesce(string_agg(distinct currency, ',' order by currency) filter (where currency is not null), '') as currencies,
        coalesce(sum(spent) filter (where currency = 'USD' and not malformed), 0)::text as usd_spent,
        ${bytesSelect(context, false)}
      from (
        select b.state ->> 'currency' as currency, pg_column_size(b.*) as bytes, r.spent,
          (jsonb_typeof(b.state -> 'reservations') is distinct from 'array'
            or coalesce(b.state ->> 'currency' !~ '^[A-Z]{3}$', true)
            or r.bad > 0) as malformed
        from usage_budget_states b
        cross join lateral (
          select coalesce(sum((x ->> 'chargedMicrounits')::numeric) filter (where valid), 0) as spent,
            count(*) filter (where not valid) as bad
          from (
            select x, case when jsonb_typeof(x -> 'chargedMicrounits') = 'number'
                then (x ->> 'chargedMicrounits')::numeric >= 0
                  and (x ->> 'chargedMicrounits')::numeric = trunc((x ->> 'chargedMicrounits')::numeric)
                else false end as valid
            from jsonb_array_elements(case when jsonb_typeof(b.state -> 'reservations') = 'array' then b.state -> 'reservations' else '[]'::jsonb end) x
          ) v
        ) r
        where b.workspace_id = ${context.workspaceId}
        limit ${context.maxRows + 1}
      ) scoped`,
    parse: (row) => {
      if (wholeNumber(row['malformed']) > 0) throw new MalformedRow()
      const currencies = String(row['currencies'] ?? '')
        .split(',')
        .filter((currency) => currency.length > 0)
      return {
        records: wholeNumber(row['scanned']),
        currencies,
        usdSpentMicrounits: currencies.includes('USD') ? wholeNumber(row['usd_spent']) : null,
        storage: storage(row, false),
      }
    },
  },
  'usage-effects': {
    namespace: 'usage-effects',
    joined: false,
    query: (context) => sql`
      select count(*)::text as scanned, ${bytesSelect(context, false)}
      from (
        select pg_column_size(r.*) as bytes
        from usage_operation_receipts r
        where r.workspace_id = ${context.workspaceId}
        limit ${context.maxRows + 1}
      ) scoped`,
    parse: (row) => ({ storage: storage(row, false) }),
  },
}

function reasonFor(error: unknown): PostgresMeasurementSourceReason {
  // drizzle wraps driver errors; the PostgreSQL SQLSTATE sits on the error or its cause.
  let candidate: unknown = error
  for (
    let depth = 0;
    depth < 3 && typeof candidate === 'object' && candidate !== null;
    depth += 1
  ) {
    const code = (candidate as { code?: unknown }).code
    if (code === '57014') return 'timeout'
    if (code === '55P03') return 'lock_timeout'
    if (code === '42501') return 'permission_denied'
    candidate = (candidate as { cause?: unknown }).cause
  }
  return 'query_failed'
}

type MeasurementTransaction = Parameters<
  Parameters<PostgresMeasurementDatabase['transaction']>[0]
>[0]

async function readSource<K extends PostgresMeasuredNamespace>(
  transaction: MeasurementTransaction,
  spec: SourceSpec<K>,
  context: QueryContext
): Promise<Outcome<SourceFacts[K]>> {
  let rows: readonly Row[]
  try {
    // A savepoint keeps one failed source from aborting the whole snapshot.
    rows = await transaction.transaction(
      async (savepoint) => (await savepoint.execute(spec.query(context))) as unknown as Row[]
    )
  } catch (error) {
    return { status: 'unavailable', reason: reasonFor(error) }
  }
  try {
    const row = rows[0]
    if (row === undefined) return { status: 'unavailable', reason: 'query_failed' }
    if (spec.joined && row['executions_truncated'] === true)
      return { status: 'incomplete', reason: 'row_budget_reached' }
    if (wholeNumber(row['scanned']) > context.maxRows)
      return { status: 'incomplete', reason: 'row_budget_reached' }
    return { status: 'complete', facts: spec.parse(row) }
  } catch (error) {
    if (error instanceof UnsafeTotal) return { status: 'incomplete', reason: 'unsafe_total' }
    return { status: 'incomplete', reason: 'malformed_records' }
  }
}

// ---- Point assembly (pure) ---------------------------------------------------

type Baseline = ReadonlyMap<PostgresMeasuredNamespace, number>

interface AssembledPass {
  readonly points: OperationsMetricPoint[]
  readonly nextBaseline: Baseline | undefined
}

function pushStats(
  points: OperationsMetricPoint[],
  name: string,
  value: LatencyStats | null,
  labels: Record<string, string>
): void {
  if (value === null) return
  points.push(
    { name, value: value.min, labels: { ...labels, statistic: 'min' } },
    { name, value: value.median, labels: { ...labels, statistic: 'median' } },
    { name, value: value.max, labels: { ...labels, statistic: 'max' } }
  )
}

/**
 * Turns per-source outcomes into points. A point derived from a source that is
 * not `complete` is suppressed; nothing is estimated or zero-filled. The
 * baseline for storage growth is replaced only by a fully complete snapshot.
 */
export function assemblePostgresOperationsPoints(
  outcomes: SourceOutcomes,
  baseline: Baseline | undefined,
  storageUsdPerGiBMonth: number | undefined
): AssembledPass {
  const points: OperationsMetricPoint[] = []
  const facts = <K extends PostgresMeasuredNamespace>(namespace: K): SourceFacts[K] | undefined => {
    const outcome = outcomes[namespace]
    return outcome.status === 'complete' ? outcome.facts : undefined
  }

  const commands = facts('runtime-commands')
  if (commands !== undefined) {
    pushStats(points, operationsMetricNames.queueLatency, commands.dispatch, { stage: 'dispatch' })
    pushStats(points, operationsMetricNames.queueLatency, commands.waiting, { stage: 'wait' })
  }
  const interactions = facts('interaction-requests')
  if (interactions !== undefined) {
    pushStats(points, operationsMetricNames.humanLatency, interactions.responded, {
      outcome: 'responded',
    })
    pushStats(points, operationsMetricNames.humanLatency, interactions.waiting, {
      outcome: 'waiting',
    })
  }
  const attempts = facts('execution-attempts')
  if (attempts !== undefined) {
    pushStats(points, operationsMetricNames.retryAge, attempts.gap, { kind: 'gap' })
    pushStats(points, operationsMetricNames.retryAge, attempts.current, { kind: 'current' })
  }
  const executions = facts('executions')
  if (executions !== undefined)
    pushStats(points, operationsMetricNames.reconciliationAge, executions.reconciliation, {})
  const usageEntries = facts('usage-ledger-entries')
  if (usageEntries?.usd) {
    points.push(
      {
        name: operationsMetricNames.usageCostUsd,
        value: usageEntries.usd.exact / MICROUNITS_PER_USD,
        labels: { exactness: 'exact' },
      },
      {
        name: operationsMetricNames.usageCostUsd,
        value: usageEntries.usd.inexact / MICROUNITS_PER_USD,
        labels: { exactness: 'inexact' },
      }
    )
  }

  // Storage: per complete namespace, then the measured-set total only when every
  // measured namespace is complete. Rewritten bytes exist only for namespaces
  // with a last-write timestamp, so no total is claimed for them.
  let totalBytes = 0
  let allComplete = true
  const bytesByNamespace = new Map<PostgresMeasuredNamespace, number>()
  for (const namespace of postgresMeasuredNamespaces) {
    const outcome = outcomes[namespace]
    if (outcome.status !== 'complete') {
      allComplete = false
      continue
    }
    const { storage: namespaceStorage } = outcome.facts as { storage: StorageFacts }
    bytesByNamespace.set(namespace, namespaceStorage.bytes)
    totalBytes += namespaceStorage.bytes
    points.push({
      name: operationsMetricNames.storageRetainedBytes,
      value: namespaceStorage.bytes,
      labels: { namespace },
    })
    if (namespaceStorage.rewritten !== null)
      points.push({
        name: operationsMetricNames.storageRewrittenBytes,
        value: namespaceStorage.rewritten,
        labels: { namespace },
      })
    const previous = baseline?.get(namespace)
    if (previous !== undefined)
      points.push({
        name: operationsMetricNames.storageGrowthBytes,
        value: namespaceStorage.bytes - previous,
        labels: { namespace },
      })
  }
  if (allComplete) {
    points.push({
      name: operationsMetricNames.storageRetainedBytes,
      value: totalBytes,
      labels: { namespace: 'total' },
    })
    if (baseline !== undefined) {
      let baselineTotal = 0
      for (const value of baseline.values()) baselineTotal += value
      points.push({
        name: operationsMetricNames.storageGrowthBytes,
        value: totalBytes - baselineTotal,
        labels: { namespace: 'total' },
      })
    }
  }

  const activeObjects: readonly [string, number | undefined][] = [
    ['execution', executions?.active],
    ['job', commands?.active],
    ['attempt', attempts?.active],
    ['session', facts('runtime-discovery-sessions')?.active],
    ['approval', interactions?.pending],
    ['effect', facts('execution-events')?.active],
  ]
  for (const [objectKind, active] of activeObjects) {
    if (active === undefined) continue
    points.push({
      name: operationsMetricNames.activeObjectCount,
      value: active,
      labels: { object_kind: objectKind },
    })
  }

  // Operating cost: storage is priced only with an explicit rate over a complete
  // snapshot; the total additionally needs a clean single-currency USD budget.
  if (storageUsdPerGiBMonth !== undefined && allComplete) {
    const storageMicrounits = Math.round(
      (totalBytes / BYTES_PER_GIB) * storageUsdPerGiBMonth * MICROUNITS_PER_USD
    )
    points.push({
      name: operationsMetricNames.operatingCostUsd,
      value: storageMicrounits / MICROUNITS_PER_USD,
      labels: { component: 'storage' },
    })
    const budgets = facts('usage-budgets')
    if (
      budgets !== undefined &&
      budgets.records > 0 &&
      budgets.currencies.length === 1 &&
      budgets.usdSpentMicrounits !== null
    ) {
      const total = budgets.usdSpentMicrounits + storageMicrounits
      if (Number.isSafeInteger(total))
        points.push({
          name: operationsMetricNames.operatingCostUsd,
          value: total / MICROUNITS_PER_USD,
          labels: { component: 'total' },
        })
    }
  }

  return { points, nextBaseline: allComplete ? bytesByNamespace : undefined }
}

// ---- Producer ------------------------------------------------------------------

function sourceStatuses(
  outcomes: SourceOutcomes
): Record<PostgresMeasuredNamespace, PostgresMeasurementSourceStatus> {
  return Object.fromEntries(
    postgresMeasuredNamespaces.map((namespace) => {
      const outcome = outcomes[namespace]
      return [
        namespace,
        outcome.status === 'complete'
          ? { status: 'complete' }
          : { status: outcome.status, reason: outcome.reason },
      ]
    })
  ) as Record<PostgresMeasuredNamespace, PostgresMeasurementSourceStatus>
}

export function createPostgresOperationsMeasurementProducer(
  options: PostgresOperationsMeasurementOptions
): PostgresOperationsMeasurementProducer {
  const resolved = resolveOptions(options)
  let baseline: Baseline | undefined
  let inFlight: Promise<PostgresOperationsMeasurementResult | undefined> | undefined

  async function pass(): Promise<PostgresOperationsMeasurementResult | undefined> {
    const nowMs = resolved.now().getTime()
    if (!Number.isFinite(nowMs)) return undefined
    const context: QueryContext = {
      workspaceId: resolved.workspaceId,
      now: new Date(nowMs).toISOString(),
      since: new Date(nowMs - resolved.windowSeconds * 1000).toISOString(),
      maxRows: resolved.maxScanRows,
    }
    let outcomes: SourceOutcomes
    try {
      outcomes = await resolved.database.transaction(
        async (transaction) => {
          await transaction.execute(sql`select
            set_config('statement_timeout', ${String(resolved.statementTimeoutMs)}, true),
            set_config('lock_timeout', ${String(resolved.lockTimeoutMs)}, true),
            set_config('idle_in_transaction_session_timeout', ${String(IDLE_IN_TRANSACTION_TIMEOUT_MS)}, true)`)
          const collected: Record<string, Outcome<unknown>> = {}
          for (const namespace of postgresMeasuredNamespaces)
            collected[namespace] = await readSource(transaction, sources[namespace], context)
          return collected as unknown as SourceOutcomes
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' }
      )
    } catch {
      // No snapshot could be established or committed: the substrate is
      // unavailable, and nothing about it is claimed.
      return undefined
    }
    if (
      postgresMeasuredNamespaces.every((namespace) => outcomes[namespace].status === 'unavailable')
    )
      return undefined
    const assembled = assemblePostgresOperationsPoints(
      outcomes,
      baseline,
      resolved.storageUsdPerGiBMonth
    )
    // Only a complete storage snapshot from a committed transaction replaces
    // the baseline; partial or failed passes leave the previous one intact.
    if (assembled.nextBaseline !== undefined) baseline = assembled.nextBaseline
    return {
      points: assembled.points,
      sources: sourceStatuses(outcomes),
      baselineCommitted: assembled.nextBaseline !== undefined,
    }
  }

  const measureDetailed = (): Promise<PostgresOperationsMeasurementResult | undefined> => {
    if (inFlight !== undefined) return inFlight
    const current = pass().finally(() => {
      if (inFlight === current) inFlight = undefined
    })
    inFlight = current
    return current
  }

  return {
    measureDetailed,
    measure: async () => (await measureDetailed())?.points,
  }
}

export interface PostgresRuntimeMeasurementsOptions extends PostgresOperationsMeasurementOptions {
  readonly adapter: MetricAdapter
  readonly intervalMs: number
}

/**
 * Hosted PostgreSQL counterpart of `createLocalRuntimeMeasurements`: a bounded
 * `OperationsMeasurementLifecycle` over the scoped producer above. The
 * composition owns `start()` after migrations and runtime startup, and must
 * `close()` before it ends the database pool; close drains an active pass.
 */
export function createPostgresRuntimeMeasurements(
  options: PostgresRuntimeMeasurementsOptions
): OperationsMeasurementLifecycle {
  const producer = createPostgresOperationsMeasurementProducer(options)
  return new OperationsMeasurementLifecycle({
    adapter: options.adapter,
    serviceName: 'hosted-control-plane',
    intervalMs: options.intervalMs,
    measure: () => producer.measure(),
  })
}
