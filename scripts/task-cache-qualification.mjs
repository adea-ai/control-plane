/**
 * Deterministic qualification of the production task cache.
 *
 * The task runner writes a machine-readable summary of every run to
 * `node_modules/.vite/task-cache/v<version>/last-summary.json`: it names every
 * task the run executed, whether each task was served from the cache, and which
 * input invalidated it. This script reads that summary instead of matching a
 * human-facing log line, so the qualification never depends on a log string and
 * never hardcodes a task count.
 *
 * The expected task set comes from the build graph in `scripts/orch-graph.mjs`,
 * and the expected outputs come from the `cache.output` globs the same graph
 * declares. A task count that no longer matches the graph therefore fails the
 * qualification instead of passing a stale number.
 *
 * Every check fails closed: a malformed summary, an unexpected task, a missing
 * task, a command that does not match the graph, or an output inventory that
 * differs from the clean build ends the run with a non-zero exit code.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildTasks } from './orch-graph.mjs'
import { expectedId } from './orch-toolchain.mjs'

export const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The directory the task runner keeps its cache entries in. */
export function cacheDirectory(root = repositoryRoot) {
  return join(root, 'node_modules', '.vite', 'task-cache')
}

/** The machine-readable summary of the last run, one per cache format version. */
const summaryFileName = 'last-summary.json'

/** A cache entry is one archived task result. */
const entrySuffix = '.tar.zst'

/**
 * Code-point order, the locale-independent comparison the repository uses for
 * every digest. Plain `<`/`>` compares code points; `localeCompare` does not.
 */
/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
const compareCodePointOrder = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

/** The malformed input that makes the qualification impossible to trust. */
export class MalformedSummaryError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = 'MalformedSummaryError'
  }
}

/**
 * One task of the build graph: the command it runs, the tasks it depends on and
 * whether its result is cached.
 *
 * @typedef {{ command: string, dependsOn?: string[], cache?: unknown }} Task
 */

/**
 * Why a task did not come from the cache.
 *
 * @typedef {{ reason: string, path: string | null, inputKind: string | null }} Invalidation
 */

/**
 * One task of a run summary.
 *
 * @typedef {{
 *   name: string,
 *   packageName: string,
 *   command: string,
 *   kind: string,
 *   savedMs: number | null,
 *   invalidation: Invalidation | null,
 *   failed: boolean,
 * }} SummaryTask
 */

/**
 * The machine-readable summary of one run.
 *
 * @typedef {{ exitCode: number, tasks: SummaryTask[] }} RunSummary
 */

/**
 * The tasks a run of a scope executes, with the commands the graph gives them.
 *
 * @typedef {{
 *   scope: string,
 *   tasks: Map<string, Task & { name: string, cached: boolean, outputs: string[] }>,
 *   toolchain: string,
 * }} ExpectedRun
 */

/**
 * An invalidation, with the place the changed input lives.
 *
 * @typedef {{ task: string, kind: string, path: string | null, package: string | null }} ClassifiedInvalidation
 */

/**
 * A command the run used that the build graph does not declare.
 *
 * @typedef {{ task: string, expected: string, observed: string, kind: string }} CommandMismatch
 */

/**
 * A run, compared with the tasks the build graph expects.
 *
 * @typedef {{
 *   scope: string,
 *   toolchain: string,
 *   exitCode: number,
 *   expected: string[],
 *   cached: string[],
 *   hits: string[],
 *   misses: string[],
 *   disabled: string[],
 *   failures: string[],
 *   missing: string[],
 *   unexpected: string[],
 *   commandMismatches: CommandMismatch[],
 *   invalidations: ClassifiedInvalidation[],
 * }} RunAnalysis
 */

/**
 * One build output, with its digest.
 *
 * @typedef {{ path: string, bytes: number, sha256: string }} OutputFile
 */

