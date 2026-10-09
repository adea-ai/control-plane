import {
  ExternalSessionDiscoveryReadModelSchema,
  IdentifierSchemas,
  compareCodePointOrder,
} from '@control-plane/contracts'
import {
  ExecutionAttemptSchema,
  ExecutionSchema,
  InteractionRequestSchema,
  RuntimeCommandRecordSchema,
} from '@control-plane/domain'
import { ExecutionEventSchema } from '@control-plane/events'
import {
  operationsMetricNames,
  operationsStorageNamespaces,
  type OperationsMetricPoint,
} from '@control-plane/telemetry'
import { UsageLedgerEntrySchema } from '@control-plane/usage-ledger'
import { DurableUsageBudgetSchema } from '@control-plane/usage-ledger/durable-contract'
import { z, type ZodType } from 'zod'

/**
 * Read-only runtime telemetry correlation and operations measurement for a
 * stopped Local or Hosted Simple SQLite data directory.
 *
 * The report correlates the already-persisted conversation anchor, job
 * (runtime command), attempt, external session, approval (interaction), effect
 * (execution event) and artifact reference state of every execution in one
 * workspace, then measures queue and human latency, retry and reconciliation
 * age, usage, storage growth, active objects and operating cost.
 *
 * Boundaries this module preserves:
 * - Tenant scope: only records whose own workspace scope — or an in-scope
 *   execution anchor, for records that carry none — matches the selected
 *   workspace are measured or emitted. Other workspaces are counted, never
 *   named.
 * - Current authority: measurement reads the current authoritative record per
 *   object (the stored execution and its current attempt, the highest channel
 *   generation reserved per node, the current discovery projection and
 *   publication status). It never reconstructs state from historical journals
 *   or superseded generations, and it never mutates anything.
 * - Conversation and artifact state belong to Agent HQ and the product
 *   artifact authority; the Control Plane correlates references only and marks
 *   both `reference_only`. No object bytes, prompts, responses, payloads or
 *   credentials are ever read into the report.
 * - Cost is measured, never inferred: usage and operating-cost numbers come
 *   from the durable usage ledger, and storage is priced only when the operator
 *   supplies an explicit rate.
 *
 * Source quality is propagated, not assumed. `summary.complete` is true only
 * when every namespace walk finished, every record parsed and every summed
 * total stayed in the safe-integer range; `summary.sourceQuality` and
 * `summary.incompleteSources` attribute the exact namespaces at fault. Every
 * measurement section carries its own `complete` flag, correlation dimensions
 * expose scan and generation-source completeness, and telemetry points derived
 * from incomplete or overflowed sources are suppressed rather than emitted as
 * ordinary observations. Storage growth is a signed snapshot delta against a
 * prior complete report of the same workspace (`baselineReport`) and is
 * reported as unavailable until one exists; bytes rewritten inside the window
 * are reported separately and are never called growth.
 */

/** Records fetched per continuation page while walking a namespace. */
export const SCAN_PAGE_SIZE = 512
/** Raw rows examined per namespace before the scan reports itself incomplete. */
export const MAX_SCAN_ROWS = 100_000
/** In-scope records retained per namespace before the scan reports itself incomplete. */
export const MAX_SCAN_MATCHES = 10_000
export const DEFAULT_CORRELATION_LIMIT = 100
export const MAX_CORRELATION_LIMIT = 500
/** Default measurement window: windowed usage and rewritten-byte accounting over 24 hours. */
export const DEFAULT_WINDOW_SECONDS = 86_400
export const MIN_WINDOW_SECONDS = 60
export const MAX_WINDOW_SECONDS = 31_536_000
/** Operator-supplied storage price bound; no provider pricing is ever inferred. */
export const MIN_STORAGE_USD_PER_GIB_MONTH = 0
export const MAX_STORAGE_USD_PER_GIB_MONTH = 100_000

const BYTES_PER_GIB = 1024 * 1024 * 1024
const MICROUTENTS_PER_USD = 1_000_000

export const availabilitySchema = z.enum([
  'resolved',
  'missing',
  'unparseable',
  'not_established',
  'reference_only',
  'unreferenced',
  /** The namespace walk stopped at a budget; the dimension is a lower bound. */
  'scan_incomplete',
])

export const operationsMeasurementOptionsSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    limit: z.number().int().min(1).max(MAX_CORRELATION_LIMIT).default(DEFAULT_CORRELATION_LIMIT),
    maxScanMatches: z.number().int().min(1).max(1_000_000).default(MAX_SCAN_MATCHES),
    windowSeconds: z
      .number()
      .int()
      .min(MIN_WINDOW_SECONDS)
      .max(MAX_WINDOW_SECONDS)
      .default(DEFAULT_WINDOW_SECONDS),
    /** Explicit USD per GiB-month storage price; omitted means unpriced. */
    storageUsdPerGiBMonth: z
      .number()
      .min(MIN_STORAGE_USD_PER_GIB_MONTH)
      .max(MAX_STORAGE_USD_PER_GIB_MONTH)
      .optional(),
    /**
     * A prior complete report of the same workspace, used as the snapshot
     * baseline for true storage-growth deltas. Without one, growth is
     * explicitly unavailable — never estimated from rewritten bytes.
     */
    baselineReport: z.unknown().optional(),
    /** Deterministic measurement clock; defaults to wall time. */
    now: z.iso.datetime().optional(),
  })
  .strict()

export type OperationsMeasurementOptions = z.input<typeof operationsMeasurementOptionsSchema>

/**
 * The subset of a prior measurement report accepted as a growth baseline:
 * identity, scope and the baseline storage snapshot under `measurements`.
 * Superset fields from a full report are ignored; a report from another
 * workspace, a foreign command or an incomplete baseline is rejected instead
 * of silently producing a misleading delta.
 */
export const OperationsMeasurementBaselineSchema = z.object({
  schemaVersion: z.literal(1),
  command: z.literal('local.operator.telemetry.operations'),
  generatedAt: z.iso.datetime(),
  scope: z.object({ workspaceId: z.string() }),
  measurements: z.object({
    storage: z.object({
      complete: z.boolean(),
      namespaces: z.array(
        z.object({
          namespace: z.string(),
          bytes: z.number().int().nonnegative(),
          complete: z.boolean(),
        })
      ),
      totals: z.object({ bytes: z.number().int().nonnegative() }),
    }),
  }),
})

const NullableId = z.string().nullable()
const NullableState = z.string().nullable()
const NullableTimestamp = z.string().nullable()
const NullableInt = z.number().int().nullable()

const LatencyStatsSchema = z
  .object({
    samples: z.number().int().nonnegative(),
    minMs: NullableInt,
    medianMs: NullableInt,
    maxMs: NullableInt,
  })
  .strict()

const ConversationViewSchema = z
  .object({
    availability: availabilitySchema,
    /** Agent HQ owns conversation bodies and state; anchors only, never content. */
    authority: z.literal('agent_hq_reference'),
    taskId: NullableId,
    agentId: NullableId,
    requestId: NullableId,
  })
  .strict()

const JobCorrelationViewSchema = z
  .object({
    availability: availabilitySchema,
    active: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
    /**
     * True when an active job lags its node's current channel generation,
     * false when every active job reports the current one, null when any
     * active job has no known generation to compare against — or when the
     * generation source itself is not clean, in which case a `false` verdict
     * could be produced by a truncated or corrupted reservation walk.
     */
    staleGeneration: z.boolean().nullable(),
    /**
     * False when the `runtime-channel-sequences` walk was truncated or held
     * malformed records: every non-positively-stale generation verdict is then
     * forced to unknown instead of being asserted from a damaged source.
     */
    generationScanComplete: z.boolean(),
    oldestActiveAgeMs: NullableInt,
  })
  .strict()

const AttemptCorrelationViewSchema = z
  .object({
    availability: availabilitySchema,
    attemptId: NullableId,
    sequence: NullableInt,
    state: NullableState,
    updatedAt: NullableTimestamp,
    ageMs: NullableInt,
    /** Attempts past the first one, from the authoritative attempt count. */
    retryCount: z.number().int().nonnegative(),
  })
  .strict()

const SessionCorrelationViewSchema = z
  .object({
    availability: availabilitySchema,
    externalSessionId: NullableId,
    state: NullableState,
    recoverable: z.boolean().nullable(),
    observedAt: NullableTimestamp,
  })
  .strict()

const ApprovalCorrelationViewSchema = z
  .object({
    availability: availabilitySchema,
    pending: z.number().int().nonnegative(),
    responded: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    oldestPendingAgeMs: NullableInt,
  })
  .strict()

const EffectCorrelationViewSchema = z
  .object({
    availability: availabilitySchema,
    pending: z.number().int().nonnegative(),
    published: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    oldestPendingAgeMs: NullableInt,
  })
  .strict()

const ArtifactViewSchema = z
  .object({
    availability: availabilitySchema,
    /** The product artifact authority owns bytes, verification and access. */
    authority: z.literal('product_artifact_reference'),
    artifactId: NullableId,
    source: z.enum(['execution', 'attempt', 'command']).nullable(),
  })
  .strict()

