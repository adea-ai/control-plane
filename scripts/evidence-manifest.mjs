import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Evidence manifest validator for Adea #1225 (parent #1183, M18.03).
//
// The manifest maps each requirement and each A01–A40 acceptance id to:
//   1. repository evidence. Each reference names a repository key declared in
//      `repositories`; the key's `rootCommit` is its immutable identity, and its
//      `sourceSha` is the one revision every reference must resolve at.
//      - `test-reference`: a test title appears in a *.test.* file at that revision.
//        This is a source-text match, so it also matches comments and strings.
//      - `execution-reference`: a recorded run at exactly that revision (`exitCode` 0,
//        status `passed`) whose JUnit receipt lists the title as passing.
//      Only runner-verified titles count. A declaration alone never verifies an id.
//   2. candidate records (packaged or deployed). A candidate declares the exact
//      source SHA of every repository the id references, a compatible contract
//      version, and a passing JUnit receipt of its own.
// `coverage: complete` is only accepted with criteria, each citing runner-verified
// tests, and no gaps. Anything else stays `pending` with its gaps listed. Local
// checkouts are used only when they contain the declared root commit. Otherwise the pinned
// commit is read through the authorized source (openAuthorizedCheckout), within bounds.
// Files are read only when they are regular, within the root, and under
// MAX_EVIDENCE_BYTES. Unmapped ids stay `pending`.
// Git reads run under explicit deadlines and output limits (runCommand). A failed or
// timed-out read fails the report closed as a `git read failed` schema error; it is never
// read as a missing file.

export const SCHEMA_VERSION = 1
export const ISSUE = 1225
export const HOME_REPOSITORY = 'adea'
export const MAX_EVIDENCE_BYTES = 1024 * 1024

/** Requirement ids named by #1225 traceability (`REQ 005,012,…`). */
export const REQUIREMENT_IDS = Object.freeze(
  [
    '005',
    '012',
    '033',
    '059',
    '108',
    '118',
    '119',
    '120',
    '130',
    '131',
    '132',
    '133',
    '134',
    '135',
    '136',
    '150',
    '151',
    '153',
    '154',
    '155',
    '174',
    '175',
    '176',
    '177',
  ].map((number) => `REQ-${number}`)
)

/** Acceptance ids named by #1225 (`Tests: A01–A40`). */
export const ACCEPTANCE_IDS = Object.freeze(
  Array.from({ length: 40 }, (_, index) => `A${String(index + 1).padStart(2, '0')}`)
)

export const REQUIRED_IDS = Object.freeze([...REQUIREMENT_IDS, ...ACCEPTANCE_IDS])

export const STATUS = Object.freeze({
  pending: 'pending',
  invalid: 'invalid',
  repoVerified: 'repo-verified',
  candidateCompatible: 'candidate-compatible',
})

const CHANNELS = new Set(['packaged', 'deployed'])
const EXECUTION_SCHEMA = 'adea.evidence.execution.v1'
const CANDIDATE_SCHEMA = 'adea.evidence.candidate.v1'
const REGULAR_BLOB_MODES = new Set(['100644', '100755'])
const SHA = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const TEST_FILE = /\.test\.(ts|tsx|mjs|js)$/
const REPO_KEY = /^[a-z][a-z0-9-]{0,62}$/
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const LS_TREE = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\s+(-|\d+)\t([\s\S]*)$/

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** A repo-relative POSIX path with no absolute prefix, `..`, `.`, or empty segment. */
export function safeRepoPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.startsWith('/')) return null
  if (path.includes('\\')) return null
  const segments = path.split('/')
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ? null
    : path
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function parseJson(bytes) {
  try {
    return { value: JSON.parse(Buffer.from(bytes).toString('utf8')) }
  } catch {
    return { error: 'not valid JSON' }
  }
}

// Every git read runs under an explicit deadline and an output limit. Lazy promisor fetches
// in a treeless clone run inside these calls, so a stalled transfer ends as a CommandError
// instead of blocking the validator or the test that asked for it. The GIT_HTTP_* settings
// also end a stalled transfer inside git itself.
export const GIT_READ_TIMEOUT_MS = 60_000
const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_HTTP_LOW_SPEED_LIMIT: '1000',
  GIT_HTTP_LOW_SPEED_TIME: '30',
}
// git's wording for an object the repository does not have. Any other nonzero exit is a
// failed read, not an absent object.
const ABSENT_OBJECT = /Not a valid object name|bad object|unknown revision/

/** A subprocess that produced no usable result. It is never read as an absent object or as empty output. */
export class CommandError extends Error {
  constructor(code, message, { command, args, status = null, signal = null, stderr = '' } = {}) {
    super(message)
    this.name = 'CommandError'
    this.code = code
    this.command = command
    this.args = args
    this.status = status
    this.signal = signal
    this.stderr = stderr
  }
}

/**
 * Run one subprocess under a deadline. A timeout, a signal, a spawn failure, a nonzero exit,
 * output over the limit or missing output throws a CommandError. Nothing returns null or a
 * partial result.
 */
