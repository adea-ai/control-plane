// M16.01 (#938) read-only deployed-PostgreSQL collector for the LangGraph
// retirement inventory.
//
// The reviewed repository script (scripts/langgraph-retirement-inventory.mjs)
// inventories one SQLite control-plane store and reports the deployed Postgres
// catalog as an unknown source. This command is that missing observation
// source: it connects to one explicitly provided PostgreSQL DSN (operator
// supplied through --dsn or the environment — never defaulted, never embedded)
// and emits a bounded, deterministic JSON manifest covering the deployed
// cloud-side tables the persistence layer owns: graph definition versions and
// command receipts (packages/database/src/schema/graph-definitions.ts),
// execution plans and executions (execution-plans.ts / executions.ts), and the
// LangGraph Postgres checkpointer tables (langgraph-checkpoints.ts), plus the
// execution cancellation receipts, so the disposition validator built for the
// reviewed manifest can consume this output unchanged.
//
// Epistemics contract (identical to the reviewed tool): every section carries
// a typed observation status — observed | zero | unknown | inaccessible |
// incomplete | stale — with reasons. Canonical plan attribution applies the
// plan compiler's own contracts (assertExecutionPlanIntegrity + the
// GraphReferenceSchema validation of a retained graph selection), and an
// execution attributes to a workflow only when its full plan pin
// (execution_plan_id + execution_plan_digest) matches the retained plan.
// Graphless classification is reserved for canonically intact plans without a
// graph selection whose execution pins match; everything else is
// attribution-incomplete evidence. Only a fully-read attested deployed-dsn
// observation may conclude zero-in-scope; any pagination bound or skipped
// section downgrades to incomplete and blocks the claim. A bound hit by a
// supporting attribution index (the plan-integrity/pin index over
// execution_plans, the catalog-command receipt index over
// graph_definition_commands) downgrades every section that consumes it, and a
// failed or malformed/unattributable catalog-command receipt index does the
// same through typed reasons — it is never read back as an empty exact index. Counts
// taken over a bounded scan are bounded counts — the per-section
// `countsBounded` flag marks them lower bounds over what was actually read;
// counts are exact only when every contributing scan ran to exhaustion. The
// shared retainedWorkEpistemics encoding from the reviewed script decides.
//
// Safety: the collector opens one connection whose entire observation runs
// inside a single REPEATABLE READ, READ ONLY transaction — one connection is
// one snapshot, so every page of every table observes one database state even
// while other sessions commit (a plain READ ONLY transaction would default to
// READ COMMITTED and let pages and tables mix states). It issues
// parameterized SELECTs only, never migrates, never writes, never locks
// beyond what SELECT needs, and never adopts, cancels, drains or transplants
// anything. Output carries the store identity as a SHA-256 digest of the
// credential-free DSN origin only; no DSNs, hosts, database names,
// credentials, paths, message bodies, record payloads or lifecycle-reason
// free text (an operator-provided field that may carry a credential) are ever
// printed or embedded — reasons surface only as a presence indicator.
// Failures print one sanitized
// LANGGRAPH_RETIREMENT_INVENTORY_PG_FAILED:<CODE> line on stderr.

import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createPostgresConnection } from '@control-plane/database'
import { GraphReferenceSchema } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import {
  GraphDefinitionCommandReceiptSchema,
  PublishedGraphDefinitionSchema,
} from '@control-plane/orchestration'
// Shared vocabulary and encodings from the reviewed inventory script: the
// typed statuses, the curated consumer registry, the zero-vs-unknown rule and
// the deterministic serializer are imported (never duplicated) so both tools
// speak one epistemics contract. Importing is read-only module reuse; the
// reviewed script is not modified.
import {
  KNOWN_CONSUMERS,
  OBSERVATION_SCOPES,
  OBSERVATION_STATUS,
  retainedWorkEpistemics,
  stableJsonStringify,
} from './langgraph-retirement-inventory.mjs'

export const MANIFEST_NAME = 'langgraph-retirement-inventory-pg'
export const MANIFEST_VERSION = 1

const TERMINAL_EXECUTION_STATES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

/**
 * Deployed tables observed by this collector, keyed by the reviewed manifest's
 * section vocabulary. These are the physical tables behind the SQLite
 * namespaces the reviewed tool scans: packages/database owns
 * graph_definition_versions / graph_definition_commands / execution_plans /
 * executions / execution_cancellations and the LangGraph Postgres checkpointer
 * owns checkpoints / checkpoint_blobs / checkpoint_writes.
 */
export const OBSERVED_TABLES = Object.freeze({
  definitions: 'graph_definition_versions',
  catalogCommands: 'graph_definition_commands',
  executions: 'executions',
  executionPlans: 'execution_plans',
  cancellationReceipts: 'execution_cancellations',
  langgraphCheckpoints: 'checkpoints',
  langgraphCheckpointBlobs: 'checkpoint_blobs',
  langgraphCheckpointWrites: 'checkpoint_writes',
})

const DEFAULT_LIMITS = Object.freeze({
  entriesPerSection: 100,
  maximumEntriesPerSection: 1000,
  pageSize: 64,
  maximumPageSize: 128,
  maxAgeDays: 30,
  maximumPages: 4096,
})

const OBSERVATION_SCOPE_RULE =
  'A repository scan or a disposable local store can never establish that production has zero retained work; only an explicitly attested deployed-dsn observation read in full can.'

export class RetirementInventoryPgError extends Error {
  constructor(code) {
    super(code)
    this.name = 'RetirementInventoryPgError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// DSN handling (redaction boundary)
// ---------------------------------------------------------------------------

/**
 * Store identity is the SHA-256 digest of the credential-free DSN origin
 * (host, port, database name). Userinfo is deliberately excluded so the
 * digest can never be narrowed toward a credential; two DSNs to the same
 * database through different roles therefore share one store identity.
 */
export function dsnIdentity(dsn) {
  let url
  try {
    url = new URL(dsn)
  } catch {
    throw new RetirementInventoryPgError('INVALID_DSN')
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const origin = `postgres://${url.hostname}\u0000${url.port || '5432'}\u0000${database}`
  return `sha256:${createHash('sha256').update(origin).digest('hex')}`
}

/**
 * Resolves the target DSN: the explicit --dsn value wins, then the
 * collector-specific environment variable, then DATABASE_URL. There is no
 * default: without an explicit target the command refuses to run rather than
 * guessing a store.
 */
export function resolveDsn({ dsnArgument, environment = process.env } = {}) {
  if (typeof dsnArgument === 'string' && dsnArgument.length > 0) return dsnArgument
  const fromEnvironment =
    environment.LANGGRAPH_RETIREMENT_PG_DSN ?? environment.DATABASE_URL ?? undefined
  if (typeof fromEnvironment === 'string' && fromEnvironment.length > 0) return fromEnvironment
  throw new RetirementInventoryPgError('DSN_REQUIRED')
}

// ---------------------------------------------------------------------------
// Read-only store access
// ---------------------------------------------------------------------------

/**
 * Opens the connection and runs the whole observation inside one REPEATABLE
 * READ, READ ONLY transaction. The connection profile is the repository's
 * canonical application-role connection (pooled-safe `prepare: false`, one
 * connection so the transaction scope is unambiguous); `$client` is the
 * underlying postgres.js pool and every statement below is a parameterized
 * SELECT executed through it. No statement in this module writes, locks or
 * migrates.
 *
 * One connection is one snapshot: REPEATABLE READ pins the transaction's
 * snapshot at its first read, so every page of every table observes one
 * database state for the whole observation even while other sessions commit.
 * (postgres.js sanitizes the mode string to letters and spaces, and Postgres's
 * transaction-mode list does not require commas, so the mode below issues
 * `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.)
 *
 * `observe` receives the transaction-scoped sql tag and must return the
 * manifest body; any error it throws aborts the read-only transaction (a
 * no-op — nothing was written) and is mapped to typed reasons by the caller.
 */
export async function observeReadOnly(dsn, observe, options = {}) {
  const connection = createPostgresConnection(
    { role: 'application', url: dsn },
    { maxConnections: options.maxConnections ?? 1 }
  )
  // The drizzle handle exposes the postgres.js pool it was constructed with;
  // every statement in this module is a raw parameterized SELECT, so the
  // query builder is never used.
  const client = connection.database.$client
  try {
    return await client.begin(
      'transaction isolation level repeatable read read only',
      (transaction) => observe(transaction)
    )
  } finally {
    await connection.close()
  }
}

/**
 * Preflight over the deployed schema. Never migrates: a database missing any
 * expected table is reported as inaccessible with typed per-table reasons
 * instead of being upgraded. Table names are schema identity and safe to
 * report; nothing else about the server is echoed beyond its version string.
 */
export async function readStoreProfile(transaction) {
  try {
    const version = await transaction.unsafe('select current_setting($1) as version', [
      'server_version',
    ])
    const reasons = []
    for (const table of Object.values(OBSERVED_TABLES)) {
      const present = await transaction.unsafe('select to_regclass($1) as reg', [`public.${table}`])
      if (present[0]?.reg === null) reasons.push(`${table.toUpperCase()}_TABLE_MISSING`)
    }
    if (reasons.length > 0)
      return { status: OBSERVATION_STATUS.INACCESSIBLE, schemaVersion: null, reasons }
    const schemaVersion = typeof version[0]?.version === 'string' ? version[0].version : null
    return { status: OBSERVATION_STATUS.OBSERVED, schemaVersion, reasons: [] }
  } catch {
    return {
      status: OBSERVATION_STATUS.INACCESSIBLE,
      schemaVersion: null,
      reasons: ['PREFLIGHT_FAILED'],
    }
  }
}

/**
 * Bounded keyset pagination over one table in primary-key order. The callback
 * receives every row; bounding of emitted entries is the caller's decision, so
 * counts stay exact even when entries are truncated. Iteration stops at
 * exhaustion or at the pagination bound (`spec.maximumPages`, default 4096) —
 * the caller MUST consume the returned `boundReached` flag: a bound hit means
 * the scan is partial, so the section and every index built from it downgrade
 * to incomplete and their counts become bounded counts.
 */
export async function scanTable(transaction, spec, onRow) {
  const pageSize = boundedPageSize(spec.pageSize)
  const maximumPages = boundedMaximumPages(spec.maximumPages)
  // Every keyset column must be selected: the cursor is the last row's key.
  const columns = [...new Set([...spec.columns, ...spec.keyColumns])].join(', ')
  const order = spec.keyColumns.join(', ')
  // Row-value comparisons leave parameters untyped on the wire; explicit
  // casts (the physical column types from packages/database/src/schema) keep
  // the keyset predicates plan-safe.
  const keyTypes = spec.keyTypes ?? spec.keyColumns.map(() => 'text')
  const cursor = spec.keyColumns
    .map((column, index) => `$${index + 1}::${keyTypes[index]}`)
    .join(', ')
  const firstText = `select ${columns} from ${spec.table} order by ${order} limit $1`
  const pageText = `select ${columns} from ${spec.table} where (${order}) > (${cursor}) order by ${order} limit $${spec.keyColumns.length + 1}`
  let afterKey = null
  let scanned = 0
  let pages = 0
  let boundReached = false
  while (true) {
    pages += 1
    if (pages > maximumPages) {
      boundReached = true
      break
    }
    const rows =
      afterKey === null
        ? await transaction.unsafe(firstText, [pageSize])
        : await transaction.unsafe(pageText, [...afterKey, pageSize])
    if (rows.length === 0) break
    for (const row of rows) {
      onRow(row)
      scanned += 1
    }
    if (rows.length < pageSize) break
    afterKey = spec.keyColumns.map((column) => rows[rows.length - 1][column])
  }
  return { scanned, pages, boundReached }
}

function boundedPageSize(pageSize) {
  const value = pageSize ?? DEFAULT_LIMITS.pageSize
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS.maximumPageSize)
    throw new RetirementInventoryPgError('INVALID_PAGE_SIZE')
  return value
}

function boundedMaximumPages(maximumPages) {
  const value = maximumPages ?? DEFAULT_LIMITS.maximumPages
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS.maximumPages)
    throw new RetirementInventoryPgError('INVALID_MAXIMUM_PAGES')
  return value
}

function normalizeLimits(limits) {
  const entriesPerSection = limits?.entriesPerSection ?? DEFAULT_LIMITS.entriesPerSection
  if (
    !Number.isSafeInteger(entriesPerSection) ||
    entriesPerSection < 1 ||
    entriesPerSection > DEFAULT_LIMITS.maximumEntriesPerSection
  )
    throw new RetirementInventoryPgError('INVALID_ENTRY_LIMIT')
  const maxAgeDays = limits?.maxAgeDays ?? DEFAULT_LIMITS.maxAgeDays
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0)
    throw new RetirementInventoryPgError('INVALID_MAX_AGE_DAYS')
  return {
    entriesPerSection,
    maxAgeDays,
    pageSize: boundedPageSize(limits?.pageSize),
    maximumPages: boundedMaximumPages(limits?.maximumPages),
  }
}

