import {
  ExternalSessionDiscoveryReadModelSchema,
  IdentifierSchemas,
  RuntimeConnectionDiscoveryReadModelSchema,
  compareCodePointOrder,
} from '@control-plane/contracts'
import {
  ExecutionAttemptSchema,
  ExecutionSchema,
  InteractionRequestSchema,
  RuntimeCommandRecordSchema,
} from '@control-plane/domain'
import { ExecutionEventSchema } from '@control-plane/events'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdtemp } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { z, type ZodType } from 'zod'

/**
 * Read-only stuck-job inspection for the Local/Hosted Simple SQLite store.
 *
 * The inspection correlates already-persisted execution, runtime-command (job),
 * attempt, external-session, interaction (approval/input) and execution-event
 * (effect) records into one bounded telemetry view. It never mutates: the CLI
 * opens the database with SQLite `readOnly`, and every statement issued here is
 * a parameterized `SELECT`. Output is allow-listed metadata only — identifiers,
 * states, timestamps, counts, ages and booleans. Record payloads, prompts,
 * response values, plan definitions and any credential material are never read
 * into the report, and no provider cost is inferred from usage data.
 *
 * Every correlated dimension carries an explicit availability state. An
 * inspection never answers "unknown" with a blank field.
 */

/** Records fetched per continuation page while walking a namespace. */
export const SCAN_PAGE_SIZE = 512
/** Raw rows examined per namespace before the scan reports itself incomplete. */
export const MAX_SCAN_ROWS = 100_000
/**
 * In-scope records retained per namespace. The budget counts only records that
 * belong to the selected workspace (and project), so unrelated workspaces can
 * never push a selected workspace out of the scan; the walk continues through
 * them until the namespace is exhausted.
 */
export const MAX_SCAN_MATCHES = 10_000
/** Listed stuck executions per report. */
export const DEFAULT_RESULT_LIMIT = 20
export const MAX_RESULT_LIMIT = 100
/** Unchanged-age threshold that marks candidates as stale. */
export const DEFAULT_STALE_AFTER_SECONDS = 900
export const MIN_STALE_AFTER_SECONDS = 60
export const MAX_STALE_AFTER_SECONDS = 86_400
/** Non-terminal delivery attempts before a job counts as delivery-stalled. */
export const STALLED_DELIVERY_ATTEMPTS = 3
/** Per-execution job and pending-interaction listing bounds. */
export const MAX_LISTED_JOBS = 10
export const MAX_LISTED_PENDING_INTERACTIONS = 10
/** Bound on the profile-filter unattributed execution list. */
export const MAX_LISTED_UNATTRIBUTED = 32

export const stuckReasonSchema = z.enum([
  'execution_stale',
  'reconciliation_required',
  'cancelling_stalled',
  'deadline_exceeded',
  'attempt_interrupted',
  'command_expired',
  'dispatch_stalled',
  'delivery_stalled',
  'stale_generation',
  'awaiting_human',
  'effects_pending',
])

export const availabilitySchema = z.enum([
  'resolved',
  'missing',
  'unparseable',
  'not_established',
  'reference_only',
  'unreferenced',
])

const NullableId = z.string().nullable()
const NullableState = z.string().nullable()
const NullableTimestamp = z.string().nullable()
const NullableInt = z.number().int().nullable()

export const LocalStuckJobInspectionOptionsSchema = z
  .object({
    workspaceId: IdentifierSchemas.workspaceId,
    projectId: IdentifierSchemas.projectId.optional(),
    profileId: IdentifierSchemas.profileId.optional(),
    limit: z.number().int().min(1).max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
    staleAfterSeconds: z
      .number()
      .int()
      .min(MIN_STALE_AFTER_SECONDS)
      .max(MAX_STALE_AFTER_SECONDS)
      .default(DEFAULT_STALE_AFTER_SECONDS),
    /**
     * Diagnostic bound on in-scope records retained per namespace. It only
     * moves the bound within hard limits; an exhausted budget is always
     * reported as an incomplete scan, never as an empty result.
     */
    maxScanMatches: z.number().int().min(1).max(1_000_000).default(MAX_SCAN_MATCHES),
    /** Deterministic inspection clock; defaults to wall time. */
    now: z.iso.datetime().optional(),
  })
  .strict()

export type LocalStuckJobInspectionOptions = z.input<typeof LocalStuckJobInspectionOptionsSchema>