export function runCommand(
  command,
  args,
  {
    cwd,
    env = process.env,
    timeoutMs = GIT_READ_TIMEOUT_MS,
    encoding = 'utf8',
    maxBuffer = MAX_EVIDENCE_BYTES * 4,
  } = {}
) {
  const label = [command, args[0]].filter(Boolean).join(' ')
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding,
    maxBuffer,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  const stderr = String(result.stderr ?? '')
  const fail = (code, message) => {
    throw new CommandError(code, message, {
      command,
      args,
      status: result.status ?? null,
      signal: result.signal ?? null,
      stderr,
    })
  }
  if (result.error?.code === 'ETIMEDOUT')
    fail('timeout', `${label} timed out after ${timeoutMs} ms`)
  if (result.error?.code === 'ENOBUFS')
    fail('output', `${label} wrote more than ${maxBuffer} bytes`)
  if (result.error)
    fail('spawn', `${label} could not run: ${result.error.code ?? result.error.message}`)
  if (result.signal) fail('signal', `${label} was stopped by ${result.signal}`)
  if (result.status !== 0) {
    fail(
      'nonzero',
      `${label} exited with status ${result.status}: ${stderr.trim().split('\n')[0] ?? ''}`
    )
  }
  if (result.stdout === null || result.stdout === undefined)
    fail('output', `${label} produced no output`)
  if (Buffer.byteLength(result.stdout) > maxBuffer)
    fail('output', `${label} wrote more than ${maxBuffer} bytes`)
  return result.stdout
}

/** One local checkout, read through git. Blobs come from committed trees, not the disk. */
export function gitCheckout(root, { git = 'git', timeoutMs = GIT_READ_TIMEOUT_MS } = {}) {
  const run = (args, encoding = 'utf8') =>
    runCommand(git, args, { cwd: root, timeoutMs, encoding, env: { ...process.env, ...GIT_ENV } })
  return {
    commitExists(sha) {
      try {
        run(['cat-file', '-e', `${sha}^{commit}`])
        return true
      } catch (error) {
        if (
          error instanceof CommandError &&
          error.code === 'nonzero' &&
          ABSENT_OBJECT.test(error.stderr)
        ) {
          return false
        }
        throw error
      }
    },
    rootCommits(sha) {
      return run(['rev-list', '--max-parents=0', sha]).split('\n').filter(Boolean)
    },
    blobAtSha(sha, path) {
      const listing = run(['ls-tree', '-l', '-z', sha, '--', path])
      const match = listing
        .split('\0')
        .map((line) => LS_TREE.exec(line))
        .filter(Boolean)
        .find(([, , , , , name]) => name === path)
      if (!match) return null
      const [, mode, type, , size] = match
      return {
        regular: type === 'blob' && REGULAR_BLOB_MODES.has(mode),
        mode,
        size: size === '-' ? 0 : Number(size),
        bytes: () => run(['cat-file', 'blob', `${sha}:${path}`], 'buffer'),
      }
    },
  }
}

/** Working-tree files under the home root. Symlinks resolving outside it are reported. */
function workingFiles(root) {
  const realRoot = realpathSync(root)
  return (path) => {
    let real
    try {
      real = realpathSync(resolve(realRoot, path))
    } catch {
      return null
    }
    if (!real.startsWith(realRoot + sep)) return { outside: true }
    const stat = statSync(real)
    return {
      regular: stat.isFile(),
      size: stat.size,
      bytes: () => readFileSync(real),
    }
  }
}

/**
 * Default I/O. `mapping` maps repository keys to local checkout paths and must include
 * the home repository, whose checkout also holds the working-tree artifact records.
 * A repository key with no mapping has no checkout, so its references stay invalid.
 */
// Authorized read of one pinned commit from its declared repository. It uses the git remote
// credentials the checkout already has, and no new ones. It fetches the commit graph only, with
// no trees or blobs. It deepens in bounded steps until the declared root is found as a
// parentless ancestor of the pin, until the history is complete, or until the last step. Trees
// and blobs load lazily, and only at the pinned commit. Nothing is unshallowed.
export const AUTHORIZED_DEPTH_STEPS = Object.freeze([256, 1024, 4096, 16384])
const AUTHORIZED_SETUP_TIMEOUT_MS = 30_000
const AUTHORIZED_FETCH_TIMEOUT_MS = 120_000

// Commits listed in a bare repository's `shallow` file: the boundary of a truncated history.
function shallowBoundary(dir) {
  const path = join(dir, 'shallow')
  return existsSync(path)
    ? new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean))
    : new Set()
}

/**
 * Open a bounded authorized read of one declared pin. The checkout answers only for the pinned
 * commit, and any other revision throws. A failed step throws a CommandError that names the
 * repository and the pin, after the temporary clone is removed. Call `close()` when done.
 */
