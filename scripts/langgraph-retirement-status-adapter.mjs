// M16.03 (#940) legacy status adapter for the M16.01 deployed-PostgreSQL inventory manifest (#938).
//
// Reads one sanitized manifest from scripts/langgraph-retirement-inventory-pg.mjs and reports it in the
// legacy remainder vocabulary. It reuses the collector's manifest contract and the reviewed script's
// encodings, and it contacts no store. A legacy count is reported only where the collector measures the
// same thing, and every other legacy field is listed under `unmapped`. A count is null whenever its source
// was not read or its count is missing or invalid. Unknown, inaccessible, incomplete, stale and un-attested states are preserved.
//
// This adapter never establishes zero. It takes no attestation, so no manifest here can support zero. The
// collector's own un-attested claim is reported as `collectorClaim` and is never presented as zero.
//
// Pipeline:
//   bun scripts/langgraph-retirement-inventory-pg.mjs --observation-scope deployed-dsn --dsn <dsn> \
//     | bun scripts/langgraph-retirement-status-adapter.mjs --manifest /dev/stdin

import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { MANIFEST_NAME, MANIFEST_VERSION } from './langgraph-retirement-inventory-pg.mjs'
import {
  OBSERVATION_SCOPES,
  OBSERVATION_STATUS,
  stableJsonStringify,
} from './langgraph-retirement-inventory.mjs'

export const LEGACY_INVENTORY_STATUS_SCHEMA = 'langgraph-legacy-inventory-status/v1'

const SECTION_NAMES = Object.freeze(['definitions', 'consumers', 'executions', 'checkpoints'])
const STATUSES = new Set(Object.values(OBSERVATION_STATUS))
const READABLE = new Set([
  OBSERVATION_STATUS.OBSERVED,
  OBSERVATION_STATUS.ZERO,
  OBSERVATION_STATUS.INCOMPLETE,
  OBSERVATION_STATUS.STALE,
])
const FULLY_READ = new Set([OBSERVATION_STATUS.OBSERVED, OBSERVATION_STATUS.ZERO])
const PRECEDENCE = Object.freeze([
  OBSERVATION_STATUS.INACCESSIBLE,
  OBSERVATION_STATUS.UNKNOWN,
  OBSERVATION_STATUS.INCOMPLETE,
  OBSERVATION_STATUS.STALE,
])
const ZERO_REASON_BY_SCOPE = Object.freeze({
  'repository-scan': 'REPOSITORY_SCOPE_CANNOT_ESTABLISH_ZERO',
  'local-disposable-store': 'DISPOSABLE_SCOPE_CANNOT_ESTABLISH_ZERO',
  // This adapter has no attestation input, so a deployed observation is always un-attested.
  'deployed-dsn': 'DEPLOYED_ATTESTATION_MISSING',
})
const LEGACY_SCOPE_BY_SCOPE = Object.freeze({
  'repository-scan': 'repository-scan',
  'local-disposable-store': 'disposable-local-store',
  'deployed-dsn': 'deployed-dsn',
})
const RETAINED_CLASSES = new Set(['present', 'none-observed-in-scope', 'unknown'])
const COLLECTOR_CLAIMS = new Set(['none-observed-in-scope', 'not-claimable'])
const IDENTITY_PATTERN = /^sha256:[a-f0-9]{64}$/
const REVISION_PATTERN = /^[A-Za-z0-9._:/-]{1,64}$/
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,95}$/
const UNMAPPED = Object.freeze([
  { field: 'executionOnly', reason: 'PER_THREAD_CLASSIFICATION_NOT_IN_MANIFEST' },
  { field: 'byClassification', reason: 'PER_THREAD_CLASSIFICATION_NOT_IN_MANIFEST' },
  { field: 'items', reason: 'PER_ITEM_IDENTITIES_NOT_REPORTED' },
  { field: 'plans', reason: 'PLAN_TOTAL_NOT_IN_MANIFEST' },
  { field: 'unparseablePlans', reason: 'PLAN_RECORDS_NOT_READ_BY_COLLECTOR' },
  { field: 'plansUnverified', reason: 'PLAN_RECORDS_NOT_READ_BY_COLLECTOR' },
  { field: 'unparseableCheckpointRecords', reason: 'COLLECTOR_REPORTS_MALFORMED_ROWS_ONLY' },
  { field: 'unsupportedVersionCheckpointRecords', reason: 'CHECKPOINT_VERSION_NOT_OBSERVED' },
])
const RETAINED_DEPENDENCIES = Object.freeze([
  'LangGraph Postgres checkpointer tables (checkpoints, checkpoint_blobs, checkpoint_writes)',
  'LangGraph checkpoint saver composition',
])

