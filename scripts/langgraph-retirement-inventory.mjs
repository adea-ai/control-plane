// M16.01 (#938) read-only retirement inventory for retained graph workflows.
//
// The command inventories one SQLite control-plane store (deployed snapshot or
// disposable local store) through a strictly read-only database handle and
// emits a bounded, deterministic JSON manifest covering: workflow definitions,
// known catalog consumers, and retained/in-flight executions plus the graph
// checkpoints that keep them resumable.
//
// Epistemics contract (the core requirement): every section carries a typed
// observation status — observed | zero | unknown | inaccessible | incomplete |
// stale — with reasons. A repository scan or a disposable local store can
// NEVER establish that production has zero retained work; the global
// "none-observed-in-scope" classification is emitted only for an explicitly
// attested deployed-dsn observation whose in-flight sections were read in
// full. Orphaned or unparseable checkpoint threads report unknown in-flight
// state and block every zero claim. Anything less reports "unknown" with the
// scope rule attached.
//
// Safety: the tool opens the store read-only, never migrates, never writes,
// never prints or embeds store paths or credentials, and never adopts,
// cancels, drains or transplants anything. Disposition validation is a pure
// report; it changes nothing.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { Database } from 'bun:sqlite'
// Canonical validation sources: the same contracts the execution-plan
// compiler enforces when it writes and retains a plan. Validity of a
// retained plan's integrity (canonical digest, derived plan id, schema
// shape) and of its graph identity is decided by these contracts, never by
// ad-hoc truthiness.
import { GraphReferenceSchema } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'

export const OBSERVATION_STATUS = Object.freeze({
  OBSERVED: 'observed',
  ZERO: 'zero',
  UNKNOWN: 'unknown',
  INACCESSIBLE: 'inaccessible',
  INCOMPLETE: 'incomplete',
  STALE: 'stale',
})

export const OBSERVATION_SCOPES = Object.freeze([
  'repository-scan',
  'local-disposable-store',
  'deployed-dsn',
])

export const DISPOSITION_KINDS = Object.freeze(['keep', 'replace', 'drain', 'retire'])

const NAMESPACES = Object.freeze({
  definitions: 'graph-definitions',
  catalogCommands: 'graph-definition-commands',
  executions: 'executions',
  executionPlans: 'execution-plans',
  cancellationReceipts: 'execution-cancellation-receipts',
  langgraphCheckpoints: 'langgraph-checkpoints-v1',
})

const TERMINAL_EXECUTION_STATES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

const DEFAULT_LIMITS = Object.freeze({
  entriesPerSection: 100,
  maximumEntriesPerSection: 1000,
  pageSize: 64,
  maxAgeDays: 30,
})

const MANIFEST_NAME = 'langgraph-retirement-inventory'
const MANIFEST_VERSION = 1

/**
 * Curated consumer registry from the M16.01 repository search. These are
 * code-level facts (evidence: curated-registry); the store scan contributes
 * the catalog-command callers observed in the inventoried store. The registry
 * cannot prove that no other consumer exists — a zero caller count is a
 * store-scoped observation, never a global claim.
 */
export const KNOWN_CONSUMERS = Object.freeze([
  {
    consumerId: 'managed-local-graph-runtime',
    kind: 'in-process-graph-runtime',
    source: 'apps/local-control-plane/src/managed-graph-runtime.ts',
    profile: {
      catalogAccess: 'SqliteGraphDefinitionRepository via GraphDefinitionCatalog',
      admission: 'GraphDefinitionExecutionAuthority',
      checkpoints: 'langgraph-checkpoints-v1 scope managed-graphs (LangGraphSqliteCheckpointSaver)',
    },
  },
  {
    consumerId: 'local-graph-tool-operations',
    kind: 'graph-tool-invocation-path',
    source: 'apps/local-control-plane/src/local-graph-tool-operations.ts',
    profile: {
      catalogAccess: 'SqliteGraphDefinitionRepository via GraphDefinitionCatalog',
      admission: 'GraphDefinitionExecutionAuthority',
      checkpoints: 'langgraph-checkpoints-v1 scope managed-graphs (LangGraphSqliteCheckpointSaver)',
    },
  },
  {
    consumerId: 'langgraph-orchestration-adapter',
    kind: 'orchestration-adapter',
    source: 'packages/langgraph-adapter/src/index.ts',
    profile: {
      catalogAccess: 'CatalogBackedGraphDefinitionResolver (resolveForNewExecution/getPinned)',
      checkpoints: 'checkpointer injected per composition',
    },
  },
  {
    consumerId: 'postgres-graph-definition-repository',
    kind: 'cloud-catalog-repository',
    source: 'packages/database/src/graph-definition-repository.ts',
    profile: {
      catalogAccess: 'Postgres graph catalog tables (deployed DSN; outside this sqlite scan)',
      checkpoints: 'not covered by this scan',
    },
  },
])