/**
 * Every build output the graph declares, and the output roots they came from.
 *
 * @typedef {{ files: OutputFile[], roots?: string[] }} Inventory
 */

/**
 * The command line options of one invocation.
 *
 * @typedef {Record<string, string | boolean | string[]> & { _: string[] }} Options
 */

/**
 * Whether a value is a JSON object, so its members can be read by name.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The toolchain identifier a command was written for, if it carries one. */
/**
 * @param {string} command
 * @returns {string | null}
 */
export function toolchainOf(command) {
  const prefix = /^ORCH_TOOLCHAIN=(\S+)/.exec(command)
  if (prefix) return prefix[1]
  const expected = /--expect (\S+)/.exec(command)
  return expected ? expected[1] : null
}

/**
 * @param {unknown} miss
 * @param {string} label
 * @returns {Invalidation}
 */
function parseMiss(miss, label) {
  if (typeof miss === 'string') {
    if (miss !== 'NotFound')
      throw new MalformedSummaryError(`${label} reports an unknown cache miss "${miss}"`)
    return { reason: 'not-found', path: null, inputKind: null }
  }
  if (!isPlainObject(miss)) throw new MalformedSummaryError(`${label} has a malformed cache miss`)
  const kinds = Object.keys(miss)
  if (kinds.length !== 1) {
    throw new MalformedSummaryError(`${label} reports ${kinds.length} cache miss kinds`)
  }
  const kind = kinds[0]
  if (kind === 'NotFound') return { reason: 'not-found', path: null, inputKind: null }
  if (kind === 'InputChanged') {
    const body = miss.InputChanged
    if (!isPlainObject(body) || typeof body.path !== 'string' || body.path.length === 0) {
      throw new MalformedSummaryError(`${label} reports an input change without a path`)
    }
    return {
      reason: 'input-changed',
      path: /** @type {string} */ (body.path),
      inputKind: typeof body.kind === 'string' ? body.kind : null,
    }
  }
  throw new MalformedSummaryError(`${label} reports an unknown cache miss "${kind}"`)
}

/**
 * @param {unknown} entry
 * @param {number} index
 * @returns {SummaryTask}
 */
function parseEntry(entry, index) {
  const label = `task ${index}`
  if (!isPlainObject(entry)) throw new MalformedSummaryError(`${label} is not an object`)
  for (const key of ['package_name', 'task_name', 'command']) {
    if (typeof entry[key] !== 'string' || entry[key].length === 0) {
      throw new MalformedSummaryError(`${label} has no "${key}"`)
    }
  }
  const result = entry.result
  if (!isPlainObject(result)) throw new MalformedSummaryError(`${label} has no "result" object`)
  const kinds = Object.keys(result)
  if (kinds.length !== 1) {
    throw new MalformedSummaryError(`${label} reports ${kinds.length} result kinds`)
  }
  const kind = kinds[0]
  const body = result[kind]
  if (!isPlainObject(body))
    throw new MalformedSummaryError(`${label} has a malformed "${kind}" result`)
  const name = /** @type {string} */ (entry.task_name)
  const packageName = /** @type {string} */ (entry.package_name)
  const command = /** @type {string} */ (entry.command)
  if (kind === 'CacheHit') {
    return {
      name,
      packageName,
      command,
      kind: 'hit',
      savedMs: typeof body.saved_duration_ms === 'number' ? body.saved_duration_ms : null,
      invalidation: null,
      failed: false,
    }
  }
  if (kind !== 'Spawned') {
    throw new MalformedSummaryError(`${label} reports an unknown result kind "${kind}"`)
  }
  const status = body.cache_status
  if (status === 'Disabled') {
    return {
      name,
      packageName,
      command,
      kind: 'disabled',
      savedMs: null,
      invalidation: null,
      failed: Boolean(body.outcome && isPlainObject(body.outcome) && 'Failure' in body.outcome),
    }
  }
  if (!isPlainObject(status) || !('Miss' in status)) {
    throw new MalformedSummaryError(`${label} reports an unknown cache status`)
  }
  return {
    name,
    packageName,
    command,
    kind: 'miss',
    savedMs: null,
    invalidation: parseMiss(status.Miss, label),
    failed: Boolean(body.outcome && isPlainObject(body.outcome) && 'Failure' in body.outcome),
  }
}