// Required counts are the fields the remainder reports for a section. A readable section that lacks one of
// them, or holds one that is not a non-negative integer, is incomplete: those counts stay unknown, and the
// section is not exact. A missing count is never filled in as zero.
const REQUIRED_COUNTS = Object.freeze({
  executions: Object.freeze(['total', 'inFlight', 'byState']),
  checkpoints: Object.freeze([
    'checkpointRows',
    'writeRows',
    'distinctThreads',
    'unclassifiedThreads',
    'threadsOnInFlightExecutions',
    'threadsOnUnknownExecutions',
  ]),
})

export class LegacyInventoryStatusError extends Error {
  constructor(code) {
    super(code)
    this.name = 'LegacyInventoryStatusError'
    this.code = code
  }
}

const refuse = (code) => {
  throw new LegacyInventoryStatusError(code)
}
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value) => typeof value === 'string'
const integerOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

function validateManifest(manifest) {
  if (!isObject(manifest) || manifest.manifest !== MANIFEST_NAME) refuse('INVALID_MANIFEST')
  if (manifest.manifestVersion !== MANIFEST_VERSION) refuse('UNSUPPORTED_MANIFEST_VERSION')
  if (!OBSERVATION_SCOPES.includes(manifest.observationScope)) refuse('INVALID_MANIFEST')
  if (!isText(manifest.observedAt) || Number.isNaN(Date.parse(manifest.observedAt))) {
    refuse('INVALID_MANIFEST')
  }
  if (!isObject(manifest.sections) || !isObject(manifest.epistemics)) refuse('INVALID_MANIFEST')
  const identity = isObject(manifest.store) ? (manifest.store.identity ?? null) : null
  if (identity !== null && (!isText(identity) || !IDENTITY_PATTERN.test(identity))) {
    refuse('INVALID_MANIFEST')
  }
}

// Reasons are codes by contract. Anything else is replaced, so no free text reaches the status.
const codeReasons = (reasons) =>
  [
    ...new Set(
      reasons.map((reason) =>
        isText(reason) && CODE_PATTERN.test(reason) ? reason : 'REASON_UNRECOGNIZED'
      )
    ),
  ].toSorted()

const unverifiedSection = (reasons) => ({
  status: OBSERVATION_STATUS.UNKNOWN,
  reasons: codeReasons(reasons),
  requiredCounts: 'not-read',
  counts: {},
  truncated: false,
  malformedRecords: 0,
})

// A section whose status or flags cannot be verified is unknown. An observed section that was truncated or
// had malformed records is incomplete, as the collector itself would report it.
const isCountMap = (value) =>
  isObject(value) && Object.values(value).every((item) => integerOrNull(item) !== null)

// 'verified' only when every required count is present and valid for a readable section.
function requiredCountsOf(name, counts, status) {
  if (REQUIRED_COUNTS[name] === undefined) return 'not-required'
  if (!READABLE.has(status)) return 'not-read'
  let missing = false
  for (const key of REQUIRED_COUNTS[name]) {
    const value = counts[key]
    if (value === undefined) missing = true
    else if (key === 'byState' ? !isCountMap(value) : integerOrNull(value) === null)
      return 'invalid'
  }
  return missing ? 'missing' : 'verified'
}

// A section whose status or flags cannot be verified is unknown. An observed section that was truncated or
// had malformed records, or that lacks a required count, is incomplete, as the collector itself would report it.
function normalizeSection(name, raw) {
  if (!isObject(raw)) return unverifiedSection(['SECTION_MISSING'])
  const reasons = Array.isArray(raw.reasons) ? raw.reasons : []
  if (!STATUSES.has(raw.status)) return unverifiedSection([...reasons, 'STATUS_UNRECOGNIZED'])
  if (typeof raw.truncated !== 'boolean' || integerOrNull(raw.malformedRecords) === null) {
    return unverifiedSection([...reasons, 'FLAGS_UNVERIFIED'])
  }
  const counts = isObject(raw.counts) ? raw.counts : {}
  const requiredCounts = requiredCountsOf(name, counts, raw.status)
  const countsBroken = requiredCounts === 'missing' || requiredCounts === 'invalid'
  const demoted =
    countsBroken || (FULLY_READ.has(raw.status) && (raw.truncated || raw.malformedRecords > 0))
  const extra = countsBroken
    ? [`${name.toUpperCase()}_REQUIRED_COUNTS_${requiredCounts.toUpperCase()}`]
    : demoted
      ? ['TRUNCATED_OR_MALFORMED']
      : []
  return {
    status: demoted ? OBSERVATION_STATUS.INCOMPLETE : raw.status,
    reasons: codeReasons([...reasons, ...extra]),
    requiredCounts,
    counts,
    truncated: raw.truncated,
    malformedRecords: raw.malformedRecords,
  }
}