const CommandJobViewSchema = z.object({
  commandId: z.string(),
  status: z.string(),
  deliveryAttempts: z.number().int().nonnegative(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  updatedAt: z.string(),
  ageMs: z.number().int().nonnegative(),
  expired: z.boolean(),
  /** `null` when the current channel generation is unknown. */
  staleGeneration: z.boolean().nullable(),
})

const AttemptViewSchema = z.object({
  availability: availabilitySchema,
  attemptId: NullableId,
  sequence: NullableInt,
  state: NullableState,
  updatedAt: NullableTimestamp,
  ageMs: NullableInt,
  interrupted: z.boolean(),
})

const SessionViewSchema = z.object({
  availability: availabilitySchema,
  externalSessionId: NullableId,
  state: NullableState,
  recoverable: z.boolean().nullable(),
  observedAt: NullableTimestamp,
  stale: z.boolean(),
})

const ConnectionViewSchema = z.object({
  availability: availabilitySchema,
  runtimeConnectionId: NullableId,
  status: NullableState,
  connectionStatus: NullableState,
  nodeStatus: NullableState,
  observedAt: NullableTimestamp,
  stale: z.boolean(),
})

const PendingInteractionViewSchema = z.object({
  interactionId: z.string(),
  kind: z.string(),
  state: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  pendingAgeMs: z.number().int().nonnegative(),
  pastExpiry: z.boolean(),
})

const ApprovalsViewSchema = z.object({
  availability: availabilitySchema,
  pending: z.array(PendingInteractionViewSchema).max(MAX_LISTED_PENDING_INTERACTIONS),
  unlistedPendingCount: z.number().int().nonnegative(),
  pendingCount: z.number().int().nonnegative(),
  awaitingHuman: z.boolean(),
  respondedCount: z.number().int().nonnegative(),
  resolvedTerminalCount: z.number().int().nonnegative(),
})

/**
 * Effect (execution-event) publication view. Counts cover persisted,
 * unarchived execution events in this store only: this is a backlog signal,
 * NOT complete protected-effect settlement evidence. Archived events leave the
 * window, delivery to subscribers and downstream settlement receipts live
 * outside this store, and a zero backlog therefore proves nothing about
 * whether every protected effect actually settled.
 */
const EffectsViewSchema = z.object({
  availability: availabilitySchema,
  pendingCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  quarantinedCount: z.number().int().nonnegative(),
  publishedCount: z.number().int().nonnegative(),
  oldestPendingAt: NullableTimestamp,
  oldestPendingAgeMs: NullableInt,
  publicationBacklog: z.boolean(),
})

const ProfileViewSchema = z.object({
  availability: availabilitySchema,
  reason: NullableState,
  executionPlanId: NullableId,
  profileId: NullableId,
  profileVersionId: NullableId,
})

const ExecutionViewSchema = z.object({
  executionId: z.string(),
  state: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deadlineAt: NullableTimestamp,
  /** Age of the last observed change while the execution is not terminal. */
  reconciliationAgeMs: NullableInt,
  stuckReasons: z.array(stuckReasonSchema),
  oldestEvidenceAgeMs: NullableInt,
  attempt: AttemptViewSchema,
  jobs: z.object({
    availability: availabilitySchema,
    listed: z.array(CommandJobViewSchema).max(MAX_LISTED_JOBS),
    unlistedCount: z.number().int().nonnegative(),
    settledCount: z.number().int().nonnegative(),
  }),
  session: SessionViewSchema,
  connection: ConnectionViewSchema,
  approvals: ApprovalsViewSchema,
  effects: EffectsViewSchema,
  profile: ProfileViewSchema,
})

export const StuckJobInspectionReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: z.literal('local.operator.inspection.stuck-jobs'),
    readOnly: z.literal(true),
    generatedAt: z.iso.datetime(),
    scope: z.object({
      workspaceId: z.string(),
      projectId: NullableId,
      profileId: NullableId,
    }),
    thresholds: z.object({
      staleAfterSeconds: z.number().int().positive(),
      limit: z.number().int().positive(),
      maxScanMatches: z.number().int().positive(),
      maxScanRows: z.number().int().positive(),
      scanPageSize: z.number().int().positive(),
    }),
    summary: z
      .object({
        /** False when any namespace walk stopped before exhausting the store. */
        complete: z.boolean(),
        /**
         * Totals scoped to the selected workspace (and project), before any
         * profile filtering. These describe the authorized scope as a whole.
         */
        inScope: z.object({
          executions: z.number().int().nonnegative(),
          outOfScopeExecutions: z.number().int().nonnegative(),
          stuckCandidates: z.number().int().nonnegative(),
          oldestStuckAgeMs: NullableInt,
          awaitingHumanPendingCount: z.number().int().nonnegative(),
          oldestPendingInteractionAgeMs: NullableInt,
        }),
        /**
         * Totals after profile filtering (identical to `inScope` counters when
         * no profile was selected). Only `selected` describes what the report
         * lists; workspace-wide human-wait and execution totals live in
         * `inScope` even when the selection is empty.
         */
        selected: z.object({
          stuckCandidates: z.number().int().nonnegative(),
          remainingStuckCandidates: z.number().int().nonnegative(),
          executionsListed: z.number().int().nonnegative(),
          oldestStuckAgeMs: NullableInt,
        }),
        malformedRecords: z.record(z.string(), z.number().int().nonnegative()),
        /**
         * Namespaces whose walk stopped before exhausting the store, with the
         * last examined record id and the budget that stopped it. An incomplete
         * scan means every count and candidate list in this report is a lower
         * bound — never read an empty or small result as confident.
         */
        incompleteScans: z.array(
          z.object({
            namespace: z.string(),
            reason: z.enum(['match_budget_reached', 'row_budget_reached']),
            lastSeenRecordId: z.string(),
          })
        ),
      })
      .strict(),
    executions: z.array(ExecutionViewSchema),
    profileResolution: z.object({
      filtered: z.boolean(),
      unattributedCount: z.number().int().nonnegative(),
      unattributedExecutionIds: z.array(z.string()).max(MAX_LISTED_UNATTRIBUTED),
    }),
  })
  .strict()

export type StuckJobInspectionReport = z.output<typeof StuckJobInspectionReportSchema>
export type StuckReason = z.output<typeof stuckReasonSchema>
export type Availability = z.output<typeof availabilitySchema>