export function openAuthorizedCheckout(declaration, options = {}) {
  const { name, rootCommit, sourceSha: pin } = declaration
  const {
    remoteBase = 'https://github.com/',
    scratch = tmpdir(),
    git = 'git',
    depthSteps = AUTHORIZED_DEPTH_STEPS,
    timeoutMs = AUTHORIZED_FETCH_TIMEOUT_MS,
  } = options
  if (depthSteps.length === 0)
    throw new Error('openAuthorizedCheckout needs at least one depth step')
  const dir = mkdtempSync(join(scratch, 'adea-evidence-authorized-'))
  const close = () => rmSync(dir, { recursive: true, force: true })
  const run = (args, budget) =>
    runCommand(git, args, { cwd: dir, timeoutMs: budget, env: { ...process.env, ...GIT_ENV } })
  try {
    const setup = [
      ['init', '-q', '--bare'],
      ['config', 'remote.origin.url', `${remoteBase}${name}.git`],
      ['config', 'remote.origin.promisor', 'true'],
      ['config', 'remote.origin.partialclonefilter', 'tree:0'],
      ['config', 'extensions.partialClone', 'origin'],
    ]
    for (const args of setup) run(args, Math.min(timeoutMs, AUTHORIZED_SETUP_TIMEOUT_MS))
    let roots = []
    let depth = 0
    let found = false
    let complete = false
    // git marks the commit at the depth limit as a boundary even when it has no parents. A
    // boundary is unresolved only while it still has parents. A commit without parents is a root.
    const hasParents = (sha) => /^parent /m.test(run(['cat-file', '-p', sha], GIT_READ_TIMEOUT_MS))
    for (const step of depthSteps) {
      run(
        ['fetch', '--quiet', '--no-tags', '--filter=tree:0', `--depth=${step}`, 'origin', pin],
        timeoutMs
      )
      depth = step
      const boundary = shallowBoundary(dir)
      roots = run(['rev-list', '--max-parents=0', pin], GIT_READ_TIMEOUT_MS)
        .split('\n')
        .filter(Boolean)
      complete = roots.every((sha) => !boundary.has(sha) || !hasParents(sha))
      found = roots.includes(rootCommit) && !hasParents(rootCommit)
      if (found || complete) break
    }
    if (!found && !complete) {
      throw new CommandError(
        'depth-limit',
        `pinned history is not complete within depth ${depth} and the root was not found`
      )
    }
    const local = gitCheckout(dir, { timeoutMs: GIT_READ_TIMEOUT_MS })
    const reportedRoots = found ? [rootCommit] : roots
    const requirePin = (sha) => {
      if (sha !== pin) {
        throw new CommandError(
          'unpinned',
          `authorized read of ${name} answers only for ${pin}, not ${sha}`
        )
      }
    }
    return {
      checkout: {
        commitExists: (sha) => sha === pin && local.commitExists(sha),
        rootCommits: (sha) => {
          requirePin(sha)
          return [...reportedRoots]
        },
        blobAtSha: (sha, path) => {
          requirePin(sha)
          return local.blobAtSha(sha, path)
        },
      },
      depth,
      found,
      complete,
      close,
    }
  } catch (error) {
    close()
    if (error instanceof CommandError) {
      throw new CommandError(error.code, `cannot read ${pin} from ${name}: ${error.message}`, {
        command: error.command,
        args: error.args,
        status: error.status,
        signal: error.signal,
        stderr: error.stderr,
      })
    }
    throw error
  }
}

/**
 * Checkouts for the declared repositories. A local checkout is used only when it proves the pinned
 * commit and its root. With `authorized` options, a repository that the local checkout cannot
 * prove is read through openAuthorizedCheckout instead. Sessions open lazily, and `close()`
 * removes them.
 */
export function repositoryIo(mapping, { manifest = null, authorized = null } = {}) {
  const home = mapping[HOME_REPOSITORY]
  if (typeof home !== 'string') throw new Error(`repository mapping needs ${HOME_REPOSITORY}`)
  const locals = new Map(
    Object.entries(mapping).map(([key, path]) => [key, gitCheckout(resolve(path))])
  )
  const chosen = new Map()
  const sources = {}
  const sessions = []
  const checkout = (repository) => {
    if (chosen.has(repository)) return chosen.get(repository)
    const local = locals.get(repository) ?? null
    const declaration = isObject(manifest?.repositories)
      ? manifest.repositories[repository]
      : undefined
    const pinned =
      isObject(declaration) &&
      typeof declaration.name === 'string' &&
      REPO_NAME.test(declaration.name) &&
      typeof declaration.rootCommit === 'string' &&
      SHA.test(declaration.rootCommit) &&
      typeof declaration.sourceSha === 'string' &&
      SHA.test(declaration.sourceSha)
    let result = local
    sources[repository] = local ? 'local' : 'unmapped'
    if (authorized && pinned && !(local && proves(local, declaration))) {
      const session = openAuthorizedCheckout(declaration, authorized)
      sessions.push(session)
      result = session.checkout
      sources[repository] =
        `authorized (depth ${session.depth}${session.complete ? ', history complete' : ''})`
    }
    chosen.set(repository, result)
    return result
  }
  return {
    checkout,
    workingFile: workingFiles(resolve(home)),
    sources: () => ({ ...sources }),
    close: () => {
      for (const session of sessions) session.close()
    },
  }
}