/** bigint columns arrive as strings from the wire; count columns are numbers. */
function toCount(value) {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) ? parsed : 0
}

/**
 * timestamptz columns arrive as their raw wire text (the application
 * connection profile installs transparent parsers for date/time types);
 * normalize to an ISO instant or null.
 */
function toInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

// ---------------------------------------------------------------------------
// Section outcome vocabulary (mirrors the reviewed sectionOutcome shape)
// ---------------------------------------------------------------------------

function sectionHeader(tables, identity, observedAt) {
  return {
    observedAt,
    source: {
      backend: 'postgres-dsn',
      identity,
      tables: [...tables].toSorted(),
    },
  }
}

function sectionOutcome({
  attempted,
  readError,
  rowCount,
  malformedCount,
  truncated,
  boundReached,
  newestUpdatedAtValue,
  maxAgeDays,
  observedAt,
}) {
  if (!attempted)
    return { status: OBSERVATION_STATUS.UNKNOWN, reasons: ['SOURCE_NOT_IN_OBSERVATION_SCOPE'] }
  if (readError !== undefined)
    return { status: OBSERVATION_STATUS.INACCESSIBLE, reasons: [readError] }
  const reasons = new Set()
  let severity = 0
  if (truncated) {
    reasons.add('ENTRY_LIMIT_REACHED')
    severity = 3
  }
  if (boundReached) {
    reasons.add('PAGINATION_BOUND_REACHED')
    severity = 3
  }
  if (malformedCount > 0) {
    reasons.add('MALFORMED_RECORDS_PRESENT')
    severity = Math.max(severity, 3)
  }
  if (
    newestUpdatedAtValue !== null &&
    Date.parse(observedAt) - Date.parse(newestUpdatedAtValue) > maxAgeDays * 86_400_000
  ) {
    reasons.add('FRESHNESS_THRESHOLD_EXCEEDED')
    severity = Math.max(severity, 2)
  }
  if (severity === 3)
    return { status: OBSERVATION_STATUS.INCOMPLETE, reasons: [...reasons].toSorted() }
  if (severity === 2) return { status: OBSERVATION_STATUS.STALE, reasons: [...reasons].toSorted() }
  if (rowCount === 0)
    return { status: OBSERVATION_STATUS.ZERO, reasons: ['NO_RECORDS_IN_OBSERVED_NAMESPACE'] }
  return { status: OBSERVATION_STATUS.OBSERVED, reasons: [...reasons].toSorted() }
}

function outcomeWithExtraReasons(outcome, extraReasons) {
  if (extraReasons.length === 0) return outcome
  const reasons = [...new Set([...outcome.reasons, ...extraReasons])].toSorted()
  const status =
    outcome.status === OBSERVATION_STATUS.OBSERVED || outcome.status === OBSERVATION_STATUS.ZERO
      ? OBSERVATION_STATUS.INCOMPLETE
      : outcome.status
  return { status, reasons }
}

/**
 * Mirrors the reviewed tool's sectionFullyRead rule (not exported there): a
 * feeding section's numbers may only be read as exact when it was read in
 * full — observed or zero status, no truncation, no malformed records. Used
 * to decide whether definition-level usage counts are complete or must carry
 * their feeding scan's incompleteness.
 */
function usageSourceFullyRead(section) {
  return (
    (section?.status === OBSERVATION_STATUS.OBSERVED ||
      section?.status === OBSERVATION_STATUS.ZERO) &&
    section?.truncated === false &&
    (section?.malformedRecords ?? 0) === 0
  )
}

function mapCountsToObject(counter) {
  return Object.fromEntries(
    [...counter.entries()].toSorted((left, right) => compareCodePoint(left[0], right[0]))
  )
}

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

// ---------------------------------------------------------------------------
// Section collectors
// ---------------------------------------------------------------------------

/**
 * Inventory of deployed graph-catalog definition versions. The definition
 * jsonb is the PublishedGraphDefinition the catalog command path persisted
 * (see PostgresGraphDefinitionRepository.insert); parsing is canonical — a
 * record is evidence only when it satisfies the deployed catalog's own schema
 * (PublishedGraphDefinitionSchema) and its canonical reference/revision bind
 * to the physical row identity (the same identity rule the command repository
 * enforces on replay). Anything else is malformed or mismatched typed
 * evidence, never guessed into a bucket or read back as observed metadata.
 */