/** Parses a run summary, failing closed on any shape the runner does not write. */
/**
 * @param {string} text
 * @returns {RunSummary}
 */
export function parseSummary(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new MalformedSummaryError(`the summary is not valid JSON: ${message}`)
  }
  if (!isPlainObject(raw)) throw new MalformedSummaryError('the summary is not a JSON object')
  if (!Array.isArray(raw.tasks)) throw new MalformedSummaryError('the summary has no "tasks" array')
  if (typeof raw.exit_code !== 'number') {
    throw new MalformedSummaryError('the summary has no numeric "exit_code"')
  }
  const tasks = raw.tasks.map((entry, index) => parseEntry(entry, index))
  const names = new Set()
  for (const task of tasks) {
    if (names.has(task.name))
      throw new MalformedSummaryError(`the summary reports "${task.name}" twice`)
    names.add(task.name)
  }
  return { exitCode: raw.exit_code, tasks }
}

/** The tasks a run of `scope` executes, with the commands the graph gives them. */
/**
 * @param {string} root
 * @param {string} toolchain
 * @param {string} [scope]
 * @returns {ExpectedRun}
 */
export function expectedTasks(root, toolchain, scope = 'orch:build') {
  const graph = /** @type {Record<string, Task>} */ (buildTasks(root, toolchain))
  const names = new Set()
  const pending = [scope]
  while (pending.length > 0) {
    const name = pending.pop()
    if (name === undefined) continue
    if (names.has(name)) continue
    const task = graph[name]
    if (!task) throw new Error(`the build graph has no task "${name}"`)
    names.add(name)
    for (const dependency of task.dependsOn ?? []) pending.push(dependency)
  }
  const tasks = new Map()
  for (const name of names) {
    const task = graph[name]
    const cached = task.cache !== false
    const outputGlobs =
      isPlainObject(task.cache) && Array.isArray(task.cache.output) ? task.cache.output : []
    tasks.set(name, {
      name,
      command: task.command,
      cached,
      outputs: outputGlobs,
    })
  }
  return { scope, tasks, toolchain }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
const workspaceDirectories = (root) => {
  const directories = []
  for (const parent of ['apps', 'packages']) {
    const base = join(root, parent)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = `${parent}/${entry.name}`
      if (existsSync(join(base, entry.name, 'package.json'))) directories.push(directory)
    }
  }
  return directories.toSorted(compareCodePointOrder)
}

/**
 * Where an invalidated task's input lives: inside a workspace package is a
 * source change, anything else is a repository-wide configuration change.
 */
/**
 * @param {Invalidation | null} invalidation
 * @param {string[]} packages
 * @returns {{ kind: string, path: string | null, package: string | null }}
 */
export function classifyInvalidation(invalidation, packages) {
  if (!invalidation || invalidation.reason !== 'input-changed') {
    return { kind: 'cold', path: null, package: null }
  }
  const path = /** @type {string} */ (invalidation.path)
  const owner = packages.find((directory) => path.startsWith(`${directory}/`)) ?? null
  return { kind: owner ? 'source' : 'config', path, package: owner }
}

/** Compares a run summary with the tasks the build graph expects. */
/**
 * @param {{ summary: RunSummary, expected: ExpectedRun, packages: string[] }} run
 * @returns {RunAnalysis}
 */
