// M18 #1224 readiness evidence: inventory checks and reproducible measurements.
//
// The inventory (docs/plans/m18-readiness-inventory.json) names every explicit
// accessibility, performance, cost and operations criterion in the PRD, the TDD,
// ADR-0010 and issue #1224, with the method that can measure it. This module
// measures what it can and records the rest honestly:
//
//   - presence probes search the git tree at main and at exact candidate heads.
//     They count identifiers; they do not prove behavior.
//   - bundle results come from the check-client report that
//     `bun run --cwd apps/web start:check-bundle` prints, compared with the
//     ceilings in scripts/client-bundle-budgets.mjs.
//   - axe results come from the artifact written by scripts/audit-a11y-dev-view.mjs,
//     checked against that lane's contract before they count.
//   - unit results run the named test files (only with --run-unit, and only from a
//     clean tracked tree, so the run names one HEAD).
//   - recorded results come from a JSON file keyed by criterion id, for runs made
//     by hand (for example, the Playwright E2E run).
//   - unavailable, not-measured and not-claimed criteria stay that way. No status
//     is derived for them, and none is inferred from another criterion.
//
// Every evidence input names the exact revision it ran at (a full commit SHA), the
// command that produced it and its exit code. A verdict (pass, fail, partial or
// invalid) counts only when its revision is --main. Evidence from any other
// revision keeps what it observed under `observed` and is reported as not-run, so
// it cannot stand in for main. Malformed or missing inputs are refused or reported
// as invalid or not-run. Nothing passes by default.
//
// Input shapes:
//   --bundle    { "revision", "command", "exitCode", "report" }    report: check-client JSON
//   --axe       { "revision", "command", "exitCode", "artifact" }  artifact: audit JSON
//   --recorded  { "<criterion id>": { "revision", "command", "exitCode", "status", ... } }
//
// Usage:
//   node scripts/readiness-evidence.mjs check
//   node scripts/readiness-evidence.mjs measure --main <rev> [--candidate <pr>=<rev>]...
//     [--bundle <bundle.json>] [--axe <axe.json>] [--recorded <runs.json>]
//     [--run-unit] [--out <file>]

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIENT_BUNDLE_BUDGETS } from './client-bundle-budgets.mjs'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const INVENTORY_PATH = resolve(ROOT, 'docs/plans/m18-readiness-inventory.json')
export const MEASUREMENTS_PATH = resolve(ROOT, 'docs/plans/m18-readiness-measurements.json')

export const CATEGORIES = ['accessibility', 'performance', 'cost', 'operations']
const PREFIX_CATEGORY = {
  ACC: 'accessibility',
  PERF: 'performance',
  COST: 'cost',
  OPS: 'operations',
}
const METHOD_KINDS = [
  'axe',
  'e2e',
  'bundle',
  'unit',
  'presence',
  'recorded-run',
  'not-measured',
  'unavailable',
  'not-claimed',
]
const NEEDS_REASON = ['not-measured', 'unavailable', 'not-claimed']
const RECORDABLE_KINDS = ['axe', 'e2e', 'recorded-run', 'presence']
const TEST_FILE = /(\.test\.[cm]?[jt]sx?$)|(^|\/)(tests?|e2e)\//
const IDENTITY_FIELDS = ['id', 'category', 'kind']
const PROVENANCE_FIELDS = ['revision', 'atMain', 'command', 'exitCode']
const RECORDED_STATUSES = ['pass', 'fail', 'partial', 'blocked', 'measured']
// Statuses that claim a verdict about a revision. Only evidence at --main may make one.
const VERDICTS = ['pass', 'fail', 'partial', 'invalid']
const REVISION = /^[0-9a-f]{40}$/
const AXE_LANE = 'audit-a11y-dev-view'
const AXE_ISSUE = '#426/#541'
/** The axe tags scripts/audit-a11y-dev-view.mjs passes to axe. A test keeps the two in step. */
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const AXE_IMPACTS = ['critical', 'serious', 'moderate', 'minor']
/** Surfaces every audit run scans. `settings/<tab>` adds one per rendered Settings tab. */
const AXE_FIXED_SURFACES = ['chat', 'dev-view-terminal', 'dev-view-narrow-320']
const AXE_SETTINGS_SURFACE = /^settings\/[a-z0-9]+(?:-[a-z0-9]+)*$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
/** A count is a finite, nonnegative integer. Strings, NaN, fractions and negatives are not counts. */
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const isTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
const sameList = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  expected.every((item, index) => actual[index] === item)
const omit = (fields, names) =>
  Object.fromEntries(Object.entries(fields).filter(([key]) => !names.includes(key)))