async function collectDefinitions(transaction, context) {
  const {
    identity,
    observedAt,
    limits,
    executionsByGraph,
    checkpointRowsByExecution,
    catalogCommandsByGraph,
    catalogCommandsIndexBoundReached = false,
    catalogCommandsIndexReadError = undefined,
    catalogCommandsIndexMalformedRecords = 0,
    // Fail-closed defaults: a missing feed flag marks the usage incomplete
    // rather than presenting partial attribution as exact.
    executionsUsageComplete = false,
    checkpointsUsageComplete = false,
  } = context
  let rowCount = 0
  let malformedCount = 0
  let identityMismatchCount = 0
  let truncated = false
  let boundReached = false
  // Which feeds behind consumersObserved were read in full. A feed that was
  // bounded, truncated, malformed, stale or failed contributes lower bounds
  // only, so every emitted entry must say so instead of showing exact zeros.
  const incompleteUsageSources = []
  if (!executionsUsageComplete) incompleteUsageSources.push('executions')
  if (!checkpointsUsageComplete) incompleteUsageSources.push('checkpoints')
  if (
    catalogCommandsIndexBoundReached ||
    catalogCommandsIndexReadError !== undefined ||
    catalogCommandsIndexMalformedRecords > 0
  )
    incompleteUsageSources.push('catalogCommands')
  incompleteUsageSources.sort()
  const usageComplete = incompleteUsageSources.length === 0
  const workspaces = new Set()
  const lifecycles = new Map()
  const graphs = new Set()
  const entries = []
  try {
    const definitionsScan = await scanTable(
      transaction,
      {
        table: OBSERVED_TABLES.definitions,
        columns: ['workspace_id', 'graph_definition_id', 'graph_version', 'revision', 'definition'],
        keyColumns: ['workspace_id', 'graph_definition_id', 'graph_version'],
        keyTypes: ['text', 'text', 'text'],
        pageSize: limits.pageSize,
        maximumPages: limits.maximumPages,
      },
      (row) => {
        rowCount += 1
        const parsedRow = parseDefinitionRow(row)
        if (parsedRow === undefined) {
          malformedCount += 1
          return
        }
        // A canonically valid record stored under another row's identity is
        // rejected explicitly: never an entry, never observed metadata.
        if (parsedRow.identityMismatch) {
          identityMismatchCount += 1
          return
        }
        const definition = parsedRow.definition
        workspaces.add(definition.workspaceId)
        graphs.add(`${definition.workspaceId}\u0000${definition.graphDefinitionId}`)
        lifecycles.set(definition.lifecycle, (lifecycles.get(definition.lifecycle) ?? 0) + 1)
        if (entries.length >= limits.entriesPerSection) {
          truncated = true
          return
        }
        const graphKey = `${definition.workspaceId}\u0000${definition.graphDefinitionId}\u0000${definition.graphVersion}`
        const executionUsage = executionsByGraph.get(graphKey) ?? { inFlight: 0, retained: 0 }
        entries.push({
          changedAt: definition.changedAt,
          contentDigest: definition.contentDigest,
          durableOwner: 'control-plane-graph-catalog',
          entryVersion: {
            definitionRevision: definition.definitionRevision,
            catalogRevision: toCount(row.revision),
          },
          graphDefinitionId: definition.graphDefinitionId,
          graphVersion: definition.graphVersion,
          historyResponsibility:
            'publication history retained as graph_definition_commands receipts; execution history stays in the execution tables',
          lifecycle: definition.lifecycle,
          observedAt,
          publishedAt: definition.publishedAt,
          reasonPresent: definition.reasonPresent,
          runtimeProfile: definition.runtimeProfile,
          consumersObserved: {
            catalogCommands: catalogCommandsByGraph.get(graphKey) ?? 0,
            checkpointRows: checkpointRowsByExecution.get(graphKey) ?? 0,
            incompleteUsageSources: [...incompleteUsageSources],
            inFlightExecutions: executionUsage.inFlight,
            retainedExecutions: executionUsage.retained,
            usageComplete,
          },
          workspaceId: definition.workspaceId,
        })
      }
    )
    boundReached = definitionsScan.boundReached
  } catch {
    return failedDefinitionsSection(identity, observedAt, limits)
  }
  // A bound on the definitions scan or the catalog-command attribution index
  // bounds this section's own evidence; incomplete executions/checkpoint
  // feeds downgrade it through their typed reasons instead, because their
  // rows only shape the per-entry consumersObserved numbers. Either way the
  // section never reads partial attribution as observed fact.
  const sectionBoundReached = boundReached || catalogCommandsIndexBoundReached
  return {
    ...sectionHeader([OBSERVED_TABLES.definitions], identity, observedAt),
    ...outcomeWithExtraReasons(
      sectionOutcome({
        attempted: true,
        readError: undefined,
        rowCount,
        malformedCount,
        truncated,
        boundReached,
        newestUpdatedAtValue: null,
        maxAgeDays: limits.maxAgeDays,
        observedAt,
      }),
      [
        ...(catalogCommandsIndexBoundReached
          ? ['CATALOG_COMMAND_INDEX_PAGINATION_BOUND_REACHED']
          : []),
        ...(catalogCommandsIndexReadError !== undefined
          ? ['CATALOG_COMMAND_INDEX_SCAN_FAILED']
          : []),
        ...(catalogCommandsIndexMalformedRecords > 0 ? ['CATALOG_COMMAND_RECEIPTS_MALFORMED'] : []),
        ...(identityMismatchCount > 0 ? ['DEFINITION_IDENTITY_MISMATCH'] : []),
        ...(executionsUsageComplete ? [] : ['EXECUTIONS_USAGE_INCOMPLETE']),
        ...(checkpointsUsageComplete ? [] : ['CHECKPOINTS_USAGE_INCOMPLETE']),
      ]
    ),
    counts: {
      total: rowCount,
      workspaces: workspaces.size,
      distinctGraphs: graphs.size,
      byLifecycle: mapCountsToObject(lifecycles),
      identityMismatches: identityMismatchCount,
    },
    entries: entries.toSorted(
      (left, right) =>
        compareCodePoint(left.workspaceId, right.workspaceId) ||
        compareCodePoint(left.graphDefinitionId, right.graphDefinitionId) ||
        compareCodePoint(left.graphVersion, right.graphVersion)
    ),
    truncated,
    boundReached: sectionBoundReached,
    countsBounded: sectionBoundReached,
    malformedRecords: malformedCount,
  }
}

function failedDefinitionsSection(identity, observedAt, limits) {
  return {
    ...sectionHeader([OBSERVED_TABLES.definitions], identity, observedAt),
    ...sectionOutcome({
      attempted: true,
      readError: 'TABLE_SCAN_FAILED',
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      boundReached: false,
      newestUpdatedAtValue: null,
      maxAgeDays: limits.maxAgeDays,
      observedAt,
    }),
    counts: { total: 0, identityMismatches: 0 },
    entries: [],
    truncated: false,
    boundReached: false,
    countsBounded: false,
    malformedRecords: 0,
  }
}

/**
 * Canonical definition parsing with explicit row-identity binding.
 *
 * 1. The deployed jsonb must satisfy the exact PublishedGraphDefinitionSchema
 *    the catalog command path persists and validates on replay
 *    (packages/orchestration/src/graph-catalog.ts): strict shape, canonical
 *    reference, and the reference/content digest binding. A record that fails
 *    the schema is malformed evidence (undefined).
 * 2. A canonically valid record is then bound to the physical row: the
 *    canonical reference IDs and revision must equal the row's key columns —
 *    the same receipt/row identity rule
 *    PostgresGraphDefinitionCommandRepository enforces on replay. A mismatch
 *    (a canonical record stored under another row's identity) is rejected
 *    explicitly as typed mismatch evidence, never emitted as observed
 *    metadata.
 * 3. The lifecycle reason is operator free text (the canonical schema permits
 *    up to 1,024 characters) and may carry a DSN or other credential. It is
 *    reduced to a non-sensitive presence indicator and its text never reaches
 *    the manifest.
 */
function parseDefinitionRow(row) {
  const workspaceId = row.workspace_id
  const graphDefinitionId = row.graph_definition_id
  const graphVersion = row.graph_version
  const revision = toCount(row.revision)
  const definition = row.definition
  if (
    typeof workspaceId !== 'string' ||
    typeof graphDefinitionId !== 'string' ||
    typeof graphVersion !== 'string' ||
    definition === null ||
    typeof definition !== 'object' ||
    Array.isArray(definition)
  )
    return undefined
  const parsed = PublishedGraphDefinitionSchema.safeParse(definition)
  if (!parsed.success) return undefined
  const canonical = parsed.data
  if (
    canonical.reference.graphDefinitionId !== graphDefinitionId ||
    canonical.reference.graphVersion !== graphVersion ||
    canonical.revision !== revision
  )
    return { identityMismatch: true }
  return {
    identityMismatch: false,
    definition: {
      workspaceId,
      graphDefinitionId,
      graphVersion,
      contentDigest: canonical.reference.contentDigest,
      lifecycle: canonical.lifecycle,
      definitionRevision: canonical.revision,
      publishedAt: canonical.publishedAt,
      changedAt: canonical.changedAt,
      reasonPresent: canonical.reason !== undefined,
      runtimeProfile: {
        schemaVersion: canonical.content.schemaVersion,
        nodeCount: canonical.content.nodes.length,
        operationKinds: [
          ...new Set(canonical.content.nodes.map((node) => node.operation.kind)),
        ].toSorted(),
        requiredCapabilities: [...canonical.content.requiredCapabilities].toSorted(),
        compatibility: {
          contractMajorVersions: [
            ...canonical.content.compatibility.contractMajorVersions,
          ].toSorted((left, right) => left - right),
          compilerVersions: [...canonical.content.compatibility.compilerVersions].toSorted(),
          adapterVersions: [...canonical.content.compatibility.adapterVersions].toSorted(),
        },
      },
    },
  }
}