/** Structural read-only view of a SQLite handle; only `SELECT` is ever issued. */
export interface ReadOnlyRecordStore {
  prepare(query: string): { all(...parameters: unknown[]): unknown[] }
}

export interface StoredRecord {
  readonly id: string
  readonly value: unknown
}

export interface RecordPage {
  readonly records: readonly StoredRecord[]
  readonly unparseableJsonCount: number
  /**
   * Id of the last record on the page, for continuation; `null` when the
   * namespace is exhausted (this page was the final one).
   */
  readonly nextAfterId: string | null
}

export interface ReadOnlyRecordReader {
  pageRecords(namespace: string, pageSize: number, afterId?: string): RecordPage
}

/**
 * Wraps a read-only SQLite handle. The statements are fixed parameterized
 * `SELECT`s; the caller is responsible for opening the database itself in
 * read-only mode (the CLI does, via `DatabaseSync(..., { readOnly: true })`).
 * Paging is keyed on the record id ordering so walkers can continue through
 * arbitrarily long namespaces instead of truncating up front.
 */
export function createSqliteRecordReader(store: ReadOnlyRecordStore): ReadOnlyRecordReader {
  const firstPage = store.prepare(
    'SELECT id, value FROM control_plane_records WHERE namespace = ? ORDER BY id LIMIT ?'
  )
  const nextPage = store.prepare(
    'SELECT id, value FROM control_plane_records WHERE namespace = ? AND id > ? ORDER BY id LIMIT ?'
  )
  return {
    pageRecords(namespace: string, pageSize: number, afterId?: string): RecordPage {
      const rows = (
        afterId === undefined
          ? firstPage.all(namespace, pageSize + 1)
          : nextPage.all(namespace, afterId, pageSize + 1)
      ) as Array<{ id?: unknown; value?: unknown }>
      const hasMore = rows.length > pageSize
      const pageRows = hasMore ? rows.slice(0, pageSize) : rows
      const records: StoredRecord[] = []
      let unparseableJsonCount = 0
      let lastId: string | null = null
      for (const row of pageRows) {
        if (typeof row?.id !== 'string') {
          unparseableJsonCount += 1
          continue
        }
        lastId = row.id
        try {
          records.push({ id: row.id, value: JSON.parse(String(row?.value)) })
        } catch {
          unparseableJsonCount += 1
        }
      }
      return {
        records,
        unparseableJsonCount,
        nextAfterId: hasMore && lastId !== null ? lastId : null,
      }
    },
  }
}

/** The subset of a SQLite handle the inspection consumes. */
export interface InspectionDatabaseHandle {
  prepare(query: string): { all(...parameters: unknown[]): unknown[] }
  close(): void
}

/** The SQLite-owned write-ahead-log sidecar path for a database file. */
const walSidecarOf = (databasePath: string) => `${databasePath}-wal`

async function probeDeferredOpen(database: DatabaseSync): Promise<void> {
  // Bun defers the SQLite open until the first statement; force it so the
  // caller sees open failures here rather than mid-walk.
  database.prepare('SELECT count(*) AS n FROM sqlite_master').get()
}

/**
 * Opens an operator database for inspection without ever opening it writable.
 *
 * The primary path is a driver-level read-only open (`readOnly: true`) whose
 * deferred open is probed immediately. That path cannot serve a database whose
 * header is in WAL mode but whose `-wal`/`-shm` sidecars are already gone —
 * the exact state after a graceful launcher stop, where the final connection
 * checkpoints and removes the sidecars. For that state the command falls back
 * to a verified byte-copy of the database (and any `-wal` still present) into
 * a private 0700 temporary directory; the copy is opened with SQLite
 * `query_only` enforced before any other statement, and the operator database
 * itself is only ever read as bytes and never opened writable by SQLite.
 */
export async function openReadOnlyInspectionDatabase(
  databasePath: string
): Promise<InspectionDatabaseHandle> {
  const databaseStat = await lstat(databasePath)
  if (!databaseStat.isFile() || databaseStat.isSymbolicLink())
    throw new Error('INSPECTION_DATABASE_INVALID')
  try {
    const direct = new DatabaseSync(databasePath, { readOnly: true })
    try {
      await probeDeferredOpen(direct)
      return direct
    } catch (probeError) {
      try {
        direct.close()
      } catch {
        // The deferred open failed; closing the unused handle is best effort.
      }
      throw probeError
    }
  } catch {
    // Fall through to the snapshot path.
  }
  const snapshotDirectory = await mkdtemp(join(tmpdir(), 'operator-inspection-snapshot-'))
  const snapshotPath = join(snapshotDirectory, basename(databasePath))
  await copyFile(databasePath, snapshotPath, constants.COPYFILE_EXCL)
  const walPath = walSidecarOf(databasePath)
  try {
    if ((await lstat(walPath)).isFile()) await copyFile(walPath, `${snapshotPath}-wal`)
  } catch {
    // No write-ahead log sidecar: nothing further to copy.
  }
  let snapshot: DatabaseSync
  try {
    snapshot = new DatabaseSync(snapshotPath)
    snapshot.exec('PRAGMA query_only = ON')
    await probeDeferredOpen(snapshot)
  } catch (error) {
    rmSync(snapshotDirectory, { recursive: true, force: true })
    throw error
  }
  return {
    prepare: (query: string) => snapshot.prepare(query),
    close: () => {
      snapshot.close()
      rmSync(snapshotDirectory, { recursive: true, force: true })
    },
  }
}