const CorrelationViewSchema = z
  .object({
    executionId: z.string(),
    state: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Age of the last observed change while the execution is not terminal. */
    reconciliationAgeMs: NullableInt,
    conversation: ConversationViewSchema,
    job: JobCorrelationViewSchema,
    attempt: AttemptCorrelationViewSchema,
    session: SessionCorrelationViewSchema,
    approval: ApprovalCorrelationViewSchema,
    effect: EffectCorrelationViewSchema,
    artifact: ArtifactViewSchema,
  })
  .strict()

const ObjectCountSchema = z
  .object({
    active: z.number().int().nonnegative(),
    byState: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()

const UsageCurrencyTotalsSchema = z
  .object({
    costMicrounits: NullableInt,
    exactCostMicrounits: NullableInt,
    inexactCostMicrounits: NullableInt,
  })
  .strict()

const BudgetCurrencyTotalsSchema = z
  .object({
    spentMicrounits: NullableInt,
    reservedMicrounits: NullableInt,
  })
  .strict()

const NamespaceStorageSchema = z
  .object({
    namespace: z.string(),
    records: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    /**
     * Payload bytes of rows last written inside the measurement window. This
     * counts full rewritten payloads and ignores deletions: it is churn, not
     * growth. True growth is `growthBytes`, the signed snapshot delta.
     */
    bytesRewrittenInWindow: z.number().int().nonnegative(),
    /** False when this namespace's walk or parsing was incomplete. */
    complete: z.boolean(),
    /** Signed delta against the baseline snapshot; null while unavailable. */
    growthBytes: z.number().int().nullable(),
  })
  .strict()

const TelemetryPointSchema = z
  .object({
    name: z.string(),
    value: z.number(),
    labels: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export const OperationsMeasurementReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: z.literal('local.operator.telemetry.operations'),
    readOnly: z.literal(true),
    generatedAt: z.iso.datetime(),
    scope: z.object({ workspaceId: z.string() }).strict(),
    thresholds: z
      .object({
        windowSeconds: z.number().int().positive(),
        windowSince: z.iso.datetime(),
        limit: z.number().int().positive(),
        maxScanMatches: z.number().int().positive(),
        maxScanRows: z.number().int().positive(),
        scanPageSize: z.number().int().positive(),
        storageUsdPerGiBMonth: z.number().nullable(),
      })
      .strict(),
    summary: z
      .object({
        /**
         * True only when every namespace walk finished, every record parsed
         * and every summed total stayed safe: the conjunction in
         * `sourceQuality`. Anything less makes dependent counts lower bounds.
         */
        complete: z.boolean(),
        sourceQuality: z
          .object({
            /** No walk stopped at a scan budget. */
            scansComplete: z.boolean(),
            /** No record failed JSON or schema parsing. */
            recordsClean: z.boolean(),
            /** No summed total left the safe-integer range. */
            totalsSafe: z.boolean(),
          })
          .strict(),
        /**
         * Namespaces responsible for `complete === false`: truncated walks,
         * malformed records and overflowing totals, deduplicated and sorted,
         * so partiality is attributed rather than merely asserted.
         */
        incompleteSources: z.array(z.string()).readonly(),
        executions: z.number().int().nonnegative(),
        outOfScopeExecutions: z.number().int().nonnegative(),
        correlationsListed: z.number().int().nonnegative(),
        correlationsUnlisted: z.number().int().nonnegative(),
        malformedRecords: z.record(z.string(), z.number().int().nonnegative()),
        /**
         * Join-scoped records (attempts, interactions) that could not be
         * anchored to an in-scope execution: records of other workspaces and
         * records whose execution has been removed both land here. They are
         * excluded from every measured total and reported instead of silently
         * counted or dropped.
         */
        unattributedRecords: z.record(z.string(), z.number().int().nonnegative()),
        incompleteScans: z
          .array(
            z
              .object({
                namespace: z.string(),
                reason: z.enum(['match_budget_reached', 'row_budget_reached']),
                lastSeenRecordId: z.string(),
              })
              .strict()
          )
          .readonly(),
      })
      .strict(),
    correlation: z.array(CorrelationViewSchema).readonly(),
    measurements: z
      .object({
        queueLatency: z
          .object({
            /** False when the runtime-command source was truncated or malformed. */
            complete: z.boolean(),
            dispatch: LatencyStatsSchema,
            waiting: LatencyStatsSchema,
            waitingExpiredCount: z.number().int().nonnegative(),
          })
          .strict(),
        humanLatency: z
          .object({
            /** False when the execution or interaction source was degraded. */
            complete: z.boolean(),
            responded: LatencyStatsSchema,
            waiting: LatencyStatsSchema,
            expiredCount: z.number().int().nonnegative(),
            cancelledCount: z.number().int().nonnegative(),
          })
          .strict(),
        retryAge: z
          .object({
            /** False when the execution or attempt source was degraded. */
            complete: z.boolean(),
            retriedExecutions: z.number().int().nonnegative(),
            gap: LatencyStatsSchema,
            current: LatencyStatsSchema,
          })
          .strict(),
        reconciliationAge: z
          .object({
            /** False when the execution source was truncated or malformed. */
            complete: z.boolean(),
            nonTerminal: LatencyStatsSchema,
            awaitingReconciliation: z
              .object({
                executions: z.number().int().nonnegative(),
                oldestMs: NullableInt,
              })
              .strict(),
          })
          .strict(),
        usage: z
          .object({
            /**
             * False when the usage-entry or budget source was truncated or
             * malformed, or when either total set overflowed. Window costs and
             * operating-cost totals are then marked partial and their telemetry
             * points are suppressed.
             */
            complete: z.boolean(),
            windowEntryCount: z.number().int().nonnegative(),
            byUnit: z
              .object({
                tokens: NullableInt,
                calls: NullableInt,
                milliseconds: NullableInt,
                bytes: NullableInt,
                microunits: NullableInt,
              })
              .strict(),
            byKind: z.record(
              z.string(),
              z
                .object({
                  count: z.number().int().nonnegative(),
                  /** Cost per currency; currencies are never summed together. */
                  byCurrency: z.record(z.string(), z.number().int().nonnegative()),
                })
                .strict()
            ),
            byCurrency: z.record(z.string(), UsageCurrencyTotalsSchema),
            /**
             * True when a summed total left the safe-integer range; affected
             * totals hold their last safe value and are not complete.
             */
            unsafeTotals: z.boolean(),
            budgets: z
              .object({
                records: z.number().int().nonnegative(),
                open: z.number().int().nonnegative(),
                settled: z.number().int().nonnegative(),
                byCurrency: z.record(z.string(), BudgetCurrencyTotalsSchema),
                unsafeTotals: z.boolean(),
              })
              .strict(),
          })
          .strict(),
        storage: z
          .object({
            namespaces: z.array(NamespaceStorageSchema).readonly(),
            totals: z
              .object({
                records: z.number().int().nonnegative(),
                bytes: z.number().int().nonnegative(),
                bytesRewrittenInWindow: z.number().int().nonnegative(),
                /** Signed delta against the baseline snapshot; null while unavailable. */
                growthBytes: z.number().int().nullable(),
              })
              .strict(),
            /** False when any measured namespace was truncated or malformed. */
            complete: z.boolean(),
            baseline: z
              .object({
                /**
                 * `complete`: a prior complete report of this workspace was
                 * supplied and deltas are available; `incomplete`: a baseline
                 * was supplied but its own storage snapshot was partial, so no
                 * delta is trustworthy; `absent`: no baseline, actual growth
                 * is unavailable (never estimated).
                 */
                availability: z.enum(['complete', 'incomplete', 'absent']),
                generatedAt: NullableTimestamp,
              })
              .strict(),
            /**
             * Namespaces present in the store but outside the measured set;
             * their bytes are excluded from every total here.
             */
            unmeasuredNamespaces: z.array(z.string()).readonly(),
          })
          .strict(),
        activeObjects: z
          .object({
            /** False when any contributing object source was degraded. */
            complete: z.boolean(),
            executions: ObjectCountSchema,
            jobs: ObjectCountSchema,
            attempts: ObjectCountSchema,
            sessions: ObjectCountSchema,
            approvals: ObjectCountSchema,
            effects: ObjectCountSchema,
          })
          .strict(),
        operatingCost: z
          .object({
            usage: z
              .object({
                availability: z.enum([
                  'measured',
                  'no_budget_records',
                  /** Budget source truncated or malformed; totals are partial. */
                  'source_partial',
                  /** Budget totals overflowed the safe-integer range. */
                  'unsafe_totals',
                ]),
                byCurrency: z.record(z.string(), BudgetCurrencyTotalsSchema),
              })
              .strict(),
            storage: z
              .object({
                bytes: z.number().int().nonnegative(),
                rateUsdPerGiBMonth: z.number().nullable(),
                costMicrounits: NullableInt,
                availability: z.enum([
                  'priced',
                  'rate_not_configured',
                  /** Rate supplied but bytes are a partial snapshot. */
                  'source_partial',
                ]),
              })
              .strict(),
            /**
             * Null unless every component is complete and commensurable; the
             * reason is always named in `totalAvailability`.
             */
            totalMicrounits: NullableInt,
            totalAvailability: z.enum([
              'measured',
              'storage_rate_not_configured',
              'usage_currency_unsupported',
              'usage_unavailable',
              'usage_source_partial',
              'usage_unsafe_totals',
              'storage_source_partial',
            ]),
          })
          .strict(),
      })
      .strict(),
    telemetry: z.array(TelemetryPointSchema).readonly(),
  })
  .strict()

export type OperationsMeasurementReport = z.output<typeof OperationsMeasurementReportSchema>
export type OperationsMeasurementAvailability = z.output<typeof availabilitySchema>

/** The subset of a SQLite handle the measurement consumes. */
export interface ReadOnlyMeasurementStore {
  prepare(query: string): { all(...parameters: unknown[]): unknown[] }
}

export interface MeasurementRecord {
  readonly id: string
  readonly value: unknown
  /** UTF-8 bytes of the stored record payload; row and index overhead excluded. */
  readonly bytes: number
  /** Row `updated_at`, used for the rewritten-bytes window. */
  readonly updatedAt: string | null
}

export interface MeasurementRecordPage {
  readonly records: readonly MeasurementRecord[]
  readonly unparseableJsonCount: number
  readonly rawRowCount: number
  readonly nextAfterId: string | null
}

export interface MeasurementRecordReader {
  pageRecords(namespace: string, pageSize: number, afterId?: string): MeasurementRecordPage
  /** Every namespace physically present in the store, for coverage reporting. */
  namespaces(): readonly string[]
}

/**
 * Wraps a read-only SQLite handle for measurement. Only fixed parameterized
 * `SELECT`s are issued; the caller opens the database read-only (the CLI does,
 * through `openReadOnlyInspectionDatabase` from the inspection module). Paging
 * is keyed on raw record ids so continuation works through arbitrarily long
 * namespaces — including ones full of damaged records.
 */
export function createSqliteMeasurementReader(
  store: ReadOnlyMeasurementStore
): MeasurementRecordReader {
  const firstPage = store.prepare(
    'SELECT id, value, updated_at FROM control_plane_records WHERE namespace = ? ORDER BY id LIMIT ?'
  )
  const nextPage = store.prepare(
    'SELECT id, value, updated_at FROM control_plane_records WHERE namespace = ? AND id > ? ORDER BY id LIMIT ?'
  )
  const namespaceList = store.prepare('SELECT DISTINCT namespace FROM control_plane_records')
  return {
    pageRecords(namespace, pageSize, afterId): MeasurementRecordPage {
      const rows = (
        afterId === undefined
          ? firstPage.all(namespace, pageSize + 1)
          : nextPage.all(namespace, afterId, pageSize + 1)
      ) as Array<{ id?: unknown; value?: unknown; updated_at?: unknown }>
      const hasMore = rows.length > pageSize
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows
      const records: MeasurementRecord[] = []
      let unparseableJsonCount = 0
      let continuationId: string | null = null
      for (const row of pageRows) {
        if (typeof row?.id !== 'string') {
          unparseableJsonCount += 1
          continue
        }
        continuationId = row.id
        const rawValue = typeof row.value === 'string' ? row.value : String(row.value)
        const bytes = Buffer.byteLength(rawValue, 'utf8')
        const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : null
        try {
          records.push({ id: row.id, value: JSON.parse(rawValue), bytes, updatedAt })
        } catch {
          unparseableJsonCount += 1
        }
      }
      // Continuation is keyed on raw ids so damaged values cannot truncate a
      // walk. A page with no usable id that still has successors cannot be
      // continued safely, so it fails loudly instead of claiming exhaustion.
      if (hasMore && continuationId === null)
        throw new Error('MEASUREMENT_SCAN_CONTINUATION_UNUSABLE')
      return {
        records,
        unparseableJsonCount,
        rawRowCount: pageRows.length,
        nextAfterId: hasMore ? continuationId : null,
      }
    },
    namespaces(): readonly string[] {
      const rows = namespaceList.all() as Array<{ namespace?: unknown }>
      return rows
        .map((row) => (typeof row.namespace === 'string' ? row.namespace : null))
        .filter((value): value is string => value !== null)
    },
  }
}

function parseMs(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function ageMs(from: string | null | undefined, nowMs: number): number | null {
  const parsed = parseMs(from)
  if (parsed === null) return null
  return Math.max(0, nowMs - parsed)
}

/** Non-negative elapsed milliseconds from `from` to `to`, or null if unusable. */
function deltaMs(from: string | null | undefined, to: string | null | undefined): number | null {
  const start = parseMs(from)
  const end = parseMs(to)
  if (start === null || end === null) return null
  return Math.max(0, end - start)
}

const terminalStates = new Set(['completed', 'failed', 'cancelled', 'timed_out'])
const activeJobStatuses = new Set(['queued', 'dispatched', 'acknowledged'])
const settledJobStatuses = new Set(['succeeded', 'failed', 'cancelled', 'expired'])

function isTerminalState(state: string): boolean {
  return terminalStates.has(state)
}

/**
 * Lower-median summary over a millisecond sample. Integer, deterministic and
 * explicit about sample count: an empty sample reports nulls, never zeros.
 */
function summarize(values: readonly number[]): z.output<typeof LatencyStatsSchema> {
  if (values.length === 0) return { samples: 0, minMs: null, medianMs: null, maxMs: null }
  const sorted = [...values].toSorted((left, right) => left - right)
  const minMs = sorted.at(0)
  const medianMs = sorted.at(Math.floor((sorted.length - 1) / 2))
  const maxMs = sorted.at(-1)
  if (minMs === undefined || medianMs === undefined || maxMs === undefined)
    return { samples: 0, minMs: null, medianMs: null, maxMs: null }
  return {
    samples: sorted.length,
    minMs,
    medianMs,
    maxMs,
  }
}

/** Safe addition that flags (instead of silently corrupting) overflow. */
function addSafe(total: number, addend: number): { value: number; unsafe: boolean } {
  const value = total + addend
  if (!Number.isSafeInteger(value)) return { value: total, unsafe: true }
  return { value, unsafe: false }
}

function sortedRecord(values: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...values.entries()].toSorted((left, right) => compareCodePointOrder(left[0], right[0]))
  )
}

function sortedKeys<T>(values: ReadonlyMap<string, T>): [string, T][] {
  return [...values.entries()].toSorted((left, right) => compareCodePointOrder(left[0], right[0]))
}

const planScopeSchema = z.object({
  correlation: z.object({ workspaceId: IdentifierSchemas.workspaceId }),
})

const discoveryEnvelopeSchema = z.object({
  workspaceId: IdentifierSchemas.workspaceId,
})

const usageScopeSchema = z.object({
  workspaceId: IdentifierSchemas.workspaceId,
})

const BY_UNIT = ['tokens', 'calls', 'milliseconds', 'bytes', 'microunits'] as const

type IncompleteScan = {
  namespace: string
  reason: 'match_budget_reached' | 'row_budget_reached'
  lastSeenRecordId: string
}

/**
 * Correlates persisted records into scoped, secret-free telemetry and measures
 * operations. Purely a read-path aggregation: no state transitions, no retries,
 * no reconciliation effects and no inferred provider cost.
 */
export function measureOperations(
  reader: MeasurementRecordReader,
  options: OperationsMeasurementOptions
): OperationsMeasurementReport {
  const parsedOptions: z.output<typeof operationsMeasurementOptionsSchema> =
    operationsMeasurementOptionsSchema.parse(options)
  const nowMs = Date.parse(parsedOptions.now ?? new Date().toISOString())
  const sinceMs = nowMs - parsedOptions.windowSeconds * 1000
  const incompleteScans: IncompleteScan[] = []
  const malformedRecords = new Map<string, number>()
  const unattributedRecords = new Map<string, number>()

  // Baseline snapshot for true growth deltas: absent by default, and a
  // baseline from another workspace, a foreign command or an unparsable shape
  // fails closed instead of producing a misleading delta.
  let baseline:
    | {
        readonly generatedAt: string
        readonly complete: boolean
        readonly bytesByNamespace: ReadonlyMap<string, { bytes: number; complete: boolean }>
      }
    | undefined
  if (parsedOptions.baselineReport !== undefined) {
    const parsedBaseline = OperationsMeasurementBaselineSchema.safeParse(
      parsedOptions.baselineReport
    )
    if (!parsedBaseline.success) throw new Error('BASELINE_REPORT_INVALID')
    if (parsedBaseline.data.scope.workspaceId !== parsedOptions.workspaceId)
      throw new Error('BASELINE_SCOPE_MISMATCH')
    baseline = {
      generatedAt: parsedBaseline.data.generatedAt,
      complete: parsedBaseline.data.measurements.storage.complete,
      bytesByNamespace: new Map(
        parsedBaseline.data.measurements.storage.namespaces.map((row) => [
          row.namespace,
          { bytes: row.bytes, complete: row.complete },
        ])
      ),
    }
  }

  const noteMalformed = (namespace: string, count: number) => {
    if (count > 0) malformedRecords.set(namespace, (malformedRecords.get(namespace) ?? 0) + count)
  }
  const noteUnattributed = (namespace: string, count: number) => {
    if (count > 0)
      unattributedRecords.set(namespace, (unattributedRecords.get(namespace) ?? 0) + count)
  }

  /**
   * Source quality, evaluated after every walk: a namespace is clean only
   * when its walk finished AND every record in it parsed. Dependent
   * measurements, correlation dimensions and telemetry points consult this
   * instead of assuming the sources they read were whole.
   */
  const namespaceClean = (namespace: string): boolean =>
    !incompleteScans.some((scan) => scan.namespace === namespace) &&
    !malformedRecords.has(namespace)

  // Storage accounting: in-scope payload bytes per measured namespace, with
  // bytes last written inside the measurement window reported separately as
  // rewritten churn — never as growth.
  const storage = new Map<
    string,
    { records: number; bytes: number; bytesRewrittenInWindow: number }
  >(
    operationsStorageNamespaces
      .filter((namespace) => namespace !== 'total')
      .map((namespace) => [namespace, { records: 0, bytes: 0, bytesRewrittenInWindow: 0 }])
  )
  const accountStorage = (namespace: string, record: MeasurementRecord) => {
    const entry = storage.get(namespace)
    if (entry === undefined) return
    entry.records += 1
    entry.bytes += record.bytes
    const rewrittenAt = parseMs(record.updatedAt)
    if (rewrittenAt !== null && rewrittenAt >= sinceMs) entry.bytesRewrittenInWindow += record.bytes
  }

  /**
   * Walks a namespace with continuation until it is exhausted or a budget
   * stops the walk. Budgets count in-scope matches and raw rows — before any
   * parsing — so a selected workspace behind unrelated records is still found
   * in full and a namespace flooded with damaged records still stops at the
   * bound. An early stop is reported as an incomplete scan, which makes every
   * dependent total a lower bound.
   */
  const walkNamespace = (
    namespace: string,
    onRecord: (record: MeasurementRecord) => boolean
  ): { complete: boolean } => {
    let afterId: string | undefined
    let matches = 0
    let jsonMalformed = 0
    let rows = 0
    let incomplete: IncompleteScan | null = null
    while (incomplete === null) {
      const page = reader.pageRecords(namespace, SCAN_PAGE_SIZE, afterId)
      jsonMalformed += page.unparseableJsonCount
      rows += page.rawRowCount
      const lastRowId = page.records.at(-1)?.id ?? null
      for (const record of page.records) {
        if (onRecord(record)) matches += 1
        const exhausted = record.id === lastRowId && page.nextAfterId === null
        if (!exhausted && (rows >= MAX_SCAN_ROWS || matches >= parsedOptions.maxScanMatches)) {
          incomplete = {
            namespace,
            reason: rows >= MAX_SCAN_ROWS ? 'row_budget_reached' : 'match_budget_reached',
            lastSeenRecordId: record.id,
          }
          break
        }
      }
      if (incomplete === null && page.nextAfterId !== null && rows >= MAX_SCAN_ROWS) {
        incomplete = {
          namespace,
          reason: 'row_budget_reached',
          lastSeenRecordId: page.nextAfterId,
        }
      }
      if (incomplete !== null) break
      if (page.nextAfterId === null) break
      afterId = page.nextAfterId
    }
    if (incomplete !== null) incompleteScans.push(incomplete)
    noteMalformed(namespace, jsonMalformed)
    return { complete: incomplete === null }
  }

  // Executions carry the workspace scope; join-scoped records follow them.
  const executions = new Map<string, z.output<typeof ExecutionSchema>>()
  let outOfScopeExecutionRecords = 0
  let executionSchemaMalformed = 0
  const executionsWalk = walkNamespace('executions', (record) => {
    const parsedRecord = ExecutionSchema.safeParse(record.value)
    if (!parsedRecord.success) {
      executionSchemaMalformed += 1
      return false
    }
    if (parsedRecord.data.correlation.workspaceId !== parsedOptions.workspaceId) {
      outOfScopeExecutionRecords += 1
      return false
    }
    executions.set(parsedRecord.data.executionId, parsedRecord.data)
    accountStorage('executions', record)
    return true
  })
  noteMalformed('executions', executionSchemaMalformed)

  const joinByExecution = <T>(
    namespace: string,
    schema: ZodType<T>,
    executionIdOf: (parsed: T) => string
  ): { byExecution: Map<string, T[]>; complete: boolean } => {
    const byExecution = new Map<string, T[]>()
    let schemaMalformed = 0
    let unattributed = 0
    const walk = walkNamespace(namespace, (record) => {
      const parsedRecord = schema.safeParse(record.value)
      if (!parsedRecord.success) {
        schemaMalformed += 1
        return false
      }
      const executionId = executionIdOf(parsedRecord.data)
      if (!executions.has(executionId)) {
        unattributed += 1
        return false
      }
      accountStorage(namespace, record)
      const existing = byExecution.get(executionId)
      if (existing === undefined) byExecution.set(executionId, [parsedRecord.data])
      else existing.push(parsedRecord.data)
      return true
    })
    noteMalformed(namespace, schemaMalformed)
    noteUnattributed(namespace, unattributed)
    return { byExecution, complete: walk.complete }
  }

  const attemptsJoin = joinByExecution(
    'execution-attempts',
    ExecutionAttemptSchema,
    (attempt) => attempt.executionId
  )
  const attemptsByExecution = attemptsJoin.byExecution
  const interactionsJoin = joinByExecution(
    'interaction-requests',
    InteractionRequestSchema,
    (request) => request.executionId
  )
  const interactionsByExecution = interactionsJoin.byExecution

  // Execution events carry their own workspace scope, so their storage and
  // effect totals do not depend on the execution record still being retained.
  const eventsByExecution = new Map<string, z.output<typeof ExecutionEventSchema>[]>()
  const scopedEvents: z.output<typeof ExecutionEventSchema>[] = []
  let eventSchemaMalformed = 0
  const eventsWalk = walkNamespace('execution-events', (record) => {
    const parsedRecord = ExecutionEventSchema.safeParse(record.value)
    if (!parsedRecord.success) {
      eventSchemaMalformed += 1
      return false
    }
    if (parsedRecord.data.correlation.workspaceId !== parsedOptions.workspaceId) return false
    accountStorage('execution-events', record)
    scopedEvents.push(parsedRecord.data)
    const executionId = parsedRecord.data.executionId
    if (executions.has(executionId)) {
      const existing = eventsByExecution.get(executionId)
      if (existing === undefined) eventsByExecution.set(executionId, [parsedRecord.data])
      else existing.push(parsedRecord.data)
    }
    return true
  })
  noteMalformed('execution-events', eventSchemaMalformed)

  // Runtime commands carry their own workspace scope.
  const commandsByExecution = new Map<string, z.output<typeof RuntimeCommandRecordSchema>[]>()
  const scopedCommands: z.output<typeof RuntimeCommandRecordSchema>[] = []
  let commandSchemaMalformed = 0
  const commandsWalk = walkNamespace('runtime-commands', (record) => {
    const parsedRecord = RuntimeCommandRecordSchema.safeParse(record.value)
    if (!parsedRecord.success) {
      commandSchemaMalformed += 1
      return false
    }
    if (parsedRecord.data.workspaceId !== parsedOptions.workspaceId) return false
    accountStorage('runtime-commands', record)
    scopedCommands.push(parsedRecord.data)
    const executionId = parsedRecord.data.executionId
    if (executions.has(executionId)) {
      const existing = commandsByExecution.get(executionId)
      if (existing === undefined) commandsByExecution.set(executionId, [parsedRecord.data])
      else existing.push(parsedRecord.data)
    }
    return true
  })
  noteMalformed('runtime-commands', commandSchemaMalformed)

  // Current channel generations per (workspace, node): the current authority
  // for generation staleness, from the durable sequence reservations. The
  // gateway channel connection id (gwc_…) is transport-local and is never
  // joined to a command's runtimeConnectionId (rtc_…).
  const currentGenerations = new Map<string, number>()
  let channelSequenceMalformed = 0
  walkNamespace('runtime-channel-sequences', (record) => {
    const value = record.value as { identity?: unknown; next?: unknown } | null
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.identity !== 'string' ||
      typeof value.next !== 'number'
    ) {
      channelSequenceMalformed += 1
      return false
    }
    let identity: unknown
    try {
      identity = JSON.parse(value.identity)
    } catch {
      channelSequenceMalformed += 1
      return false
    }
    if (!Array.isArray(identity) || identity.length !== 5) {
      channelSequenceMalformed += 1
      return false
    }
    const [workspace, node, , , generation] = identity
    if (
      typeof workspace !== 'string' ||
      typeof node !== 'string' ||
      typeof generation !== 'number'
    ) {
      channelSequenceMalformed += 1
      return false
    }
    if (workspace !== parsedOptions.workspaceId) return false
    accountStorage('runtime-channel-sequences', record)
    const key = `${workspace}|${node}`
    const known = currentGenerations.get(key)
    if (known === undefined || generation > known) currentGenerations.set(key, generation)
    return true
  })
  noteMalformed('runtime-channel-sequences', channelSequenceMalformed)

  // Discovery projections are workspace-scoped through their record envelope.
  const sessionsById = new Map<string, z.output<typeof ExternalSessionDiscoveryReadModelSchema>>()
  let sessionModelMalformed = 0
  const sessionsWalk = walkNamespace('runtime-discovery-sessions', (record) => {
    const envelope = discoveryEnvelopeSchema.safeParse(record.value)
    if (!envelope.success) return false
    if (envelope.data.workspaceId !== parsedOptions.workspaceId) return false
    accountStorage('runtime-discovery-sessions', record)
    const model = ExternalSessionDiscoveryReadModelSchema.safeParse(
      (record.value as { model?: unknown }).model
    )
    if (!model.success) {
      sessionModelMalformed += 1
      return true
    }
    sessionsById.set(model.data.externalSessionId, model.data)
    return true
  })
  noteMalformed('runtime-discovery-sessions', sessionModelMalformed)
  walkNamespace('runtime-discovery-connections', (record) => {
    const envelope = discoveryEnvelopeSchema.safeParse(record.value)
    if (!envelope.success) return false
    if (envelope.data.workspaceId !== parsedOptions.workspaceId) return false
    accountStorage('runtime-discovery-connections', record)
    return true
  })

  // Execution plans are workspace-scoped through their correlation; storage
  // accounting validates the scope fields only and never plan content.
  let planScopeMalformed = 0
  walkNamespace('execution-plans', (record) => {
    const scope = planScopeSchema.safeParse(record.value)
    if (!scope.success) {
      planScopeMalformed += 1
      return false
    }
    if (scope.data.correlation.workspaceId !== parsedOptions.workspaceId) return false
    accountStorage('execution-plans', record)
    return true
  })
  noteMalformed('execution-plans', planScopeMalformed)

  // Usage ledger records are workspace-scoped through their own fields.
  const windowEntries: z.output<typeof UsageLedgerEntrySchema>[] = []
  let usageEntryMalformed = 0
  walkNamespace('usage-ledger-entries', (record) => {
    const parsedRecord = UsageLedgerEntrySchema.safeParse(record.value)
    if (!parsedRecord.success) {
      usageEntryMalformed += 1
      return false
    }
    if (parsedRecord.data.workspaceId !== parsedOptions.workspaceId) return false
    accountStorage('usage-ledger-entries', record)
    const recordedAt = parseMs(parsedRecord.data.recordedAt)
    if (recordedAt !== null && recordedAt >= sinceMs) windowEntries.push(parsedRecord.data)
    return true
  })
  noteMalformed('usage-ledger-entries', usageEntryMalformed)

  const budgets: z.output<typeof DurableUsageBudgetSchema>[] = []
  let budgetMalformed = 0
  walkNamespace('usage-budgets', (record) => {
    const parsedRecord = DurableUsageBudgetSchema.safeParse(record.value)
    if (!parsedRecord.success) {
      budgetMalformed += 1
      return false
    }
    if (parsedRecord.data.workspaceId !== parsedOptions.workspaceId) return false
    accountStorage('usage-budgets', record)
    budgets.push(parsedRecord.data)
    return true
  })
  noteMalformed('usage-budgets', budgetMalformed)

  let usageEffectMalformed = 0
  walkNamespace('usage-effects', (record) => {
    const scope = usageScopeSchema.safeParse(record.value)
    if (!scope.success) {
      usageEffectMalformed += 1
      return false
    }
    if (scope.data.workspaceId !== parsedOptions.workspaceId) return false
    accountStorage('usage-effects', record)
    return true
  })
  noteMalformed('usage-effects', usageEffectMalformed)

  let usageSequenceMalformed = 0
  walkNamespace('usage-entry-sequences', (record) => {
    const scope = usageScopeSchema.safeParse(record.value)
    if (!scope.success) {
      usageSequenceMalformed += 1
      return false
    }
    if (scope.data.workspaceId !== parsedOptions.workspaceId) return false
    accountStorage('usage-entry-sequences', record)
    return true
  })
  noteMalformed('usage-entry-sequences', usageSequenceMalformed)

  const availabilityOf = (complete: boolean): OperationsMeasurementAvailability =>
    complete ? 'resolved' : 'scan_incomplete'

  // ---- Latency, age and usage measurement over the scoped records ----

  const dispatchLatencies: number[] = []
  const waitingLatencies: number[] = []
  let waitingExpiredCount = 0
  for (const command of scopedCommands) {
    const dispatchLatency = deltaMs(command.issuedAt, command.firstDispatchedAt)
    if (dispatchLatency !== null) dispatchLatencies.push(dispatchLatency)
    if (command.status === 'queued') {
      const wait = ageMs(command.issuedAt, nowMs)
      if (wait !== null) waitingLatencies.push(wait)
      const expiry = parseMs(command.expiresAt)
      if (expiry !== null && expiry < nowMs) waitingExpiredCount += 1
    }
  }

  const respondedLatencies: number[] = []
  const waitingHumanLatencies: number[] = []
  let expiredInteractions = 0
  let cancelledInteractions = 0
  for (const requests of interactionsByExecution.values()) {
    for (const request of requests) {
      if (request.state === 'responded') {
        const latency = deltaMs(request.requestedAt, request.resolvedAt)
        if (latency !== null) respondedLatencies.push(latency)
      } else if (request.state === 'pending') {
        const waiting = ageMs(request.requestedAt, nowMs)
        if (waiting !== null) waitingHumanLatencies.push(waiting)
      } else if (request.state === 'expired') expiredInteractions += 1
      else cancelledInteractions += 1
    }
  }

  const retryGaps: number[] = []
  const currentRetryAges: number[] = []
  let retriedExecutions = 0
  for (const execution of executions.values()) {
    if (execution.attemptCount >= 2) retriedExecutions += 1
    const attempts = (attemptsByExecution.get(execution.executionId) ?? []).toSorted(
      (left, right) => left.sequence - right.sequence
    )
    for (let index = 1; index < attempts.length; index += 1) {
      const previous = attempts.at(index - 1)
      const current = attempts.at(index)
      if (previous === undefined || current === undefined) continue
      const gap = deltaMs(previous.terminalAt, current.queuedAt ?? current.acceptedAt)
      if (gap !== null) retryGaps.push(gap)
    }
    for (const attempt of attempts) {
      if (attempt.sequence < 2 || isTerminalState(attempt.state)) continue
      const age = ageMs(attempt.queuedAt ?? attempt.acceptedAt, nowMs)
      if (age !== null) currentRetryAges.push(age)
    }
  }

  const nonTerminalReconciliationAges: number[] = []
  let awaitingReconciliation = 0
  let oldestReconciliationMs: number | null = null
  for (const execution of executions.values()) {
    if (isTerminalState(execution.state)) continue
    const observed = ageMs(execution.updatedAt, nowMs)
    if (observed !== null) nonTerminalReconciliationAges.push(observed)
    const requiredAt =
      execution.reconciliationRequiredAt ??
      (execution.state === 'reconciliation_required' ? execution.updatedAt : undefined)
    if (requiredAt === undefined) continue
    awaitingReconciliation += 1
    const age = ageMs(requiredAt, nowMs)
    if (age !== null && (oldestReconciliationMs === null || age > oldestReconciliationMs))
      oldestReconciliationMs = age
  }

  // Usage: windowed entry aggregates plus point-in-time budget totals. The
  // budget math mirrors `calculateTotals` in usage-ledger/durable.ts: spent is
  // charged microunits, reserved is the open remainder of each reservation.
  let usageUnsafe = false
  const unitTotals = new Map<string, number>(BY_UNIT.map((unit) => [unit, 0]))
  const costByCurrency = new Map<string, { cost: number; exact: number; inexact: number }>()
  const kindTotals = new Map<string, { count: number; byCurrency: Map<string, number> }>()
  for (const entry of windowEntries) {
    const unitTotal = addSafe(unitTotals.get(entry.quantity.unit) ?? 0, entry.quantity.value)
    if (unitTotal.unsafe) usageUnsafe = true
    unitTotals.set(entry.quantity.unit, unitTotal.value)

    const currency = costByCurrency.get(entry.currency) ?? { cost: 0, exact: 0, inexact: 0 }
    const cost = addSafe(currency.cost, entry.costMicrounits)
    if (cost.unsafe) usageUnsafe = true
    currency.cost = cost.value
    const exactnessKey = entry.costExact ? 'exact' : 'inexact'
    const exactness = addSafe(currency[exactnessKey], entry.costMicrounits)
    if (exactness.unsafe) usageUnsafe = true
    currency[exactnessKey] = exactness.value
    costByCurrency.set(entry.currency, currency)

    const kind = kindTotals.get(entry.kind) ?? { count: 0, byCurrency: new Map<string, number>() }
    kind.count += 1
    // Costs stay separated per currency inside every derived total: summing
    // USD and EUR microunits together would be a meaningless number.
    const kindCurrency = addSafe(kind.byCurrency.get(entry.currency) ?? 0, entry.costMicrounits)
    if (kindCurrency.unsafe) usageUnsafe = true
    kind.byCurrency.set(entry.currency, kindCurrency.value)
    kindTotals.set(entry.kind, kind)
  }

  let budgetUnsafe = false
  const budgetByCurrency = new Map<string, { spent: number; reserved: number }>()
  let openBudgets = 0
  let settledBudgets = 0
  for (const budget of budgets) {
    if (budget.status === 'settled') settledBudgets += 1
    else openBudgets += 1
    let spent = 0
    let reserved = 0
    for (const reservation of budget.reservations) {
      const nextSpent = addSafe(spent, reservation.chargedMicrounits)
      if (nextSpent.unsafe) budgetUnsafe = true
      spent = nextSpent.value
      if (reservation.status === 'open') {
        const nextReserved = addSafe(
          reserved,
          reservation.maximumMicrounits - reservation.chargedMicrounits
        )
        if (nextReserved.unsafe) budgetUnsafe = true
        reserved = nextReserved.value
      }
    }
    const currency = budgetByCurrency.get(budget.currency) ?? { spent: 0, reserved: 0 }
    const spentTotal = addSafe(currency.spent, spent)
    if (spentTotal.unsafe) budgetUnsafe = true
    currency.spent = spentTotal.value
    const reservedTotal = addSafe(currency.reserved, reserved)
    if (reservedTotal.unsafe) budgetUnsafe = true
    currency.reserved = reservedTotal.value
    budgetByCurrency.set(budget.currency, currency)
  }

  // ---- Active objects ----

  const countByState = <T>(
    records: Iterable<T>,
    stateOf: (record: T) => string,
    active: (state: string) => boolean
  ): { active: number; byState: Record<string, number> } => {
    const byState = new Map<string, number>()
    let activeCount = 0
    for (const record of records) {
      const state = stateOf(record)
      byState.set(state, (byState.get(state) ?? 0) + 1)
      if (active(state)) activeCount += 1
    }
    return { active: activeCount, byState: sortedRecord(byState) }
  }

  const executionsCounts = countByState(
    executions.values(),
    (execution) => execution.state,
    (state) => !isTerminalState(state)
  )
  const jobsCounts = countByState(
    scopedCommands,
    (command) => command.status,
    (status) => activeJobStatuses.has(status)
  )
  const attemptsCounts = countByState(
    [...attemptsByExecution.values()].flat(),
    (attempt) => attempt.state,
    (state) => !isTerminalState(state)
  )
  const sessionsCounts = countByState(
    sessionsById.values(),
    (session) => session.state,
    (state) => state === 'active'
  )
  const approvalsCounts = countByState(
    [...interactionsByExecution.values()].flat(),
    (request) => request.state,
    (state) => state === 'pending'
  )
  let activeEffects = 0
  const effectsByPublication = new Map<string, number>()
  for (const event of scopedEvents) {
    if (event.archivedAt !== undefined) continue
    const status = event.publication.status
    effectsByPublication.set(status, (effectsByPublication.get(status) ?? 0) + 1)
    if (status !== 'published') activeEffects += 1
  }
  const effectsCounts = { active: activeEffects, byState: sortedRecord(effectsByPublication) }

  // ---- Per-execution correlation (bounded listing, deterministic order) ----

  const orderedExecutions = [...executions.values()].toSorted((left, right) =>
    compareCodePointOrder(left.executionId, right.executionId)
  )

  // The current-generation source must be clean before a non-stale verdict is
  // asserted from it; a truncated or corrupted reservation walk can hide the
  // generation that would have proven staleness.
  const generationSourceClean = namespaceClean('runtime-channel-sequences')

  const correlation: z.output<typeof CorrelationViewSchema>[] = []
  for (const execution of orderedExecutions) {
    if (correlation.length >= parsedOptions.limit) break
    const terminal = isTerminalState(execution.state)

    const executionCommands = commandsByExecution.get(execution.executionId) ?? []
    let activeJobs = 0
    let queuedJobs = 0
    let settledJobs = 0
    let anyStaleGeneration = false
    let anyUnknownGeneration = false
    let oldestActiveAgeMs: number | null = null
    for (const command of executionCommands) {
      if (settledJobStatuses.has(command.status)) {
        settledJobs += 1
        continue
      }
      if (command.status === 'queued') queuedJobs += 1
      activeJobs += 1
      const age = ageMs(command.updatedAt, nowMs)
      if (age !== null && (oldestActiveAgeMs === null || age > oldestActiveAgeMs))
        oldestActiveAgeMs = age
      if (command.lastChannelGeneration === undefined) anyUnknownGeneration = true
      else {
        const known = currentGenerations.get(`${command.workspaceId}|${command.nodeId}`)
        if (known === undefined) anyUnknownGeneration = true
        else if (command.lastChannelGeneration < known) anyStaleGeneration = true
      }
    }
    // A positive stale verdict survives a damaged generation source (a walked
    // reservation already proves the lag); every other verdict collapses to
    // unknown when the source is not clean.
    const staleGeneration =
      activeJobs === 0
        ? null
        : anyStaleGeneration
          ? true
          : anyUnknownGeneration || !generationSourceClean
            ? null
            : false

    const executionAttempts = attemptsByExecution.get(execution.executionId) ?? []
    const latestStored =
      execution.latestAttemptId === undefined
        ? undefined
        : executionAttempts.find((candidate) => candidate.attemptId === execution.latestAttemptId)
    let attemptView: z.output<typeof AttemptCorrelationViewSchema>
    if (execution.latestAttemptId === undefined && execution.attemptCount === 0) {
      attemptView = {
        availability: 'not_established',
        attemptId: null,
        sequence: null,
        state: null,
        updatedAt: null,
        ageMs: null,
        retryCount: 0,
      }
    } else if (!attemptsJoin.complete) {
      attemptView = {
        availability: 'scan_incomplete',
        attemptId: execution.latestAttemptId ?? null,
        sequence: null,
        state: null,
        updatedAt: null,
        ageMs: null,
        retryCount: Math.max(0, execution.attemptCount - 1),
      }
    } else if (latestStored === undefined) {
      attemptView = {
        availability: 'missing',
        attemptId: execution.latestAttemptId ?? null,
        sequence: null,
        state: null,
        updatedAt: null,
        ageMs: null,
        retryCount: Math.max(0, execution.attemptCount - 1),
      }
    } else {
      attemptView = {
        availability: 'resolved',
        attemptId: latestStored.attemptId,
        sequence: latestStored.sequence,
        state: latestStored.state,
        updatedAt: latestStored.updatedAt,
        ageMs: ageMs(latestStored.updatedAt, nowMs),
        retryCount: Math.max(0, execution.attemptCount - 1),
      }
    }

    const externalSessionId = latestStored?.runtime?.externalSessionId
    let sessionView: z.output<typeof SessionCorrelationViewSchema>
    if (!sessionsWalk.complete) {
      sessionView = {
        availability: 'scan_incomplete',
        externalSessionId: externalSessionId ?? null,
        state: null,
        recoverable: null,
        observedAt: null,
      }
    } else if (externalSessionId === undefined) {
      sessionView = {
        availability: 'not_established',
        externalSessionId: null,
        state: null,
        recoverable: null,
        observedAt: null,
      }
    } else {
      const projection = sessionsById.get(externalSessionId)
      sessionView =
        projection === undefined
          ? {
              availability: 'missing',
              externalSessionId,
              state: null,
              recoverable: null,
              observedAt: null,
            }
          : {
              availability: 'resolved',
              externalSessionId,
              state: projection.state,
              recoverable: projection.recoverable,
              observedAt: projection.freshness.observedAt,
            }
    }

    const executionInteractions = interactionsByExecution.get(execution.executionId) ?? []
    let pendingApprovals = 0
    let respondedApprovals = 0
    let expiredApprovals = 0
    let cancelledApprovals = 0
    let oldestPendingApprovalMs: number | null = null
    for (const request of executionInteractions) {
      if (request.state === 'pending') {
        pendingApprovals += 1
        const age = ageMs(request.requestedAt, nowMs)
        if (age !== null && (oldestPendingApprovalMs === null || age > oldestPendingApprovalMs))
          oldestPendingApprovalMs = age
      } else if (request.state === 'responded') respondedApprovals += 1
      else if (request.state === 'expired') expiredApprovals += 1
      else cancelledApprovals += 1
    }

    const executionEvents = eventsByExecution.get(execution.executionId) ?? []
    let pendingEffects = 0
    let publishedEffects = 0
    let failedEffects = 0
    let quarantinedEffects = 0
    let oldestPendingEffectMs: number | null = null
    for (const event of executionEvents) {
      if (event.archivedAt !== undefined) continue
      if (event.publication.status === 'published') publishedEffects += 1
      else if (event.publication.status === 'failed') failedEffects += 1
      else if (event.publication.status === 'quarantined') quarantinedEffects += 1
      else {
        pendingEffects += 1
        const age = ageMs(event.occurredAt, nowMs)
        if (age !== null && (oldestPendingEffectMs === null || age > oldestPendingEffectMs))
          oldestPendingEffectMs = age
      }
    }

    const attemptArtifactRef = latestStored?.terminalResultRef
    const commandArtifactRef = executionCommands.find(
      (command) => command.resultReference !== undefined
    )?.resultReference
    const artifactId =
      execution.terminalResultRef ?? attemptArtifactRef ?? commandArtifactRef ?? null
    const artifactSource =
      execution.terminalResultRef !== undefined
        ? 'execution'
        : attemptArtifactRef !== undefined
          ? 'attempt'
          : commandArtifactRef !== undefined
            ? 'command'
            : null
    const artifactWalksComplete =
      executionsWalk.complete && attemptsJoin.complete && commandsWalk.complete

    correlation.push({
      executionId: execution.executionId,
      state: execution.state,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      reconciliationAgeMs: terminal ? null : ageMs(execution.updatedAt, nowMs),
      conversation: {
        availability: executionsWalk.complete ? 'reference_only' : 'scan_incomplete',
        authority: 'agent_hq_reference',
        taskId: execution.correlation.taskId,
        agentId: execution.correlation.agentId,
        requestId: execution.correlation.requestId,
      },
      job: {
        availability:
          executionCommands.length === 0 && commandsWalk.complete
            ? 'unreferenced'
            : availabilityOf(commandsWalk.complete),
        active: activeJobs,
        queued: queuedJobs,
        settled: settledJobs,
        staleGeneration,
        generationScanComplete: generationSourceClean,
        oldestActiveAgeMs,
      },
      attempt: attemptView,
      session: sessionView,
      approval: {
        availability: interactionsJoin.complete ? 'resolved' : 'scan_incomplete',
        pending: pendingApprovals,
        responded: respondedApprovals,
        expired: expiredApprovals,
        cancelled: cancelledApprovals,
        oldestPendingAgeMs: oldestPendingApprovalMs,
      },
      effect: {
        availability: availabilityOf(eventsWalk.complete),
        pending: pendingEffects,
        published: publishedEffects,
        failed: failedEffects,
        quarantined: quarantinedEffects,
        oldestPendingAgeMs: oldestPendingEffectMs,
      },
      artifact: {
        availability:
          artifactId === null
            ? 'unreferenced'
            : artifactWalksComplete
              ? 'reference_only'
              : 'scan_incomplete',
        authority: 'product_artifact_reference',
        artifactId,
        source: artifactSource,
      },
    })
  }

  // ---- Storage totals, growth baseline and coverage ----

  // Join-scoped namespaces only account rows anchored to an in-scope
  // execution, so their bytes are partial whenever the execution walk itself
  // was truncated; every other namespace is scoped by its own workspace
  // field. Unattributed rows are an attribution question, not a parse/scan
  // one, and stay reported under `summary.unattributedRecords`.
  const joinScopedNamespaces = new Set(['execution-attempts', 'interaction-requests'])
  const executionsClean = namespaceClean('executions')
  const rowComplete = (namespace: string): boolean =>
    namespaceClean(namespace) && (!joinScopedNamespaces.has(namespace) || executionsClean)

  const namespaceRows = [...storage.entries()].map(([namespace, totals]) => {
    const complete = rowComplete(namespace)
    const baselineRow = baseline?.bytesByNamespace.get(namespace)
    // True growth is a signed snapshot delta against a prior complete report
    // of the same workspace; it is null (unavailable), never estimated, until
    // such a baseline exists and both sides of the delta are complete.
    const growthBytes =
      baseline?.complete === true && baselineRow !== undefined && baselineRow.complete && complete
        ? totals.bytes - baselineRow.bytes
        : null
    return {
      namespace,
      records: totals.records,
      bytes: totals.bytes,
      bytesRewrittenInWindow: totals.bytesRewrittenInWindow,
      complete,
      growthBytes,
    }
  })
  const storageComplete = namespaceRows.every((row) => row.complete)
  const baselineAvailability =
    baseline === undefined ? 'absent' : baseline.complete ? 'complete' : 'incomplete'
  const baselineGeneratedAt = baseline?.generatedAt ?? null
  const storageTotals = namespaceRows.reduce(
    (totals, row) => ({
      records: totals.records + row.records,
      bytes: totals.bytes + row.bytes,
      bytesRewrittenInWindow: totals.bytesRewrittenInWindow + row.bytesRewrittenInWindow,
      growthBytes:
        totals.growthBytes === null || row.growthBytes === null
          ? null
          : totals.growthBytes + row.growthBytes,
    }),
    { records: 0, bytes: 0, bytesRewrittenInWindow: 0, growthBytes: 0 as number | null }
  )
  const measuredNamespaces = new Set<string>(
    operationsStorageNamespaces.filter((namespace) => namespace !== 'total')
  )
  const unmeasuredNamespaces = reader
    .namespaces()
    .filter((namespace) => !measuredNamespaces.has(namespace))
    .toSorted((left, right) => compareCodePointOrder(left, right))

  // ---- Source quality: one place every dependent consumer consults ----

  const scansComplete = incompleteScans.length === 0
  const recordsClean = malformedRecords.size === 0
  const totalsSafe = !usageUnsafe && !budgetUnsafe
  const summaryComplete = scansComplete && recordsClean && totalsSafe
  const incompleteSources = [
    ...new Set([
      ...incompleteScans.map((scan) => scan.namespace),
      ...malformedRecords.keys(),
      ...(usageUnsafe ? ['usage-ledger-entries'] : []),
      ...(budgetUnsafe ? ['usage-budgets'] : []),
    ]),
  ].toSorted((left, right) => compareCodePointOrder(left, right))

  const commandsClean = namespaceClean('runtime-commands')
  const attemptsClean = namespaceClean('execution-attempts') && executionsClean
  const interactionsClean = namespaceClean('interaction-requests') && executionsClean
  const eventsClean = namespaceClean('execution-events')
  const sessionsClean = namespaceClean('runtime-discovery-sessions')
  const usageEntriesClean = namespaceClean('usage-ledger-entries')
  const budgetsClean = namespaceClean('usage-budgets')

  const queueLatencyComplete = commandsClean
  const humanLatencyComplete = executionsClean && interactionsClean
  const retryAgeComplete = executionsClean && attemptsClean
  const reconciliationComplete = executionsClean
  const usageComplete = usageEntriesClean && budgetsClean && !usageUnsafe && !budgetUnsafe
  const activeObjectsComplete =
    executionsClean &&
    attemptsClean &&
    commandsClean &&
    sessionsClean &&
    interactionsClean &&
    eventsClean

  // ---- Operating cost ----

  // Usage availability names the budget source's own quality: a partial or
  // overflowed rollup is marked, never dressed up as `measured`.
  const usageAvailability =
    budgets.length === 0
      ? 'no_budget_records'
      : budgetUnsafe
        ? 'unsafe_totals'
        : !budgetsClean
          ? 'source_partial'
          : 'measured'
  const storageRate = parsedOptions.storageUsdPerGiBMonth ?? null
  const storageCostMicrounits =
    storageRate === null
      ? null
      : Math.round((storageTotals.bytes / BYTES_PER_GIB) * storageRate * MICROUTENTS_PER_USD)
  const storageCostAvailability =
    storageRate === null ? 'rate_not_configured' : storageComplete ? 'priced' : 'source_partial'
  const currencies = sortedKeys(budgetByCurrency).map(([currency]) => currency)
  const usdBudget = budgetByCurrency.get('USD')
  let totalMicrounits: number | null = null
  let totalAvailability:
    | 'measured'
    | 'storage_rate_not_configured'
    | 'usage_currency_unsupported'
    | 'usage_unavailable'
    | 'usage_source_partial'
    | 'usage_unsafe_totals'
    | 'storage_source_partial'
  if (usageAvailability !== 'measured') {
    // Partial or overflowed budgets never combine into an ordinary total.
    totalAvailability =
      usageAvailability === 'no_budget_records'
        ? 'usage_unavailable'
        : usageAvailability === 'unsafe_totals'
          ? 'usage_unsafe_totals'
          : 'usage_source_partial'
  } else if (currencies.length !== 1 || usdBudget === undefined) {
    totalAvailability = 'usage_currency_unsupported'
  } else if (storageCostMicrounits === null) {
    totalAvailability = 'storage_rate_not_configured'
  } else if (!storageComplete) {
    totalAvailability = 'storage_source_partial'
  } else {
    const summed = addSafe(usdBudget.spent, storageCostMicrounits)
    if (summed.unsafe) totalAvailability = 'usage_unsafe_totals'
    else {
      totalMicrounits = summed.value
      totalAvailability = 'measured'
    }
  }

  // ---- Telemetry points: cataloged names, bounded labels, no identifiers ----

  const telemetry: OperationsMetricPoint[] = []
  const pushStats = (
    name: string,
    stats: z.output<typeof LatencyStatsSchema>,
    labels: Record<string, string>
  ) => {
    if (
      stats.samples === 0 ||
      stats.minMs === null ||
      stats.medianMs === null ||
      stats.maxMs === null
    )
      return
    telemetry.push(
      { name, value: stats.minMs, labels: { ...labels, statistic: 'min' } },
      { name, value: stats.medianMs, labels: { ...labels, statistic: 'median' } },
      { name, value: stats.maxMs, labels: { ...labels, statistic: 'max' } }
    )
  }
  // Points derived from a degraded source are suppressed rather than emitted
  // as ordinary observations: a partial queue latency or overflowed cost must
  // not look identical to a trustworthy one.
  if (queueLatencyComplete) {
    pushStats(operationsMetricNames.queueLatency, summarize(dispatchLatencies), {
      stage: 'dispatch',
    })
    pushStats(operationsMetricNames.queueLatency, summarize(waitingLatencies), { stage: 'wait' })
  }
  if (humanLatencyComplete) {
    pushStats(operationsMetricNames.humanLatency, summarize(respondedLatencies), {
      outcome: 'responded',
    })
    pushStats(operationsMetricNames.humanLatency, summarize(waitingHumanLatencies), {
      outcome: 'waiting',
    })
  }
  if (retryAgeComplete) {
    pushStats(operationsMetricNames.retryAge, summarize(retryGaps), { kind: 'gap' })
    pushStats(operationsMetricNames.retryAge, summarize(currentRetryAges), { kind: 'current' })
  }
  if (reconciliationComplete)
    pushStats(operationsMetricNames.reconciliationAge, summarize(nonTerminalReconciliationAges), {})
  const usdWindowCost = costByCurrency.get('USD')
  if (usageEntriesClean && !usageUnsafe && usdWindowCost !== undefined) {
    telemetry.push(
      {
        name: operationsMetricNames.usageCostUsd,
        value: usdWindowCost.exact / MICROUTENTS_PER_USD,
        labels: { exactness: 'exact' },
      },
      {
        name: operationsMetricNames.usageCostUsd,
        value: usdWindowCost.inexact / MICROUTENTS_PER_USD,
        labels: { exactness: 'inexact' },
      }
    )
  }
  for (const row of namespaceRows) {
    if (!row.complete) continue
    telemetry.push(
      {
        name: operationsMetricNames.storageRetainedBytes,
        value: row.bytes,
        labels: { namespace: row.namespace },
      },
      {
        name: operationsMetricNames.storageRewrittenBytes,
        value: row.bytesRewrittenInWindow,
        labels: { namespace: row.namespace },
      }
    )
    if (row.growthBytes !== null)
      telemetry.push({
        name: operationsMetricNames.storageGrowthBytes,
        value: row.growthBytes,
        labels: { namespace: row.namespace },
      })
  }
  if (storageComplete) {
    telemetry.push(
      {
        name: operationsMetricNames.storageRetainedBytes,
        value: storageTotals.bytes,
        labels: { namespace: 'total' },
      },
      {
        name: operationsMetricNames.storageRewrittenBytes,
        value: storageTotals.bytesRewrittenInWindow,
        labels: { namespace: 'total' },
      }
    )
    if (storageTotals.growthBytes !== null)
      telemetry.push({
        name: operationsMetricNames.storageGrowthBytes,
        value: storageTotals.growthBytes,
        labels: { namespace: 'total' },
      })
  }
  for (const [objectKind, counts, complete] of [
    ['execution', executionsCounts, executionsClean],
    ['job', jobsCounts, commandsClean],
    ['attempt', attemptsCounts, attemptsClean],
    ['session', sessionsCounts, sessionsClean],
    ['approval', approvalsCounts, interactionsClean],
    ['effect', effectsCounts, eventsClean],
  ] as const) {
    if (!complete) continue
    telemetry.push({
      name: operationsMetricNames.activeObjectCount,
      value: counts.active,
      labels: { object_kind: objectKind },
    })
  }
  if (storageCostMicrounits !== null && storageCostAvailability === 'priced') {
    telemetry.push({
      name: operationsMetricNames.operatingCostUsd,
      value: storageCostMicrounits / MICROUTENTS_PER_USD,
      labels: { component: 'storage' },
    })
  }
  if (totalMicrounits !== null && totalAvailability === 'measured') {
    telemetry.push({
      name: operationsMetricNames.operatingCostUsd,
      value: totalMicrounits / MICROUTENTS_PER_USD,
      labels: { component: 'total' },
    })
  }

  const budgetCurrencyTotals = () =>
    Object.fromEntries(
      sortedKeys(budgetByCurrency).map(([currency, totals]) => [
        currency,
        { spentMicrounits: totals.spent, reservedMicrounits: totals.reserved },
      ])
    )

  const report: OperationsMeasurementReport = {
    schemaVersion: 1,
    command: 'local.operator.telemetry.operations',
    readOnly: true,
    generatedAt: new Date(nowMs).toISOString(),
    scope: { workspaceId: parsedOptions.workspaceId },
    thresholds: {
      windowSeconds: parsedOptions.windowSeconds,
      windowSince: new Date(sinceMs).toISOString(),
      limit: parsedOptions.limit,
      maxScanMatches: parsedOptions.maxScanMatches,
      maxScanRows: MAX_SCAN_ROWS,
      scanPageSize: SCAN_PAGE_SIZE,
      storageUsdPerGiBMonth: storageRate,
    },
    summary: {
      complete: summaryComplete,
      sourceQuality: { scansComplete, recordsClean, totalsSafe },
      incompleteSources,
      executions: executions.size,
      outOfScopeExecutions: outOfScopeExecutionRecords,
      correlationsListed: correlation.length,
      correlationsUnlisted: Math.max(0, executions.size - correlation.length),
      malformedRecords: Object.fromEntries(sortedKeys(malformedRecords)),
      unattributedRecords: Object.fromEntries(sortedKeys(unattributedRecords)),
      incompleteScans: incompleteScans.toSorted((left, right) =>
        compareCodePointOrder(left.namespace, right.namespace)
      ),
    },
    correlation,
    measurements: {
      queueLatency: {
        complete: queueLatencyComplete,
        dispatch: summarize(dispatchLatencies),
        waiting: summarize(waitingLatencies),
        waitingExpiredCount,
      },
      humanLatency: {
        complete: humanLatencyComplete,
        responded: summarize(respondedLatencies),
        waiting: summarize(waitingHumanLatencies),
        expiredCount: expiredInteractions,
        cancelledCount: cancelledInteractions,
      },
      retryAge: {
        complete: retryAgeComplete,
        retriedExecutions,
        gap: summarize(retryGaps),
        current: summarize(currentRetryAges),
      },
      reconciliationAge: {
        complete: reconciliationComplete,
        nonTerminal: summarize(nonTerminalReconciliationAges),
        awaitingReconciliation: {
          executions: awaitingReconciliation,
          oldestMs: oldestReconciliationMs,
        },
      },
      usage: {
        complete: usageComplete,
        windowEntryCount: windowEntries.length,
        byUnit: {
          tokens: unitTotals.get('tokens') ?? 0,
          calls: unitTotals.get('calls') ?? 0,
          milliseconds: unitTotals.get('milliseconds') ?? 0,
          bytes: unitTotals.get('bytes') ?? 0,
          microunits: unitTotals.get('microunits') ?? 0,
        },
        byKind: Object.fromEntries(
          sortedKeys(kindTotals).map(([kind, totals]) => [
            kind,
            { count: totals.count, byCurrency: Object.fromEntries(sortedKeys(totals.byCurrency)) },
          ])
        ),
        byCurrency: Object.fromEntries(
          sortedKeys(costByCurrency).map(([currency, totals]) => [
            currency,
            {
              costMicrounits: totals.cost,
              exactCostMicrounits: totals.exact,
              inexactCostMicrounits: totals.inexact,
            },
          ])
        ),
        unsafeTotals: usageUnsafe,
        budgets: {
          records: budgets.length,
          open: openBudgets,
          settled: settledBudgets,
          byCurrency: budgetCurrencyTotals(),
          unsafeTotals: budgetUnsafe,
        },
      },
      storage: {
        namespaces: namespaceRows,
        totals: storageTotals,
        complete: storageComplete,
        baseline: {
          availability: baselineAvailability,
          generatedAt: baselineGeneratedAt,
        },
        unmeasuredNamespaces,
      },
      activeObjects: {
        complete: activeObjectsComplete,
        executions: executionsCounts,
        jobs: jobsCounts,
        attempts: attemptsCounts,
        sessions: sessionsCounts,
        approvals: approvalsCounts,
        effects: effectsCounts,
      },
      operatingCost: {
        usage: {
          availability: usageAvailability,
          byCurrency: budgetCurrencyTotals(),
        },
        storage: {
          bytes: storageTotals.bytes,
          rateUsdPerGiBMonth: storageRate,
          costMicrounits: storageCostMicrounits,
          availability: storageCostAvailability,
        },
        totalMicrounits,
        totalAvailability,
      },
    },
    telemetry,
  }
  return OperationsMeasurementReportSchema.parse(report)
}