// A local checkout proves a declared pin when it has the commit and the root is one of its roots.
function proves(local, declaration) {
  return (
    local.commitExists(declaration.sourceSha) &&
    local.rootCommits(declaration.sourceSha).includes(declaration.rootCommit)
  )
}

function checkTestReference(item, checkout, manifest) {
  if (!TEST_FILE.test(item.path)) return 'test-reference must name a *.test.* file'
  if (typeof item.name !== 'string' || item.name.length === 0) {
    return 'test-reference must name the test title'
  }
  const sha = manifest.repositories[item.repository].sourceSha
  const blob = checkout.blobAtSha(sha, item.path)
  if (blob === null) return `${item.repository}:${item.path} does not exist at ${sha}`
  if (!blob.regular) return `${item.repository}:${item.path} is not a regular file`
  if (blob.size > MAX_EVIDENCE_BYTES) {
    return `${item.repository}:${item.path} exceeds ${MAX_EVIDENCE_BYTES} bytes`
  }
  const source = blob.bytes().toString('utf8')
  const quoted = [`'${item.name}'`, `"${item.name}"`, `\`${item.name}\``]
  if (!quoted.some((literal) => source.includes(literal))) {
    return `test title "${item.name}" is not declared in ${item.repository}:${item.path} at ${sha}`
  }
  return null
}

/** Bounded, hash-pinned bytes: size is checked before any read. */
function readBytes(item, io) {
  const file = io.workingFile(item.path)
  if (file === null) return { problem: `${item.path} is missing` }
  if (file.outside) return { problem: `${item.path} resolves outside the repository root` }
  if (!file.regular) return { problem: `${item.path} is not a regular file` }
  if (file.size > MAX_EVIDENCE_BYTES) {
    return { problem: `${item.path} exceeds ${MAX_EVIDENCE_BYTES} bytes` }
  }
  const bytes = file.bytes()
  if (!SHA256.test(item.sha256 ?? '') || sha256Hex(bytes) !== item.sha256) {
    return { problem: `${item.path} does not match sha256` }
  }
  return { bytes }
}

function readRecord(item, io) {
  const { bytes, problem } = readBytes(item, io)
  if (problem) return { problem }
  const parsed = parseJson(bytes)
  if (parsed.error) return { problem: `${item.path} is ${parsed.error}` }
  if (!isObject(parsed.value)) return { problem: `${item.path} must be a JSON object` }
  return { record: parsed.value }
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (text) =>
  text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name])

/**
 * Runner-produced JUnit receipt: one entry per testcase. A testcase with a failure,
 * error, or skipped child is not passing. Counts are per testcase, so a duplicated
 * title is counted twice. Returns null when the XML has no testcases.
 */
export function parseJunit(xml) {
  const passed = new Set()
  const failed = new Set()
  let passCount = 0
  let failCount = 0
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\sname="([^"]*)"/.exec(match[1])?.[1]
    if (name === undefined) return null
    const title = unescapeXml(name)
    if (/<(failure|error|skipped)\b/.test(match[2] ?? '')) {
      failed.add(title)
      failCount += 1
    } else {
      passed.add(title)
      passCount += 1
    }
  }
  if (passCount + failCount === 0) return null
  return { passed, failed, passCount, failCount }
}

/**
 * An evidence envelope is one hashed artifact that carries its own binding: the
 * repository, the revision, the file, and the runner's JUnit document. Its per-testcase
 * counts must equal its claimed summary. Returns the titles it lists as passing and failing.
 */
function readEnvelope(item, io, schema) {
  const { record, problem } = readRecord(item, io)
  if (problem) return { problem }
  if (record.schema !== schema) return { problem: `${item.path} is not a ${schema} envelope` }
  const junit = typeof record.junit === 'string' ? parseJunit(record.junit) : null
  if (junit === null) return { problem: `${item.path} junit is not JUnit testcases` }
  if (junit.passCount !== record.summary?.pass || junit.failCount !== record.summary?.fail) {
    return {
      problem: `${item.path} junit counts ${junit.passCount}/${junit.failCount} do not match its summary`,
    }
  }
  return {
    record,
    passing: new Set([...junit.passed].filter((title) => !junit.failed.has(title))),
    failed: junit.failed,
  }
}

/**
 * A runner-verified execution, bound inside the envelope to one repository and to the
 * pinned revision. A receipt copied from another repository or revision fails here.
 */