/** Store-derived catalog consumers: the command receipts the deployed catalog wrote. */
async function collectCatalogCallers(transaction, context) {
  const { observedAt, limits } = context
  let rowCount = 0
  let malformedCount = 0
  let truncated = false
  let boundReached = false
  let newestCreatedAtValue = null
  const callers = new Map()
  try {
    const catalogScan = await scanTable(
      transaction,
      {
        table: OBSERVED_TABLES.catalogCommands,
        columns: ['workspace_id', 'caller_id', 'operation', 'created_at', 'receipt'],
        keyColumns: ['workspace_id', 'caller_id', 'operation', 'idempotency_key'],
        keyTypes: ['text', 'text', 'text', 'text'],
        pageSize: limits.pageSize,
        maximumPages: limits.maximumPages,
      },
      (row) => {
        rowCount += 1
        const createdAt = toInstant(row.created_at)
        if (
          createdAt !== null &&
          (newestCreatedAtValue === null || createdAt > newestCreatedAtValue)
        )
          newestCreatedAtValue = createdAt
        const callerId = row.caller_id
        if (typeof callerId !== 'string') {
          malformedCount += 1
          return
        }
        const caller = callers.get(callerId) ?? {
          callerId,
          commandCount: 0,
          operations: new Set(),
          workspaces: new Set(),
        }
        caller.commandCount += 1
        if (typeof row.operation === 'string') caller.operations.add(row.operation)
        if (typeof row.workspace_id === 'string') caller.workspaces.add(row.workspace_id)
        callers.set(callerId, caller)
      }
    )
    boundReached = catalogScan.boundReached
  } catch {
    return {
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      boundReached: false,
      readError: 'TABLE_SCAN_FAILED',
      distinctCallers: 0,
      newestCreatedAtValue: null,
      entries: [],
    }
  }
  const entries = []
  for (const caller of callers.values()) {
    if (entries.length >= limits.entriesPerSection) {
      truncated = true
      break
    }
    entries.push({
      consumerId: `catalog-caller:${caller.callerId}`,
      kind: 'catalog-command-caller',
      source: `deployed-table:${OBSERVED_TABLES.catalogCommands}`,
      profile: {
        callerId: caller.callerId,
        commandCount: caller.commandCount,
        operations: [...caller.operations].toSorted(),
        workspaceCount: caller.workspaces.size,
      },
      observation: { origin: 'store-scan', observedAt },
    })
  }
  return {
    rowCount,
    malformedCount,
    truncated,
    boundReached,
    readError: undefined,
    // Distinct callers are counted over the full scan — exact whenever the
    // scan was unbounded, a bounded count otherwise (boundReached says which);
    // the entry list is the only bounded surface in the unbounded case.
    distinctCallers: callers.size,
    newestCreatedAtValue,
    entries: entries.toSorted((left, right) => compareCodePoint(left.consumerId, right.consumerId)),
  }
}

/**
 * Execution plans index: the only durable graph reference on the execution
 * path. Canonical validation — the plan compiler's own contracts — decides
 * what a retained plan row means, exactly as the reviewed script does:
 * - Canonical plan integrity first (assertExecutionPlanIntegrity): the
 *   retained plan jsonb must satisfy the compiler's schema with its own
 *   digest constraints. A row that fails is corrupted evidence.
 * - A canonically intact plan carrying a graph selection validates that
 *   selection against GraphReferenceSchema; a missing or blank
 *   graphDefinitionId, a nonempty but invalid graphVersion, or a malformed
 *   contentDigest is malformed identity.
 * - A canonically intact plan with no graph selection at all is a legal
 *   non-graph workflow, counted separately once the execution's full pin
 *   matches (see collectExecutions).
 */
async function collectPlanGraphReferences(transaction, context) {
  const planGraphs = new Map()
  const plansWithMalformedGraphIdentity = new Set()
  const nonGraphPlans = new Set()
  const planDigestsById = new Map()
  let planCount = 0
  let malformedPlans = 0
  let boundReached = false
  let readError
  try {
    const plansScan = await scanTable(
      transaction,
      {
        table: OBSERVED_TABLES.executionPlans,
        columns: ['execution_plan_id', 'plan'],
        keyColumns: ['execution_plan_id'],
        keyTypes: ['text'],
        pageSize: context.pageSize,
        maximumPages: context.maximumPages,
      },
      (row) => {
        planCount += 1
        const planId = row.execution_plan_id
        if (typeof planId !== 'string') {
          malformedPlans += 1
          return
        }
        let plan
        try {
          plan = assertExecutionPlanIntegrity(row.plan)
        } catch {
          // Corrupted record: stale digest, foreign plan id, or non-canonical
          // shape. No field of such a record can be trusted as evidence.
          plansWithMalformedGraphIdentity.add(planId)
          return
        }
        planDigestsById.set(planId, plan.contentDigest)
        const graphSelection = plan.graph
        if (graphSelection === undefined) {
          // The canonical compiler writes either a valid graph selection or
          // none: absence in a canonically intact plan is a legal non-graph
          // workflow, not malformed identity.
          nonGraphPlans.add(planId)
          return
        }
        const parsed = GraphReferenceSchema.safeParse(graphSelection?.reference)
        if (!parsed.success) {
          plansWithMalformedGraphIdentity.add(planId)
          return
        }
        planGraphs.set(planId, parsed.data)
      }
    )
    boundReached = plansScan.boundReached
  } catch {
    readError = 'TABLE_SCAN_FAILED'
  }
  return {
    planGraphs,
    plansWithMalformedGraphIdentity,
    nonGraphPlans,
    planDigestsById,
    planCount,
    malformedPlans,
    // A bounded plan scan leaves every attribution index partial: the
    // executions section must downgrade to incomplete.
    boundReached,
    readError,
  }
}

/**
 * Retained executions; entries bounded to in-flight work. Pin matching uses
 * the deployed full-pin columns: an execution attributes to a workflow only
 * when its execution_plan_id resolves to a retained canonically intact plan
 * AND its execution_plan_digest equals that plan's canonical content digest.
 */
async function collectExecutions(transaction, context) {
  const { identity, observedAt, limits, planIndex } = context
  let rowCount = 0
  let malformedCount = 0
  let truncated = false
  let boundReached = false
  let newestUpdatedAtValue = null
  let newestPlanCreatedAtValue = null
  const byState = new Map()
  const executionsByGraph = new Map()
  const executionGraphKeys = new Map()
  const executionStatesById = new Map()
  const inFlightEntries = []
  let inFlightPlansMissing = 0
  let inFlightPlansWithMalformedGraphIdentity = 0
  let inFlightNonGraph = 0
  let inFlightAttributed = 0
  try {
    const executionsScan = await scanTable(
      transaction,
      {
        table: OBSERVED_TABLES.executions,
        columns: [
          'execution_id',
          'state',
          'version',
          'workspace_id',
          'execution_plan_id',
          'execution_plan_digest',
          'attempt_count',
          'accepted_at',
          'updated_at',
        ],
        keyColumns: ['execution_id'],
        keyTypes: ['text'],
        pageSize: limits.pageSize,
        maximumPages: limits.maximumPages,
      },
      (row) => {
        rowCount += 1
        const updatedAt = toInstant(row.updated_at)
        if (
          updatedAt !== null &&
          (newestUpdatedAtValue === null || updatedAt > newestUpdatedAtValue)
        )
          newestUpdatedAtValue = updatedAt
        const executionId = row.execution_id
        const state = row.state
        if (typeof executionId !== 'string' || typeof state !== 'string') {
          malformedCount += 1
          return
        }
        byState.set(state, (byState.get(state) ?? 0) + 1)
        const inFlight = !TERMINAL_EXECUTION_STATES.has(state)
        const workspaceId = typeof row.workspace_id === 'string' ? row.workspace_id : 'unknown'
        const planId = typeof row.execution_plan_id === 'string' ? row.execution_plan_id : undefined
        const planKnown = planId !== undefined && planIndex.planGraphs.has(planId)
        const planIdentityMalformed =
          planId !== undefined && planIndex.plansWithMalformedGraphIdentity.has(planId) === true
        const planNonGraph = planId !== undefined && planIndex.nonGraphPlans.has(planId) === true
        // The execution's full plan pin must match the retained plan: a pin
        // digest that is missing or names a different plan leaves the
        // execution unattributable, even when the plan record itself is
        // intact.
        const pinDigest =
          typeof row.execution_plan_digest === 'string' ? row.execution_plan_digest : undefined
        const planPinned =
          planId !== undefined &&
          typeof pinDigest === 'string' &&
          planIndex.planDigestsById.get(planId) === pinDigest
        const graphReference =
          planKnown && planPinned ? planIndex.planGraphs.get(planId) : undefined
        let graphKey
        if (graphReference !== undefined) {
          graphKey = `${workspaceId}\u0000${graphReference.graphDefinitionId}\u0000${graphReference.graphVersion}`
          const usage = executionsByGraph.get(graphKey) ?? { inFlight: 0, retained: 0 }
          usage.retained += 1
          if (inFlight) usage.inFlight += 1
          executionsByGraph.set(graphKey, usage)
          executionGraphKeys.set(executionId, graphKey)
        }
        executionStatesById.set(executionId, { inFlight, workspaceId })
        if (!inFlight) return
        if (planIdentityMalformed || ((planKnown || planNonGraph) && !planPinned)) {
          inFlightPlansWithMalformedGraphIdentity += 1
        } else if (planKnown) {
          inFlightAttributed += 1
        } else if (planNonGraph) {
          inFlightNonGraph += 1
        } else {
          inFlightPlansMissing += 1
        }
        if (inFlightEntries.length < limits.entriesPerSection) {
          inFlightEntries.push({
            attemptCount: toCount(row.attempt_count),
            createdAt: toInstant(row.accepted_at) ?? 'unknown',
            durableOwner: 'control-plane-execution-history',
            executionId,
            graphWorkflow: graphReference !== undefined,
            historyResponsibility:
              'execution events and cancellation receipts remain in this store; retirement must not cancel or adopt this execution',
            observedAt,
            recordRevision: toCount(row.version),
            state,
            updatedAt: updatedAt ?? 'unknown',
            workspaceId,
            executionPlan: planId === undefined ? undefined : { executionPlanId: planId },
            ...(graphReference === undefined ? {} : { graphReference }),
          })
        } else {
          truncated = true
        }
      }
    )
    const plansNewest = await newestInstant(
      transaction,
      OBSERVED_TABLES.executionPlans,
      'created_at'
    )
    newestPlanCreatedAtValue = plansNewest
    boundReached = executionsScan.boundReached
  } catch {
    return failedExecutionsSection(identity, observedAt, limits)
  }
  const inFlightTotal = [...byState.entries()]
    .filter(([state]) => !TERMINAL_EXECUTION_STATES.has(state))
    .reduce((summand, [, count]) => summand + count, 0)
  const extraReasons = []
  if (planIndex.readError !== undefined) extraReasons.push('PLAN_TABLE_SCAN_FAILED')
  if (planIndex.boundReached === true) extraReasons.push('PLAN_INDEX_PAGINATION_BOUND_REACHED')
  if (
    planIndex.plansWithMalformedGraphIdentity.size > 0 ||
    inFlightPlansWithMalformedGraphIdentity > 0
  )
    extraReasons.push('PLAN_GRAPH_IDENTITY_MALFORMED')
  // Either bound makes the attribution totals partial: the executions scan
  // bounds the state counts, the plan index bounds the attribution buckets.
  const sectionBoundReached = boundReached || planIndex.boundReached === true
  const newestEvidence = [newestUpdatedAtValue, newestPlanCreatedAtValue]
    .filter((value) => value !== null)
    .toSorted()
    .at(-1)
  return {
    ...sectionHeader(
      [OBSERVED_TABLES.executions, OBSERVED_TABLES.executionPlans],
      identity,
      observedAt
    ),
    ...outcomeWithExtraReasons(
      sectionOutcome({
        attempted: true,
        readError: undefined,
        rowCount,
        malformedCount,
        truncated,
        boundReached,
        newestUpdatedAtValue: newestEvidence,
        maxAgeDays: limits.maxAgeDays,
        observedAt,
      }),
      extraReasons
    ),
    counts: {
      total: rowCount,
      inFlight: inFlightTotal,
      terminal: rowCount - inFlightTotal - malformedCount,
      inFlightAttributed,
      inFlightPlansWithMalformedGraphIdentity,
      inFlightNonGraph,
      inFlightPlansMissing,
      byState: mapCountsToObject(byState),
    },
    entries: inFlightEntries.toSorted((left, right) =>
      compareCodePoint(left.executionId, right.executionId)
    ),
    truncated,
    boundReached: sectionBoundReached,
    countsBounded: sectionBoundReached,
    malformedRecords: malformedCount,
    internal: { executionsByGraph, executionGraphKeys, executionStatesById },
  }
}