/** Structural checks on the inventory. Returns an array of error strings. */
export function inventoryErrors(
  inventory,
  { fileExists = (path) => existsSync(resolve(ROOT, path)) } = {}
) {
  const errors = []
  if (inventory?.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  const probes = inventory?.probes ?? {}
  for (const [name, probe] of Object.entries(probes)) {
    const hasPaths = Array.isArray(probe.paths) && probe.paths.length > 0
    if (probe.pathPattern !== undefined) {
      if (typeof probe.pathPattern !== 'string' || probe.pathPattern === '')
        errors.push(`probe ${name} needs a pathPattern`)
      if (!hasPaths) errors.push(`probe ${name} needs paths for pathPattern`)
    } else {
      if (typeof probe.pattern !== 'string' || probe.pattern === '')
        errors.push(`probe ${name} needs a pattern`)
      if (!hasPaths) errors.push(`probe ${name} needs paths`)
    }
  }
  const ids = new Set()
  for (const criterion of inventory?.criteria ?? []) {
    const id = criterion.id
    const where = typeof id === 'string' ? id : '(no id)'
    if (typeof id !== 'string' || !/^(ACC|PERF|COST|OPS)-\d{2}$/.test(id))
      errors.push(`${where}: invalid id`)
    if (ids.has(id)) errors.push(`${where}: duplicate id`)
    ids.add(id)
    const prefix = typeof id === 'string' ? id.split('-')[0] : ''
    if (criterion.category !== PREFIX_CATEGORY[prefix])
      errors.push(`${where}: category must match its id prefix`)
    if (!CATEGORIES.includes(criterion.category)) errors.push(`${where}: unknown category`)
    if (typeof criterion.source !== 'string' || criterion.source === '')
      errors.push(`${where}: source is required`)
    if (typeof criterion.criterion !== 'string' || criterion.criterion === '')
      errors.push(`${where}: criterion text is required`)
    const method = criterion.method ?? {}
    if (!METHOD_KINDS.includes(method.kind)) {
      errors.push(`${where}: unknown method kind ${method.kind}`)
      continue
    }
    if (
      NEEDS_REASON.includes(method.kind) &&
      !(typeof method.reason === 'string' && method.reason.trim())
    )
      errors.push(`${where}: ${method.kind} needs a reason`)
    if (method.kind === 'presence') {
      if (!Array.isArray(method.probes) || method.probes.length === 0)
        errors.push(`${where}: presence needs probes`)
      for (const name of method.probes ?? [])
        if (!probes[name]) errors.push(`${where}: unknown probe ${name}`)
    }
    if (method.kind === 'bundle') {
      if (!Array.isArray(method.keys) || method.keys.length === 0)
        errors.push(`${where}: bundle needs keys`)
      for (const key of method.keys ?? [])
        if (!bundleBudget(key)) errors.push(`${where}: unknown bundle key ${key}`)
    }
    if (method.kind === 'unit') {
      if (!Array.isArray(method.files) || method.files.length === 0)
        errors.push(`${where}: unit needs files`)
      for (const file of method.files ?? [])
        if (!fileExists(file)) errors.push(`${where}: unit file ${file} does not exist`)
    }
  }
  return errors
}

/** The ceiling for a bundle key such as `total`, `startup` or `views.chat`. */
export function bundleBudget(key) {
  if (key === 'total') return CLIENT_BUNDLE_BUDGETS.total
  if (key === 'startup') return CLIENT_BUNDLE_BUDGETS.startup
  if (key.startsWith('views.')) return CLIENT_BUNDLE_BUDGETS.views?.[key.slice('views.'.length)]
  return undefined
}

/**
 * Compare a client bundle report with the ceilings. `report` is check-client's JSON.
 * A metric the report does not carry is `not-run`. A metric that is not a finite
 * nonnegative integer is `invalid`. Neither ever passes.
 */
export function evaluateBundle(report, keys) {
  return keys.map((key) => {
    const budget = bundleBudget(key)
    if (!budget) return { key, status: 'invalid', reason: 'no ceiling for this key' }
    const measured =
      key === 'total'
        ? {
            rawBytes: report?.clientJavaScriptBytes,
            gzipBytes: report?.clientJavaScriptGzipBytes,
            fileCount: report?.clientJavaScriptFiles,
          }
        : key === 'startup'
          ? report?.startup
          : report?.views?.[key.slice('views.'.length)]
    if (!isObject(measured))
      return { key, status: 'not-run', reason: 'key missing from the bundle report' }
    const checks = {
      rawBytes: { measured: measured.rawBytes, limit: budget.rawBytes },
      gzipBytes: { measured: measured.gzipBytes, limit: budget.gzipBytes },
    }
    if (budget.fileCount !== undefined)
      checks.fileCount = { measured: measured.fileCount, limit: budget.fileCount }
    const names = Object.keys(checks)
    const missing = names.filter((name) => checks[name].measured === undefined)
    if (missing.length)
      return { key, status: 'not-run', reason: 'metric missing from the bundle report', missing }
    const invalid = names.filter((name) => !isCount(checks[name].measured))
    if (invalid.length)
      return {
        key,
        status: 'invalid',
        reason: 'metrics must be finite nonnegative integers',
        invalid,
      }
    const failing = names.filter((name) => checks[name].measured > checks[name].limit)
    const headroom = Object.fromEntries(
      names.map((name) => [name, checks[name].limit - checks[name].measured])
    )
    return { key, status: failing.length ? 'fail' : 'pass', checks, headroom, failing }
  })
}

/** Overall status of bundle keys: invalid beats not-run, which beats fail, which beats pass. */
export function bundleStatus(keys) {
  const statuses = keys.map((entry) => entry.status)
  if (statuses.includes('invalid')) return 'invalid'
  if (statuses.includes('not-run')) return 'not-run'
  return statuses.includes('fail') ? 'fail' : 'pass'
}

/**
 * Check the artifact written by scripts/audit-a11y-dev-view.mjs against that lane's
 * contract, then summarize it. `exitCode` is the audit's exit code. A surface the
 * audit did not scan, a failed or empty scope, counts that disagree with the recorded
 * violations, or an exit code the lane does not produce makes the artifact `invalid`.
 * Only a complete strict scan can pass or fail.
 */
export function summarizeAxe(artifact, { exitCode } = {}) {
  if (!isObject(artifact)) return { status: 'invalid', problems: ['artifact is not an object'] }
  const problems = []
  if (artifact.schemaVersion !== 1) problems.push('schemaVersion must be 1')
  if (artifact.lane !== AXE_LANE) problems.push(`lane must be ${AXE_LANE}`)
  if (artifact.issue !== AXE_ISSUE) problems.push(`issue must be ${AXE_ISSUE}`)
  if (typeof artifact.standard !== 'string' || !artifact.standard.includes('WCAG 2.2 AA'))
    problems.push('standard must name WCAG 2.2 AA')
  if (!sameList(artifact.tags, AXE_TAGS)) problems.push('tags must be the WCAG 2.2 AA axe tag set')
  if (artifact.strict !== true) problems.push('the audit must run with --strict')
  if (typeof artifact.axeVersion !== 'string' || artifact.axeVersion === '')
    problems.push('axeVersion is required')
  if (typeof artifact.baseUrl !== 'string' || artifact.baseUrl === '')
    problems.push('baseUrl is required')
  if (!isTimestamp(artifact.startedAt) || !isTimestamp(artifact.completedAt))
    problems.push('startedAt and completedAt must be timestamps')
  if (!Array.isArray(artifact.violationClasses)) problems.push('violationClasses is required')

  const totals = { critical: 0, serious: 0, moderate: 0, minor: 0 }
  const labels = new Set()
  const surfaces = Array.isArray(artifact.surfaces) ? artifact.surfaces : []
  if (surfaces.length === 0) problems.push('no surface was scanned')
  for (const [index, surface] of surfaces.entries()) {
    if (!isObject(surface)) {
      problems.push(`surfaces[${index}] is not an object`)
      continue
    }
    const label = surface.surface
    if (typeof label !== 'string' || label === '') {
      problems.push(`surfaces[${index}] has no surface label`)
      continue
    }
    if (surface.error !== undefined) problems.push(`${label} failed: ${String(surface.error)}`)
    if (labels.has(label)) problems.push(`${label} is listed twice`)
    labels.add(label)
    if (!AXE_FIXED_SURFACES.includes(label) && !AXE_SETTINGS_SURFACE.test(label))
      problems.push(`${label} is not an audited surface`)
    if (typeof surface.url !== 'string' || surface.url === '') problems.push(`${label} has no url`)
    const violations = Array.isArray(surface.violations) ? surface.violations : null
    if (!violations) problems.push(`${label} has no violations list`)
    const recounted = { critical: 0, serious: 0, moderate: 0, minor: 0 }
    for (const violation of violations ?? []) {
      const knownImpact = violation?.impact === null || AXE_IMPACTS.includes(violation?.impact)
      if (
        !isObject(violation) ||
        typeof violation.id !== 'string' ||
        !isCount(violation.nodeCount) ||
        !knownImpact
      ) {
        problems.push(`${label} has a malformed violation`)
        continue
      }
      if (violation.impact !== null) recounted[violation.impact] += violation.nodeCount
    }
    const counts = isObject(surface.counts) ? surface.counts : {}
    for (const impact of AXE_IMPACTS) {
      if (!isCount(counts[impact])) {
        problems.push(`${label} counts.${impact} must be a count`)
        continue
      }
      totals[impact] += counts[impact]
      if (violations && counts[impact] !== recounted[impact])
        problems.push(`${label} counts.${impact} disagrees with its violations`)
    }
  }
  for (const label of AXE_FIXED_SURFACES)
    if (!labels.has(label)) problems.push(`${label} was not scanned`)
  if (![...labels].some((label) => AXE_SETTINGS_SURFACE.test(label)))
    problems.push('no Settings tab was scanned')

  const blocking = totals.critical + totals.serious
  if (
    !isObject(artifact.totals) ||
    AXE_IMPACTS.some((impact) => artifact.totals[impact] !== totals[impact])
  )
    problems.push('totals disagree with the scanned surfaces')
  if (artifact.blockingViolations !== blocking)
    problems.push('blockingViolations disagrees with the scanned surfaces')
  if (!Number.isInteger(exitCode)) problems.push('exitCode is required')
  else if (exitCode !== 0 && exitCode !== 2)
    problems.push(`exit ${exitCode} is a lane failure, not a completed scan`)
  else if ((exitCode === 2) !== blocking > 0)
    problems.push(`exit ${exitCode} does not match ${blocking} serious or critical violation(s)`)

  if (problems.length) return { status: 'invalid', problems }
  return {
    status: blocking === 0 ? 'pass' : 'fail',
    totals,
    surfaces: surfaces.map((surface) => ({
      surface: surface.surface,
      violationRules: surface.violations.length,
      counts: surface.counts,
    })),
  }
}

export function resolveRevision(revision, cwd = ROOT) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0)
    throw new Error(`revision ${revision} is not in the local object store; fetch it first`)
  return result.stdout.trim()
}