function checkExecutionReference(item, id, io, manifest) {
  const envelope = readEnvelope(item, io, EXECUTION_SCHEMA)
  if (envelope.problem) return { problem: envelope.problem }
  const { record } = envelope
  if (record.repository !== item.repository) {
    return {
      problem: `execution envelope names repository ${record.repository}, reference names ${item.repository}`,
    }
  }
  const sha = manifest.repositories[item.repository].sourceSha
  if (record.sourceSha !== sha) {
    return {
      problem: `execution envelope pins ${record.sourceSha}, ${item.repository} pins ${sha}`,
    }
  }
  if (record.executedAtHead !== sha) {
    return { problem: `executedAtHead ${record.executedAtHead} is not the pinned ${sha}` }
  }
  if (record.status !== 'passed') {
    return { problem: `execution envelope status is ${record.status}, not passed` }
  }
  if (record.exitCode !== 0) {
    return { problem: `execution envelope exit code is ${record.exitCode}, not 0` }
  }
  if (typeof record.command !== 'string' || record.command.length === 0) {
    return { problem: 'execution envelope must name the command' }
  }
  if (!Array.isArray(record.ids) || !record.ids.includes(id)) {
    return { problem: `execution envelope does not list ${id}` }
  }
  if (safeRepoPath(record.file) === null || !TEST_FILE.test(record.file)) {
    return { problem: 'execution envelope must name a *.test.* file' }
  }
  return { file: record.file, passing: envelope.passing }
}

function sourceProblems(entry, io, manifest) {
  const problems = []
  for (const ref of entry.sourceReferences ?? []) {
    if (safeRepoPath(ref.path) === null) {
      problems.push(`unsafe source reference ${String(ref.path)}`)
      continue
    }
    const checkout = io.checkout(ref.repository)
    if (checkout === null) {
      problems.push(`no local checkout mapped for repository ${ref.repository}`)
      continue
    }
    const blob = checkout.blobAtSha(manifest.repositories[ref.repository].sourceSha, ref.path)
    if (blob === null || !blob.regular) {
      problems.push(`source ${ref.repository}:${ref.path} is not a regular file at the pinned SHA`)
    }
  }
  return problems
}

/**
 * A candidate envelope is the candidate build's own run of one repository's test file. It
 * pins the exact source of every repository the id references, lists the id, and shows no
 * failing testcase. It can only cover scenario tests of its own repository and file.
 */
function checkCandidateEvidence(item, id, io, manifest, repositories) {
  const envelope = readEnvelope(item, io, CANDIDATE_SCHEMA)
  if (envelope.problem) return { problem: envelope.problem }
  const { record } = envelope
  if (typeof record.candidateId !== 'string' || record.candidateId.length === 0) {
    return { problem: 'candidate envelope must name candidateId' }
  }
  const name = record.candidateId
  if (!CHANNELS.has(record.channel)) {
    return { problem: `candidate ${name} channel ${record.channel} is not packaged or deployed` }
  }
  if (!manifest.compatibility.contractVersions.includes(record.contractVersion)) {
    return { problem: `candidate ${name} contract ${record.contractVersion} is not compatible` }
  }
  if (record.status !== 'passed') return { problem: `candidate ${name} status is ${record.status}` }
  if (record.exitCode !== 0) {
    return { problem: `candidate ${name} exit code is ${record.exitCode}, not 0` }
  }
  if (!Array.isArray(record.ids) || !record.ids.includes(id)) {
    return { problem: `candidate ${name} does not list ${id}` }
  }
  if (!isObject(record.sources)) {
    return { problem: `candidate ${name} must declare sources per repository` }
  }
  for (const repository of repositories) {
    const sha = manifest.repositories[repository].sourceSha
    if (record.sources[repository] !== sha) {
      return { problem: `candidate ${name} does not declare sources.${repository} = ${sha}` }
    }
  }
  if (!repositories.has(record.repository)) {
    return {
      problem: `candidate ${name} runs tests of ${record.repository}, which this id does not reference`,
    }
  }
  if (safeRepoPath(record.file) === null || !TEST_FILE.test(record.file)) {
    return { problem: `candidate ${name} must name a *.test.* file` }
  }
  if (envelope.failed.size > 0 || envelope.passing.size === 0) {
    return { problem: `candidate ${name} test result is not all passing` }
  }
  return {
    candidateId: name,
    repository: record.repository,
    file: record.file,
    passing: envelope.passing,
  }
}

const scenarioKey = (repository, path, name) => JSON.stringify([repository, path, name])

const intersect = (previous, next) =>
  previous === undefined ? next : new Set([...previous].filter((title) => next.has(title)))

/** Receipts are scoped to one repository: the same path in another repository never matches. */
const receiptKey = (repository, path) => JSON.stringify([repository, path])
const isVerified = (test, receipts) =>
  receipts.get(receiptKey(test.repository, test.path))?.has(test.name) === true