function failedExecutionsSection(identity, observedAt, limits) {
  return {
    ...sectionHeader(
      [OBSERVED_TABLES.executions, OBSERVED_TABLES.executionPlans],
      identity,
      observedAt
    ),
    ...sectionOutcome({
      attempted: true,
      readError: 'TABLE_SCAN_FAILED',
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      boundReached: false,
      newestUpdatedAtValue: null,
      maxAgeDays: limits.maxAgeDays,
      observedAt,
    }),
    counts: {
      total: 0,
      inFlight: 0,
      terminal: 0,
      inFlightAttributed: 0,
      inFlightPlansWithMalformedGraphIdentity: 0,
      inFlightNonGraph: 0,
      inFlightPlansMissing: 0,
    },
    entries: [],
    truncated: false,
    boundReached: false,
    countsBounded: false,
    malformedRecords: 0,
    internal: {
      executionsByGraph: new Map(),
      executionGraphKeys: new Map(),
      executionStatesById: new Map(),
    },
  }
}

/**
 * LangGraph checkpoint rows: resume state that retirement must not transplant.
 * The Postgres checkpointer splits evidence across checkpoints / checkpoint_blobs
 * / checkpoint_writes; all three are counted, and thread classification joins
 * through the executions walk exactly as the reviewed tool does. Blob rows
 * register their threads as well: a thread that exists only as
 * checkpoint_blobs evidence still carries resume state whose in-flight
 * classification the observation must resolve or declare unknown — never
 * silently count without classifying.
 */
async function collectCheckpoints(transaction, context) {
  const { identity, observedAt, limits, executionGraphKeys, executionStates } = context
  let rowCount = 0
  let malformedCount = 0
  let truncated = false
  let boundReached = false
  let checkpointRows = 0
  let blobRows = 0
  let writeRows = 0
  let unclassifiedThreads = 0
  let threadsOnInFlightExecutions = 0
  let threadsOnUnknownExecutions = 0
  const threads = new Map()
  const threadFor = (threadId, checkpointNs) => {
    const threadKey = `${threadId}\u0000${checkpointNs}`
    const thread = threads.get(threadKey) ?? {
      scope: checkpointNs,
      thread: threadId,
      blobRows: 0,
      checkpointRows: 0,
      writeRows: 0,
    }
    threads.set(threadKey, thread)
    return thread
  }
  try {
    const checkpointsScan = await scanTable(
      transaction,
      {
        table: OBSERVED_TABLES.langgraphCheckpoints,
        columns: ['thread_id', 'checkpoint_ns', 'checkpoint_id'],
        keyColumns: ['thread_id', 'checkpoint_ns', 'checkpoint_id'],
        keyTypes: ['text', 'text', 'text'],
        pageSize: limits.pageSize,
        maximumPages: limits.maximumPages,
      },
      (row) => {
        rowCount += 1
        const parsed = parseCheckpointRow(row)
        if (parsed === undefined) {
          malformedCount += 1
          return
        }
        checkpointRows += 1
        threadFor(parsed.thread, parsed.scope).checkpointRows += 1
      }
    )
    boundReached = checkpointsScan.boundReached
    const writesScan = await scanTable(
      transaction,
      {
        table: OBSERVED_TABLES.langgraphCheckpointWrites,
        columns: ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'idx'],
        keyColumns: ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'idx'],
        keyTypes: ['text', 'text', 'text', 'text', 'integer'],
        pageSize: limits.pageSize,
        maximumPages: limits.maximumPages,
      },
      (row) => {
        rowCount += 1
        const parsed = parseCheckpointRow(row)
        if (parsed === undefined) {
          malformedCount += 1
          return
        }
        writeRows += 1
        threadFor(parsed.thread, parsed.scope).writeRows += 1
      }
    )
    boundReached = writesScan.boundReached || boundReached
    const blobsScan = await scanTable(
      transaction,
      {
        table: OBSERVED_TABLES.langgraphCheckpointBlobs,
        columns: ['thread_id', 'checkpoint_ns', 'channel', 'version'],
        keyColumns: ['thread_id', 'checkpoint_ns', 'channel', 'version'],
        keyTypes: ['text', 'text', 'text', 'text'],
        pageSize: limits.pageSize,
        maximumPages: limits.maximumPages,
      },
      (row) => {
        rowCount += 1
        if (typeof row.thread_id !== 'string' || typeof row.checkpoint_ns !== 'string') {
          malformedCount += 1
          return
        }
        blobRows += 1
        // Register the blob's thread so blob-only threads join the same
        // classification walk as checkpoint and write rows below; an orphan
        // blob thread must surface as typed unknown state, never as a row
        // count with no thread behind it.
        threadFor(row.thread_id, row.checkpoint_ns).blobRows += 1
      }
    )
    boundReached = blobsScan.boundReached || boundReached
  } catch {
    return failedCheckpointsSection(identity, observedAt, limits)
  }
  const checkpointRowsByExecution = new Map()
  const entries = []
  for (const thread of threads.values()) {
    const parsed = parseCheckpointThread(thread.thread)
    const graphKey =
      parsed?.executionId === undefined ? undefined : executionGraphKeys.get(parsed.executionId)
    const onGraphExecution = graphKey !== undefined
    const executionState =
      parsed?.executionId === undefined ? undefined : executionStates?.get(parsed.executionId)
    const onInFlightExecution = executionState?.inFlight === true
    if (onInFlightExecution) threadsOnInFlightExecutions += 1
    if (parsed === undefined) unclassifiedThreads += 1
    else if (executionState === undefined) threadsOnUnknownExecutions += 1
    if (onGraphExecution)
      checkpointRowsByExecution.set(
        graphKey,
        (checkpointRowsByExecution.get(graphKey) ?? 0) +
          thread.checkpointRows +
          thread.writeRows +
          thread.blobRows
      )
    if (entries.length >= limits.entriesPerSection) {
      truncated = true
      continue
    }
    entries.push({
      blobRows: thread.blobRows,
      checkpointRows: thread.checkpointRows,
      durableOwner: 'langgraph-postgres-checkpointer',
      graphWorkflow: onGraphExecution,
      historyResponsibility:
        'graph resume state for the thread; retirement reports it and never transplants checkpoints between workflow generations',
      inFlight: onInFlightExecution,
      ...(parsed?.executionId === undefined ? {} : { executionId: parsed.executionId }),
      scope: thread.scope,
      thread: thread.thread,
      writeRows: thread.writeRows,
      ...(parsed?.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
    })
  }
  // Orphaned (execution unknown) or unparseable threads must surface as typed
  // incompleteness: their in-flight state is unknown, so they can never be
  // silently excluded from in-flight accounting or a zero-live-work claim.
  const unknownStateReasons = []
  if (unclassifiedThreads > 0) unknownStateReasons.push('CHECKPOINT_THREADS_UNCLASSIFIED')
  if (threadsOnUnknownExecutions > 0)
    unknownStateReasons.push('CHECKPOINT_THREADS_WITH_UNKNOWN_EXECUTION_STATE')
  return {
    ...sectionHeader(
      [
        OBSERVED_TABLES.langgraphCheckpoints,
        OBSERVED_TABLES.langgraphCheckpointBlobs,
        OBSERVED_TABLES.langgraphCheckpointWrites,
      ],
      identity,
      observedAt
    ),
    ...outcomeWithExtraReasons(
      sectionOutcome({
        attempted: true,
        readError: undefined,
        rowCount,
        malformedCount,
        truncated,
        boundReached,
        newestUpdatedAtValue: null,
        maxAgeDays: limits.maxAgeDays,
        observedAt,
      }),
      unknownStateReasons
    ),
    counts: {
      total: rowCount,
      checkpointRows,
      blobRows,
      writeRows,
      distinctThreads: threads.size,
      unclassifiedThreads,
      threadsOnInFlightExecutions,
      threadsOnUnknownExecutions,
    },
    entries: entries.toSorted(
      (left, right) =>
        compareCodePoint(left.scope, right.scope) || compareCodePoint(left.thread, right.thread)
    ),
    truncated,
    boundReached,
    countsBounded: boundReached,
    malformedRecords: malformedCount,
    internal: { checkpointRowsByExecution },
  }
}