export class RetirementInventoryError extends Error {
  constructor(code) {
    super(code)
    this.name = 'RetirementInventoryError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Read-only store access
// ---------------------------------------------------------------------------

/**
 * Opens the store strictly read-only. Same target discipline as
 * scripts/retention-report.mjs: absolute path, regular file, never a symlink.
 * The database handle is never used for writes and migrations are never run.
 */
export async function openReadOnlyStore(storePath) {
  if (typeof storePath !== 'string' || storePath.length === 0)
    throw new RetirementInventoryError('STORE_PATH_REQUIRED')
  if (!isAbsolute(storePath)) throw new RetirementInventoryError('STORE_PATH_NOT_ABSOLUTE')
  const stat = await lstat(storePath).catch(() => undefined)
  if (stat === undefined) throw new RetirementInventoryError('STORE_FILE_MISSING')
  if (!stat.isFile()) throw new RetirementInventoryError('STORE_NOT_A_FILE')
  if (stat.isSymbolicLink()) throw new RetirementInventoryError('STORE_PATH_IS_SYMLINK')
  let database
  try {
    database = new Database(storePath, { readonly: true })
  } catch {
    throw new RetirementInventoryError('STORE_UNREADABLE')
  }
  return {
    database,
    identity: `sha256:${createHash('sha256').update(storePath).digest('hex')}`,
  }
}

/**
 * Preflight over the raw schema. Never migrates: an uninitialized or
 * incompatible store is reported as inaccessible with typed reasons instead of
 * being upgraded.
 */
export function readStoreProfile(database) {
  try {
    const recordsTable = database
      .query(
        "select name from sqlite_master where type = 'table' and name = 'control_plane_records'"
      )
      .get()
    if (recordsTable === undefined)
      return {
        status: OBSERVATION_STATUS.INACCESSIBLE,
        schemaVersion: null,
        reasons: ['RECORDS_TABLE_MISSING'],
      }
    const metadataTable = database
      .query(
        "select name from sqlite_master where type = 'table' and name = 'control_plane_metadata'"
      )
      .get()
    if (metadataTable === undefined)
      return {
        status: OBSERVATION_STATUS.INACCESSIBLE,
        schemaVersion: null,
        reasons: ['METADATA_TABLE_MISSING'],
      }
    const version = database
      .query("select value from control_plane_metadata where key = 'schema_version'")
      .get()
    if (version === undefined || typeof version.value !== 'string')
      return {
        status: OBSERVATION_STATUS.INACCESSIBLE,
        schemaVersion: null,
        reasons: ['SCHEMA_VERSION_UNREADABLE'],
      }
    return { status: OBSERVATION_STATUS.OBSERVED, schemaVersion: version.value, reasons: [] }
  } catch {
    return {
      status: OBSERVATION_STATUS.INACCESSIBLE,
      schemaVersion: null,
      reasons: ['NOT_A_SQLITE_STORE'],
    }
  }
}

function countRecords(database, namespace) {
  return database
    .query('select count(*) as count from control_plane_records where namespace = ?1')
    .get(namespace).count
}

function newestUpdatedAt(database, namespaces) {
  const placeholders = namespaces.map((_, index) => `?${index + 1}`).join(', ')
  const row = database
    .query(
      `select max(updated_at) as newest from control_plane_records where namespace in (${placeholders})`
    )
    .get(...namespaces)
  return typeof row?.newest === 'string' ? row.newest : null
}

/**
 * Bounded page walk over one namespace in record-id order. The callback
 * receives every record; bounding of emitted entries is the caller's decision,
 * so counts stay exact even when entries are truncated.
 */
export function scanNamespaceRecords(database, namespace, options, onRecord) {
  const pageSize = boundedPageSize(options?.pageSize)
  const firstQuery = database.query(
    'select id, revision, value, updated_at from control_plane_records where namespace = ?1 order by id limit ?2'
  )
  const pageQuery = database.query(
    'select id, revision, value, updated_at from control_plane_records where namespace = ?1 and id > ?2 order by id limit ?3'
  )
  let afterId = null
  let scanned = 0
  while (true) {
    const rows =
      afterId === null
        ? firstQuery.all(namespace, pageSize)
        : pageQuery.all(namespace, afterId, pageSize)
    if (rows.length === 0) break
    for (const row of rows) {
      onRecord({
        id: row.id,
        revision: row.revision,
        value: parseStoredJson(row.value),
        updatedAt: row.updated_at,
      })
      scanned += 1
    }
    if (rows.length < pageSize) break
    afterId = rows[rows.length - 1].id
  }
  return scanned
}

function boundedPageSize(pageSize) {
  const value = pageSize ?? DEFAULT_LIMITS.pageSize
  if (!Number.isSafeInteger(value) || value < 1 || value > 128)
    throw new RetirementInventoryError('INVALID_PAGE_SIZE')
  return value
}

function parseStoredJson(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Section collectors
// ---------------------------------------------------------------------------

function sectionHeader(namespaces, identity, observedAt) {
  return {
    observedAt,
    source: {
      backend: 'sqlite-file',
      identity,
      namespaces: [...namespaces].toSorted(),
    },
  }
}

function sectionOutcome({
  attempted,
  readError,
  rowCount,
  malformedCount,
  truncated,
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

/** Inventory of graph-catalog definitions, version by version. */
function collectDefinitions(database, context) {
  const {
    identity,
    observedAt,
    limits,
    executionsByGraph,
    checkpointRowsByExecution,
    catalogCommandsByGraph,
  } = context
  let rowCount = 0
  let malformedCount = 0
  let truncated = false
  const workspaces = new Set()
  const lifecycles = new Map()
  const graphs = new Set()
  const entries = []
  try {
    scanNamespaceRecords(database, NAMESPACES.definitions, context, (record) => {
      rowCount += 1
      const definition = parseDefinitionRecord(record.value)
      if (definition === undefined) {
        malformedCount += 1
        return
      }
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
          recordRevision: record.revision,
        },
        graphDefinitionId: definition.graphDefinitionId,
        graphVersion: definition.graphVersion,
        historyResponsibility:
          'publication history retained as graph-definition-commands receipts; execution history stays in the execution namespaces',
        lifecycle: definition.lifecycle,
        observedAt,
        publishedAt: definition.publishedAt,
        ...(definition.reason === undefined ? {} : { reason: definition.reason }),
        runtimeProfile: definition.runtimeProfile,
        consumersObserved: {
          catalogCommands: catalogCommandsByGraph.get(graphKey) ?? 0,
          checkpointRows: checkpointRowsByExecution.get(graphKey) ?? 0,
          inFlightExecutions: executionUsage.inFlight,
          retainedExecutions: executionUsage.retained,
        },
        workspaceId: definition.workspaceId,
      })
    })
  } catch {
    return failedDefinitionsSection(identity, observedAt, limits)
  }
  return {
    ...sectionHeader([NAMESPACES.definitions], identity, observedAt),
    ...sectionOutcome({
      attempted: true,
      readError: undefined,
      rowCount,
      malformedCount,
      truncated,
      newestUpdatedAtValue: newestUpdatedAt(database, [NAMESPACES.definitions]),
      maxAgeDays: limits.maxAgeDays,
      observedAt,
    }),
    counts: {
      total: rowCount,
      workspaces: workspaces.size,
      distinctGraphs: graphs.size,
      byLifecycle: mapCountsToObject(lifecycles),
    },
    entries: entries.toSorted(
      (left, right) =>
        compareCodePoint(left.workspaceId, right.workspaceId) ||
        compareCodePoint(left.graphDefinitionId, right.graphDefinitionId) ||
        compareCodePoint(left.graphVersion, right.graphVersion)
    ),
    truncated,
    malformedRecords: malformedCount,
  }
}

function failedDefinitionsSection(identity, observedAt, limits) {
  return {
    ...sectionHeader([NAMESPACES.definitions], identity, observedAt),
    ...sectionOutcome({
      attempted: true,
      readError: 'NAMESPACE_SCAN_FAILED',
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      newestUpdatedAtValue: null,
      maxAgeDays: limits.maxAgeDays,
      observedAt,
    }),
    counts: { total: 0 },
    entries: [],
    truncated: false,
    malformedRecords: 0,
  }
}

function mapCountsToObject(counter) {
  return Object.fromEntries(
    [...counter.entries()].toSorted((left, right) => compareCodePoint(left[0], right[0]))
  )
}

function parseDefinitionRecord(value) {
  if (value === null) return undefined
  const workspaceId = value.workspaceId
  const graphDefinitionId = value.graphDefinitionId
  const graphVersion = value.graphVersion
  const version = value.version
  if (
    typeof workspaceId !== 'string' ||
    typeof graphDefinitionId !== 'string' ||
    typeof graphVersion !== 'string' ||
    version === null ||
    typeof version !== 'object'
  )
    return undefined
  const reference = version.reference
  const content = version.content
  if (reference === null || typeof reference !== 'object') return undefined
  if (content === null || typeof content !== 'object') return undefined
  const lifecycle = version.lifecycle
  if (lifecycle !== 'published' && lifecycle !== 'deprecated' && lifecycle !== 'revoked')
    return undefined
  const compatibility = content.compatibility ?? {}
  const operations = new Set()
  for (const node of Array.isArray(content.nodes) ? content.nodes : []) {
    const kind = node?.operation?.kind
    if (typeof kind === 'string') operations.add(kind)
  }
  return {
    workspaceId,
    graphDefinitionId,
    graphVersion,
    contentDigest:
      typeof reference.contentDigest === 'string' ? reference.contentDigest : 'unknown',
    lifecycle,
    definitionRevision: typeof version.revision === 'number' ? version.revision : 0,
    publishedAt: typeof version.publishedAt === 'string' ? version.publishedAt : 'unknown',
    changedAt: typeof version.changedAt === 'string' ? version.changedAt : 'unknown',
    ...(typeof version.reason === 'string' ? { reason: version.reason } : {}),
    runtimeProfile: {
      schemaVersion: typeof content.schemaVersion === 'number' ? content.schemaVersion : null,
      nodeCount: Array.isArray(content.nodes) ? content.nodes.length : 0,
      operationKinds: [...operations].toSorted(),
      requiredCapabilities: (Array.isArray(content.requiredCapabilities)
        ? content.requiredCapabilities
        : []
      )
        .filter((capability) => typeof capability === 'string')
        .toSorted(),
      compatibility: {
        contractMajorVersions: (Array.isArray(compatibility.contractMajorVersions)
          ? compatibility.contractMajorVersions
          : []
        ).filter((entry) => typeof entry === 'number'),
        compilerVersions: (Array.isArray(compatibility.compilerVersions)
          ? compatibility.compilerVersions
          : []
        )
          .filter((entry) => typeof entry === 'string')
          .toSorted(),
        adapterVersions: (Array.isArray(compatibility.adapterVersions)
          ? compatibility.adapterVersions
          : []
        )
          .filter((entry) => typeof entry === 'string')
          .toSorted(),
      },
    },
  }
}

/** Store-derived catalog consumers: the command receipts the catalog wrote. */
function collectCatalogCallers(database, context) {
  const { observedAt, limits } = context
  let rowCount = 0
  let malformedCount = 0
  let truncated = false
  const callers = new Map()
  try {
    scanNamespaceRecords(database, NAMESPACES.catalogCommands, context, (record) => {
      rowCount += 1
      const command = record.value?.command
      const callerId = command?.callerId
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
      if (typeof command.operation === 'string') caller.operations.add(command.operation)
      if (typeof record.value?.workspaceId === 'string')
        caller.workspaces.add(record.value.workspaceId)
      callers.set(callerId, caller)
    })
  } catch {
    return {
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      readError: 'NAMESPACE_SCAN_FAILED',
      distinctCallers: 0,
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
      source: `store-namespace:${NAMESPACES.catalogCommands}`,
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
    readError: undefined,
    // Distinct callers are counted over the full scan; the entry list is the
    // only bounded surface.
    distinctCallers: callers.size,
    entries: entries.toSorted((left, right) => compareCodePoint(left.consumerId, right.consumerId)),
  }
}

/**
 * Execution plans index: the only durable graph reference on the execution
 * path. Canonical validation — the plan compiler's own contracts — decides
 * what a retained plan record means, never ad-hoc truthiness:
 * - Canonical plan integrity first: the record must satisfy the compiler's
 *   plan schema with its own digest constraints (the retained contentDigest
 *   must be the hash of the canonical content and the plan id must derive
 *   from it). A record that fails — because its graph selection was deleted,
 *   its content was edited after the digest was retained, or its shape is
 *   no longer canonical — is corrupted evidence.
 * - A canonically intact plan carrying a graph selection validates that
 *   selection against GraphReferenceSchema; a missing or blank
 *   graphDefinitionId, a nonempty but invalid graphVersion, or a malformed
 *   contentDigest is malformed identity.
 * - A canonically intact plan with no graph selection at all is a legal
 *   non-graph workflow — counted separately (inFlightNonGraph) once the
 *   execution's full plan pin also matches (see collectExecutions).
 * Everything else is attribution-incomplete evidence that conservatively
 * blocks retirement: it is never silently excluded or benignly bucketed as
 * an unknown graph or a non-graph workflow.
 */
function collectPlanGraphReferences(database, context) {
  const planGraphs = new Map()
  const plansWithMalformedGraphIdentity = new Set()
  const nonGraphPlans = new Set()
  const planDigestsById = new Map()
  let planCount = 0
  let malformedPlans = 0
  let readError
  try {
    scanNamespaceRecords(database, NAMESPACES.executionPlans, context, (record) => {
      planCount += 1
      const planId = record.value?.executionPlanId
      if (typeof planId !== 'string') {
        malformedPlans += 1
        return
      }
      let plan
      try {
        plan = assertExecutionPlanIntegrity(record.value)
      } catch {
        // Corrupted record: stale digest, foreign plan id, or non-canonical
        // shape. No field of such a record can be trusted as evidence.
        plansWithMalformedGraphIdentity.add(planId)
        return
      }
      planDigestsById.set(planId, plan.contentDigest)
      const graphSelection = plan.graph
      if (graphSelection === undefined) {
        // The canonical compiler writes either a valid graph selection or none:
        // absence in a canonically intact plan is a legal non-graph workflow,
        // not malformed identity.
        nonGraphPlans.add(planId)
        return
      }
      const parsed = GraphReferenceSchema.safeParse(graphSelection?.reference)
      if (!parsed.success) {
        plansWithMalformedGraphIdentity.add(planId)
        return
      }
      planGraphs.set(planId, parsed.data)
    })
  } catch {
    readError = 'NAMESPACE_SCAN_FAILED'
  }
  return {
    planGraphs,
    plansWithMalformedGraphIdentity,
    nonGraphPlans,
    planDigestsById,
    planCount,
    malformedPlans,
    readError,
  }
}

/** Retained executions; entries bounded to in-flight work. */
function collectExecutions(database, context) {
  const { identity, observedAt, limits, planIndex } = context
  let rowCount = 0
  let malformedCount = 0
  let truncated = false
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
    scanNamespaceRecords(database, NAMESPACES.executions, context, (record) => {
      rowCount += 1
      const executionId = record.value?.executionId
      const state = record.value?.state
      if (typeof executionId !== 'string' || typeof state !== 'string') {
        malformedCount += 1
        return
      }
      byState.set(state, (byState.get(state) ?? 0) + 1)
      const inFlight = !TERMINAL_EXECUTION_STATES.has(state)
      const workspaceId =
        typeof record.value?.correlation?.workspaceId === 'string'
          ? record.value.correlation.workspaceId
          : 'unknown'
      const planPin = record.value?.executionPlan
      const planId =
        typeof planPin?.executionPlanId === 'string' ? planPin.executionPlanId : undefined
      const planKnown = planId !== undefined && planIndex.planGraphs.has(planId)
      const planIdentityMalformed =
        planId !== undefined && planIndex.plansWithMalformedGraphIdentity.has(planId) === true
      const planNonGraph = planId !== undefined && planIndex.nonGraphPlans.has(planId) === true
      // The execution's full plan pin must match the retained plan: a pin
      // digest that is missing or names a different plan leaves the execution
      // unattributable, even when the plan record itself is intact.
      const pinDigest = planPin?.contentDigest
      const planPinned =
        planId !== undefined &&
        typeof pinDigest === 'string' &&
        planIndex.planDigestsById.get(planId) === pinDigest
      const graphReference = planKnown && planPinned ? planIndex.planGraphs.get(planId) : undefined
      let graphKey
      if (graphReference !== undefined) {
        // Every execution attributed to a graph counts as retained history;
        // the in-flight split is tracked separately below.
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
        // The plan exists but is not usable attribution evidence: its graph
        // identity fails canonical validation, its canonical integrity is
        // broken (content removed or edited after the digest was retained),
        // or the execution's retained pin names a different plan digest. The
        // execution cannot be attributed to any workflow and is never
        // benignly bucketed as a non-graph workflow or an unknown graph — the
        // real graph cannot pass a retire check while this stays unresolved.
        inFlightPlansWithMalformedGraphIdentity += 1
      } else if (planKnown) {
        inFlightAttributed += 1
      } else if (planNonGraph) {
        // A legal non-graph workflow: the retained plan is canonically
        // intact, carries no graph selection, and the execution's full pin
        // matches it. Counted separately; it never becomes malformed evidence
        // and never blocks a graph's retirement.
        inFlightNonGraph += 1
      } else {
        // A retained in-flight execution whose plan is gone cannot be
        // attributed to a workflow: an explicit incompleteness, never silence.
        inFlightPlansMissing += 1
      }
      if (inFlightEntries.length < limits.entriesPerSection) {
        inFlightEntries.push({
          attemptCount:
            typeof record.value?.attemptCount === 'number' ? record.value.attemptCount : 0,
          createdAt:
            typeof record.value?.createdAt === 'string' ? record.value.createdAt : 'unknown',
          durableOwner: 'control-plane-execution-history',
          executionId,
          graphWorkflow: graphReference !== undefined,
          historyResponsibility:
            'execution events and cancellation receipts remain in this store; retirement must not cancel or adopt this execution',
          observedAt,
          recordRevision: record.revision,
          state,
          updatedAt:
            typeof record.value?.updatedAt === 'string' ? record.value.updatedAt : 'unknown',
          workspaceId,
          executionPlan: planId === undefined ? undefined : { executionPlanId: planId },
          ...(graphReference === undefined ? {} : { graphReference }),
        })
      } else {
        truncated = true
      }
    })
  } catch {
    return failedExecutionsSection(identity, observedAt, limits)
  }
  const inFlightTotal = [...byState.entries()]
    .filter(([state]) => !TERMINAL_EXECUTION_STATES.has(state))
    .reduce((summand, [, count]) => summand + count, 0)
  const extraReasons = []
  if (planIndex.readError !== undefined) extraReasons.push('PLAN_NAMESPACE_SCAN_FAILED')
  if (
    planIndex.plansWithMalformedGraphIdentity.size > 0 ||
    inFlightPlansWithMalformedGraphIdentity > 0
  )
    extraReasons.push('PLAN_GRAPH_IDENTITY_MALFORMED')
  return {
    ...sectionHeader([NAMESPACES.executions, NAMESPACES.executionPlans], identity, observedAt),
    ...outcomeWithExtraReasons(
      sectionOutcome({
        attempted: true,
        readError: undefined,
        rowCount,
        malformedCount,
        truncated,
        newestUpdatedAtValue: newestUpdatedAt(database, [
          NAMESPACES.executions,
          NAMESPACES.executionPlans,
        ]),
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
    malformedRecords: malformedCount,
    internal: { executionsByGraph, executionGraphKeys, executionStatesById: executionStatesById },
  }
}

function failedExecutionsSection(identity, observedAt, limits) {
  return {
    ...sectionHeader([NAMESPACES.executions, NAMESPACES.executionPlans], identity, observedAt),
    ...sectionOutcome({
      attempted: true,
      readError: 'NAMESPACE_SCAN_FAILED',
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
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
    malformedRecords: 0,
    internal: {
      executionsByGraph: new Map(),
      executionGraphKeys: new Map(),
      executionStatesById: new Map(),
    },
  }
}

/** LangGraph checkpoint rows: resume state that retirement must not transplant. */
function collectCheckpoints(database, context) {
  const { identity, observedAt, limits, executionGraphKeys, executionStates } = context
  let rowCount = 0
  let malformedCount = 0
  let truncated = false
  let checkpointRows = 0
  let writeRows = 0
  let unclassifiedThreads = 0
  let threadsOnInFlightExecutions = 0
  let threadsOnUnknownExecutions = 0
  const threads = new Map()
  try {
    scanNamespaceRecords(database, NAMESPACES.langgraphCheckpoints, context, (record) => {
      rowCount += 1
      const row = parseCheckpointRow(record.value)
      if (row === undefined) {
        malformedCount += 1
        return
      }
      if (row.kind === 'checkpoint') checkpointRows += 1
      else writeRows += 1
      const threadKey = `${row.scope}\u0000${row.thread}`
      const thread = threads.get(threadKey) ?? {
        scope: row.scope,
        thread: row.thread,
        checkpointRows: 0,
        writeRows: 0,
      }
      if (row.kind === 'checkpoint') thread.checkpointRows += 1
      else thread.writeRows += 1
      threads.set(threadKey, thread)
    })
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
        (checkpointRowsByExecution.get(graphKey) ?? 0) + thread.checkpointRows + thread.writeRows
      )
    if (entries.length >= limits.entriesPerSection) {
      truncated = true
      continue
    }
    entries.push({
      checkpointRows: thread.checkpointRows,
      durableOwner: 'langgraph-sqlite-checkpointer',
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
    ...sectionHeader([NAMESPACES.langgraphCheckpoints], identity, observedAt),
    ...outcomeWithExtraReasons(
      sectionOutcome({
        attempted: true,
        readError: undefined,
        rowCount,
        malformedCount,
        truncated,
        newestUpdatedAtValue: newestUpdatedAt(database, [NAMESPACES.langgraphCheckpoints]),
        maxAgeDays: limits.maxAgeDays,
        observedAt,
      }),
      unknownStateReasons
    ),
    counts: {
      total: rowCount,
      checkpointRows,
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
    malformedRecords: malformedCount,
    internal: { checkpointRowsByExecution },
  }
}

function failedCheckpointsSection(identity, observedAt, limits) {
  return {
    ...sectionHeader([NAMESPACES.langgraphCheckpoints], identity, observedAt),
    ...sectionOutcome({
      attempted: true,
      readError: 'NAMESPACE_SCAN_FAILED',
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      newestUpdatedAtValue: null,
      maxAgeDays: limits.maxAgeDays,
      observedAt,
    }),
    counts: { total: 0 },
    entries: [],
    truncated: false,
    malformedRecords: 0,
  }
}

function parseCheckpointRow(value) {
  if (value === null || typeof value !== 'object') return undefined
  const { version, scope, thread, checkpointId, kind } = value
  if (
    version !== 1 ||
    typeof scope !== 'string' ||
    typeof thread !== 'string' ||
    typeof checkpointId !== 'string' ||
    (kind !== 'checkpoint' && kind !== 'write')
  )
    return undefined
  return { scope, thread, checkpointId, kind }
}

/**
 * The managed runtime stores threads as `${workspaceId}:${executionId}:${threadId}`
 * (see storageThreadId in packages/langgraph-adapter). Identifier alphabets
 * exclude ':' but the caller-supplied threadId may contain colons, so the
 * first two separators delimit the identifiers and the rest is opaque;
 * anything else stays deliberately unclassified instead of guessed.
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

function collectCancellationReceiptCount(database) {
  try {
    return countRecords(database, NAMESPACES.cancellationReceipts)
  } catch {
    return null
  }
}

/** Receipt counts per graph reference, joined through the command result. */
function catalogCommandsByGraphIndex(database, context) {
  const index = new Map()
  try {
    scanNamespaceRecords(database, NAMESPACES.catalogCommands, context, (record) => {
      const reference = record.value?.result?.reference
      const workspaceId = record.value?.workspaceId
      if (
        typeof workspaceId !== 'string' ||
        typeof reference?.graphDefinitionId !== 'string' ||
        typeof reference?.graphVersion !== 'string'
      )
        return
      const key = `${workspaceId}\u0000${reference.graphDefinitionId}\u0000${reference.graphVersion}`
      index.set(key, (index.get(key) ?? 0) + 1)
    })
  } catch {
    return new Map()
  }
  return index
}

// ---------------------------------------------------------------------------
// Manifest assembly
// ---------------------------------------------------------------------------

export function buildInventoryManifest({
  database,
  storeIdentity = null,
  storeProfile = null,
  observationScope,
  observedAt,
  limits = DEFAULT_LIMITS,
  sourceRevision = 'unspecified',
}) {
  if (!OBSERVATION_SCOPES.includes(observationScope))
    throw new RetirementInventoryError('INVALID_OBSERVATION_SCOPE')
  const normalizedLimits = normalizeLimits(limits)
  const storeAvailable = database !== null && storeProfile?.status === OBSERVATION_STATUS.OBSERVED
  const scanContext = { pageSize: normalizedLimits.pageSize }

  const planIndex = storeAvailable
    ? collectPlanGraphReferences(database, scanContext)
    : {
        planGraphs: new Map(),
        plansWithMalformedGraphIdentity: new Set(),
        nonGraphPlans: new Set(),
        planDigestsById: new Map(),
        planCount: 0,
        malformedPlans: 0,
        readError: 'STORE_UNAVAILABLE',
      }

  const executions = storeAvailable
    ? collectExecutions(database, {
        identity: storeIdentity,
        observedAt,
        limits: normalizedLimits,
        planIndex,
        ...scanContext,
      })
    : emptyExecutionsSection(storeIdentity, observedAt, normalizedLimits)
  const { internal: executionInternals, ...executionsPublic } = executions
  const executionGraphKeys = executionInternals?.executionGraphKeys ?? new Map()
  const executionStatesById = executionInternals?.executionStatesById ?? new Map()

  const catalogCallers = storeAvailable
    ? collectCatalogCallers(database, { observedAt, limits: normalizedLimits, ...scanContext })
    : {
        rowCount: 0,
        malformedCount: 0,
        truncated: false,
        readError: 'STORE_UNAVAILABLE',
        distinctCallers: 0,
        entries: [],
      }

  const checkpoints = storeAvailable
    ? collectCheckpoints(database, {
        identity: storeIdentity,
        observedAt,
        limits: normalizedLimits,
        executionGraphKeys,
        executionStates: executionStatesById,
        ...scanContext,
      })
    : emptyCheckpointsSection(storeIdentity, observedAt, normalizedLimits)
  const { internal: checkpointInternals, ...checkpointsPublic } = checkpoints
  // Row attribution per graph is computed over every checkpoint thread, never
  // over the bounded display entries, so it stays exact under --limit.
  const checkpointRowsByGraph = checkpointInternals?.checkpointRowsByExecution ?? new Map()

  const definitions = storeAvailable
    ? collectDefinitions(database, {
        identity: storeIdentity,
        observedAt,
        limits: normalizedLimits,
        executionsByGraph: executionInternals?.executionsByGraph ?? new Map(),
        checkpointRowsByExecution: checkpointRowsByGraph,
        catalogCommandsByGraph: storeAvailable
          ? catalogCommandsByGraphIndex(database, scanContext)
          : new Map(),
        ...scanContext,
      })
    : emptyDefinitionsSection(storeIdentity, observedAt, normalizedLimits)

  // The entry cap applies to the whole consumers section — curated registry
  // and observed callers together — while counts stay computed over the full
  // scan, so bounding never changes any total.
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
  const consumersTotal = KNOWN_CONSUMERS.length + catalogCallers.distinctCallers

  const consumers = {
    observedAt,
    source: {
      backend: storeAvailable ? 'sqlite-file' : 'repository-scan',
      identity: storeAvailable ? storeIdentity : null,
      namespaces: storeAvailable ? [NAMESPACES.catalogCommands] : [],
    },
    ...consumersOutcome({
      storeAvailable,
      catalogCallers,
      truncated: consumersTotal > normalizedLimits.entriesPerSection,
      normalizedLimits,
      observedAt,
    }),
    counts: {
      registered: KNOWN_CONSUMERS.length,
      catalogCommandReceipts: catalogCallers.rowCount,
      distinctCatalogCallers: catalogCallers.distinctCallers,
    },
    entries: consumerEntries,
  }

  return {
    manifest: MANIFEST_NAME,
    manifestVersion: MANIFEST_VERSION,
    observedAt,
    observationScope,
    observationScopeRule:
      'A repository scan or a disposable local store can never establish that production has zero retained work; only an explicitly attested deployed-dsn observation read in full can.',
    sourceRevision,
    tool: {
      script: 'scripts/langgraph-retirement-inventory.mjs',
      readMode: 'read-only',
      migration: 'never',
      mutations: 'none',
      adoption: 'never',
      cancellation: 'never',
      draining: 'never',
      checkpointTransplant: 'never',
    },
    limits: {
      entriesPerSection: normalizedLimits.entriesPerSection,
      maxAgeDays: normalizedLimits.maxAgeDays,
      pageSize: normalizedLimits.pageSize,
    },
    traceability: {
      issue: 'adea-ai/control-plane#938',
      milestone: 'M16.01',
      requirementIds: ['010', '160', '161', '170', '173'],
      tests: ['A28', 'A30', 'A32'],
    },
    store: {
      backend: 'sqlite-file',
      identity: storeIdentity,
      ...(storeProfile ?? {
        status: OBSERVATION_STATUS.INACCESSIBLE,
        schemaVersion: null,
        reasons: ['STORE_UNAVAILABLE'],
      }),
    },
    sections: {
      definitions,
      consumers,
      executions: executionsPublic,
      checkpoints: checkpointsPublic,
    },
    historyOwnership: {
      catalogCommands:
        'graph-definition-commands receipts are the append-only publication history of the catalog',
      cancellationReceipts: {
        count: storeAvailable ? collectCancellationReceiptCount(database) : null,
        namespace: NAMESPACES.cancellationReceipts,
        responsibility:
          'operator cancel intent recorded by ExecutionCancellationRepository; counted, never replayed or applied',
      },
      durableOwner: 'control-plane-sqlite-persistence (one store per observation)',
      executionHistory:
        'executions and execution-events namespaces; deletion is governed by retention classes and holds, not by this tool',
      graphCheckpoints:
        'langgraph-checkpoints-v1 namespace owned by LangGraphSqliteCheckpointSaver; counted only, never transplanted',
      responsibilities:
        'This manifest reports ownership only; it never adopts, cancels, drains or transplants anything.',
    },
    epistemics: retainedWorkEpistemics({
      observationScope,
      executions: executionsPublic,
      checkpoints: checkpointsPublic,
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

function normalizeLimits(limits) {
  const entriesPerSection = limits?.entriesPerSection ?? DEFAULT_LIMITS.entriesPerSection
  if (
    !Number.isSafeInteger(entriesPerSection) ||
    entriesPerSection < 1 ||
    entriesPerSection > DEFAULT_LIMITS.maximumEntriesPerSection
  )
    throw new RetirementInventoryError('INVALID_ENTRY_LIMIT')
  const maxAgeDays = limits?.maxAgeDays ?? DEFAULT_LIMITS.maxAgeDays
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0)
    throw new RetirementInventoryError('INVALID_MAX_AGE_DAYS')
  return {
    entriesPerSection,
    maxAgeDays,
    pageSize: boundedPageSize(limits?.pageSize),
  }
}

function consumersOutcome({
  storeAvailable,
  catalogCallers,
  truncated,
  normalizedLimits,
  observedAt,
}) {
  if (!storeAvailable)
    return {
      status: OBSERVATION_STATUS.UNKNOWN,
      reasons: ['SOURCE_NOT_IN_OBSERVATION_SCOPE', 'CURATED_REGISTRY_ONLY'],
      truncated: false,
      malformedRecords: 0,
    }
  const outcome = sectionOutcome({
    attempted: true,
    readError: catalogCallers.readError,
    rowCount: catalogCallers.rowCount,
    malformedCount: catalogCallers.malformedCount,
    truncated,
    newestUpdatedAtValue: null,
    maxAgeDays: normalizedLimits.maxAgeDays,
    observedAt,
  })
  // The curated registry is always present, so the consumers section never
  // reports 'zero'; an empty caller set is a store-scoped count instead.
  const status =
    outcome.status === OBSERVATION_STATUS.ZERO ? OBSERVATION_STATUS.OBSERVED : outcome.status
  return {
    status,
    reasons: outcome.reasons,
    truncated,
    malformedRecords: catalogCallers.malformedCount,
  }
}

function emptyDefinitionsSection(identity, observedAt, normalizedLimits) {
  return {
    ...sectionHeader([NAMESPACES.definitions], identity, observedAt),
    ...sectionOutcome({
      attempted: false,
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      newestUpdatedAtValue: null,
      maxAgeDays: normalizedLimits.maxAgeDays,
      observedAt,
    }),
    counts: { total: 0 },
    entries: [],
    truncated: false,
    malformedRecords: 0,
  }
}

function emptyExecutionsSection(identity, observedAt, normalizedLimits) {
  return {
    ...sectionHeader([NAMESPACES.executions, NAMESPACES.executionPlans], identity, observedAt),
    ...sectionOutcome({
      attempted: false,
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      newestUpdatedAtValue: null,
      maxAgeDays: normalizedLimits.maxAgeDays,
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
    malformedRecords: 0,
  }
}

function emptyCheckpointsSection(identity, observedAt, normalizedLimits) {
  return {
    ...sectionHeader([NAMESPACES.langgraphCheckpoints], identity, observedAt),
    ...sectionOutcome({
      attempted: false,
      rowCount: 0,
      malformedCount: 0,
      truncated: false,
      newestUpdatedAtValue: null,
      maxAgeDays: normalizedLimits.maxAgeDays,
      observedAt,
    }),
    counts: { total: 0 },
    entries: [],
    truncated: false,
    malformedRecords: 0,
  }
}

/**
 * A section supports "fully read" conclusions (exact attribution, zero claims)
 * only when it was read completely: observed or zero, untruncated, with no
 * malformed rows. Incomplete, stale, unknown and inaccessible sections do not.
 */
function sectionFullyRead(section) {
  return (
    (section?.status === OBSERVATION_STATUS.OBSERVED ||
      section?.status === OBSERVATION_STATUS.ZERO) &&
    section?.truncated === false &&
    (section?.malformedRecords ?? 0) === 0
  )
}

/**
 * The zero-vs-unknown rule, encoded. `none-observed-in-scope` requires an
 * explicitly attested deployed-dsn observation whose in-flight sections were
 * fully read (observed or zero, no truncation, no malformed rows) and show no
 * in-flight work and no orphan or unclassified checkpoint threads. Every other
 * observation is 'unknown' or 'present' and carries the typed reasons why the
 * stronger claim is not available.
 */
export function retainedWorkEpistemics({ observationScope, executions, checkpoints }) {
  const inFlightEvidence =
    (executions?.counts?.inFlight ?? 0) > 0 ||
    (checkpoints?.counts?.threadsOnInFlightExecutions ?? 0) > 0
  const unclassifiedThreads = checkpoints?.counts?.unclassifiedThreads ?? 0
  const threadsOnUnknownExecutions = checkpoints?.counts?.threadsOnUnknownExecutions ?? 0
  const unknownStateEvidence = unclassifiedThreads > 0 || threadsOnUnknownExecutions > 0
  const claimAllowed =
    observationScope === 'deployed-dsn' &&
    !inFlightEvidence &&
    !unknownStateEvidence &&
    sectionFullyRead(executions) &&
    sectionFullyRead(checkpoints)
  const classification = inFlightEvidence
    ? 'present'
    : claimAllowed
      ? 'none-observed-in-scope'
      : 'unknown'
  const reasons = []
  if (!claimAllowed) {
    if (inFlightEvidence) reasons.push('IN_FLIGHT_WORK_OBSERVED')
    if (unclassifiedThreads > 0) reasons.push('CHECKPOINT_THREADS_UNCLASSIFIED')
    if (threadsOnUnknownExecutions > 0)
      reasons.push('CHECKPOINT_THREADS_WITH_UNKNOWN_EXECUTION_STATE')
    if (observationScope !== 'deployed-dsn')
      reasons.push(
        `OBSERVATION_SCOPE_${observationScope.toUpperCase()}_CANNOT_ESTABLISH_ZERO_LIVE_WORK`
      )
    if (!sectionFullyRead(executions)) reasons.push('EXECUTIONS_SECTION_NOT_FULLY_READ')
    if (!sectionFullyRead(checkpoints)) reasons.push('CHECKPOINTS_SECTION_NOT_FULLY_READ')
  }
  return {
    statusVocabulary: {
      observed: 'section read in full with data',
      zero: 'section read in full and empty — true only for the observed store, never for production',
      unknown: 'source not covered by this observation',
      inaccessible: 'source present but unreadable; typed reason recorded',
      incomplete: 'partially read: truncation or malformed records; counts stay exact',
      stale: 'readable but older than the freshness threshold',
    },
    retainedWorkClassification: classification,
    zeroLiveWorkClaim: {
      claimAllowed,
      claim: claimAllowed ? 'none-observed-in-scope' : 'not-claimable',
      reasons,
    },
  }
}

// ---------------------------------------------------------------------------
// Disposition validator (pure; report-only)
// ---------------------------------------------------------------------------

const DISPOSITION_EVIDENCE_MATRIX = Object.freeze({
  keep: ['durableOwner', 'historyReceiptResponsibility', 'requiredBehavior', 'rollbackEvidence'],
  replace: [
    'durableOwner',
    'historyReceiptResponsibility',
    'requiredBehavior',
    'replacementEvidence',
    'rollbackEvidence',
  ],
  drain: ['durableOwner', 'historyReceiptResponsibility', 'requiredBehavior', 'rollbackEvidence'],
  retire: ['durableOwner', 'historyReceiptResponsibility', 'rollbackEvidence'],
})

/**
 * Validates proposed keep/replace/drain/retire dispositions against the
 * inventory. Pure function: it reads nothing and mutates nothing, and it never
 * executes a disposition. Verdicts: approved | rejected | blocked.
 * Workflow identity is workspace-scoped — a proposal names
 * (workspaceId, graphDefinitionId, graphVersion).
 *
 * Retirement (`retire`) additionally blocks while the store's evidence does
 * not support a zero-live-work conclusion: running executions whose plan
 * vanished are unattributable (IN_FLIGHT_EXECUTION_WITHOUT_PLAN); a retained
 * plan whose graph identity is missing or fails canonical reference
 * validation, whose canonical integrity is broken (stale digest, foreign plan
 * id, or non-canonical shape — e.g. a graph selection deleted from a compiled
 * plan), or that is pinned by an execution under a different plan digest
 * leaves its executions unattributable (PLAN_GRAPH_IDENTITY_MALFORMED) — the
 * real graph cannot pass while that attribution is unresolved; an executions
 * section that was not fully read (incomplete, stale, truncated, malformed,
 * or out of scope) means a zero in-flight count is not trustworthy attribution
 * (IN_FLIGHT_ATTRIBUTION_INCOMPLETE); and checkpoint evidence that is not
 * fully read or carries orphan/unclassified threads leaves resume-state
 * coverage unresolved (CHECKPOINT_EVIDENCE_INCOMPLETE /
 * CHECKPOINT_EVIDENCE_UNKNOWN). Missing attribution is never counted as zero.
 * A retained plan with no graph selection at all is a legal non-graph
 * workflow only when it is canonically intact and the execution's full pin
 * matches it: it is counted as inFlightNonGraph and never blocks a graph's
 * retirement.
 */
export function validateDispositions(document, manifest) {
  if (document === null || typeof document !== 'object' || !Array.isArray(document.dispositions))
    throw new RetirementInventoryError('INVALID_DISPOSITIONS_DOCUMENT')
  const definitions = manifest?.sections?.definitions
  const inventory = new Map()
  for (const entry of definitions?.entries ?? []) {
    inventory.set(
      dispositionKey(entry.workspaceId, entry.graphDefinitionId, entry.graphVersion),
      entry
    )
  }
  const seen = new Set()
  const verdicts = document.dispositions.map((proposal, index) => {
    const base = { proposalIndex: index }
    if (proposal === null || typeof proposal !== 'object')
      return { ...base, verdict: 'rejected', missingEvidence: [], reasons: ['MALFORMED_PROPOSAL'] }
    const workspaceId = proposal.workspaceId
    const graphDefinitionId = proposal.graphDefinitionId
    const graphVersion = proposal.graphVersion
    const disposition = proposal.disposition
    const key =
      typeof workspaceId === 'string' &&
      typeof graphDefinitionId === 'string' &&
      typeof graphVersion === 'string'
        ? dispositionKey(workspaceId, graphDefinitionId, graphVersion)
        : null
    if (key === null || !DISPOSITION_KINDS.includes(disposition)) {
      const reasons = []
      if (typeof disposition === 'string' && !DISPOSITION_KINDS.includes(disposition))
        reasons.push('INVALID_DISPOSITION')
      else reasons.push('MALFORMED_PROPOSAL')
      return {
        ...base,
        disposition: typeof disposition === 'string' ? disposition : null,
        ...(key === null ? {} : { workspaceId, graphDefinitionId, graphVersion }),
        verdict: 'rejected',
        missingEvidence: [],
        reasons,
      }
    }
    const reasons = []
    const missingEvidence = new Set()
    const entry = inventory.get(key)
    if (entry === undefined) {
      reasons.push('WORKFLOW_NOT_IN_INVENTORY')
      if (definitions?.truncated === true) reasons.push('INVENTORY_ENTRIES_TRUNCATED')
    }
    if (seen.has(key)) reasons.push('DUPLICATE_DISPOSITION')
    seen.add(key)
    for (const field of DISPOSITION_EVIDENCE_MATRIX[disposition]) {
      if (!nonEmptyString(proposal[field])) missingEvidence.add(field)
    }
    const inFlight = entry?.consumersObserved?.inFlightExecutions ?? 0
    if (disposition === 'drain' && inFlight > 0 && proposal.inFlightAcknowledged !== true)
      missingEvidence.add('inFlightAcknowledged')
    if (disposition === 'retire') {
      if (inFlight > 0) reasons.push('IN_FLIGHT_WORK_PRESENT')
      const executionsSection = manifest?.sections?.executions
      const checkpointsSection = manifest?.sections?.checkpoints
      if ((executionsSection?.counts?.inFlightPlansMissing ?? 0) > 0)
        reasons.push('IN_FLIGHT_EXECUTION_WITHOUT_PLAN')
      if ((executionsSection?.counts?.inFlightPlansWithMalformedGraphIdentity ?? 0) > 0)
        reasons.push('PLAN_GRAPH_IDENTITY_MALFORMED')
      if (!sectionFullyRead(executionsSection)) reasons.push('IN_FLIGHT_ATTRIBUTION_INCOMPLETE')
      // Checkpoint evidence quality gates retirement as well: orphaned or
      // unclassified threads could belong to the workflow being retired, and
      // an incomplete or stale checkpoint scan leaves resume-state coverage
      // unresolved. Only fully-read, attributed checkpoint evidence permits a
      // retire verdict.
      if (
        (checkpointsSection?.counts?.unclassifiedThreads ?? 0) > 0 ||
        (checkpointsSection?.counts?.threadsOnUnknownExecutions ?? 0) > 0
      )
        reasons.push('CHECKPOINT_EVIDENCE_UNKNOWN')
      if (!sectionFullyRead(checkpointsSection)) reasons.push('CHECKPOINT_EVIDENCE_INCOMPLETE')
    }
    if (missingEvidence.size > 0) reasons.push('MISSING_REQUIRED_EVIDENCE')
    if (Array.isArray(proposal.unresolvedBlockers) && proposal.unresolvedBlockers.length > 0)
      reasons.push('UNRESOLVED_BLOCKERS_DECLARED')
    const blocked =
      reasons.includes('UNRESOLVED_BLOCKERS_DECLARED') ||
      reasons.includes('IN_FLIGHT_EXECUTION_WITHOUT_PLAN') ||
      reasons.includes('PLAN_GRAPH_IDENTITY_MALFORMED') ||
      reasons.includes('IN_FLIGHT_ATTRIBUTION_INCOMPLETE') ||
      reasons.includes('CHECKPOINT_EVIDENCE_INCOMPLETE') ||
      reasons.includes('CHECKPOINT_EVIDENCE_UNKNOWN')
    const verdict = blocked
      ? 'blocked'
      : reasons.length === 0 && missingEvidence.size === 0
        ? 'approved'
        : 'rejected'
    return {
      workspaceId,
      graphDefinitionId,
      graphVersion,
      disposition,
      proposalIndex: index,
      verdict,
      missingEvidence: [...missingEvidence].toSorted(),
      reasons: reasons.toSorted(),
      ...(entry === undefined ? {} : { inventoryCounts: entry.consumersObserved }),
    }
  })
  return {
    validation: 'langgraph-retirement-dispositions',
    manifestVersion: MANIFEST_VERSION,
    observedAt: manifest?.observedAt,
    observationScope: manifest?.observationScope,
    summary: {
      total: verdicts.length,
      approved: verdicts.filter((verdict) => verdict.verdict === 'approved').length,
      rejected: verdicts.filter((verdict) => verdict.verdict === 'rejected').length,
      blocked: verdicts.filter((verdict) => verdict.verdict === 'blocked').length,
    },
    verdicts,
  }
}

function dispositionKey(workspaceId, graphDefinitionId, graphVersion) {
  return `${workspaceId}@${graphDefinitionId}@${graphVersion}`
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

/** Deep key-sorted, 2-space JSON: byte-stable for identical store state. */
export function stableJsonStringify(value) {
  return JSON.stringify(sortKeysDeep(value), null, 2)
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const sorted = {}
    for (const key of Object.keys(value).toSorted()) sorted[key] = sortKeysDeep(value[key])
    return sorted
  }
  return value
}

function compareCodePoint(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `langgraph-retirement-inventory — M16.01 read-only retained-workflow inventory

Usage:
  bun scripts/langgraph-retirement-inventory.mjs --observation-scope <scope> --store <absolute-path> [options]
  bun scripts/langgraph-retirement-inventory.mjs --observation-scope repository-scan [options]
  bun scripts/langgraph-retirement-inventory.mjs --validate-dispositions <file> --observation-scope <scope> --store <path>

Required:
  --observation-scope <repository-scan|local-disposable-store|deployed-dsn>
      Explicit observation scope. 'deployed-dsn' is an operator attestation
      that the store is a deployed snapshot; only that scope can ever permit
      the global none-observed-in-scope classification.

Read-only store access:
  --store <absolute-path>   SQLite control-plane store. Opened read-only,
                            never migrated, never written. Required unless the
                            scope is repository-scan (where it must be absent).

Options:
  --now <iso-instant>       Observation time (injectable for deterministic runs).
  --limit <n>               Maximum emitted entries per section (1-1000, default 100).
                            Counts stay exact; truncation is flagged.
  --max-age-days <n>        Freshness threshold for the stale status (default 30).
  --source-revision <sha>   Repository revision the curated registry was verified against.
  --validate-dispositions <file>
                            Validate a proposed keep/replace/drain/retire
                            disposition document against the inventory.
                            Report-only: exits 0 when every verdict is
                            approved, 1 otherwise. Never executes anything.
  --help                    Show this text.

Disposition document format (one disposition per workflow; workflow identity
is workspace-scoped):
  {"dispositions": [{
     "workspaceId": "wsp_...", "graphDefinitionId": "graph:...",
     "graphVersion": "1.0.0", "disposition": "keep|replace|drain|retire",
     "durableOwner": "...", "historyReceiptResponsibility": "...",
     "requiredBehavior": "...",            // keep/replace/drain
     "replacementEvidence": "...",         // replace
     "rollbackEvidence": "...",            // keep/replace/drain/retire
     "inFlightAcknowledged": true,         // drain, when in-flight work exists
     "unresolvedBlockers": []              // nonempty -> verdict blocked
  }]}

Retire verdicts block while execution or checkpoint evidence is not fully read
(incomplete, stale, truncated, or out of scope), any running execution lost its
plan, any retained plan fails the plan compiler's canonical validation (its
graph identity is missing or invalid, its retained digest no longer matches its
canonical content — e.g. a graph selection deleted from a compiled plan — or an
execution pins it under a different plan digest), or checkpoint threads are
orphaned/unclassified — unattributed in-flight work and resume state are never
counted as zero. A retained plan with no graph selection is a legal non-graph
workflow only when it is canonically intact and the execution's full plan pin
matches it; it never blocks retirement.

Output: a single deterministic JSON manifest on stdout. Failures print one
sanitized LANGGRAPH_RETIREMENT_INVENTORY_FAILED:<CODE> line on stderr.
The tool never prints store paths, credentials, or record payloads.
`

export async function runInventoryCli({
  argv,
  now,
  stdout = process.stdout,
  dependencies = {},
} = {}) {
  const openStore = dependencies.openStore ?? openReadOnlyStore
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean' },
        'observation-scope': { type: 'string' },
        store: { type: 'string' },
        now: { type: 'string' },
        limit: { type: 'string' },
        'max-age-days': { type: 'string' },
        'source-revision': { type: 'string' },
        'validate-dispositions': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }))
  } catch {
    throw new RetirementInventoryError('INVALID_ARGUMENTS')
  }
  if (values.help === true) {
    stdout.write(HELP_TEXT)
    return { action: 'help', exitCode: 0 }
  }
  const observationScope = values['observation-scope']
  if (typeof observationScope !== 'string' || !OBSERVATION_SCOPES.includes(observationScope))
    throw new RetirementInventoryError('INVALID_OBSERVATION_SCOPE')
  if (observationScope === 'repository-scan' && values.store !== undefined)
    throw new RetirementInventoryError('STORE_NOT_ALLOWED_FOR_REPOSITORY_SCAN')
  if (observationScope !== 'repository-scan' && typeof values.store !== 'string')
    throw new RetirementInventoryError('STORE_REQUIRED')
  const observedAt = normalizeObservedAt(
    values.now ?? (typeof now === 'function' ? now() : new Date().toISOString())
  )
  const limits = {
    entriesPerSection:
      values.limit === undefined
        ? undefined
        : boundedInteger(values.limit, 'INVALID_ENTRY_LIMIT', 1000),
    maxAgeDays:
      values['max-age-days'] === undefined
        ? undefined
        : boundedInteger(values['max-age-days'], 'INVALID_MAX_AGE_DAYS', 3650),
  }
  let store = null
  let storeIdentity = null
  let storeProfile = null
  try {
    if (typeof values.store === 'string') {
      const opened = await openStore(values.store).catch((error) => {
        if (error instanceof RetirementInventoryError) {
          // Sloppy targets are argument errors; an absent or unreadable file is
          // an observation result and becomes a typed inaccessible manifest.
          if (error.code === 'STORE_FILE_MISSING' || error.code === 'STORE_UNREADABLE')
            return { failed: error.code }
          throw error
        }
        throw error
      })
      if (opened.failed !== undefined) {
        storeProfile = {
          status: OBSERVATION_STATUS.INACCESSIBLE,
          schemaVersion: null,
          reasons: [opened.failed],
        }
      } else {
        store = opened
        storeIdentity = opened.identity
        storeProfile = readStoreProfile(opened.database)
      }
    }
    const manifest = buildInventoryManifest({
      database: store?.database ?? null,
      storeIdentity,
      storeProfile,
      observationScope,
      observedAt,
      limits,
      ...(values['source-revision'] === undefined
        ? {}
        : { sourceRevision: values['source-revision'] }),
    })
    if (values['validate-dispositions'] !== undefined) {
      const document = parseDispositionDocument(values['validate-dispositions'])
      const report = validateDispositions(document, manifest)
      stdout.write(`${stableJsonStringify(report)}\n`)
      return {
        action: 'validation',
        report,
        exitCode: report.summary.rejected > 0 || report.summary.blocked > 0 ? 1 : 0,
      }
    }
    stdout.write(`${stableJsonStringify(manifest)}\n`)
    return { action: 'manifest', manifest, exitCode: 0 }
  } finally {
    store?.database.close()
  }
}

function normalizeObservedAt(value) {
  if (typeof value !== 'string' || value.length === 0)
    throw new RetirementInventoryError('INVALID_OBSERVED_AT')
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new RetirementInventoryError('INVALID_OBSERVED_AT')
  return parsed.toISOString()
}

function boundedInteger(value, code, maximum) {
  if (!/^\d+$/.test(value)) throw new RetirementInventoryError(code)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new RetirementInventoryError(code)
  return parsed
}

function parseDispositionDocument(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new RetirementInventoryError('DISPOSITIONS_FILE_UNREADABLE')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new RetirementInventoryError('INVALID_DISPOSITIONS_DOCUMENT')
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    const outcome = await runInventoryCli({
      argv: process.argv.slice(2),
      // normalizeObservedAt requires an ISO string: convert here at the
      // process entrypoint, where the default clock is produced.
      now: () => new Date().toISOString(),
    })
    if (outcome.action === 'validation') process.exitCode = outcome.exitCode
  } catch (error) {
    const code = error instanceof RetirementInventoryError ? error.code : 'OPERATION_FAILED'
    process.stderr.write(`LANGGRAPH_RETIREMENT_INVENTORY_FAILED:${code}\n`)
    process.exitCode = 1
  }
}