/** Evidence names one exact revision: a full commit SHA that exists in the local object store. */
export function exactRevision(value, cwd = ROOT, label = 'revision') {
  if (typeof value !== 'string' || !REVISION.test(value))
    throw new Error(`${label} must be a full 40-character commit SHA, got ${JSON.stringify(value)}`)
  return resolveRevision(value, cwd)
}

/** Files at a revision matching a probe. Returns repo paths, sorted. */
export function probeFiles(revision, probe, cwd = ROOT) {
  const sha = resolveRevision(revision, cwd)
  let files
  if (probe.pathPattern) {
    const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', sha, '--', ...probe.paths], {
      cwd,
      encoding: 'utf8',
    })
    if (listed.status !== 0) throw new Error(`git ls-tree failed at ${sha}`)
    files = listed.stdout
      .split('\n')
      .filter(Boolean)
      .filter((path) => new RegExp(probe.pathPattern, 'i').test(path))
  } else {
    const args = ['grep', '-l', '-I', '-E', '-e', probe.pattern]
    if (probe.ignoreCase) args.push('-i')
    args.push(sha, '--', ...probe.paths)
    const grep = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (grep.status !== 0 && grep.status !== 1)
      throw new Error(`git grep failed at ${sha}: ${grep.stderr}`)
    files = grep.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(sha.length + 1))
  }
  if (probe.testFilesOnly) files = files.filter((path) => TEST_FILE.test(path))
  return [...new Set(files)].toSorted()
}