export function analyzeRun({ summary, expected, packages }) {
  const hits = []
  const misses = []
  const disabled = []
  const failures = []
  const missing = []
  const unexpected = []
  const commandMismatches = []
  const invalidations = []
  const seen = new Set()
  for (const entry of summary.tasks) {
    seen.add(entry.name)
    const task = expected.tasks.get(entry.name)
    if (!task) {
      unexpected.push(entry.name)
      continue
    }
    if (task.command !== entry.command) {
      commandMismatches.push({
        task: entry.name,
        expected: task.command,
        observed: entry.command,
        kind: toolchainOf(task.command) !== toolchainOf(entry.command) ? 'toolchain' : 'command',
      })
    }
    if (entry.failed) failures.push(entry.name)
    if (entry.kind === 'hit') hits.push(entry.name)
    else if (entry.kind === 'disabled') disabled.push(entry.name)
    else {
      misses.push(entry.name)
      invalidations.push({
        task: entry.name,
        ...classifyInvalidation(entry.invalidation, packages),
      })
    }
  }
  for (const name of expected.tasks.keys()) if (!seen.has(name)) missing.push(name)
  return {
    scope: expected.scope,
    toolchain: expected.toolchain,
    exitCode: summary.exitCode,
    expected: [...expected.tasks.keys()].toSorted(compareCodePointOrder),
    cached: [...expected.tasks.values()]
      .filter((task) => task.cached)
      .map((task) => task.name)
      .toSorted(compareCodePointOrder),
    hits: hits.toSorted(compareCodePointOrder),
    misses: misses.toSorted(compareCodePointOrder),
    disabled: disabled.toSorted(compareCodePointOrder),
    failures: failures.toSorted(compareCodePointOrder),
    missing: missing.toSorted(compareCodePointOrder),
    unexpected: unexpected.toSorted(compareCodePointOrder),
    commandMismatches,
    invalidations,
  }
}

/** The reason a task did not come from the cache, in words. */
/**
 * @param {RunAnalysis} analysis
 * @param {string} task
 * @returns {string}
 */
export function describeInvalidation(analysis, task) {
  const invalidation = analysis.invalidations.find((entry) => entry.task === task)
  if (!invalidation) return 'the summary does not say why'
  if (invalidation.kind === 'cold') return 'no cache entry existed'
  return `the ${invalidation.kind} input "${invalidation.path}" changed`
}

/**
 * Checks a run against an expectation.
 *
 * `hits` requires every cached task to have been served from the cache,
 * `misses` requires every cached task to have run, `invalidated` requires every
 * cached task to have been invalidated by a changed input, and
 * `invalidated:<kind>=<task>` requires one task to have been invalidated that
 * way and every other cached task to have been served from the cache.
 */