function evaluate(id, entry, io, manifest) {
  if (entry === undefined) return { status: STATUS.pending, reasons: ['no evidence mapped'] }
  const sources = sourceProblems(entry, io, manifest)
  if (sources.length > 0) return { status: STATUS.invalid, reasons: sources }
  const gapReasons = (entry.gaps ?? []).map((gap) => `gap: ${gap}`)

  if (entry.repoEvidence.length === 0) {
    if (entry.candidateEvidence.length > 0) {
      return {
        status: STATUS.invalid,
        reasons: ['candidate evidence requires an execution-reference'],
      }
    }
    return { status: STATUS.pending, reasons: ['no repository evidence mapped', ...gapReasons] }
  }

  const reasons = []
  const repositories = new Set()
  // Repository + file -> titles that passed in every execution-reference for that file.
  const receipts = new Map()
  const tests = []
  let executions = 0
  for (const item of entry.repoEvidence) {
    if (safeRepoPath(item.path) === null) {
      reasons.push(`unsafe evidence path ${String(item.path)}`)
      continue
    }
    repositories.add(item.repository)
    const checkout = io.checkout(item.repository)
    if (checkout === null) {
      reasons.push(`no local checkout mapped for repository ${item.repository}`)
      continue
    }
    if (item.kind === 'test-reference') {
      tests.push(item)
      const problem = checkTestReference(item, checkout, manifest)
      if (problem) reasons.push(problem)
    } else if (item.kind === 'execution-reference') {
      executions += 1
      const result = checkExecutionReference(item, id, io, manifest)
      if (result.problem) reasons.push(result.problem)
      else {
        const key = receiptKey(item.repository, result.file)
        receipts.set(key, intersect(receipts.get(key), result.passing))
      }
    } else {
      reasons.push(`unknown repository evidence kind ${item.kind}`)
    }
  }
  if (reasons.length > 0) return { status: STATUS.invalid, reasons }
  for (const ref of entry.sourceReferences ?? []) repositories.add(ref.repository)

  const verified = tests.filter((test) => isVerified(test, receipts))
  const unverified = tests.filter((test) => !isVerified(test, receipts))

  if (executions === 0) {
    if (entry.candidateEvidence.length > 0) {
      return {
        status: STATUS.invalid,
        reasons: ['candidate evidence requires an execution-reference'],
      }
    }
    if (entry.coverage === 'complete') {
      return {
        status: STATUS.invalid,
        reasons: ['complete coverage requires an execution-reference'],
      }
    }
    return {
      status: STATUS.pending,
      reasons: ['declaration only, no execution-reference', ...gapReasons],
    }
  }
  if (verified.length === 0) {
    return {
      status: STATUS.invalid,
      reasons: ['no test-reference is a passing title in its receipt'],
    }
  }

  if (entry.coverage === 'partial') {
    if (entry.candidateEvidence.length > 0) {
      return {
        status: STATUS.invalid,
        reasons: ['partial coverage cannot carry candidate evidence'],
      }
    }
    return {
      status: STATUS.pending,
      reasons: [
        `runner-verified titles: ${verified.length}, source-text-only titles: ${unverified.length} (weaker)`,
        ...gapReasons,
      ],
    }
  }

  // Complete coverage is a claim. Every declared test must have passed in its receipt,
  // and every criterion must cite runner-verified tests from this entry.
  const failures = unverified.map(
    (test) =>
      `test-reference is not a passing title in its receipt: ${test.repository}:${test.path} "${test.name}"`
  )
  for (const criterion of entry.criteria ?? []) {
    const evidenced = criterion.tests.every((ref) =>
      verified.some(
        (test) =>
          test.repository === ref.repository && test.path === ref.path && test.name === ref.name
      )
    )
    if (!evidenced)
      failures.push(`criterion not evidenced by runner-verified tests: ${criterion.text}`)
  }
  if (failures.length > 0) return { status: STATUS.invalid, reasons: failures }

  if (entry.candidateEvidence.length === 0) {
    return { status: STATUS.repoVerified, reasons: ['candidate evidence pending'] }
  }

  // A candidate covers the criterion tests it actually ran: same repository, same file,
  // same title, passing, at the pinned sources. Every other criterion test stays explicitly missing.
  const covered = new Set()
  for (const item of entry.candidateEvidence) {
    if (item?.kind !== 'candidate-reference' || safeRepoPath(item.path) === null) {
      reasons.push(`invalid candidate evidence reference for ${id}`)
      continue
    }
    const result = checkCandidateEvidence(item, id, io, manifest, repositories)
    if (result.problem) {
      reasons.push(result.problem)
    } else {
      for (const title of result.passing) {
        covered.add(scenarioKey(result.repository, result.file, title))
      }
    }
  }
  if (reasons.length > 0) return { status: STATUS.invalid, reasons }

  const missing = new Map()
  for (const criterion of entry.criteria ?? []) {
    for (const ref of criterion.tests) {
      const key = scenarioKey(ref.repository, ref.path, ref.name)
      if (!covered.has(key)) missing.set(key, ref)
    }
  }
  if (missing.size > 0) {
    return {
      status: STATUS.repoVerified,
      reasons: [...missing.values()].map(
        (ref) =>
          `candidate evidence does not cover criterion test ${ref.repository}:${ref.path} "${ref.name}"`
      ),
    }
  }
  return { status: STATUS.candidateCompatible, reasons: [] }
}