/** A finished unit run passes only with tests reported and none failing. Exit 0 with no tests is invalid. */
export function unitVerdict({ exitCode, pass, fail }) {
  if (exitCode !== 0 || fail > 0) return 'fail'
  return pass > 0 ? 'pass' : 'invalid'
}

/** Run the named unit test files under `cwd` and report the command and its exit code. */
export function runUnit(files, cwd = ROOT) {
  const started = Date.now()
  const argv = ['test', ...files]
  const run = spawnSync('bun', argv, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.error) throw run.error
  if (run.status === null) throw new Error(`bun test ended by signal ${run.signal}`)
  const output = `${run.stdout}${run.stderr}`
  const count = (label) =>
    Number(output.match(new RegExp(`^\\s*(\\d+) ${label}\\b`, 'm'))?.[1] ?? 0)
  return {
    command: ['bun', ...argv].join(' '),
    exitCode: run.status,
    pass: count('pass'),
    fail: count('fail'),
    seconds: Math.round((Date.now() - started) / 100) / 10,
  }
}

function gitOutput(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/**
 * The HEAD a working-tree run is about. Uncommitted tracked changes mean the run names
 * no single revision, so it is refused.
 */
export function headRevision(cwd = ROOT) {
  if (gitOutput(cwd, ['status', '--porcelain', '--untracked-files=no']) !== '')
    throw new Error(
      '--run-unit needs a clean tracked tree so the run names one revision; commit the changes first'
    )
  return gitOutput(cwd, ['rev-parse', 'HEAD'])
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Build the measurement record. `options` names the revisions and carries the evidence
 * the caller produced. Missing evidence stays `not-run`. Malformed evidence throws.
 */
export function buildMeasurements(inventory, options) {
  const {
    cwd = ROOT,
    mainRevision,
    candidates = {},
    bundle,
    axe,
    recorded = {},
    unitRuns = {},
  } = options
  const main = resolveRevision(mainRevision, cwd)
  const revisions = { main }
  for (const [pr, rev] of Object.entries(candidates))
    revisions[`pr-${pr}`] = resolveRevision(rev, cwd)
  const seen = new Set(Object.values(revisions))

  const criteria = new Map(inventory.criteria.map((criterion) => [criterion.id, criterion]))
  for (const id of Object.keys(recorded)) {
    const criterion = criteria.get(id)
    if (!criterion) throw new Error(`recorded run for unknown criterion ${id}`)
    if (!RECORDABLE_KINDS.includes(criterion.method.kind))
      throw new Error(`${id} (${criterion.method.kind}) does not accept recorded runs`)
  }
  for (const id of Object.keys(unitRuns))
    if (criteria.get(id)?.method.kind !== 'unit')
      throw new Error(`unit run for ${id}, which is not a unit criterion`)

  // Evidence names its exact revision, command and exit code, or it is refused.
  const provenance = (evidence, label) => {
    if (!isObject(evidence)) throw new Error(`${label} must be an object`)
    const revision = exactRevision(evidence.revision, cwd, `${label} revision`)
    if (typeof evidence.command !== 'string' || evidence.command.trim() === '')
      throw new Error(`${label} needs the command that produced it`)
    if (!Number.isInteger(evidence.exitCode)) throw new Error(`${label} needs an integer exitCode`)
    seen.add(revision)
    return {
      revision,
      atMain: revision === main,
      command: evidence.command,
      exitCode: evidence.exitCode,
    }
  }
  // A verdict counts only for --main. Other evidence keeps what it observed, reported as not-run.
  const settle = (source, verdict) => {
    if (source.atMain || !VERDICTS.includes(verdict.status)) return { ...source, ...verdict }
    return {
      ...source,
      status: 'not-run',
      reason: `measured at ${source.revision}, not at --main ${main}`,
      observed: verdict,
    }
  }
  // A recorded run keeps its own identity fields out of the result. A conflicting identity is refused.
  const recordedRun = (criterion, entry) => {
    if (!isObject(entry)) throw new Error(`${criterion.id}: a recorded run must be an object`)
    const identity = { id: criterion.id, category: criterion.category, kind: criterion.method.kind }
    for (const field of IDENTITY_FIELDS)
      if (entry[field] !== undefined && entry[field] !== identity[field])
        throw new Error(
          `${criterion.id}: recorded ${field} ${JSON.stringify(entry[field])} does not match ${JSON.stringify(identity[field])}`
        )
    if (!RECORDED_STATUSES.includes(entry.status))
      throw new Error(
        `${criterion.id}: recorded status must be one of ${RECORDED_STATUSES.join(', ')}`
      )
    if (entry.status === 'blocked' && !(typeof entry.reason === 'string' && entry.reason.trim()))
      throw new Error(`${criterion.id}: a blocked run needs a reason`)
    const source = provenance(entry, `${criterion.id} recorded run`)
    const succeeded = ['pass', 'partial', 'measured'].includes(entry.status)
    if (succeeded !== (source.exitCode === 0))
      throw new Error(
        `${criterion.id}: a ${entry.status} run needs exit ${succeeded ? 0 : 'non-zero'}, got ${source.exitCode}`
      )
    return { source, verdict: omit(entry, [...IDENTITY_FIELDS, ...PROVENANCE_FIELDS]) }
  }
  const recordedContext = (criterion) => {
    if (!recorded[criterion.id]) return {}
    const { source, verdict } = recordedRun(criterion, recorded[criterion.id])
    return { recorded: { ...source, ...verdict } }
  }

  const bundleSource = bundle === undefined ? undefined : provenance(bundle, 'bundle')
  if (bundleSource && !/check-(client|bundle)/.test(bundleSource.command))
    throw new Error('bundle must come from the check-client run')
  if (bundle && !isObject(bundle.report)) throw new Error('bundle needs the check-client report')
  const axeSource = axe === undefined ? undefined : provenance(axe, 'axe')
  if (axeSource && !axeSource.command.includes('audit-a11y-dev-view'))
    throw new Error('axe must come from the audit-a11y-dev-view run')

  const probeCache = new Map()
  const presence = (probeName, revisionKey) => {
    const cacheKey = `${probeName}@${revisionKey}`
    if (!probeCache.has(cacheKey)) {
      const files = probeFiles(revisions[revisionKey], inventory.probes[probeName], cwd)
      probeCache.set(cacheKey, {
        probe: probeName,
        revision: revisions[revisionKey],
        count: files.length,
        files: files.slice(0, 10),
      })
    }
    return probeCache.get(cacheKey)
  }

  const results = inventory.criteria.map((criterion) => {
    const method = criterion.method
    const record = (fields) => ({
      id: criterion.id,
      category: criterion.category,
      kind: method.kind,
      ...omit(fields, IDENTITY_FIELDS),
    })
    switch (method.kind) {
      case 'presence': {
        const onMain = method.probes.map((name) => presence(name, 'main'))
        const onCandidates = Object.keys(candidates).map((pr) => ({
          pr: Number(pr),
          probes: method.probes.map((name) => presence(name, `pr-${pr}`)),
        }))
        return record({
          status: onMain.some((entry) => entry.count > 0) ? 'present' : 'absent',
          revision: main,
          atMain: true,
          main: onMain,
          candidates: onCandidates,
          ...recordedContext(criterion),
        })
      }
      case 'bundle': {
        if (!bundleSource) return record({ status: 'not-run', reason: 'no bundle report supplied' })
        const keys = evaluateBundle(bundle.report, method.keys)
        // check-client throws, exits nonzero and prints no report when a budget is exceeded.
        // A report that arrives with a nonzero exit is not a measurement, whatever its fields say.
        if (bundleSource.exitCode !== 0)
          return record(
            settle(bundleSource, {
              status: 'invalid',
              reason: `check-client exited ${bundleSource.exitCode}; its report is not a measurement`,
              keys,
            })
          )
        return record(settle(bundleSource, { status: bundleStatus(keys), keys }))
      }
      case 'axe': {
        if (axeSource) {
          const verdict = summarizeAxe(axe.artifact, { exitCode: axe.exitCode })
          return record({ ...settle(axeSource, verdict), ...recordedContext(criterion) })
        }
        if (recorded[criterion.id]) {
          const { source, verdict } = recordedRun(criterion, recorded[criterion.id])
          // Without its validated audit artifact, an axe run can be recorded as blocked or failed,
          // never as a pass. A recorded pass is kept as observed and reported as invalid.
          if (['pass', 'partial'].includes(verdict.status))
            return record({
              ...source,
              status: 'invalid',
              reason: `a recorded axe ${verdict.status} needs its validated audit artifact (--axe)`,
              observed: verdict,
            })
          return record(settle(source, verdict))
        }
        return record({ status: 'not-run', reason: 'no axe artifact or recorded run supplied' })
      }
      case 'unit': {
        const run = unitRuns[criterion.id]
        if (!run) return record({ status: 'not-run', reason: 'run with --run-unit' })
        const source = provenance(run, `${criterion.id} unit run`)
        if (!isCount(run.pass) || !isCount(run.fail))
          throw new Error(`${criterion.id}: a unit run needs pass and fail counts`)
        if (!method.files.every((file) => source.command.includes(file)))
          throw new Error(
            `${criterion.id}: the unit run's command does not name every criterion file`
          )
        const status = unitVerdict({ exitCode: run.exitCode, pass: run.pass, fail: run.fail })
        // A passing run that covers only part of the criterion is partial, not pass.
        const scoped = method.limit && status === 'pass'
        const verdict = scoped ? { status: 'partial', scopeLimit: method.limit } : { status }
        return record(
          settle(source, { ...verdict, pass: run.pass, fail: run.fail, seconds: run.seconds })
        )
      }
      case 'e2e':
      case 'recorded-run': {
        if (!recorded[criterion.id])
          return record({ status: 'not-run', reason: 'no recorded run supplied' })
        const { source, verdict } = recordedRun(criterion, recorded[criterion.id])
        return record(settle(source, verdict))
      }
      case 'not-measured':
      case 'unavailable':
      case 'not-claimed':
        return record({ status: method.kind, reason: method.reason })
      default:
        throw new Error(`unhandled method ${method.kind}`)
    }
  })
  return {
    schemaVersion: 1,
    issue: inventory.issue,
    inventorySha256: sha256(INVENTORY_PATH),
    revisions,
    evidenceRevisions: [...seen].toSorted(),
    probes: Object.keys(inventory.probes),
    results,
  }
}

function argValues(argv, name) {
  const values = []
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === name) values.push(argv[i + 1])
  return values
}

function argValue(argv, name) {
  return argValues(argv, name)[0]
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'))
}

async function runCli(argv) {
  const [command] = argv
  const inventory = readJson(INVENTORY_PATH.slice(ROOT.length + 1))
  if (command === 'check') {
    const errors = inventoryErrors(inventory)
    if (errors.length) {
      for (const error of errors) console.error(error)
      process.exit(1)
    }
    console.log(
      `inventory ok: ${inventory.criteria.length} criteria, ${Object.keys(inventory.probes).length} probes`
    )
    return
  }
  if (command === 'measure') {
    const errors = inventoryErrors(inventory)
    if (errors.length) throw new Error(`inventory invalid: ${errors.join('; ')}`)
    const mainRevision = argValue(argv, '--main')
    if (!mainRevision) throw new Error('measure needs --main <rev>')
    const candidates = {}
    for (const pair of argValues(argv, '--candidate')) {
      const [pr, rev] = pair.split('=')
      if (!pr || !rev) throw new Error(`--candidate needs <pr>=<rev>, got ${pair}`)
      candidates[pr] = rev
    }
    const bundlePath = argValue(argv, '--bundle')
    const axePath = argValue(argv, '--axe')
    const recordedPath = argValue(argv, '--recorded')
    const unitRuns = {}
    if (argv.includes('--run-unit')) {
      const head = headRevision(ROOT)
      for (const criterion of inventory.criteria) {
        if (criterion.method.kind === 'unit')
          unitRuns[criterion.id] = { revision: head, ...runUnit(criterion.method.files) }
      }
    }
    const measurements = buildMeasurements(inventory, {
      mainRevision,
      candidates,
      bundle: bundlePath ? readJson(bundlePath) : undefined,
      axe: axePath ? readJson(axePath) : undefined,
      recorded: recordedPath ? readJson(recordedPath) : {},
      unitRuns,
    })
    const out = argValue(argv, '--out') ?? MEASUREMENTS_PATH.slice(ROOT.length + 1)
    writeFileSync(resolve(ROOT, out), `${JSON.stringify(measurements, null, 2)}\n`)
    console.log(`wrote ${out}: ${measurements.results.length} criteria`)
    return
  }
  console.error('usage: readiness-evidence.mjs check | measure --main <rev> [options]')
  process.exit(2)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runCli(process.argv.slice(2))
}