// Why the required sections do not support exact counts. Empty when both were read in full.
function exactReasonsOf(sections) {
  const reasons = []
  for (const name of ['executions', 'checkpoints']) {
    const section = sections[name]
    if (fullyRead(section)) continue
    reasons.push(
      section.requiredCounts === 'missing' || section.requiredCounts === 'invalid'
        ? `${name.toUpperCase()}_REQUIRED_COUNTS_${section.requiredCounts.toUpperCase()}`
        : `${name.toUpperCase()}_${section.status.toUpperCase()}`
    )
  }
  return reasons.toSorted()
}

const fullyRead = (section) =>
  FULLY_READ.has(section.status) && section.truncated === false && section.malformedRecords === 0

const measured = (section, key) =>
  READABLE.has(section.status) ? integerOrNull(section.counts[key]) : null

function byStateCount(section, state) {
  if (!READABLE.has(section.status) || !isObject(section.counts.byState)) return null
  return integerOrNull(section.counts.byState[state] ?? 0)
}

function remainderOf(sections) {
  const { executions, checkpoints } = sections
  return {
    executions: measured(executions, 'total'),
    inFlightExecutions: measured(executions, 'inFlight'),
    malformedExecutions: READABLE.has(executions.status) ? executions.malformedRecords : null,
    uncertainEffectExecutions: byStateCount(executions, 'reconciliation_required'),
    threads: measured(checkpoints, 'distinctThreads'),
    checkpoints: measured(checkpoints, 'checkpointRows'),
    writes: measured(checkpoints, 'writeRows'),
    malformedCheckpointRecords: READABLE.has(checkpoints.status)
      ? checkpoints.malformedRecords
      : null,
    unclassifiedThreads: measured(checkpoints, 'unclassifiedThreads'),
    threadsOnInFlightExecutions: measured(checkpoints, 'threadsOnInFlightExecutions'),
    threadsOnUnknownExecutions: measured(checkpoints, 'threadsOnUnknownExecutions'),
  }
}

// Blocker tallies count source records and are included only when the source was read.
function blockersOf(remainder) {
  const blockers = {}
  const add = (code, value) => {
    if (value !== null && value > 0) blockers[code] = value
  }
  add('IN_FLIGHT_WORK', remainder.inFlightExecutions)
  add('UNCERTAIN_EFFECT_UNRECONCILED', remainder.uncertainEffectExecutions)
  add('RETAINED_THREADS_PRESENT', remainder.threads)
  add('MALFORMED_EXECUTION_RECORDS_PRESENT', remainder.malformedExecutions)
  add('MALFORMED_CHECKPOINT_RECORDS_PRESENT', remainder.malformedCheckpointRecords)
  add('UNCLASSIFIED_CHECKPOINT_THREADS', remainder.unclassifiedThreads)
  add('THREADS_ON_UNKNOWN_EXECUTIONS', remainder.threadsOnUnknownExecutions)
  return blockers
}

// Zero is never established by this adapter. The reasons say why, in the scope's own terms.
function zeroOf(scope, sections, exact, exactReasons, blockers) {
  const reasons = new Set([ZERO_REASON_BY_SCOPE[scope]])
  if (!exact) reasons.add('READ_INCOMPLETE')
  for (const name of SECTION_NAMES) {
    if (!FULLY_READ.has(sections[name].status)) {
      reasons.add(`${name.toUpperCase()}_${sections[name].status.toUpperCase()}`)
    }
  }
  for (const code of exactReasons) reasons.add(code)
  for (const code of Object.keys(blockers)) reasons.add(code)
  return { established: false, attested: false, reasons: [...reasons].toSorted() }
}