/** True when the database still has a write-ahead log sidecar on disk. */
export async function hasWalSidecar(databasePath: string): Promise<boolean> {
  try {
    return (await lstat(walSidecarOf(databasePath))).isFile()
  } catch {
    return false
  }
}

function ageMs(from: string | undefined, now: number): number | null {
  if (from === undefined) return null
  const parsed = Date.parse(from)
  if (Number.isNaN(parsed)) return null
  return Math.max(0, now - parsed)
}

function isTerminalState(state: string): boolean {
  return ['completed', 'failed', 'cancelled', 'timed_out'].includes(state)
}

/**
 * Correlates persisted records into the bounded stuck-job telemetry view.
 * Purely a read-path aggregation: no state transitions, no retries, no
 * reconciliation effects and no cost inference.
 */
export function inspectStuckJobs(
  reader: ReadOnlyRecordReader,
  options: LocalStuckJobInspectionOptions
): StuckJobInspectionReport {
  const parsedOptions: z.output<typeof LocalStuckJobInspectionOptionsSchema> =
    LocalStuckJobInspectionOptionsSchema.parse(options)
  const nowMs = Date.parse(parsedOptions.now ?? new Date().toISOString())
  const staleAfterMs = parsedOptions.staleAfterSeconds * 1000
  const malformedRecords = new Map<string, number>()
  const incompleteScans: z.output<
    typeof StuckJobInspectionReportSchema
  >['summary']['incompleteScans'] = []

  /**
   * Walks a namespace with continuation until the namespace is exhausted or a
   * budget stops the walk. Budgets count scoped matches (and raw rows), never
   * unrelated records alone, so a selected workspace behind any number of
   * unrelated rows is still found; an early stop is reported as an incomplete
   * scan instead of silently narrowing the result.
   */
  const walkNamespace = (
    namespace: string,
    matchBudget: number,
    onRecord: (record: StoredRecord) => boolean
  ): { matches: number; malformed: number; incomplete: boolean } => {
    let afterId: string | undefined
    let matches = 0
    let malformed = 0
    let rows = 0
    let incomplete: (typeof incompleteScans)[number] | null = null
    while (incomplete === null) {
      const page = reader.pageRecords(namespace, SCAN_PAGE_SIZE, afterId)
      malformed += page.unparseableJsonCount
      const lastRowId = page.records.at(-1)?.id ?? null
      for (const record of page.records) {
        rows += 1
        if (onRecord(record)) matches += 1
        const exhausted = record.id === lastRowId && page.nextAfterId === null
        if (!exhausted && (rows >= MAX_SCAN_ROWS || matches >= matchBudget)) {
          incomplete = {
            namespace,
            reason: rows >= MAX_SCAN_ROWS ? 'row_budget_reached' : 'match_budget_reached',
            lastSeenRecordId: record.id,
          }
          break
        }
      }
      if (incomplete !== null) break
      if (page.nextAfterId === null) break
      afterId = page.nextAfterId
    }
    if (incomplete !== null) incompleteScans.push(incomplete)
    return { matches, malformed, incomplete: incomplete !== null }
  }

  // Executions carry the workspace scope; every other record joins through them.
  const executions = new Map<string, z.output<typeof ExecutionSchema>>()
  let outOfScopeExecutionRecords = 0
  let executionMalformed = 0
  const executionWalk = walkNamespace('executions', parsedOptions.maxScanMatches, (record) => {
    const parsed = ExecutionSchema.safeParse(record.value)
    if (!parsed.success) {
      executionMalformed += 1
      return false
    }
    if (parsed.data.correlation.workspaceId !== parsedOptions.workspaceId) {
      outOfScopeExecutionRecords += 1
      return false
    }
    if (
      parsedOptions.projectId !== undefined &&
      parsed.data.correlation.projectId !== parsedOptions.projectId
    )
      return false
    executions.set(parsed.data.executionId, parsed.data)
    return true
  })
  if (executionWalk.malformed + executionMalformed > 0)
    malformedRecords.set('executions', executionWalk.malformed + executionMalformed)

  const joinByExecution = <T>(
    namespace: string,
    schema: ZodType<T>,
    executionIdOf: (parsed: T) => string
  ): Map<string, T[]> => {
    const byExecution = new Map<string, T[]>()
    let malformedCount = 0
    const walk = walkNamespace(namespace, parsedOptions.maxScanMatches, (record) => {
      const parsed = schema.safeParse(record.value)
      if (!parsed.success) {
        malformedCount += 1
        return false
      }
      if (!executions.has(executionIdOf(parsed.data))) return false
      const existing = byExecution.get(executionIdOf(parsed.data))
      if (existing === undefined) byExecution.set(executionIdOf(parsed.data), [parsed.data])
      else existing.push(parsed.data)
      return true
    })
    if (walk.malformed + malformedCount > 0)
      malformedRecords.set(namespace, walk.malformed + malformedCount)
    return byExecution
  }

  const attempts = joinByExecution(
    'execution-attempts',
    ExecutionAttemptSchema,
    (a) => a.executionId
  )
  const interactions = joinByExecution(
    'interaction-requests',
    InteractionRequestSchema,
    (request) => request.executionId
  )
  const events = joinByExecution(
    'execution-events',
    ExecutionEventSchema,
    (event) => event.executionId
  )

  // Runtime commands carry their own workspace scope.
  const commandsByExecution = new Map<string, z.output<typeof RuntimeCommandRecordSchema>[]>()
  let runtimeCommandMalformed = 0
  const commandWalk = walkNamespace('runtime-commands', parsedOptions.maxScanMatches, (record) => {
    const parsed = RuntimeCommandRecordSchema.safeParse(record.value)
    if (!parsed.success) {
      runtimeCommandMalformed += 1
      return false
    }
    if (parsed.data.workspaceId !== parsedOptions.workspaceId) return false
    if (!executions.has(parsed.data.executionId)) return false
    const existing = commandsByExecution.get(parsed.data.executionId)
    if (existing === undefined) commandsByExecution.set(parsed.data.executionId, [parsed.data])
    else existing.push(parsed.data)
    return true
  })
  if (commandWalk.malformed + runtimeCommandMalformed > 0)
    malformedRecords.set('runtime-commands', commandWalk.malformed + runtimeCommandMalformed)

  // Current channel generations per (workspace, node), from the durable
  // sequence reservations. Channel ownership is claimed per node, so the
  // authoritative current generation for a node is the highest generation
  // reserved across that node's gateway channels; the gateway channel
  // connection id (gwc_…) is transport-local and is never joined to a
  // command's runtimeConnectionId. Unparseable entries stay explicit as
  // unknown (staleGeneration: null).
  const currentGenerations = new Map<string, number>()
  let generationMalformed = 0
  walkNamespace('runtime-channel-sequences', parsedOptions.maxScanMatches, (record) => {
    const value = record.value as { identity?: unknown; next?: unknown } | null
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.identity !== 'string' ||
      typeof value.next !== 'number'
    ) {
      generationMalformed += 1
      return false
    }
    let identity: unknown
    try {
      identity = JSON.parse(value.identity)
    } catch {
      generationMalformed += 1
      return false
    }
    if (!Array.isArray(identity) || identity.length !== 5) return false
    const workspace = identity[0]
    const node = identity[1]
    const generation = identity[4]
    if (
      typeof workspace !== 'string' ||
      typeof node !== 'string' ||
      typeof generation !== 'number'
    ) {
      generationMalformed += 1
      return false
    }
    if (workspace !== parsedOptions.workspaceId) return false
    const key = `${workspace}|${node}`
    const known = currentGenerations.get(key)
    if (known === undefined || generation > known) currentGenerations.set(key, generation)
    return true
  })
  if (generationMalformed > 0)
    malformedRecords.set('runtime-channel-sequences', generationMalformed)

  // Runtime discovery projections (connections and external sessions).
  const connectionsById = new Map<
    string,
    z.output<typeof RuntimeConnectionDiscoveryReadModelSchema>
  >()
  let connectionMalformed = 0
  walkNamespace('runtime-discovery-connections', parsedOptions.maxScanMatches, (record) => {
    const value = record.value as { workspaceId?: unknown; model?: unknown } | null
    if (value === null || typeof value !== 'object' || typeof value.workspaceId !== 'string') {
      connectionMalformed += 1
      return false
    }
    if (value.workspaceId !== parsedOptions.workspaceId) return false
    const parsed = RuntimeConnectionDiscoveryReadModelSchema.safeParse(value.model)
    if (!parsed.success) {
      connectionMalformed += 1
      return false
    }
    connectionsById.set(parsed.data.runtimeConnectionId, parsed.data)
    return true
  })
  if (connectionMalformed > 0)
    malformedRecords.set('runtime-discovery-connections', connectionMalformed)

  const sessionsById = new Map<string, z.output<typeof ExternalSessionDiscoveryReadModelSchema>>()
  let sessionMalformed = 0
  walkNamespace('runtime-discovery-sessions', parsedOptions.maxScanMatches, (record) => {
    const value = record.value as { workspaceId?: unknown; model?: unknown } | null
    if (value === null || typeof value !== 'object' || typeof value.workspaceId !== 'string') {
      sessionMalformed += 1
      return false
    }
    if (value.workspaceId !== parsedOptions.workspaceId) return false
    const parsed = ExternalSessionDiscoveryReadModelSchema.safeParse(value.model)
    if (!parsed.success) {
      sessionMalformed += 1
      return false
    }
    sessionsById.set(parsed.data.externalSessionId, parsed.data)
    return true
  })
  if (sessionMalformed > 0) malformedRecords.set('runtime-discovery-sessions', sessionMalformed)

  // Plans resolve the profile pin for each execution.
  const plansById = new Map<
    string,
    { profileId: string; profileVersionId: string; digest: string }
  >()
  let planMalformed = 0
  walkNamespace('execution-plans', parsedOptions.maxScanMatches, (record) => {
    let plan: ReturnType<typeof assertExecutionPlanIntegrity>
    try {
      plan = assertExecutionPlanIntegrity(record.value)
    } catch {
      planMalformed += 1
      return false
    }
    if (plan.correlation.workspaceId !== parsedOptions.workspaceId) return false
    plansById.set(plan.executionPlanId, {
      profileId: plan.profile.profileId,
      profileVersionId: plan.profile.profileVersionId,
      digest: plan.contentDigest,
    })
    return true
  })
  if (planMalformed > 0) malformedRecords.set('execution-plans', planMalformed)

  const candidates: z.output<typeof ExecutionViewSchema>[] = []
  const unattributedExecutionIds: string[] = []
  let executionsInScope = 0
  let awaitingHumanPendingCount = 0
  let oldestPendingInteractionAgeMs: number | null = null

  const orderedExecutions = [...executions.values()].toSorted((left, right) =>
    compareCodePointOrder(left.executionId, right.executionId)
  )

  for (const execution of orderedExecutions) {
    executionsInScope += 1
    const terminal = isTerminalState(execution.state)
    const stuckReasons = new Set<StuckReason>()
    let oldestEvidenceAgeMs: number | null = null

    const considerEvidence = (candidateAge: number | null) => {
      if (candidateAge === null) return
      if (oldestEvidenceAgeMs === null || candidateAge > oldestEvidenceAgeMs)
        oldestEvidenceAgeMs = candidateAge
    }

    const executionUpdatedAtAge = ageMs(execution.updatedAt, nowMs)
    if (!terminal && executionUpdatedAtAge !== null && executionUpdatedAtAge > staleAfterMs)
      stuckReasons.add('execution_stale')
    if (!terminal && execution.deadlineAt !== undefined && Date.parse(execution.deadlineAt) < nowMs)
      stuckReasons.add('deadline_exceeded')
    if (execution.state === 'reconciliation_required') {
      stuckReasons.add('reconciliation_required')
      considerEvidence(ageMs(execution.reconciliationRequiredAt, nowMs) ?? executionUpdatedAtAge)
    }
    if (
      execution.state === 'cancelling' &&
      (ageMs(execution.cancellingAt, nowMs) ?? executionUpdatedAtAge ?? 0) > staleAfterMs
    )
      stuckReasons.add('cancelling_stalled')

    // Attempt correlation.
    const executionAttempts = attempts.get(execution.executionId) ?? []
    const latestStored =
      execution.latestAttemptId === undefined
        ? undefined
        : executionAttempts.find((candidate) => candidate.attemptId === execution.latestAttemptId)
    let attemptView: z.output<typeof AttemptViewSchema>
    if (execution.latestAttemptId === undefined && execution.attemptCount === 0) {
      attemptView = {
        availability: 'not_established',
        attemptId: null,
        sequence: null,
        state: null,
        updatedAt: null,
        ageMs: null,
        interrupted: false,
      }
    } else if (latestStored === undefined) {
      attemptView = {
        availability: 'missing',
        attemptId: execution.latestAttemptId ?? null,
        sequence: null,
        state: null,
        updatedAt: null,
        ageMs: null,
        interrupted: false,
      }
    } else {
      const attemptAge = ageMs(latestStored.updatedAt, nowMs)
      const attemptTerminal = isTerminalState(latestStored.state)
      const interrupted =
        !attemptTerminal &&
        !terminal &&
        (attemptAge === null || attemptAge > staleAfterMs || latestStored.state === 'cancelling')
      if (interrupted) stuckReasons.add('attempt_interrupted')
      attemptView = {
        availability: 'resolved',
        attemptId: latestStored.attemptId,
        sequence: latestStored.sequence,
        state: latestStored.state,
        updatedAt: latestStored.updatedAt,
        ageMs: attemptAge,
        interrupted,
      }
    }

    // Runtime command (job) correlation.
    const executionCommands = commandsByExecution.get(execution.executionId) ?? []
    const jobViews: z.output<typeof CommandJobViewSchema>[] = []
    let unlistedJobs = 0
    let settledJobs = 0
    for (const command of executionCommands) {
      const terminalCommand = ['succeeded', 'failed', 'cancelled', 'expired'].includes(
        command.status
      )
      if (terminalCommand) {
        settledJobs += 1
        continue
      }
      const commandAge = ageMs(command.updatedAt, nowMs) ?? 0
      const expired = Date.parse(command.expiresAt) < nowMs
      if (expired) stuckReasons.add('command_expired')
      if (command.status === 'queued' && commandAge > staleAfterMs)
        stuckReasons.add('dispatch_stalled')
      if (
        ['dispatched', 'acknowledged'].includes(command.status) &&
        (command.deliveryAttempts >= STALLED_DELIVERY_ATTEMPTS || commandAge > staleAfterMs)
      )
        stuckReasons.add('delivery_stalled')
      let staleGeneration: boolean | null = null
      if (command.lastChannelGeneration !== undefined) {
        const known = currentGenerations.get(`${command.workspaceId}|${command.nodeId}`)
        staleGeneration = known === undefined ? null : command.lastChannelGeneration < known
        if (staleGeneration) stuckReasons.add('stale_generation')
      }
      considerEvidence(commandAge)
      if (jobViews.length < MAX_LISTED_JOBS) {
        jobViews.push({
          commandId: command.commandId,
          status: command.status,
          deliveryAttempts: command.deliveryAttempts,
          issuedAt: command.issuedAt,
          expiresAt: command.expiresAt,
          updatedAt: command.updatedAt,
          ageMs: commandAge,
          expired,
          staleGeneration,
        })
      } else unlistedJobs += 1
    }

    // Session correlation.
    const externalSessionId = latestStored?.runtime?.externalSessionId
    let sessionView: z.output<typeof SessionViewSchema>
    if (externalSessionId === undefined) {
      sessionView = {
        availability: 'not_established',
        externalSessionId: null,
        state: null,
        recoverable: null,
        observedAt: null,
        stale: false,
      }
    } else {
      const projection = sessionsById.get(externalSessionId)
      if (projection === undefined) {
        sessionView = {
          availability: 'reference_only',
          externalSessionId,
          state: null,
          recoverable: null,
          observedAt: null,
          stale: false,
        }
      } else {
        const observedAge = ageMs(projection.freshness.observedAt, nowMs)
        sessionView = {
          availability: 'resolved',
          externalSessionId: projection.externalSessionId,
          state: projection.state,
          recoverable: projection.recoverable,
          observedAt: projection.freshness.observedAt,
          stale:
            projection.state === 'stale' || (observedAge !== null && observedAge > staleAfterMs),
        }
      }
    }

    // Runtime connection correlation (revocation and availability).
    const runtimeConnectionId = latestStored?.runtime?.runtimeConnectionId
    let connectionView: z.output<typeof ConnectionViewSchema>
    if (runtimeConnectionId === undefined) {
      connectionView = {
        availability: 'unreferenced',
        runtimeConnectionId: null,
        status: null,
        connectionStatus: null,
        nodeStatus: null,
        observedAt: null,
        stale: false,
      }
    } else {
      const connection = connectionsById.get(runtimeConnectionId)
      if (connection === undefined) {
        connectionView = {
          availability: 'missing',
          runtimeConnectionId,
          status: null,
          connectionStatus: null,
          nodeStatus: null,
          observedAt: null,
          stale: false,
        }
      } else {
        const observedAge = ageMs(connection.freshness.observedAt, nowMs)
        const revoked =
          connection.status === 'revoked' ||
          connection.connection.status === 'revoked' ||
          (connection.node?.status !== undefined && connection.node.status === 'revoked')
        connectionView = {
          availability: 'resolved',
          runtimeConnectionId: connection.runtimeConnectionId,
          status: connection.status,
          connectionStatus: connection.connection.status,
          nodeStatus: connection.node?.status ?? null,
          observedAt: connection.freshness.observedAt,
          stale: revoked || (observedAge !== null && observedAge > staleAfterMs),
        }
      }
    }

    // Interaction (approval/input) correlation — human latency.
    const executionInteractions = interactions.get(execution.executionId) ?? []
    const pendingViews: z.output<typeof PendingInteractionViewSchema>[] = []
    let unlistedPending = 0
    let respondedCount = 0
    let resolvedTerminalCount = 0
    for (const interaction of executionInteractions) {
      if (interaction.state === 'pending') {
        const pendingAge = ageMs(interaction.requestedAt, nowMs) ?? 0
        awaitingHumanPendingCount += 1
        if (oldestPendingInteractionAgeMs === null || pendingAge > oldestPendingInteractionAgeMs)
          oldestPendingInteractionAgeMs = pendingAge
        const pastExpiry = Date.parse(interaction.expiresAt) < nowMs
        if (pendingAge > staleAfterMs) stuckReasons.add('awaiting_human')
        considerEvidence(pendingAge)
        if (pendingViews.length < MAX_LISTED_PENDING_INTERACTIONS) {
          pendingViews.push({
            interactionId: interaction.interactionId,
            kind: interaction.kind,
            state: interaction.state,
            requestedAt: interaction.requestedAt,
            expiresAt: interaction.expiresAt,
            pendingAgeMs: pendingAge,
            pastExpiry,
          })
        } else unlistedPending += 1
      } else if (interaction.state === 'responded') respondedCount += 1
      else resolvedTerminalCount += 1
    }

    // Effect (execution event) publication correlation.
    const executionEvents = events.get(execution.executionId) ?? []
    let pendingEffects = 0
    let failedEffects = 0
    let quarantinedEffects = 0
    let publishedEffects = 0
    let oldestPendingAt: string | null = null
    let oldestPendingAgeMs: number | null = null
    for (const event of executionEvents) {
      if (event.archivedAt !== undefined) continue
      if (event.publication.status === 'published') publishedEffects += 1
      else if (event.publication.status === 'pending') {
        pendingEffects += 1
        const occurredAge = ageMs(event.occurredAt, nowMs)
        if (oldestPendingAt === null || event.occurredAt < oldestPendingAt) {
          oldestPendingAt = event.occurredAt
          oldestPendingAgeMs = occurredAge
        }
        if (occurredAge !== null && occurredAge > staleAfterMs) {
          stuckReasons.add('effects_pending')
          considerEvidence(occurredAge)
        }
      } else if (event.publication.status === 'failed') {
        failedEffects += 1
        const occurredAge = ageMs(event.occurredAt, nowMs)
        if (occurredAge !== null && occurredAge > staleAfterMs) {
          stuckReasons.add('effects_pending')
          considerEvidence(occurredAge)
        }
      } else quarantinedEffects += 1
    }

    // Profile pin resolution through the stored plan.
    const pin = plansById.get(execution.executionPlan.executionPlanId)
    let profileView: z.output<typeof ProfileViewSchema>
    if (pin === undefined) {
      profileView = {
        availability: 'missing',
        reason: 'plan_missing_or_out_of_scope',
        executionPlanId: execution.executionPlan.executionPlanId,
        profileId: null,
        profileVersionId: null,
      }
    } else if (pin.digest !== execution.executionPlan.contentDigest) {
      profileView = {
        availability: 'unparseable',
        reason: 'plan_pin_mismatch',
        executionPlanId: execution.executionPlan.executionPlanId,
        profileId: null,
        profileVersionId: null,
      }
    } else {
      profileView = {
        availability: 'resolved',
        reason: null,
        executionPlanId: execution.executionPlan.executionPlanId,
        profileId: pin.profileId,
        profileVersionId: pin.profileVersionId,
      }
    }

    if (!terminal) considerEvidence(executionUpdatedAtAge)

    const isStuck = stuckReasons.size > 0
    if (!isStuck) continue

    const view: z.output<typeof ExecutionViewSchema> = {
      executionId: execution.executionId,
      state: execution.state,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
      deadlineAt: execution.deadlineAt ?? null,
      reconciliationAgeMs: terminal ? null : executionUpdatedAtAge,
      stuckReasons: [...stuckReasons].toSorted((left, right) => compareCodePointOrder(left, right)),
      oldestEvidenceAgeMs,
      attempt: attemptView,
      jobs: {
        availability: 'resolved',
        listed: jobViews,
        unlistedCount: unlistedJobs,
        settledCount: settledJobs,
      },
      session: sessionView,
      connection: connectionView,
      approvals: {
        availability: 'resolved',
        pending: pendingViews,
        unlistedPendingCount: unlistedPending,
        pendingCount: pendingViews.length + unlistedPending,
        awaitingHuman: stuckReasons.has('awaiting_human'),
        respondedCount,
        resolvedTerminalCount,
      },
      effects: {
        availability: 'resolved',
        pendingCount: pendingEffects,
        failedCount: failedEffects,
        quarantinedCount: quarantinedEffects,
        publishedCount: publishedEffects,
        oldestPendingAt,
        oldestPendingAgeMs,
        publicationBacklog: stuckReasons.has('effects_pending'),
      },
      profile: profileView,
    }
    candidates.push(view)
  }

  // Profile filtering keeps executions whose resolved pin matches; executions
  // whose plan could not be attributed are reported explicitly instead of
  // being silently dropped.
  const filtered = parsedOptions.profileId !== undefined
  let selected = candidates
  if (filtered) {
    selected = candidates.filter(
      (view) =>
        view.profile.availability === 'resolved' &&
        view.profile.profileId === parsedOptions.profileId
    )
    for (const view of candidates) {
      if (view.profile.availability !== 'resolved') unattributedExecutionIds.push(view.executionId)
    }
  }
  const unattributedCount = unattributedExecutionIds.length
  const ordered = selected.toSorted((left, right) => {
    const leftAge = left.oldestEvidenceAgeMs ?? -1
    const rightAge = right.oldestEvidenceAgeMs ?? -1
    if (leftAge !== rightAge) return rightAge - leftAge
    return compareCodePointOrder(left.executionId, right.executionId)
  })
  const limited = ordered.slice(0, parsedOptions.limit)

  const oldestAgeAmong = (views: typeof candidates): number | null =>
    views.reduce<number | null>(
      (oldest, view) =>
        view.oldestEvidenceAgeMs !== null && (oldest === null || view.oldestEvidenceAgeMs > oldest)
          ? view.oldestEvidenceAgeMs
          : oldest,
      null
    )

  const report: StuckJobInspectionReport = {
    schemaVersion: 1,
    command: 'local.operator.inspection.stuck-jobs',
    readOnly: true,
    generatedAt: new Date(nowMs).toISOString(),
    scope: {
      workspaceId: parsedOptions.workspaceId,
      projectId: parsedOptions.projectId ?? null,
      profileId: parsedOptions.profileId ?? null,
    },
    thresholds: {
      staleAfterSeconds: parsedOptions.staleAfterSeconds,
      limit: parsedOptions.limit,
      maxScanMatches: parsedOptions.maxScanMatches,
      maxScanRows: MAX_SCAN_ROWS,
      scanPageSize: SCAN_PAGE_SIZE,
    },
    summary: {
      complete: incompleteScans.length === 0,
      // Workspace-and-project scoped totals, independent of profile filtering.
      inScope: {
        executions: executionsInScope,
        outOfScopeExecutions: outOfScopeExecutionRecords,
        stuckCandidates: candidates.length,
        oldestStuckAgeMs: oldestAgeAmong(candidates),
        awaitingHumanPendingCount,
        oldestPendingInteractionAgeMs,
      },
      // Totals after profile filtering; only these describe `executions`.
      selected: {
        stuckCandidates: selected.length,
        remainingStuckCandidates: Math.max(0, ordered.length - limited.length),
        executionsListed: limited.length,
        oldestStuckAgeMs: oldestAgeAmong(selected),
      },
      malformedRecords: Object.fromEntries(
        [...malformedRecords.entries()].toSorted((left, right) =>
          compareCodePointOrder(left[0], right[0])
        )
      ),
      incompleteScans: incompleteScans.toSorted((left, right) =>
        compareCodePointOrder(left.namespace, right.namespace)
      ),
    },
    executions: limited,
    profileResolution: {
      filtered,
      unattributedCount,
      unattributedExecutionIds: unattributedExecutionIds.slice(0, MAX_LISTED_UNATTRIBUTED),
    },
  }
  return StuckJobInspectionReportSchema.parse(report)
}