function failedCheckpointsSection(identity, observedAt, limits) {
  return {
    ...sectionHeader(
      [
        OBSERVED_TABLES.langgraphCheckpoints,
        OBSERVED_TABLES.langgraphCheckpointBlobs,
        OBSERVED_TABLES.langgraphCheckpointWrites,
      ],
      identity,
      observedAt
    ),
    ...sectionOutcome({
      attempted: true,
      readError: 'TABLE_SCAN_FAILED',
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      boundReached: false,
      newestUpdatedAtValue: null,
      maxAgeDays: limits.maxAgeDays,
      observedAt,
    }),
    counts: { total: 0 },
    entries: [],
    truncated: false,
    boundReached: false,
    countsBounded: false,
    malformedRecords: 0,
  }
}

function parseCheckpointRow(row) {
  const { thread_id: thread, checkpoint_ns: scope, checkpoint_id: checkpointId } = row
  if (typeof thread !== 'string' || typeof scope !== 'string' || typeof checkpointId !== 'string')
    return undefined
  return { scope, thread, checkpointId }
}

/**
 * The managed runtime stores threads as `${workspaceId}:${executionId}:${threadId}`
 * (see storageThreadId in packages/langgraph-adapter). Identifier alphabets
 * exclude ':' but the caller-supplied threadId may contain colons, so the
 * first two separators delimit the identifiers and the rest is opaque;
 * anything else stays deliberately unclassified instead of guessed. Duplicated
 * from the reviewed script (not exported there) so both tools classify
 * identically.
 */
function parseCheckpointThread(thread) {
  const first = thread.indexOf(':')
  const second = first === -1 ? -1 : thread.indexOf(':', first + 1)
  if (first === -1 || second === -1) return undefined
  const workspaceId = thread.slice(0, first)
  const executionId = thread.slice(first + 1, second)
  if (!workspaceId.startsWith('wsp_') || !executionId.startsWith('exe_')) return undefined
  return { workspaceId, executionId }
}

/**
 * Receipt counts per graph reference, joined through the command result.
 *
 * A row contributes only when its receipt parses as the canonical
 * GraphDefinitionCommandReceiptSchema (every legitimate receipt carries a
 * PublishedGraphDefinition result) AND its identity matches the row — the same
 * rule PostgresGraphDefinitionCommandRepository.parseGraphDefinitionCommand-
 * Receipt enforces on replay. Missing, malformed or identity-mismatched rows
 * are counted as malformed evidence, never silently skipped, and a failed scan
 * is surfaced as a typed read error so the definitions section can propagate
 * either state into per-definition usage completeness and reasons instead of
 * reading exact zeros from an empty index.
 */
async function catalogCommandsByGraphIndex(transaction, context) {
  const index = new Map()
  let boundReached = false
  let malformedRecords = 0
  // Isolate this scan in a savepoint: a failed statement inside the single
  // repeatable-read snapshot would otherwise abort the whole transaction and
  // lose the definitions section entirely, so a catalog-index failure could
  // never reach per-definition usage reasons. Savepoints are transaction
  // control, not data writes — the observation stays read-only and
  // repeatable-read. If even the savepoint cannot be taken (the transaction is
  // already failed), the typed read error still propagates.
  try {
    await transaction.unsafe('savepoint catalog_command_index_scan')
  } catch {
    return {
      index: new Map(),
      boundReached: false,
      malformedRecords: 0,
      readError: 'TABLE_SCAN_FAILED',
    }
  }
  try {
    const commandsScan = await scanTable(
      transaction,
      {
        table: OBSERVED_TABLES.catalogCommands,
        columns: [
          'workspace_id',
          'caller_id',
          'operation',
          'idempotency_key',
          'payload_hash',
          'receipt',
        ],
        keyColumns: ['workspace_id', 'caller_id', 'operation', 'idempotency_key'],
        keyTypes: ['text', 'text', 'text', 'text'],
        pageSize: context.pageSize,
        maximumPages: context.maximumPages,
      },
      (row) => {
        const receipt = GraphDefinitionCommandReceiptSchema.safeParse(row.receipt)
        if (
          !receipt.success ||
          typeof row.workspace_id !== 'string' ||
          receipt.data.workspaceId !== row.workspace_id ||
          receipt.data.command.callerId !== row.caller_id ||
          receipt.data.command.operation !== row.operation ||
          receipt.data.command.idempotencyKey !== row.idempotency_key ||
          receipt.data.command.payloadHash !== row.payload_hash
        ) {
          malformedRecords += 1
          return
        }
        const reference = receipt.data.result.reference
        const key = `${row.workspace_id}\u0000${reference.graphDefinitionId}\u0000${reference.graphVersion}`
        index.set(key, (index.get(key) ?? 0) + 1)
      }
    )
    boundReached = commandsScan.boundReached
    await transaction.unsafe('release savepoint catalog_command_index_scan')
  } catch {
    // Roll back to the savepoint so the rest of the observation keeps its one
    // usable snapshot; a failure that cannot be rolled back leaves typed
    // failures for the downstream sections to surface themselves.
    try {
      await transaction.unsafe('rollback to savepoint catalog_command_index_scan')
    } catch {}
    return {
      index: new Map(),
      boundReached: false,
      malformedRecords: 0,
      readError: 'TABLE_SCAN_FAILED',
    }
  }
  // A bounded index scan makes every consumersObserved.catalogCommands number
  // a lower bound, and failed or unattributable receipt rows make the
  // attribution partial; the definitions section downgrades to incomplete in
  // either case instead of presenting partial attribution as observed fact.
  return { index, boundReached, malformedRecords, readError: undefined }
}

async function collectCancellationReceiptCount(transaction) {
  try {
    const rows = await transaction.unsafe(
      `select count(*) as count from ${OBSERVED_TABLES.cancellationReceipts}`
    )
    return toCount(rows[0]?.count)
  } catch {
    return null
  }
}