/** A criterion cites tests by repository, path, and title; the repository must be declared. */
function criteriaErrors(entry, repositories) {
  const errors = []
  for (const criterion of entry.criteria ?? []) {
    const valid =
      isObject(criterion) &&
      typeof criterion.text === 'string' &&
      criterion.text.length > 0 &&
      Array.isArray(criterion.tests) &&
      criterion.tests.length > 0 &&
      criterion.tests.every(
        (ref) =>
          isObject(ref) &&
          typeof ref.repository === 'string' &&
          typeof ref.path === 'string' &&
          typeof ref.name === 'string'
      )
    if (!valid)
      errors.push(
        `${entry.id} criterion must name text and at least one test {repository, path, name}`
      )
    else
      for (const ref of criterion.tests) {
        if (!Object.hasOwn(repositories, ref.repository)) {
          errors.push(`${entry.id} criterion names undeclared repository ${ref.repository}`)
        }
      }
  }
  return errors
}

function manifestErrors(manifest, io) {
  const errors = []
  if (!isObject(manifest)) return ['manifest must be a JSON object']
  if (manifest.schemaVersion !== SCHEMA_VERSION)
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`)
  if (manifest.issue !== ISSUE) errors.push(`issue must be ${ISSUE}`)

  const repositories = manifest.repositories
  if (!isObject(repositories) || Object.keys(repositories).length === 0) {
    errors.push('repositories must be a non-empty object')
  } else if (!Object.hasOwn(repositories, HOME_REPOSITORY)) {
    errors.push(`repositories must include ${HOME_REPOSITORY}`)
  }
  for (const [key, repo] of Object.entries(isObject(repositories) ? repositories : {})) {
    if (!REPO_KEY.test(key)) {
      errors.push(`repository key ${key} must be lowercase letters, digits, or dashes`)
      continue
    }
    if (!isObject(repo) || typeof repo.name !== 'string' || !REPO_NAME.test(repo.name)) {
      errors.push(`${key}.name must be owner/repo`)
      continue
    }
    if (typeof repo.rootCommit !== 'string' || !SHA.test(repo.rootCommit)) {
      errors.push(`${key}.rootCommit must be a 40-character lowercase commit SHA`)
    }
    if (typeof repo.sourceSha !== 'string' || !SHA.test(repo.sourceSha)) {
      errors.push(`${key}.sourceSha must be a 40-character lowercase commit SHA`)
      continue
    }
    const checkout = io.checkout(key)
    if (checkout === null) continue
    if (!checkout.commitExists(repo.sourceSha)) {
      errors.push(`${key} sourceSha ${repo.sourceSha} is not a commit in its local checkout`)
    } else if (!checkout.rootCommits(repo.sourceSha).includes(repo.rootCommit)) {
      errors.push(`local checkout for ${key} is not ${repo.name} (root ${repo.rootCommit} absent)`)
    }
  }

  if (
    !isObject(manifest.compatibility) ||
    !Array.isArray(manifest.compatibility.contractVersions)
  ) {
    errors.push('compatibility.contractVersions must be an array')
  } else if (manifest.compatibility.contractVersions.some((v) => typeof v !== 'string' || !v)) {
    errors.push('compatibility.contractVersions must contain non-empty strings')
  }
  if (!Array.isArray(manifest.entries)) {
    errors.push('entries must be an array')
    return errors
  }
  const seen = new Set()
  for (const entry of manifest.entries) {
    if (!isObject(entry) || typeof entry.id !== 'string') {
      errors.push('every entry must be an object with an id')
      continue
    }
    if (!REQUIRED_IDS.includes(entry.id)) errors.push(`unknown id ${entry.id}`)
    if (seen.has(entry.id)) errors.push(`duplicate entry ${entry.id}`)
    seen.add(entry.id)
    if (!Array.isArray(entry.repoEvidence) || !Array.isArray(entry.candidateEvidence)) {
      errors.push(`${entry.id} must list repoEvidence and candidateEvidence arrays`)
      continue
    }
    if (entry.coverage !== 'complete' && entry.coverage !== 'partial') {
      errors.push(`${entry.id} coverage must be complete or partial`)
    } else if (entry.coverage === 'partial') {
      if (
        !Array.isArray(entry.gaps) ||
        entry.gaps.length === 0 ||
        entry.gaps.some((g) => typeof g !== 'string' || !g)
      ) {
        errors.push(`${entry.id} partial coverage must list gaps`)
      }
    } else {
      if (entry.gaps !== undefined) errors.push(`${entry.id} complete coverage must not list gaps`)
      if (!Array.isArray(entry.criteria) || entry.criteria.length === 0) {
        errors.push(`${entry.id} complete coverage must list criteria`)
      }
    }
    if (entry.criteria !== undefined && !Array.isArray(entry.criteria)) {
      errors.push(`${entry.id} criteria must be an array`)
    } else {
      errors.push(...criteriaErrors(entry, isObject(repositories) ? repositories : {}))
    }
    for (const item of entry.repoEvidence) {
      if (
        !isObject(item) ||
        !isObject(repositories) ||
        !Object.hasOwn(repositories, item.repository)
      ) {
        errors.push(`${entry.id} references unknown repository ${item?.repository}`)
      }
    }
    if (entry.sourceReferences !== undefined) {
      if (!Array.isArray(entry.sourceReferences)) {
        errors.push(`${entry.id} sourceReferences must be an array`)
      } else {
        for (const ref of entry.sourceReferences) {
          if (
            !isObject(ref) ||
            typeof ref.path !== 'string' ||
            !isObject(repositories) ||
            !Object.hasOwn(repositories, ref.repository)
          ) {
            errors.push(`${entry.id} source reference must name a declared repository and path`)
          }
        }
      }
    }
  }
  return errors
}

/**
 * Validate a manifest against the #1225 id universe.
 *
 * Returns `{ ok, schemaErrors, results, counts }`. `ok` is false on any schema error
 * or invalid mapping. `strict` also requires every id to be candidate-compatible.
 */
export function validateEvidenceManifest(manifest, io, options = {}) {
  try {
    return validateChecked(manifest, io, options)
  } catch (error) {
    // A git read that failed or timed out leaves the evidence unverified. Report it as a
    // schema error so the report fails closed: no partial pass, no skip, no "missing" file.
    if (!(error instanceof CommandError)) throw error
    const message = `git read failed (${error.code}): ${error.message}`
    return { ok: false, schemaErrors: [message], results: [], counts: countStatuses([]) }
  }
}

function validateChecked(manifest, io, { strict = false } = {}) {
  const schemaErrors = manifestErrors(manifest, io)
  if (schemaErrors.length > 0) {
    return { ok: false, schemaErrors, results: [], counts: countStatuses([]) }
  }

  const byId = new Map(manifest.entries.map((entry) => [entry.id, entry]))
  const results = REQUIRED_IDS.map((id) => {
    const group = id.startsWith('REQ-') ? 'requirement' : 'acceptance'
    return { id, group, ...evaluate(id, byId.get(id), io, manifest) }
  })
  const counts = countStatuses(results)
  const complete = counts[STATUS.candidateCompatible] === REQUIRED_IDS.length
  const ok = counts[STATUS.invalid] === 0 && (!strict || complete)
  return { ok, schemaErrors, results, counts }
}

function countStatuses(results) {
  const counts = Object.fromEntries(Object.values(STATUS).map((status) => [status, 0]))
  for (const result of results) counts[result.status] += 1
  return counts
}

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultManifest = 'docs/plans/m18-evidence-manifest.json'

/** Human summary: the revisions checked, every invalid id, and the explicit certification state. */
function summarize(manifest, report, provenance = {}) {
  const lines = []
  const revisions = Object.entries(manifest.repositories ?? {})
    .map(([key, repo]) => `${key}@${repo?.sourceSha}`)
    .join(' ')
  lines.push(`revisions: ${revisions}`)
  if (Object.keys(provenance).length > 0) {
    lines.push(
      `sources: ${Object.entries(provenance)
        .map(([key, value]) => `${key} ${value}`)
        .join('; ')}`
    )
  }
  lines.push(JSON.stringify(report.counts))
  for (const error of report.schemaErrors) lines.push(`schema: ${error}`)
  for (const result of report.results.filter((r) => r.status === STATUS.invalid)) {
    lines.push(`${result.id}: ${result.reasons.join('; ')}`)
  }
  if (report.schemaErrors.length === 0) {
    const pending = report.results.filter((r) => r.status === STATUS.pending).map((r) => r.id)
    if (pending.length > 0) lines.push(`pending: ${pending.join(' ')}`)
    const certified = report.counts[STATUS.candidateCompatible]
    lines.push(
      certified === REQUIRED_IDS.length
        ? 'certification: complete'
        : `certification: incomplete (${certified} of ${REQUIRED_IDS.length} candidate-compatible)`
    )
  }
  if (report.schemaErrors.length === 0) {
    const withoutProof = REQUIRED_IDS.length - report.counts[STATUS.candidateCompatible]
    lines.push(
      withoutProof === 0
        ? 'candidate-compatible proof: complete'
        : `candidate-compatible proof: missing for ${withoutProof} of ${REQUIRED_IDS.length} ids`
    )
  }
  return lines.join('\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const strict = args.includes('--strict')
  const json = args.includes('--json')
  const localOnly = args.includes('--local-only')
  const mapping = { [HOME_REPOSITORY]: repoRoot }
  const positional = []
  let io = null
  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '--repo') {
        const value = args[(index += 1)] ?? ''
        const equals = value.indexOf('=')
        if (equals <= 0) throw new Error('--repo expects key=path')
        mapping[value.slice(0, equals)] = resolve(value.slice(equals + 1))
      } else if (!arg.startsWith('--')) {
        positional.push(arg)
      }
    }
    const manifestPath = resolve(repoRoot, positional[0] ?? defaultManifest)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    io = repositoryIo(mapping, { manifest, authorized: localOnly ? null : {} })
    const report = validateEvidenceManifest(manifest, io, { strict })
    process.stdout.write(
      json
        ? `${JSON.stringify(report, null, 2)}\n`
        : `${summarize(manifest, report, io.sources())}\n`
    )
    if (strict && report.schemaErrors.length === 0 && !report.ok) {
      process.stdout.write('strict: not every id is candidate-compatible\n')
    }
    process.exitCode = report.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  } finally {
    io?.close()
  }
}