/**
 * @param {RunAnalysis} analysis
 * @param {string | null} expectation
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function evaluateExpectation(analysis, expectation) {
  /** @type {string[]} */
  const failures = []
  const pattern = expectation ?? ''
  const separator = pattern.indexOf('=')
  const mode = separator === -1 ? pattern : pattern.slice(0, separator)
  const argument = separator === -1 ? null : pattern.slice(separator + 1)
  const explained = mode.startsWith('invalidated:') && argument ? new Set([argument]) : new Set()

  // The semantic checks hold for every run, with or without a cache pattern: a
  // run that did not execute the expected tasks, that executed tasks the graph
  // does not declare, that ran a command the graph does not declare, that
  // failed a task or that exited non-zero is never a qualification.
  if (analysis.missing.length > 0) {
    failures.push(`the run did not execute: ${analysis.missing.join(', ')}`)
  }
  if (analysis.unexpected.length > 0) {
    failures.push(`the run executed tasks outside the graph: ${analysis.unexpected.join(', ')}`)
  }
  for (const mismatch of analysis.commandMismatches) {
    if (explained.has(mismatch.task)) continue
    failures.push(
      `"${mismatch.task}" ran as "${mismatch.observed}" but the graph expects "${mismatch.expected}"`
    )
  }
  if (analysis.failures.length > 0) {
    failures.push(`the run failed: ${analysis.failures.join(', ')}`)
  }
  if (analysis.exitCode !== 0) {
    failures.push(`the run exited with status ${analysis.exitCode}`)
  }

  if (!expectation) return { ok: failures.length === 0, failures }
  if (mode === 'hits') {
    for (const task of analysis.cached) {
      if (!analysis.hits.includes(task)) {
        failures.push(
          `"${task}" was not served from the cache: ${describeInvalidation(analysis, task)}`
        )
      }
    }
    for (const task of analysis.misses) {
      failures.push(
        `"${task}" was not served from the cache: ${describeInvalidation(analysis, task)}`
      )
    }
  } else if (mode === 'misses') {
    for (const task of analysis.cached) {
      if (!analysis.misses.includes(task)) {
        failures.push(`"${task}" was served from the cache, so the run was not a clean run`)
      }
    }
  } else if (mode === 'invalidated') {
    for (const task of analysis.cached) {
      const invalidation = analysis.invalidations.find((entry) => entry.task === task)
      if (!invalidation || invalidation.kind === 'cold') {
        failures.push(`"${task}" was not invalidated by a changed input`)
      }
    }
  } else if (mode.startsWith('invalidated:')) {
    const kind = mode.slice('invalidated:'.length)
    const task = argument
    if (!task) failures.push(`the expectation "${expectation}" names no task`)
    else {
      if (kind === 'toolchain') {
        const mismatch = analysis.commandMismatches.find((entry) => entry.task === task)
        if (!mismatch || mismatch.kind !== 'toolchain') {
          failures.push(`"${task}" did not run under a different toolchain`)
        }
      } else {
        const invalidation = analysis.invalidations.find((entry) => entry.task === task)
        if (!invalidation || invalidation.kind !== kind) {
          failures.push(
            `"${task}" was not invalidated by a ${kind} change: ${
              invalidation
                ? `it was invalidated by a ${invalidation.kind} change`
                : 'it was not invalidated'
            }`
          )
        }
      }
      for (const other of analysis.cached) {
        if (other === task) continue
        if (!analysis.hits.includes(other)) {
          failures.push(
            `"${other}" was not served from the cache: ${describeInvalidation(analysis, other)}`
          )
        }
      }
    }
  } else {
    failures.push(`unknown expectation "${expectation}"`)
  }
  return { ok: failures.length === 0, failures }
}

/**
 * @param {string} glob
 * @returns {RegExp}
 */
const globToRegExp = (glob) => {
  const segments = glob.split('/')
  let source = '^'
  for (const [index, segment] of segments.entries()) {
    if (segment === '**') {
      source += index === segments.length - 1 ? '.*' : '(?:[^/]+/)*'
      continue
    }
    source += segment
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
    if (index < segments.length - 1) source += '/'
  }
  return new RegExp(`${source}$`)
}

/**
 * @param {string} glob
 * @returns {string}
 */
const staticPrefix = (glob) => {
  const prefix = []
  for (const segment of glob.split('/')) {
    if (segment.includes('*') || segment.includes('?')) break
    prefix.push(segment)
  }
  return prefix.join('/')
}

/**
 * @param {string} directory
 * @returns {string[]}
 */