async function newestInstant(transaction, table, column) {
  try {
    const rows = await transaction.unsafe(`select max(${column}) as newest from ${table}`)
    return toInstant(rows[0]?.newest)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Manifest assembly
// ---------------------------------------------------------------------------

/**
 * Assembles the deployed-Postgres inventory manifest. Section shape mirrors
 * the reviewed SQLite manifest (status/reasons/counts/entries/truncated/
 * malformedRecords per section, consumersOutcome semantics, historyOwnership,
 * epistemics) so the reviewed disposition validator consumes this output
 * unchanged; the physical differences (source.backend 'postgres-dsn', source
 * tables instead of record-store namespaces, the extra blobRows checkpoint
 * count, and the boundReached/countsBounded flags) are additive.
 */
export function buildInventoryManifestFromSections({
  observationScope,
  observedAt,
  limits,
  identity,
  storeProfile,
  sections,
  cancellationReceiptCount,
  sourceRevision = 'unspecified',
}) {
  if (!OBSERVATION_SCOPES.includes(observationScope))
    throw new RetirementInventoryPgError('INVALID_OBSERVATION_SCOPE')
  return {
    manifest: MANIFEST_NAME,
    manifestVersion: MANIFEST_VERSION,
    observedAt,
    observationScope,
    observationScopeRule: OBSERVATION_SCOPE_RULE,
    sourceRevision,
    tool: {
      script: 'scripts/langgraph-retirement-inventory-pg.mjs',
      readMode: 'read-only',
      transactionMode: 'repeatable read, read only (one snapshot for the whole observation)',
      migration: 'never',
      mutations: 'none',
      adoption: 'never',
      cancellation: 'never',
      draining: 'never',
      checkpointTransplant: 'never',
    },
    limits: {
      entriesPerSection: limits.entriesPerSection,
      maxAgeDays: limits.maxAgeDays,
      pageSize: limits.pageSize,
      maximumPages: limits.maximumPages,
    },
    traceability: {
      issue: 'adea-ai/control-plane#938',
      milestone: 'M16.01',
      requirementIds: ['010', '160', '161', '170', '173'],
      tests: ['A28', 'A30', 'A32'],
    },
    store: {
      backend: 'postgres-dsn',
      identity,
      ...(storeProfile ?? {
        status: OBSERVATION_STATUS.INACCESSIBLE,
        schemaVersion: null,
        reasons: ['STORE_UNAVAILABLE'],
      }),
    },
    sections: {
      definitions: sections.definitions,
      consumers: sections.consumers,
      executions: sections.executions,
      checkpoints: sections.checkpoints,
    },
    historyOwnership: {
      catalogCommands:
        'graph_definition_commands receipts are the append-only publication history of the deployed catalog',
      cancellationReceipts: {
        count: cancellationReceiptCount,
        table: OBSERVED_TABLES.cancellationReceipts,
        responsibility:
          'operator cancel intent recorded by PostgresExecutionCancellationRepository; counted, never replayed or applied',
      },
      durableOwner: 'control-plane-postgres-persistence (one deployed database per observation)',
      executionHistory:
        'executions, execution_attempts and execution_events tables; deletion is governed by retention classes and holds, not by this tool',
      graphCheckpoints:
        'checkpoints / checkpoint_blobs / checkpoint_writes owned by the LangGraph Postgres checkpointer; counted only, never transplanted',
      responsibilities:
        'This manifest reports ownership only; it never adopts, cancels, drains or transplants anything.',
    },
    epistemics: retainedWorkEpistemics({
      observationScope,
      executions: sections.executions,
      checkpoints: sections.checkpoints,
    }),
    historicalDecisionReconciliation: {
      items: [
        {
          decision: 'M8 multi-agent orchestration — LangGraph orchestration adoption',
          reference:
            'tests/m8-multi-agent-orchestration.test.mjs; docs/requirements/control-plane-prd-atomic-inventory.md (CPPRD-287 roadmap boundary)',
          reconciliation: 'reported-only',
          reason:
            'historical Effect decision lineage requires operator confirmation; no automatic adoption',
          status: OBSERVATION_STATUS.UNKNOWN,
        },
        {
          decision: 'CP-M14 Effect Migration decisions',
          reference:
            'docs/requirements/control-plane-prd-atomic-inventory.md CPPRD-287 (CP-M13/CP-M14 local milestones)',
          reconciliation: 'reported-only',
          reason: 'no automatic adoption, cancellation, or checkpoint transplantation',
          status: OBSERVATION_STATUS.UNKNOWN,
        },
      ],
      observedAt,
      status: OBSERVATION_STATUS.UNKNOWN,
    },
  }
}

/**
 * Runs the full read-only observation against one DSN and returns the
 * manifest. `observedAt` must be a normalized ISO instant; `limits` carries
 * entriesPerSection / maxAgeDays / pageSize.
 */
export async function collectInventoryManifest({
  dsn,
  identity = dsnIdentity(dsn),
  observationScope,
  observedAt,
  limits = {},
  sourceRevision = 'unspecified',
}) {
  const normalizedLimits = normalizeLimits(limits)
  let storeProfile = null
  let sections = emptySections(observedAt, normalizedLimits)
  let cancellationReceiptCount = null
  if (dsn === undefined) {
    // Repository-scope observation: no store is contacted, mirroring the
    // reviewed tool's attempted:false sections over its registry-only
    // consumers section.
    storeProfile = {
      status: OBSERVATION_STATUS.INACCESSIBLE,
      schemaVersion: null,
      reasons: ['STORE_UNAVAILABLE'],
    }
    return buildInventoryManifestFromSections({
      observationScope,
      observedAt,
      limits: normalizedLimits,
      identity: null,
      storeProfile,
      sections,
      cancellationReceiptCount,
      sourceRevision,
    })
  }
  try {
    await observeReadOnly(dsn, async (transaction) => {
      storeProfile = await readStoreProfile(transaction)
      const storeAvailable = storeProfile.status === OBSERVATION_STATUS.OBSERVED
      if (!storeAvailable) return
      const scanContext = {
        pageSize: normalizedLimits.pageSize,
        maximumPages: normalizedLimits.maximumPages,
      }

      const planIndex = await collectPlanGraphReferences(transaction, scanContext)
      const executions = await collectExecutions(transaction, {
        identity,
        observedAt,
        limits: normalizedLimits,
        planIndex,
        ...scanContext,
      })
      const { internal: executionInternals, ...executionsPublic } = executions
      const executionGraphKeys = executionInternals?.executionGraphKeys ?? new Map()
      const executionStatesById = executionInternals?.executionStatesById ?? new Map()

      const catalogCallers = await collectCatalogCallers(transaction, {
        observedAt,
        limits: normalizedLimits,
        ...scanContext,
      })

      const checkpoints = await collectCheckpoints(transaction, {
        identity,
        observedAt,
        limits: normalizedLimits,
        executionGraphKeys,
        executionStates: executionStatesById,
        ...scanContext,
      })
      const { internal: checkpointInternals, ...checkpointsPublic } = checkpoints
      const checkpointRowsByGraph = checkpointInternals?.checkpointRowsByExecution ?? new Map()

      const catalogCommandsIndex = await catalogCommandsByGraphIndex(transaction, scanContext)
      const definitions = await collectDefinitions(transaction, {
        identity,
        observedAt,
        limits: normalizedLimits,
        executionsByGraph: executionInternals?.executionsByGraph ?? new Map(),
        checkpointRowsByExecution: checkpointRowsByGraph,
        catalogCommandsByGraph: catalogCommandsIndex.index,
        catalogCommandsIndexBoundReached: catalogCommandsIndex.boundReached,
        catalogCommandsIndexReadError: catalogCommandsIndex.readError,
        catalogCommandsIndexMalformedRecords: catalogCommandsIndex.malformedRecords,
        // Definition-level usage inherits its feeding scans' incompleteness: a
        // bounded, failed or malformed catalog-command index and a bounded or
        // failed executions/checkpoint scan must never surface as exact
        // per-definition usage counts.
        executionsUsageComplete: usageSourceFullyRead(executions),
        checkpointsUsageComplete: usageSourceFullyRead(checkpoints),
        ...scanContext,
      })

      // The entry cap applies to the whole consumers section — curated
      // registry and observed callers together — while counts stay computed
      // over the full scan, so bounding never changes any total. The curated
      // registry is always present, so the section never reports 'zero'.
      const consumersTotal = KNOWN_CONSUMERS.length + catalogCallers.distinctCallers
      const consumerEntries = [
        ...KNOWN_CONSUMERS.map((consumer) => ({
          ...consumer,
          profile: { ...consumer.profile },
          observation: { evidence: 'curated-registry', observedAt, origin: 'repository-scan' },
        })),
        ...catalogCallers.entries,
      ]
        .toSorted((left, right) => compareCodePoint(left.consumerId, right.consumerId))
        .slice(0, normalizedLimits.entriesPerSection)
      const consumersOutcomeBase = sectionOutcome({
        attempted: true,
        readError: catalogCallers.readError,
        rowCount: catalogCallers.rowCount,
        malformedCount: catalogCallers.malformedCount,
        truncated: consumersTotal > normalizedLimits.entriesPerSection,
        boundReached: catalogCallers.boundReached,
        newestUpdatedAtValue: null,
        maxAgeDays: normalizedLimits.maxAgeDays,
        observedAt,
      })
      const consumersStatus =
        consumersOutcomeBase.status === OBSERVATION_STATUS.ZERO
          ? OBSERVATION_STATUS.OBSERVED
          : consumersOutcomeBase.status
      const consumers = {
        observedAt,
        source: {
          backend: 'postgres-dsn',
          identity,
          tables: [OBSERVED_TABLES.catalogCommands],
        },
        status: consumersStatus,
        reasons: consumersOutcomeBase.reasons,
        truncated: consumersTotal > normalizedLimits.entriesPerSection,
        boundReached: catalogCallers.boundReached,
        countsBounded: catalogCallers.boundReached,
        malformedRecords: catalogCallers.malformedCount,
        counts: {
          registered: KNOWN_CONSUMERS.length,
          catalogCommandReceipts: catalogCallers.rowCount,
          distinctCatalogCallers: catalogCallers.distinctCallers,
        },
        entries: consumerEntries,
      }

      cancellationReceiptCount = await collectCancellationReceiptCount(transaction)
      sections = {
        definitions,
        consumers,
        executions: executionsPublic,
        checkpoints: checkpointsPublic,
      }
    })
  } catch {
    // Connection-level failure (unreachable server, refused, auth): a typed
    // observation result, never a crash and never zero. The store profile
    // stays unavailable and every section reports unknown.
    storeProfile = {
      status: OBSERVATION_STATUS.INACCESSIBLE,
      schemaVersion: null,
      reasons: ['CONNECTION_FAILED'],
    }
  }
  return buildInventoryManifestFromSections({
    observationScope,
    observedAt,
    limits: normalizedLimits,
    identity,
    storeProfile,
    sections,
    cancellationReceiptCount,
    sourceRevision,
  })
}

function emptySections(observedAt, limits) {
  return {
    definitions: emptyDefinitionsSection(observedAt, limits),
    consumers: emptyConsumersSection(observedAt),
    executions: emptyExecutionsSection(observedAt, limits),
    checkpoints: emptyCheckpointsSection(observedAt, limits),
  }
}

function emptyDefinitionsSection(observedAt, limits) {
  return {
    ...sectionHeader([OBSERVED_TABLES.definitions], null, observedAt),
    ...sectionOutcome({
      attempted: false,
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      boundReached: false,
      newestUpdatedAtValue: null,
      maxAgeDays: limits.maxAgeDays,
      observedAt,
    }),
    counts: { total: 0, identityMismatches: 0 },
    entries: [],
    truncated: false,
    boundReached: false,
    malformedRecords: 0,
  }
}

function emptyConsumersSection(observedAt) {
  return {
    observedAt,
    source: { backend: 'postgres-dsn', identity: null, tables: [] },
    status: OBSERVATION_STATUS.UNKNOWN,
    reasons: ['SOURCE_NOT_IN_OBSERVATION_SCOPE', 'CURATED_REGISTRY_ONLY'],
    truncated: false,
    boundReached: false,
    countsBounded: false,
    malformedRecords: 0,
    counts: {
      registered: KNOWN_CONSUMERS.length,
      catalogCommandReceipts: 0,
      distinctCatalogCallers: 0,
    },
    entries: [],
  }
}

function emptyExecutionsSection(observedAt, limits) {
  return {
    ...sectionHeader(
      [OBSERVED_TABLES.executions, OBSERVED_TABLES.executionPlans],
      null,
      observedAt
    ),
    ...sectionOutcome({
      attempted: false,
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      boundReached: false,
      newestUpdatedAtValue: null,
      maxAgeDays: limits.maxAgeDays,
      observedAt,
    }),
    counts: {
      total: 0,
      inFlight: 0,
      terminal: 0,
      inFlightAttributed: 0,
      inFlightPlansWithMalformedGraphIdentity: 0,
      inFlightNonGraph: 0,
      inFlightPlansMissing: 0,
    },
    entries: [],
    truncated: false,
    boundReached: false,
    malformedRecords: 0,
  }
}

function emptyCheckpointsSection(observedAt, limits) {
  return {
    ...sectionHeader(
      [
        OBSERVED_TABLES.langgraphCheckpoints,
        OBSERVED_TABLES.langgraphCheckpointBlobs,
        OBSERVED_TABLES.langgraphCheckpointWrites,
      ],
      null,
      observedAt
    ),
    ...sectionOutcome({
      attempted: false,
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      boundReached: false,
      newestUpdatedAtValue: null,
      maxAgeDays: limits.maxAgeDays,
      observedAt,
    }),
    counts: { total: 0 },
    entries: [],
    truncated: false,
    boundReached: false,
    malformedRecords: 0,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `langgraph-retirement-inventory-pg — M16.01 read-only deployed-PostgreSQL inventory

Usage:
  bun scripts/langgraph-retirement-inventory-pg.mjs --observation-scope deployed-dsn --dsn <dsn> [options]

Required:
  --observation-scope <repository-scan|local-disposable-store|deployed-dsn>
      Explicit observation scope. 'deployed-dsn' is an operator attestation
      that the target is the deployed store; only that scope can ever permit
      the global none-observed-in-scope classification.

Read-only store access:
  --dsn <dsn>               PostgreSQL connection string. Required unless the
                            scope is repository-scan (where it must be
                            absent). Falls back to LANGGRAPH_RETIREMENT_PG_DSN,
                            then DATABASE_URL, in that order; there is no
                            default target. Opened read-only (one REPEATABLE
                            READ, READ ONLY snapshot transaction — one
                            connection is one snapshot for the whole
                            observation), never migrated, never written.

Options:
  --now <iso-instant>       Observation time (injectable for deterministic runs).
  --limit <n>               Maximum emitted entries per section (1-1000, default 100).
                            Counts stay exact; truncation is flagged.
  --page-size <n>           Keyset page size (1-128, default 64).
  --max-pages <n>           Pagination bound per scanned table (1-4096, default 4096).
                            A bound hit flags the affected sections incomplete.
  --max-age-days <n>        Freshness threshold for the stale status (default 30).
  --source-revision <sha>   Repository revision the curated registry was verified against.
  --help                    Show this text.

Output: a single deterministic JSON manifest on stdout, shaped like the
reviewed scripts/langgraph-retirement-inventory.mjs manifest so its
disposition validator consumes this output unchanged. Failures print one
sanitized LANGGRAPH_RETIREMENT_INVENTORY_PG_FAILED:<CODE> line on stderr.
The tool never prints DSNs, hosts, database names, credentials, paths,
record payloads, or lifecycle-reason free text (reasons surface only as a
presence indicator); the store identity is a SHA-256 digest of the
credential-free DSN origin.
`

export async function runInventoryPgCli({
  argv,
  now,
  environment = process.env,
  stdout = process.stdout,
} = {}) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean' },
        'observation-scope': { type: 'string' },
        dsn: { type: 'string' },
        now: { type: 'string' },
        limit: { type: 'string' },
        'page-size': { type: 'string' },
        'max-pages': { type: 'string' },
        'max-age-days': { type: 'string' },
        'source-revision': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }))
  } catch {
    throw new RetirementInventoryPgError('INVALID_ARGUMENTS')
  }
  if (values.help === true) {
    stdout.write(HELP_TEXT)
    return { action: 'help', exitCode: 0 }
  }
  const observationScope = values['observation-scope']
  if (typeof observationScope !== 'string' || !OBSERVATION_SCOPES.includes(observationScope))
    throw new RetirementInventoryPgError('INVALID_OBSERVATION_SCOPE')
  if (observationScope === 'repository-scan') {
    if (values.dsn !== undefined)
      throw new RetirementInventoryPgError('DSN_NOT_ALLOWED_FOR_REPOSITORY_SCAN')
    // A repository scan observes no store: emit the registry-only manifest so
    // downstream consumers see one uniform shape.
    const observedAt = normalizeObservedAt(
      values.now ?? (typeof now === 'function' ? now() : new Date().toISOString())
    )
    const manifest = await collectInventoryManifest({
      dsn: undefined,
      identity: null,
      observationScope,
      observedAt,
      limits: cliLimits(values),
      ...(values['source-revision'] === undefined
        ? {}
        : { sourceRevision: values['source-revision'] }),
    })
    stdout.write(`${stableJsonStringify(manifest)}\n`)
    return { action: 'manifest', manifest, exitCode: 0 }
  }
  const dsn = resolveDsn({ dsnArgument: values.dsn, environment })
  const observedAt = normalizeObservedAt(
    values.now ?? (typeof now === 'function' ? now() : new Date().toISOString())
  )
  const manifest = await collectInventoryManifest({
    dsn,
    observationScope,
    observedAt,
    limits: cliLimits(values),
    ...(values['source-revision'] === undefined
      ? {}
      : { sourceRevision: values['source-revision'] }),
  })
  stdout.write(`${stableJsonStringify(manifest)}\n`)
  return { action: 'manifest', manifest, exitCode: 0 }
}