function observationOf(sections, exact) {
  const statuses = SECTION_NAMES.map((name) => sections[name].status)
  return (
    PRECEDENCE.find((status) => statuses.includes(status)) ??
    (exact ? OBSERVATION_STATUS.OBSERVED : OBSERVATION_STATUS.INCOMPLETE)
  )
}

/**
 * Reports one collector manifest in the legacy remainder vocabulary. Pure: no store, no clock, no output
 * beyond the returned object. The result never carries entries, connection strings, or free-text reasons,
 * and `zero.established` is always false.
 */
export function buildLegacyInventoryStatus(manifest) {
  validateManifest(manifest)
  const scope = manifest.observationScope
  const sections = Object.fromEntries(
    SECTION_NAMES.map((name) => [name, normalizeSection(name, manifest.sections[name])])
  )
  const exactReasons = exactReasonsOf(sections)
  const exact = exactReasons.length === 0
  const remainder = remainderOf(sections)
  const blockers = blockersOf(remainder)
  const epistemics = manifest.epistemics
  const collectorClaim = isObject(epistemics.zeroLiveWorkClaim)
    ? epistemics.zeroLiveWorkClaim.claim
    : undefined
  return {
    schema: LEGACY_INVENTORY_STATUS_SCHEMA,
    source: {
      manifest: manifest.manifest,
      manifestVersion: manifest.manifestVersion,
      observedAt: manifest.observedAt,
      observationScope: scope,
      legacyScope: LEGACY_SCOPE_BY_SCOPE[scope],
      identity: isObject(manifest.store) ? (manifest.store.identity ?? null) : null,
      sourceRevision: REVISION_PATTERN.test(manifest.sourceRevision ?? '')
        ? manifest.sourceRevision
        : 'unspecified',
    },
    observation: observationOf(sections, exact),
    exact,
    exactReasons,
    sections: Object.fromEntries(
      SECTION_NAMES.map((name) => [
        name,
        {
          status: sections[name].status,
          reasons: sections[name].reasons,
          requiredCounts: sections[name].requiredCounts,
        },
      ])
    ),
    remainder,
    blockers,
    zero: zeroOf(scope, sections, exact, exactReasons, blockers),
    retainedWork: {
      classification: RETAINED_CLASSES.has(epistemics.retainedWorkClassification)
        ? epistemics.retainedWorkClassification
        : 'unknown',
      collectorClaim: COLLECTOR_CLAIMS.has(collectorClaim) ? collectorClaim : 'unknown',
      attested: false,
    },
    retainedDependencies: [...RETAINED_DEPENDENCIES],
    removal: {
      satisfied: false,
      reasons: ['ZERO_NOT_ESTABLISHED', 'NO_ADMISSIBLE_GRAPHS_OBSERVED', 'LEGACY_OWNER_RETAINED'],
    },
    unmapped: [...UNMAPPED],
  }
}

const HELP_TEXT = `langgraph-retirement-status-adapter — M16.03 legacy status for one M16.01 manifest

  bun scripts/langgraph-retirement-inventory-pg.mjs --observation-scope deployed-dsn --dsn <dsn> \\
    | bun scripts/langgraph-retirement-status-adapter.mjs --manifest /dev/stdin

  --manifest <path>   A manifest JSON file from the collector, or /dev/stdin.
  --help              Print this help.

Reads one file. Contacts no store and never establishes zero.
`

export async function runLegacyInventoryStatusCli({
  argv,
  stdout = process.stdout,
  readManifest = (path) => readFile(path, 'utf8'),
} = {}) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: { help: { type: 'boolean' }, manifest: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }))
  } catch {
    refuse('INVALID_ARGUMENTS')
  }
  if (values.help === true) {
    stdout.write(HELP_TEXT)
    return { action: 'help', exitCode: 0 }
  }
  if (typeof values.manifest !== 'string') refuse('INVALID_ARGUMENTS')
  let manifest
  try {
    manifest = JSON.parse(await readManifest(values.manifest))
  } catch {
    refuse('MANIFEST_UNREADABLE')
  }
  const status = buildLegacyInventoryStatus(manifest)
  stdout.write(`${stableJsonStringify(status)}\n`)
  return { action: 'status', status, exitCode: 0 }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    await runLegacyInventoryStatusCli({ argv: process.argv.slice(2) })
  } catch (error) {
    const code = error instanceof LegacyInventoryStatusError ? error.code : 'OPERATION_FAILED'
    process.stderr.write(`LANGGRAPH_RETIREMENT_STATUS_FAILED:${code}\n`)
    process.exitCode = 1
  }
}