const walk = (directory) => {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

/** The digests of every build output the graph declares, in code-point order. */
/**
 * @param {string} root
 * @param {string[]} globs
 * @returns {Inventory}
 */
export function outputInventory(root, globs) {
  const files = new Map()
  const roots = new Set()
  for (const glob of globs) {
    const pattern = globToRegExp(glob)
    const prefix = staticPrefix(glob)
    for (const file of walk(join(root, prefix))) {
      const path = relative(root, file).split('\\').join('/')
      if (!pattern.test(path)) continue
      const bytes = readFileSync(file)
      roots.add(prefix)
      files.set(path, {
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }
  return {
    files: [...files.values()].toSorted((left, right) =>
      compareCodePointOrder(left.path, right.path)
    ),
    roots: [...roots].toSorted(compareCodePointOrder),
  }
}

/** The differences between two output inventories. */
/**
 * @param {Inventory} left
 * @param {Inventory} right
 * @returns {{
 *   equal: boolean,
 *   added: string[],
 *   removed: string[],
 *   changed: { path: string, before: unknown, after: unknown }[],
 *   roots: { added: string[], removed: string[] },
 * }}
 */
export function compareInventories(left, right) {
  const before = new Map(left.files.map((file) => [file.path, file]))
  const after = new Map(right.files.map((file) => [file.path, file]))
  /** @type {string[]} */
  const added = []
  /** @type {string[]} */
  const removed = []
  /** @type {{ path: string, before: unknown, after: unknown }[]} */
  const changed = []
  for (const [path, file] of after) {
    const other = before.get(path)
    if (!other) added.push(path)
    else if (other.sha256 !== file.sha256 || other.bytes !== file.bytes) {
      changed.push({ path, before: other, after: file })
    }
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path)
  const beforeRoots = new Set(left.roots ?? [])
  const afterRoots = new Set(right.roots ?? [])
  return {
    equal:
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      beforeRoots.size === afterRoots.size &&
      [...beforeRoots].every((root) => afterRoots.has(root)),
    added: added.toSorted(compareCodePointOrder),
    removed: removed.toSorted(compareCodePointOrder),
    changed: changed.toSorted((entry, other) => compareCodePointOrder(entry.path, other.path)),
    roots: {
      added: [...afterRoots]
        .filter((root) => !beforeRoots.has(root))
        .toSorted(compareCodePointOrder),
      removed: [...beforeRoots]
        .filter((root) => !afterRoots.has(root))
        .toSorted(compareCodePointOrder),
    },
  }
}

/** The cache entries on disk, in code-point order. */
/**
 * @param {string} root
 * @returns {{ versions: string[], entries: { name: string, bytes: number, sha256: string }[], count: number }}
 */
export function cacheState(root) {
  const directory = cacheDirectory(root)
  const entries = []
  const versions = []
  if (existsSync(directory)) {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (!child.isDirectory()) continue
      versions.push(child.name)
      const versionDirectory = join(directory, child.name)
      for (const entry of readdirSync(versionDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(entrySuffix)) continue
        const file = join(versionDirectory, entry.name)
        const bytes = readFileSync(file)
        entries.push({
          name: `${child.name}/${entry.name}`,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
    }
  }
  return {
    versions: versions.toSorted(compareCodePointOrder),
    entries: entries.toSorted((left, right) => compareCodePointOrder(left.name, right.name)),
    count: entries.length,
  }
}

/** The summary of the last run, newest cache version first. */
export function findSummary(root = repositoryRoot) {
  const directory = cacheDirectory(root)
  if (!existsSync(directory)) {
    throw new Error(`the task cache directory ${directory} does not exist`)
  }
  const candidates = []
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (!child.isDirectory()) continue
    const file = join(directory, child.name, summaryFileName)
    if (existsSync(file)) candidates.push({ file, modified: statSync(file).mtimeMs })
  }
  if (candidates.length === 0) {
    throw new Error(`the task cache holds no ${summaryFileName}`)
  }
  const newest = candidates.toSorted((left, right) => right.modified - left.modified)
  return newest[0].file
}

/**
 * @param {string[]} argv
 * @returns {Options}
 */
const parseArguments = (argv) => {
  /** @type {Record<string, string | boolean | string[]> & { _: string[] }} */
  const options = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      options._.push(argument)
      continue
    }
    const separator = argument.indexOf('=')
    if (separator !== -1) {
      options[argument.slice(2, separator)] = argument.slice(separator + 1)
      continue
    }
    const name = argument.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[name] = true
      continue
    }
    options[name] = next
    index += 1
  }
  return options
}

/**
 * @param {string | undefined} file
 * @param {unknown} value
 */
const writeJson = (file, value) => {
  if (!file) return
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * The value of one command line option, when it is a string.
 *
 * @param {Options} options
 * @param {string} name
 * @returns {string | undefined}
 */
const option = (options, name) => {
  const value = options[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * @param {string} root
 * @returns {string | null}
 */
const toolchainFor = (root) => {
  try {
    return expectedId(root)
  } catch {
    return null
  }
}

/**
 * @param {Options} options
 */
const summarise = (options) => {
  const root = resolve(option(options, 'root') ?? repositoryRoot)
  const scope = option(options, 'scope') ?? 'orch:build'
  const toolchain = option(options, 'toolchain') ?? toolchainFor(root)
  if (!toolchain) throw new Error('the toolchain could not be identified')
  const file = option(options, 'summary') ?? findSummary(root)
  const summary = parseSummary(readFileSync(file, 'utf8'))
  const expected = expectedTasks(root, toolchain, scope)
  const analysis = analyzeRun({ summary, expected, packages: workspaceDirectories(root) })
  const expectation = evaluateExpectation(analysis, option(options, 'expect') ?? null)
  const report = {
    scope,
    toolchain,
    summary: file,
    expectation: option(options, 'expect') ?? null,
    ok: expectation.ok,
    failures: expectation.failures,
    tasks: {
      expected: analysis.expected.length,
      cached: analysis.cached.length,
      hits: analysis.hits.length,
      misses: analysis.misses.length,
      disabled: analysis.disabled.length,
      missing: analysis.missing,
      unexpected: analysis.unexpected,
      failed: analysis.failures,
      commandMismatches: analysis.commandMismatches,
    },
    invalidations: analysis.invalidations,
  }
  writeJson(option(options, 'out'), report)
  return report
}

/**
 * @param {Options} options
 */
const inventory = (options) => {
  const root = resolve(option(options, 'root') ?? repositoryRoot)
  const toolchain = option(options, 'toolchain') ?? toolchainFor(root)
  if (!toolchain) throw new Error('the toolchain could not be identified')
  const scope = option(options, 'scope') ?? 'orch:build'
  const expected = expectedTasks(root, toolchain, scope)
  const globs = new Set()
  for (const task of expected.tasks.values()) for (const glob of task.outputs) globs.add(glob)
  /** @type {string[]} */
  const failures = []
  if (globs.size === 0) {
    failures.push('the build graph declares no build output, so there is nothing to compare')
  }
  const result = outputInventory(root, [...globs])
  const roots = result.roots ?? []
  if (result.files.length === 0) {
    failures.push('the build produced no declared output, so the inventory covers nothing')
  }
  if (roots.length === 0) {
    failures.push('the inventory covers no declared output root')
  }
  writeJson(option(options, 'out'), result)
  return {
    files: result.files.length,
    roots,
    globs: [...globs].toSorted(compareCodePointOrder),
    ok: failures.length === 0,
    failures,
  }
}

/**
 * Removes the build outputs the graph declares, and nothing else.
 *
 * @param {string} root
 * @param {string[]} globs
 * @returns {string[]}
 */
export function removeOutputs(root, globs) {
  /** @type {string[]} */
  const removed = []
  for (const glob of globs) {
    const pattern = globToRegExp(glob)
    const prefix = staticPrefix(glob)
    for (const file of walk(join(root, prefix))) {
      const path = relative(root, file).split('\\').join('/')
      if (!pattern.test(path)) continue
      rmSync(file, { force: true })
      removed.push(path)
    }
    // The output root itself goes when it is empty, so the next build has to
    // restore or rebuild every file it declared.
    try {
      rmdirSync(join(root, prefix))
    } catch {
      // the root still holds files the glob does not cover
    }
  }
  return removed.toSorted(compareCodePointOrder)
}

/**
 * @param {Options} options
 */
const cleanOutputs = (options) => {
  const root = resolve(option(options, 'root') ?? repositoryRoot)
  const toolchain = option(options, 'toolchain') ?? toolchainFor(root)
  if (!toolchain) throw new Error('the toolchain could not be identified')
  const scope = option(options, 'scope') ?? 'orch:build'
  const expected = expectedTasks(root, toolchain, scope)
  const globs = new Set()
  for (const task of expected.tasks.values()) for (const glob of task.outputs) globs.add(glob)
  if (globs.size === 0) {
    throw new Error('the build graph declares no build output, so there is nothing to clean')
  }
  const removed = removeOutputs(root, [...globs])
  writeJson(option(options, 'out'), { removed })
  return { removed: removed.length, files: removed }
}

/**
 * @param {Options} options
 */
const compare = (options) => {
  const [leftFile, rightFile] = options._
  if (!leftFile || !rightFile) throw new Error('compare needs two inventory files')
  const left = JSON.parse(readFileSync(leftFile, 'utf8'))
  const right = JSON.parse(readFileSync(rightFile, 'utf8'))
  const difference = compareInventories(left, right)
  /** @type {string[]} */
  const failures = []
  if (left.files.length === 0 || right.files.length === 0) {
    failures.push('an inventory holds no output, so the comparison proves nothing')
  }
  if ((left.roots ?? []).length === 0 || (right.roots ?? []).length === 0) {
    failures.push('an inventory covers no declared output root, so the comparison proves nothing')
  }
  if (!difference.equal) {
    failures.push(
      `the outputs differ: ${difference.added.length} added, ${difference.removed.length} removed, ${difference.changed.length} changed, ${difference.roots.added.length} output roots added, ${difference.roots.removed.length} output roots removed`
    )
  }
  writeJson(option(options, 'out'), { ...difference, ok: failures.length === 0, failures })
  return { ...difference, ok: failures.length === 0, failures }
}

/**
 * @param {Options} options
 */
const state = (options) => {
  const root = resolve(option(options, 'root') ?? repositoryRoot)
  const result = cacheState(root)
  /** @type {string[]} */
  const failures = []
  if (options['expect-entries'] !== undefined) {
    const declared = option(options, 'expect-entries') ?? options['expect-entries']
    let expected = null
    if (declared === 'graph') {
      const toolchain = option(options, 'toolchain') ?? toolchainFor(root)
      if (!toolchain) throw new Error('the toolchain could not be identified')
      const scope = option(options, 'scope') ?? 'orch:build'
      const graph = expectedTasks(root, toolchain, scope)
      expected = [...graph.tasks.values()].filter((task) => task.cached).length
    } else {
      expected = Number(declared)
      if (!Number.isInteger(expected)) throw new Error('the expected entry count is not a number')
    }
    if (result.count !== expected) {
      failures.push(`the cache holds ${result.count} entries, the build graph declares ${expected}`)
    }
  }
  writeJson(option(options, 'out'), result)
  return { ...result, ok: failures.length === 0, failures }
}

/** @type {Record<string, (options: Options) => unknown>} */
const commands = {
  summary: summarise,
  inventory,
  compare,
  'clean-outputs': cleanOutputs,
  'cache-state': state,
}

const main = () => {
  const [command, ...rest] = process.argv.slice(2)
  const handler = commands[command]
  if (!handler) {
    console.error(
      `usage: task-cache-qualification.mjs <${Object.keys(commands).join('|')}> [options]`
    )
    process.exitCode = 2
    return
  }
  const options = parseArguments(rest)
  try {
    const result = /** @type {{ failures?: string[], ok?: boolean }} */ (handler(options))
    console.log(JSON.stringify(result, null, 2))
    const failures = result.failures ?? []
    if (failures.length > 0) {
      for (const failure of failures) console.error(`task-cache-qualification: ${failure}`)
      process.exitCode = 1
    }
    if (result.ok === false) process.exitCode = 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`task-cache-qualification: ${message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