function cliLimits(values) {
  return {
    entriesPerSection:
      values.limit === undefined
        ? undefined
        : boundedInteger(values.limit, 'INVALID_ENTRY_LIMIT', 1000),
    maxAgeDays:
      values['max-age-days'] === undefined
        ? undefined
        : boundedInteger(values['max-age-days'], 'INVALID_MAX_AGE_DAYS', 3650),
    pageSize:
      values['page-size'] === undefined
        ? undefined
        : boundedInteger(values['page-size'], 'INVALID_PAGE_SIZE', 128),
    maximumPages:
      values['max-pages'] === undefined
        ? undefined
        : boundedInteger(values['max-pages'], 'INVALID_MAXIMUM_PAGES', 4096),
  }
}

function normalizeObservedAt(value) {
  if (typeof value !== 'string' || value.length === 0)
    throw new RetirementInventoryPgError('INVALID_OBSERVED_AT')
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new RetirementInventoryPgError('INVALID_OBSERVED_AT')
  return parsed.toISOString()
}

function boundedInteger(value, code, maximum) {
  if (!/^\d+$/.test(value)) throw new RetirementInventoryPgError(code)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new RetirementInventoryPgError(code)
  return parsed
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    await runInventoryPgCli({
      argv: process.argv.slice(2),
      now: () => new Date().toISOString(),
    })
  } catch (error) {
    const code = error instanceof RetirementInventoryPgError ? error.code : 'OPERATION_FAILED'
    process.stderr.write(`LANGGRAPH_RETIREMENT_INVENTORY_PG_FAILED:${code}\n`)
    process.exitCode = 1
  }
}
