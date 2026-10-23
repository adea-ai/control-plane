import { describe, expect, test } from 'bun:test'
import { parse } from 'acorn'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEDICATED_INTEGRATION_QUALIFICATIONS,
  INTEGRATION_SHARDS,
  integrationFileArguments,
  selectIntegrationShard,
} from '../scripts/integration-shards.mjs'
import {
  describePostgresProbeFailure,
  isProbeTimeout,
  POSTGRES_RECOVERY_CEILING_SECONDS,
} from '../scripts/postgres-probe-diagnostics.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const runner = join(repository, 'scripts/run-integration-tests.mjs')
// The harness spawns the real runner and its interpreter doubles, so each
// test's wall clock is spawn-bound; align it with the smoke lane's per-test
// budget so the harness timeout above stays the binding bound.
const runnerTestBudgetMs = 30_000

// One executable double backs both runner harnesses. FAKE_DOCKER_HANG_ON and
// FAKE_BUN_HANG let a regression freeze a runner-owned command at a chosen
// injection point (startup, readiness, test execution or cleanup) after writing
// its receipt, so the test can send a real SIGINT/SIGTERM and observe the cleanup.
const runnerDoubleSource = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
const program = basename(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(process.env.COMMAND_RECEIPT, JSON.stringify({ program, args, project: process.env.COMPOSE_PROJECT_NAME ?? null }) + '\\n')
if (process.env.FAKE_DOCKER_HANG_ON && args.includes(process.env.FAKE_DOCKER_HANG_ON)) await new Promise(() => {})
if (process.env.FAKE_BUN_SPAWN_DESCENDANT === 'true' && args.includes('test')) {
  // A nested build descendant that inherits the runner's pipes. It stays alive
  // when the direct child is killed, so the inherited pipes stay open and the
  // runner's completion cannot settle on the child's own exit.
  const { spawn } = await import('node:child_process')
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  appendFileSync(process.env.DESCENDANT_RECEIPT, String(descendant.pid) + '\\n')
  await new Promise(() => {})
}
if (process.env.FAKE_BUN_SPAWN_DETACHED_DESCENDANT === 'true' && args.includes('test')) {
  // A descendant that is re-parented to init before the runner terminates the
  // direct child, so the runner can no longer attribute it to its own tree. It
  // still holds the inherited pipes. With FAKE_DESCENDANT_SCRUBS_OWNER it also
  // drops the owner token the runner gave its child, so the token cannot
  // attribute it either.
  const { spawn } = await import('node:child_process')
  const detachedEnv = { ...process.env }
  if (process.env.FAKE_DESCENDANT_SCRUBS_OWNER === 'true') delete detachedEnv.CONTROL_PLANE_RUNNER_OWNER
  spawn(process.execPath, [
    '-e',
    "const { spawn } = require('node:child_process'); const { appendFileSync } = require('node:fs'); const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); appendFileSync(process.env.DESCENDANT_RECEIPT, String(holder.pid) + '\\\\n'); process.exit(0)",
  ], { stdio: ['ignore', 'inherit', 'inherit'], env: detachedEnv })
  await new Promise(() => {})
}
if (process.env.FAKE_BUN_WRAPPER_EXITS_FIRST === 'true' && args.includes(process.env.FAKE_WRAPPER_EXITS_FIRST_ARG ?? 'test')) {
  // The direct child exits at once, before anything interrupts it, and leaves a
  // descendant that outlives it. By default the descendant holds the inherited
  // pipes, so the child's \`close\` can never arrive; with
  // FAKE_DESCENDANT_CLOSES_PIPES it closed its pipe ends and \`close\` arrives
  // while it is still running.
  const { spawn } = await import('node:child_process')
  const holderEnv = { ...process.env }
  if (process.env.FAKE_DESCENDANT_SCRUBS_OWNER === 'true') delete holderEnv.CONTROL_PLANE_RUNNER_OWNER
  const holderStdio = process.env.FAKE_DESCENDANT_CLOSES_PIPES === 'true'
    ? ['ignore', 'ignore', 'ignore']
    : ['ignore', 'inherit', 'inherit']
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: holderStdio,
    env: holderEnv,
  })
  appendFileSync(process.env.DESCENDANT_RECEIPT, String(holder.pid) + '\\n')
  process.exit(0)
}
if (program === 'docker') {
  if (process.env.FAKE_DOCKER_DISABLED === 'true') process.exit(90)
  if (process.env.FAKE_DOCKER_RATE_LIMIT === 'true' && args.includes('pull')) {
    console.error('Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit.')
    process.exit(1)
  }
  if (args.includes('ps') && process.env.FAKE_POSTGRES_RUNNING === 'true') console.log('postgres')
  if (args.includes('exec')) console.log('1')
  if (args.includes('up') && process.env.FAKE_DOCKER_ECHO_PROJECT === 'true') console.log('Created ' + process.env.COMPOSE_PROJECT_NAME + '-postgres')
  if (args.includes(process.env.FAKE_DOCKER_FAIL_ON)) process.exit(7)
} else if (args.includes('test') && process.env.FAKE_BUN_HANG === 'true') {
  await new Promise(() => {})
} else if (args.includes('test') && process.env.FAKE_BUN_OVERSIZED_FAIL === 'true') {
  process.stdout.write('stdout-start-marker\\n' + 'x'.repeat(90_000) + '\\nstdout-end-marker\\n')
  process.stderr.write('stderr-start-marker\\n' + 'y'.repeat(90_000) + '\\nstderr-end-marker\\n')
  process.exitCode = 9
} else if (args.includes('test') && process.env.FAKE_BUN_MIXED_FAIL === 'true') {
  console.error('TypeError: custom failure in an integration assertion')
  console.error('diagnostic context also mentions CONNECTION_CLOSED')
  process.exit(9)
} else if (args.includes('test') && process.env.FAKE_BUN_ASSERTION_FAIL === 'true') {
  console.error('AssertionError: expected true but received false; fixture also logged CONNECTION_CLOSED')
  process.exit(9)
} else if (args.includes('test') && process.env.FAKE_BUN_CONNECTION_FAIL === 'true') {
  console.error('Error: CONNECTION_CLOSED')
  process.exit(8)
} else if (process.env.FAKE_BUN_FAIL === 'true') process.exit(9)
`

function readCommandReceipts(commands) {
  return existsSync(commands)
    ? readFileSync(commands, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : []
}

// A disposable directory with the two executable doubles ahead of PATH and a
// receipt file for every invoked command. DATABASE_/COMPOSE_/INTEGRATION_ state
// from the host is removed so each harness controls its own classification.
function createRunnerHarness(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cp-integration-lifecycle-'))
  const commands = join(directory, 'commands.jsonl')
  const descendants = join(directory, 'descendants.pid')
  for (const name of ['docker', 'bun']) {
    writeFileSync(join(directory, name), runnerDoubleSource, { mode: 0o700 })
  }
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith('DATABASE_') ||
      key.startsWith('COMPOSE_') ||
      key.startsWith('INTEGRATION_')
    ) {
      delete environment[key]
    }
  }
  return {
    directory,
    commands,
    descendants,
    environment: {
      ...environment,
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      COMMAND_RECEIPT: commands,
      DESCENDANT_RECEIPT: descendants,
      // Every process the doubles spawn inherits this marker, including the ones
      // that drop the runner's owner token on purpose, so a teardown can prove a
      // process is the fixture's before it signals it.
      [FIXTURE_MARKER_VARIABLE]: directory,
      ...overrides,
    },
  }
}

// The signal and ownership cases exercise the runner's own process ownership,
// which does not depend on how many shards run, so they run one small explicit
// shard by default: a bounded number of doubles, and a tree the ledger can follow.
// A case that needs the default local path, where every shard runs concurrently,
// passes `shard: null`; at least one interruption case and one reap case do, and
// the default-local partition is asserted file by file below.
const TARGETED_SHARD = '1'

function targetedShardOverrides(overrides, shard) {
  if (shard === null || Object.hasOwn(overrides, 'INTEGRATION_SHARD')) return overrides
  return { INTEGRATION_SHARD: shard, ...overrides }
}

const FIXTURE_MARKER_VARIABLE = 'CP_LIFECYCLE_FIXTURE'
const TEARDOWN_WAIT_MS = 5_000
const SAMPLE_INTERVAL_MS = 100

// Whether /proc can prove a process belongs to a fixture. Cases that re-parent
// fixture processes out of the runner's tree depend on it and are gated on it;
// a case can switch it off to exercise the portable path of the teardown.
let procFilesystem = existsSync('/proc/self')

async function withoutProcFilesystem(callback) {
  const previous = procFilesystem
  procFilesystem = false
  try {
    return await callback()
  } finally {
    procFilesystem = previous
  }
}

/** Whether a PID is provably a process of this fixture's harness directory. */
function carriesFixtureMarker(pid, marker) {
  // Without /proc nothing can be proven from the environment, and a receipt
  // alone is not proof: the PID may have been recycled since it was written.
  if (!procFilesystem) return false
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, 'latin1')
    return `\0${environ}\0`.includes(`\0${FIXTURE_MARKER_VARIABLE}=${marker}\0`)
  } catch {
    return false
  }
}

/** The live PIDs whose environment carries this fixture's marker, from /proc. */
function pidsCarryingFixtureMarker(marker) {
  if (!procFilesystem) return []
  let entries
  try {
    entries = readdirSync('/proc')
  } catch {
    return []
  }
  return entries
    .filter((entry) => /^\d+$/u.test(entry))
    .map((entry) => Number.parseInt(entry, 10))
    .filter((pid) => pid > 1 && pid !== process.pid && carriesFixtureMarker(pid, marker))
}

/**
 * A token that names one process rather than one PID: the PID with the moment
 * the process started, so a recycled PID has a different identity.
 */
function processIdentity(pid) {
  if (procFilesystem) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'latin1')
      // The command name may hold spaces; the fields that follow it do not.
      return `${pid}@${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`
    } catch {
      return undefined
    }
  }
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  const started = String(result.stdout ?? '').trim()
  return result.status === 0 && started !== '' ? `${pid}@${started}` : undefined
}

/** The runner and everything below it, from one parent-link snapshot. */
function processTree(rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1) return []
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
  if (result.status !== 0) return []
  const childrenByParent = new Map()
  for (const line of String(result.stdout ?? '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/u)
    if (match === null) continue
    const [pid, parent] = [Number(match[1]), Number(match[2])]
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
    childrenByParent.get(parent).push(pid)
  }
  const tree = [rootPid]
  for (let index = 0; index < tree.length; index += 1) {
    for (const child of childrenByParent.get(tree[index]) ?? []) {
      if (child > 1 && child !== process.pid && !tree.includes(child)) tree.push(child)
    }
  }
  return tree
}

/**
 * The processes a harness has PROVEN to be its own, retained before their parent
 * dies.
 *
 * A process is added while it is still part of the runner's tree, so its
 * lineage is the proof, and it is kept with its identity: once the runner is
 * gone and the process is re-parented, or its PID is recycled, the identity
 * still tells the two apart. This is what makes the teardown safe where /proc
 * cannot be read.
 */
function createFixtureLedger() {
  const identities = new Map()
  return {
    identities,
    sample(rootPid) {
      for (const pid of processTree(rootPid)) {
        if (pid === process.pid || identities.has(pid)) continue
        const identity = processIdentity(pid)
        if (identity !== undefined) identities.set(pid, identity)
      }
    },
    owns(pid) {
      const identity = identities.get(pid)
      return identity !== undefined && processIdentity(pid) === identity
    },
  }
}

/**
 * Bounded, unconditional reaping of the processes a harness directory spawned.
 *
 * Only a process that is proven to belong to this fixture is signalled: it was
 * retained in the ledger while it was part of the runner's tree and still has
 * the identity it was retained with, or (where /proc exists) it carries the
 * marker of this harness directory, which every double and every descendant
 * inherits, including the ones that drop the runner's owner token on purpose.
 * A receipt names a PID, not a process, so a receipt PID without either proof
 * is never signalled; it is returned as unverified. Resolves with the PIDs still
 * alive after the wait and the unverified ones.
 */
async function reapFixtureProcesses({ descendants, directory, ledger }) {
  const receipts = readDescendantPids(descendants).filter(
    (pid) => Number.isSafeInteger(pid) && pid > 1
  )
  const verified = new Set()
  for (const pid of ledger?.identities.keys() ?? []) {
    if (isProcessAlive(pid) && ledger.owns(pid)) verified.add(pid)
  }
  for (const pid of [...receipts, ...pidsCarryingFixtureMarker(directory)]) {
    if (isProcessAlive(pid) && carriesFixtureMarker(pid, directory)) verified.add(pid)
  }
  const unverified = receipts.filter((pid) => isProcessAlive(pid) && !verified.has(pid))
  for (const pid of verified) killQuietly(pid)
  const deadline = Date.now() + TEARDOWN_WAIT_MS
  let alive = [...verified].filter((pid) => isProcessAlive(pid))
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    alive = alive.filter((pid) => isProcessAlive(pid))
  }
  return { survivors: alive, unverified }
}

/**
 * The teardown every harness run ends with, whatever happened before it.
 *
 * The runner's tree is recorded while the runner is alive, the runner is killed
 * and waited for within a bound, and the fixture's own processes are reaped
 * while their receipt still exists. The directory is removed only when nothing
 * is left over: a survivor or an unverifiable receipt keeps the directory and
 * its receipts for whoever has to clean up. It never throws; it resolves with
 * the problems it found, which an empty list means there were none.
 */
async function tearDownRunnerHarness({ child, gone, directory, descendants, ledger }) {
  const problems = []
  try {
    // The last look at the runner's tree must come before the runner dies.
    if (isRunning(child)) ledger?.sample(child.pid)
    reapHarnessChild(child)
    if (child !== undefined && gone !== undefined) {
      const timedOut = Symbol('timed out')
      const outcome = await Promise.race([
        gone,
        new Promise((resolve) => setTimeout(() => resolve(timedOut), TEARDOWN_WAIT_MS)),
      ])
      if (outcome === timedOut)
        problems.push(`the runner process ${child.pid} did not exit after SIGKILL`)
    }
    const { survivors, unverified } = await reapFixtureProcesses({ descendants, directory, ledger })
    if (survivors.length > 0)
      problems.push(`fixture process(es) ${survivors.join(', ')} survived SIGKILL`)
    if (unverified.length > 0)
      problems.push(
        `receipt PID(s) ${unverified.join(', ')} could not be verified as fixture-owned and were left running`
      )
  } catch (error) {
    problems.push(`the teardown itself failed: ${error?.message ?? String(error)}`)
  }
  if (problems.length > 0) {
    problems.push(`the harness directory was kept with its receipts at ${directory}`)
    return problems
  }
  try {
    rmSync(directory, { recursive: true, force: true })
  } catch (error) {
    problems.push(`could not remove ${directory}: ${error?.message ?? String(error)}`)
  }
  return problems
}

// These executable doubles exercise the real runner without a Docker engine,
// network target, database, install, build, or integration suite.
function executeRunner(overrides = {}) {
  const record = (entry) => {
    if (process.env.M11_RESOURCE_LEDGER)
      appendFileSync(
        process.env.M11_RESOURCE_LEDGER,
        JSON.stringify({ owner: 'integration runner lifecycle tests', ...entry }) + '\n'
      )
  }
  record({ prefix: 'cp-integration-lifecycle-', state: 'planned' })
  const { directory, commands, environment } = createRunnerHarness(overrides)
  record({ directory, state: 'created' })
  try {
    record({
      command: [process.execPath, runner],
      cwd: repository,
      state: 'planned',
      directory,
      port: null,
    })
    const result = spawnSync(process.execPath, [runner], {
      cwd: repository,
      encoding: 'utf8',
      // The runner boots several interpreter instances (node plus one bun
      // double per probe), which costs a few seconds idle and more under smoke
      // lane contention; 5s sat inside that envelope and killed healthy runs.
      // This is only the executable-double harness; production probes retain
      // their independent two-second deadline below.
      timeout: 20_000,
      env: environment,
    })
    record({
      command: [process.execPath, runner],
      cwd: repository,
      pid: result.pid,
      state: 'reaped',
      status: result.status,
      error: result.error?.code,
      directory,
      port: null,
    })
    if (result.error) throw result.error
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readCommandReceipts(commands),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
    record({ directory, state: 'removed' })
  }
}

/** Whether the spawned runner is still the process its PID names. */
function isRunning(child) {
  return child !== undefined && child.exitCode === null && child.signalCode === null
}

function reapHarnessChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGKILL')
  } catch {
    // The process already exited between the check and the signal.
  }
}

async function waitForReceipt(commands, predicate, description) {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (readCommandReceipts(commands).some(predicate)) return
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** The PIDs of the descendants the command double spawned. */
function readDescendantPids(descendants) {
  return existsSync(descendants)
    ? readFileSync(descendants, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => Number.parseInt(line.trim(), 10))
    : []
}

/** Waits until the command double has recorded its spawned descendant. */
async function waitForDescendant(descendants) {
  const deadline = Date.now() + 10_000
  for (;;) {
    if (readDescendantPids(descendants).length > 0) return
    if (Date.now() > deadline) throw new Error('Timed out waiting for the spawned descendant')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Waits until a PID is no longer a child of the process that spawned it.
 *
 * The receipt of a spawned survivor can arrive before the kernel re-parents
 * it, and a survivor that is still a child is still part of the owned tree: a
 * case that signalled before the re-parenting would measure the owned-tree
 * termination, not the un-attributable survivor. The wait makes the case
 * deterministic.
 */
async function waitForReparent(pid, budgetMs = 5_000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' })
    const parent = Number.parseInt(String(result.stdout ?? '').trim(), 10)
    if (parent === 1) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Whether a PID still names a live process. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    return true
  }
}

/** Keeps the ledger current while the runner runs, so its tree is known before it dies. */
function startSampling(ledger, child, intervalMs = SAMPLE_INTERVAL_MS) {
  const timer = setInterval(() => {
    try {
      if (isRunning(child)) ledger.sample(child.pid)
    } catch {
      // A failed snapshot is retried at the next tick and once more at teardown.
    }
  }, intervalMs)
  timer.unref?.()
  return timer
}

// The bounded settle after the runner is gone, before liveness is read. A
// signal is delivered asynchronously, and a killed process can linger for a
// moment as a zombie until its new parent reaps it, so liveness at a single
// instant is not proof that anything survived.
const FIXTURE_LIVENESS_SETTLE_MS = 2_000

/**
 * The PIDs that are still alive after a bounded settle.
 *
 * This is the same rule the runner applies to its own owned tree: a process
 * that is on its way out is not a survivor, and one that is still there when
 * the settle is over is.
 */
async function survivingAfterSettle(pids, budgetMs) {
  const deadline = Date.now() + budgetMs
  let alive = pids.filter((pid) => isProcessAlive(pid))
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    alive = alive.filter((pid) => isProcessAlive(pid))
  }
  return alive
}

// The reap of what the fixture spawned is tearDownRunnerHarness above: it signals
// only processes proven to be the fixture's own and keeps the receipts of any it
// cannot reap, which replaces the receipt-PID-only reap of the preserved version.

// Spawn the real runner asynchronously, wait until its receipt records the
// injected command, deliver a real signal, and report how it exited. A runner
// without an installed handler dies from the signal (status null, signal name);
// a handled interruption exits with 128 + signal number.
//
// `inspect(result)` runs while the harness directory and every fixture process
// still exist, so a case reads what survived there; the teardown that follows
// is unconditional (see tearDownRunnerHarness) and does not depend on any
// assertion, receipt or timeout having succeeded.
async function executeRunnerInterrupted(
  overrides,
  {
    signal,
    predicate,
    description,
    settleMs = 15_000,
    waitFor = 'close',
    inspect,
    sampleIntervalMs,
    shard = TARGETED_SHARD,
  }
) {
  const { directory, commands, descendants, environment } = createRunnerHarness(
    targetedShardOverrides(overrides, shard)
  )
  const ledger = createFixtureLedger()
  let child
  let gone
  let sampler
  let failure
  try {
    child = spawn(process.execPath, [runner], {
      cwd: repository,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    gone = new Promise((resolve) => child.once('exit', () => resolve()))
    sampler = startSampling(ledger, child, sampleIntervalMs)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    // `exit` reports that the runner PROCESS is gone; `close` additionally
    // waits for its pipes. A survivor that holds an inherited pipe keeps
    // `close` from arriving, so a case that exercises the runner's own
    // completion bound waits for `exit`.
    const exited = new Promise((resolve) =>
      child.once(waitFor, (status, closeSignal) => resolve({ status, signal: closeSignal }))
    )
    await waitForReceipt(commands, predicate, description)
    if (
      overrides.FAKE_BUN_SPAWN_DESCENDANT === 'true' ||
      overrides.FAKE_BUN_SPAWN_DETACHED_DESCENDANT === 'true'
    )
      await waitForDescendant(descendants)
    // The survivor of the detached case must be RE-PARENTED before the signal:
    // a survivor that is still a child is still part of the owned tree, and the
    // case would then measure the owned-tree termination instead.
    if (overrides.FAKE_BUN_SPAWN_DETACHED_DESCENDANT === 'true') {
      for (const pid of readDescendantPids(descendants)) {
        if (!(await waitForReparent(pid)))
          throw new Error(`the descendant ${pid} was never re-parented`)
      }
    }
    // The periodic sample can be up to one interval old, and a double the runner
    // started since then would die with the runner before the teardown could see
    // it: the proven tree is recorded synchronously, immediately before the signal.
    if (isRunning(child)) ledger.sample(child.pid)
    child.kill(signal)
    const outcome = await Promise.race([
      exited,
      new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ status: null, signal: 'settle-timeout' }),
          settleMs
        )
        timer.unref?.()
      }),
    ])
    // The teardown below reaps the runner within its own bound; nothing waits
    // on a pipe a surviving descendant may still hold.
    if (outcome.signal === 'settle-timeout') {
      const timeout = new Error(`Runner did not exit within ${settleMs}ms after ${signal}`)
      // The receipts the fixture recorded stay attached to the failure, so a case
      // that fails here can still name what the teardown must have reaped, and
      // never has to search the process table for it.
      timeout.fixtureDescendants = readDescendantPids(descendants)
      throw timeout
    }
    // Liveness is measured after a bounded settle, and BEFORE the teardown below:
    // it is what the runner left behind, which a post-teardown reading could not
    // show. The settle is what makes the reading mean "survived" rather than
    // "was still being reaped".
    const survivorsAtExit = await survivingAfterSettle(
      readDescendantPids(descendants),
      FIXTURE_LIVENESS_SETTLE_MS
    )
    const result = {
      ...outcome,
      stdout,
      stderr,
      calls: readCommandReceipts(commands),
      descendants: readDescendantPids(descendants),
      survivorsAtExit,
    }
    if (inspect !== undefined) await inspect(result)
    return result
  } catch (error) {
    failure = error
    throw error
  } finally {
    await finishHarness({ child, gone, directory, descendants, ledger, sampler }, failure)
  }
}

/**
 * Runs the teardown. A cleanup problem fails the case when nothing else failed;
 * when the case already failed, the report is appended to that failure's message
 * and the failure itself is still the one that propagates.
 */
async function finishHarness(harness, failure) {
  clearInterval(harness.sampler)
  const problems = await tearDownRunnerHarness(harness)
  if (problems.length === 0) return
  const report = `Harness cleanup problem(s):\n- ${problems.join('\n- ')}`
  if (failure === undefined) throw new Error(report)
  if (failure instanceof Error) {
    failure.message = `${failure.message}\n\n${report}`
    failure.cleanupReport = report
  } else {
    console.error(report)
  }
}

/** Kills a process the case spawned, tolerating one that is already gone. */
function killQuietly(pid) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // The process is already gone.
  }
}

/**
 * Runs the real runner with no signal and reports how it ended. A descendant
 * that holds an inherited pipe keeps `close` from arriving, so the case waits
 * for the runner PROCESS to exit and treats a runner that never exits as a
 * failure instead of hanging. `inspect` and the teardown behave as in
 * executeRunnerInterrupted.
 */
async function executeRunnerToExit(
  overrides,
  { settleMs = 30_000, inspect, shard = TARGETED_SHARD } = {}
) {
  const { directory, descendants, environment } = createRunnerHarness(
    targetedShardOverrides(overrides, shard)
  )
  const ledger = createFixtureLedger()
  let child
  let gone
  let sampler
  let failure
  try {
    child = spawn(process.execPath, [runner], {
      cwd: repository,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    sampler = startSampling(ledger, child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const exited = new Promise((resolve) =>
      child.once('exit', (status, signal) => resolve({ status, signal }))
    )
    gone = exited
    const outcome = await Promise.race([
      exited,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ signal: 'settle-timeout' }), settleMs)
        timer.unref?.()
      }),
    ])
    if (outcome.signal === 'settle-timeout')
      throw new Error(`Runner did not exit within ${settleMs}ms`)
    const result = { ...outcome, stdout, stderr, descendants: readDescendantPids(descendants) }
    if (inspect !== undefined) await inspect(result)
    return result
  } catch (error) {
    failure = error
    throw error
  } finally {
    await finishHarness({ child, gone, directory, descendants, ledger, sampler }, failure)
  }
}

const remoteTarget = {
  DATABASE_URL: 'postgresql://app:fixture@remote.invalid/control_plane',
  DATABASE_MIGRATION_URL: 'postgresql://migration:fixture@remote.invalid/control_plane',
  DATABASE_ADMIN_URL: 'postgresql://admin:fixture@remote.invalid/postgres',
  FAKE_DOCKER_DISABLED: 'true',
}

function destructiveCalls(result) {
  return result.calls.filter(
    ({ program, args }) =>
      program === 'docker' && ['stop', 'down'].some((verb) => args.includes(verb))
  )
}

describe('integration runner resource ownership', () => {
  test(
    'local PostgreSQL runs every verified shard once and removes only its owned project',
    () => {
      const result = executeRunner()
      const start = result.calls.find(
        ({ program, args }) => program === 'docker' && args.includes('up')
      )
      const localTestCalls = result.calls.filter(
        ({ program, args }) => program === 'bun' && args[0] === 'test'
      )
      const expectedCalls = INTEGRATION_SHARDS.flatMap(({ groups }) =>
        groups.flatMap((group) =>
          group.files.map((file) => integrationFileArguments(group, file, '30000'))
        )
      )
      const sortCalls = (calls) =>
        calls.toSorted((left, right) => {
          const leftValue = JSON.stringify(left)
          const rightValue = JSON.stringify(right)
          return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
        })

      expect(result.status).toBe(0)
      expect(
        result.calls.filter(
          ({ program, args }) => program === 'bun' && args[0] === 'run' && args[1] === 'build'
        )
      ).toHaveLength(1)
      // The default local path runs the whole inventory: one test command per file
      // of the partition (currently 55 files across shards 1, 2 and 3), so no file
      // is skipped or run by two shards. The receipt records the arguments and
      // not the package directory, so equal argument lists from different
      // packages stay separate entries and the comparison below is of multisets.
      expect(localTestCalls).toHaveLength(expectedCalls.length)
      expect(sortCalls(localTestCalls.map(({ args }) => args))).toEqual(sortCalls(expectedCalls))
      expect(localTestCalls.every(({ project }) => project === start.project)).toBe(true)
      expect(
        result.calls.filter(({ program, args }) => program === 'docker' && args.includes('up'))
      ).toHaveLength(1)
      const cleanup = destructiveCalls(result)
      expect(cleanup).toHaveLength(1)
      expect(cleanup[0].project).toBe(start.project)
      expect(cleanup[0].args).toContain('--volumes')
    },
    runnerTestBudgetMs
  )

  test(
    'remote shard 3 leaves Hosted graph to its sole dedicated PostgreSQL qualification owner',
    () => {
      const hostedGraphFile = 'apps/hosted-control-plane/src/hosted-graph.integration.test.mjs'
      const shardOwners = INTEGRATION_SHARDS.flatMap(({ shard, groups }) =>
        groups.flatMap((group) =>
          group.files
            .map((file) =>
              group.package === '.' ? file.replace(/^\.\//, '') : `${group.package}/${file}`
            )
            .filter((file) => file === hostedGraphFile)
            .map(() => ({ kind: 'shard', shard }))
        )
      )
      const qualificationOwners = DEDICATED_INTEGRATION_QUALIFICATIONS.filter(
        ({ file }) => file === hostedGraphFile
      ).map(({ file, workflow, command }) => ({ kind: 'qualification', file, workflow, command }))
      expect([...shardOwners, ...qualificationOwners]).toEqual([
        {
          kind: 'qualification',
          file: hostedGraphFile,
          workflow: '.github/workflows/postgres-pull-request.yml',
          command: 'bash scripts/run-hosted-graph-qualification.sh',
        },
      ])

      const expectedShardCalls = selectIntegrationShard(3).flatMap((group) =>
        group.files.map((file) => integrationFileArguments(group, file, '120000'))
      )
      const shardTestCalls = (result) =>
        result.calls
          .filter(({ program, args }) => program === 'bun' && args[0] === 'test')
          .map(({ args }) => args)
      const result = executeRunner({
        ...remoteTarget,
        INTEGRATION_SHARD: '3',
        GITHUB_ACTIONS: 'true',
      })
      expect(result.status).toBe(0)
      expect(result.calls.filter(({ program }) => program === 'docker')).toEqual([])
      expect(shardTestCalls(result)).toEqual(expectedShardCalls)
      expect(result.stdout).not.toContain(
        'Hosted PostgreSQL/Restate graph runs in its required qualification step.'
      )
      const developer = executeRunner({
        ...remoteTarget,
        INTEGRATION_SHARD: '3',
        GITHUB_ACTIONS: '',
      })
      expect(developer.status).toBe(0)
      expect(shardTestCalls(developer)).toEqual(expectedShardCalls)
    },
    runnerTestBudgetMs
  )

  test(
    'remote verification needs no Docker command even when the engine is unavailable',
    () => {
      const result = executeRunner(remoteTarget)
      expect(result.status).toBe(0)
      expect(result.calls.filter(({ program }) => program === 'docker')).toEqual([])
      expect(result.calls.filter(({ program }) => program === 'bun')).toHaveLength(4)
    },
    runnerTestBudgetMs
  )

  test(
    'remote configuration rejection does not contact Docker',
    () => {
      const result = executeRunner({ ...remoteTarget, DATABASE_ADMIN_URL: '' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('explicit DATABASE_ADMIN_URL')
      expect(result.calls).toEqual([])
    },
    runnerTestBudgetMs
  )

  test(
    'remote PostgreSQL connection drops remain failed checks without automatic retries',
    () => {
      const result = executeRunner({
        ...remoteTarget,
        INTEGRATION_SHARD: '2',
        FAKE_BUN_CONNECTION_FAIL: 'true',
      })
      const testCalls = result.calls.filter(
        ({ program, args }) => program === 'bun' && args.includes('test')
      )
      expect(result.status).not.toBe(0)
      expect(testCalls).toHaveLength(1)
      expect(result.stderr).toContain('CONNECTION_CLOSED')
      expect(result.stderr).not.toContain('retrying it once')
    },
    runnerTestBudgetMs
  )

  test(
    'remote PostgreSQL does not retry assertion failures even when their output mentions a connection code',
    () => {
      const result = executeRunner({
        ...remoteTarget,
        INTEGRATION_SHARD: '2',
        FAKE_BUN_ASSERTION_FAIL: 'true',
      })
      const testCalls = result.calls.filter(
        ({ program, args }) => program === 'bun' && args.includes('test')
      )
      expect(result.status).not.toBe(0)
      expect(testCalls).toHaveLength(1)
      expect(result.stderr).toContain('AssertionError')
      expect(result.stderr).toContain('CONNECTION_CLOSED')
      expect(result.stderr).not.toContain('retrying it once')
    },
    runnerTestBudgetMs
  )

  test(
    'remote PostgreSQL does not retry a mixed unknown failure that mentions a connection code',
    () => {
      const result = executeRunner({
        ...remoteTarget,
        INTEGRATION_SHARD: '2',
        FAKE_BUN_MIXED_FAIL: 'true',
      })
      const testCalls = result.calls.filter(
        ({ program, args }) => program === 'bun' && args.includes('test')
      )
      expect(result.status).not.toBe(0)
      expect(testCalls).toHaveLength(1)
      expect(result.stderr).toContain('TypeError: custom failure')
      expect(result.stderr).toContain('CONNECTION_CLOSED')
      expect(result.stderr).not.toContain('retrying it once')
    },
    runnerTestBudgetMs
  )

  test(
    'remote PostgreSQL streams oversized output completely and retains only bounded failure tails',
    () => {
      const result = executeRunner({
        ...remoteTarget,
        INTEGRATION_SHARD: '2',
        FAKE_BUN_OVERSIZED_FAIL: 'true',
      })
      const testCalls = result.calls.filter(
        ({ program, args }) => program === 'bun' && args.includes('test')
      )
      expect(result.status).not.toBe(0)
      expect(testCalls).toHaveLength(1)
      expect(result.stdout).toContain('stdout-start-marker')
      expect(result.stdout).toContain('stdout-end-marker')
      expect(result.stderr).toContain('stderr-start-marker')
      expect(result.stderr).toContain('stderr-end-marker')

      const stdoutTail = result.stderr.match(
        /stdout tail \(max 16384 bytes\):\n([\s\S]*?)\nstderr tail/
      )
      const stderrTail = result.stderr.match(/stderr tail \(max 16384 bytes\):\n([\s\S]*?)\n\s+at /)
      expect(stdoutTail?.[1]).toContain('stdout-end-marker')
      expect(stderrTail?.[1]).toContain('stderr-end-marker')
      expect(Buffer.byteLength(stdoutTail[1])).toBeLessThanOrEqual(16 * 1024)
      expect(Buffer.byteLength(stderrTail[1])).toBeLessThanOrEqual(16 * 1024)
    },
    runnerTestBudgetMs
  )

  test(
    'a runner-owned PostgreSQL project removes its volume after success',
    () => {
      const result = executeRunner()
      expect(result.status).toBe(0)
      const start = result.calls.find(
        ({ program, args }) => program === 'docker' && args.includes('up')
      )
      expect(start.project).toMatch(/^control-plane-integration-/)
      expect(result.stdout).toContain(start.project)
      const cleanup = destructiveCalls(result)
      expect(cleanup).toHaveLength(1)
      expect(cleanup[0].project).toBe(start.project)
      expect(cleanup[0].args).toEqual([
        'compose',
        'down',
        '--volumes',
        '--remove-orphans',
        '--timeout',
        '60',
      ])
      expect(
        result.calls
          .filter(({ program, args }) => program === 'docker' && !args.includes('ps'))
          .every(({ project }) => project === start.project)
      ).toBe(true)
    },
    runnerTestBudgetMs
  )

  test(
    'separate invocations cannot reuse an owned fixture volume',
    () => {
      const first = executeRunner()
      const second = executeRunner()
      const startedProject = (result) =>
        result.calls.find(({ program, args }) => program === 'docker' && args.includes('up'))
          .project
      expect(first.status).toBe(0)
      expect(second.status).toBe(0)
      expect(startedProject(first)).not.toBe(startedProject(second))
    },
    runnerTestBudgetMs
  )

  for (const [label, overrides] of [
    ['partial startup failure', { FAKE_DOCKER_FAIL_ON: 'up' }],
    ['integration failure', { FAKE_BUN_FAIL: 'true' }],
  ]) {
    test(
      `owned volume cleanup runs after ${label}`,
      () => {
        const result = executeRunner(overrides)
        expect(result.status).not.toBe(0)
        const start = result.calls.find(
          ({ program, args }) => program === 'docker' && args.includes('up')
        )
        const [cleanup] = destructiveCalls(result)
        expect(cleanup.project).toBe(start.project)
        expect(cleanup.args).toContain('down')
        expect(cleanup.args).toContain('--volumes')
      },
      runnerTestBudgetMs
    )
  }

  test(
    'a previously running PostgreSQL service is preserved',
    () => {
      const result = executeRunner({ FAKE_POSTGRES_RUNNING: 'true' })
      expect(result.status).toBe(0)
      expect(destructiveCalls(result)).toEqual([])
      expect(
        result.calls.some(({ program, args }) => program === 'docker' && args.includes('up'))
      ).toBe(false)
    },
    runnerTestBudgetMs
  )

  test(
    'caller project is omitted from the startup receipt while command diagnostics stay visible',
    () => {
      const result = executeRunner({
        COMPOSE_PROJECT_NAME: 'caller-project-private-marker',
        FAKE_DOCKER_ECHO_PROJECT: 'true',
      })
      expect(result.status).toBe(0)
      const startup = result.stdout.split('\n').filter((line) => line.startsWith('Starting'))
      expect(startup).toHaveLength(1)
      expect(startup[0]).not.toContain('caller-project-private-marker')
      // Docker/Bun diagnostics retain their existing stream behavior. This is
      // intentionally not a claim that arbitrary child output is redacted.
      expect(result.stdout).toContain('Created caller-project-private-marker-postgres')
    },
    runnerTestBudgetMs
  )

  test(
    'an explicit caller project retains its volume and original project identity',
    () => {
      const result = executeRunner({ COMPOSE_PROJECT_NAME: 'caller-owned-recovery' })
      expect(result.status).toBe(0)
      expect(
        result.calls
          .filter(({ program }) => program === 'docker')
          .every(({ project }) => project === 'caller-owned-recovery')
      ).toBe(true)
      expect(destructiveCalls(result).map(({ args }) => args)).toEqual([
        ['compose', 'stop', '--timeout', '60', 'postgres'],
      ])
    },
    runnerTestBudgetMs
  )

  test(
    'a failed engine query creates no cleanup authority',
    () => {
      const result = executeRunner({ FAKE_DOCKER_DISABLED: 'true' })
      expect(result.status).not.toBe(0)
      expect(destructiveCalls(result)).toEqual([])
      expect(result.calls.some(({ args }) => args.includes('up'))).toBe(false)
    },
    runnerTestBudgetMs
  )

  test(
    'both verification and cleanup errors remain observable',
    () => {
      const result = executeRunner({ FAKE_BUN_FAIL: 'true', FAKE_DOCKER_FAIL_ON: 'down' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('bun exited with status 9')
      expect(result.stderr).toContain('docker exited with status 7')
    },
    runnerTestBudgetMs
  )

  test(
    'IPv6 loopback keeps the local lifecycle',
    () => {
      const result = executeRunner({
        DATABASE_URL: 'postgresql://app:fixture@[::1]:54329/control_plane',
      })
      expect(result.status).toBe(0)
      expect(
        result.calls.some(({ program, args }) => program === 'docker' && args.includes('up'))
      ).toBe(true)
      expect(destructiveCalls(result)[0].args).toContain('--volumes')
    },
    runnerTestBudgetMs
  )

  test(
    'cleanup failure makes the verification fail',
    () => {
      const result = executeRunner({ FAKE_DOCKER_FAIL_ON: 'down' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('docker exited with status 7')
    },
    runnerTestBudgetMs
  )

  test(
    'SIGINT during owned startup reaps the frozen command and removes its project once',
    async () => {
      const result = await executeRunnerInterrupted(
        { FAKE_DOCKER_HANG_ON: 'up' },
        {
          signal: 'SIGINT',
          predicate: ({ program, args }) => program === 'docker' && args.includes('up'),
          description: 'the owned PostgreSQL startup',
        }
      )
      const start = result.calls.find(
        ({ program, args }) => program === 'docker' && args.includes('up')
      )
      const cleanup = destructiveCalls(result)
      expect(result.status).toBe(130)
      expect(result.signal).toBe(null)
      expect(start.project).toMatch(/^control-plane-integration-/)
      expect(cleanup).toHaveLength(1)
      expect(cleanup[0].project).toBe(start.project)
      expect(cleanup[0].args).toEqual([
        'compose',
        'down',
        '--volumes',
        '--remove-orphans',
        '--timeout',
        '60',
      ])
    },
    runnerTestBudgetMs
  )

  test(
    'SIGINT during the readiness probe stops it and removes the owned project once',
    async () => {
      const result = await executeRunnerInterrupted(
        { FAKE_DOCKER_HANG_ON: 'exec' },
        {
          signal: 'SIGINT',
          predicate: ({ program, args }) => program === 'docker' && args.includes('exec'),
          description: 'the PostgreSQL readiness probe',
        }
      )
      const start = result.calls.find(
        ({ program, args }) => program === 'docker' && args.includes('up')
      )
      const cleanup = destructiveCalls(result)
      expect(result.status).toBe(130)
      expect(result.signal).toBe(null)
      expect(cleanup).toHaveLength(1)
      expect(cleanup[0].project).toBe(start.project)
      expect(cleanup[0].args).toContain('--volumes')
    },
    runnerTestBudgetMs
  )

  test(
    'SIGTERM during owned test execution cleans up and retains a nonzero status',
    async () => {
      const result = await executeRunnerInterrupted(
        { FAKE_BUN_HANG: 'true' },
        {
          signal: 'SIGTERM',
          predicate: ({ program, args }) => program === 'bun' && args.includes('test'),
          description: 'an owned integration test file',
        }
      )
      const start = result.calls.find(
        ({ program, args }) => program === 'docker' && args.includes('up')
      )
      const cleanup = destructiveCalls(result)
      expect(result.status).toBe(143)
      expect(cleanup).toHaveLength(1)
      expect(cleanup[0].project).toBe(start.project)
      expect(cleanup[0].args).toContain('--volumes')
    },
    runnerTestBudgetMs
  )

  test(
    'SIGTERM during runner-owned cleanup stops it and keeps a failure status',
    async () => {
      const result = await executeRunnerInterrupted(
        { FAKE_DOCKER_HANG_ON: 'down' },
        {
          signal: 'SIGTERM',
          predicate: ({ program, args }) => program === 'docker' && args.includes('down'),
          description: 'owned project cleanup',
        }
      )
      const cleanup = destructiveCalls(result)
      expect(result.status).toBe(143)
      expect(cleanup).toHaveLength(1)
      expect(cleanup[0].args).toContain('down')
    },
    runnerTestBudgetMs
  )

  test(
    'an interrupted cleanup keeps the original verification failure observable',
    async () => {
      const result = await executeRunnerInterrupted(
        { FAKE_BUN_FAIL: 'true', FAKE_DOCKER_HANG_ON: 'down' },
        {
          signal: 'SIGTERM',
          predicate: ({ program, args }) => program === 'docker' && args.includes('down'),
          description: 'owned project cleanup after a failed verification',
        }
      )
      expect(result.status).toBe(143)
      expect(result.stderr).toContain('bun exited with status 9')
      expect(result.stderr).toContain('Integration run interrupted by SIGTERM')
    },
    runnerTestBudgetMs
  )

  test(
    'SIGINT preserves a caller-owned project while reaping the frozen command',
    async () => {
      const result = await executeRunnerInterrupted(
        { COMPOSE_PROJECT_NAME: 'caller-owned-interrupt', FAKE_BUN_HANG: 'true' },
        {
          signal: 'SIGINT',
          predicate: ({ program, args }) => program === 'bun' && args.includes('test'),
          description: 'an owned integration test file',
        }
      )
      expect(result.status).toBe(130)
      expect(destructiveCalls(result).map(({ args }) => args)).toEqual([
        ['compose', 'stop', '--timeout', '60', 'postgres'],
      ])
      expect(
        result.calls
          .filter(({ program }) => program === 'docker')
          .every(({ project }) => project === 'caller-owned-interrupt')
      ).toBe(true)
    },
    runnerTestBudgetMs
  )

  test(
    'SIGINT after a pre-existing service creates no cleanup authority',
    async () => {
      const result = await executeRunnerInterrupted(
        { FAKE_POSTGRES_RUNNING: 'true', FAKE_BUN_HANG: 'true' },
        {
          signal: 'SIGINT',
          predicate: ({ program, args }) => program === 'bun' && args.includes('test'),
          description: 'an owned integration test file',
        }
      )
      expect(result.status).toBe(130)
      expect(destructiveCalls(result)).toEqual([])
      expect(
        result.calls.some(({ program, args }) => program === 'docker' && args.includes('up'))
      ).toBe(false)
    },
    runnerTestBudgetMs
  )
})

/**
 * Evaluates the runner's OWN internals together in one context.
 *
 * The lifecycle properties under test (the bounded completion of a terminated
 * child, the owned-tree termination, the abandonment of the pipes) live in
 * several functions that call each other, so they are sliced and evaluated as
 * one block: the code under test is the shipped code, with only the process
 * boundary stubbed. A constant may be overridden for the case, which is how the
 * completion bound is shortened without changing the shipped value.
 */
function readScriptBlock(path, { functions, constants, overrides = {} }, globals, exportName) {
  const source = readFileSync(new URL(`../scripts/${path}`, import.meta.url), 'utf8')
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const pieces = []
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && functions.includes(node.id.name)) {
      pieces.push(source.slice(node.start, node.end))
      continue
    }
    if (node.type !== 'VariableDeclaration') continue
    for (const declaration of node.declarations) {
      if (!constants.includes(declaration.id.name)) continue
      let text = source.slice(node.start, node.end)
      if (overrides[declaration.id.name] !== undefined) {
        text = text.replace(
          new RegExp(`(const\\s+${declaration.id.name}\\s*=\\s*)[^\\n]+`),
          `$1${overrides[declaration.id.name]}`
        )
      }
      pieces.push(text)
    }
  }
  return runInNewContext(`${pieces.join('\n')}\n;${exportName}`, globals)
}

function readScriptFunction(path, name, globals) {
  const source = readFileSync(new URL(`../scripts/${path}`, import.meta.url), 'utf8')
  const declaration = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === name
  )
  expect(declaration).toBeDefined()
  return runInNewContext(`(${source.slice(declaration.start, declaration.end)})`, globals)
}

test('bounded output tail keeps the final diagnostic within its byte limit', () => {
  const appendBoundedOutputTail = readScriptFunction(
    'run-integration-tests.mjs',
    'appendBoundedOutputTail',
    {
      Buffer,
    }
  )
  const tail = appendBoundedOutputTail('', `${'é'.repeat(20_000)}final-marker`, 16 * 1024)
  expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(16 * 1024)
  expect(tail.endsWith('final-marker')).toBe(true)
})

test('an interrupted runner spends no new owned command beyond cleanup', async () => {
  const spawnCalls = []
  const run = readScriptFunction('run-integration-tests.mjs', 'run', {
    interruptedSignal: 'SIGINT',
    runnerEnvironment: {},
    CHILD_COMMAND_TIMEOUT_MS: 90_000,
    OWNER_TOKEN_VARIABLE: 'CONTROL_PLANE_RUNNER_OWNER',
    randomUUID: () => 'owner-token',
    process,
    setTimeout,
    trackRunnerChild: (child) => child,
    terminateChild: (child) => child.kill(),
    bindChildCompletion: () => {},
    spawn: (command, arguments_) => {
      spawnCalls.push([command, arguments_])
      return {
        once() {},
        kill() {},
        stdout: { setEncoding() {}, on() {} },
        stderr: { setEncoding() {}, on() {} },
        exitCode: null,
        signalCode: null,
      }
    },
  })

  // After the first signal a concurrent shard must not start another frozen
  // command, or it would outlive the interruption and be orphaned.
  await expect(run('bun', ['test', './tests/example.integration.test.mjs'])).rejects.toThrow(
    'not started'
  )
  expect(spawnCalls).toEqual([])

  // The shared cleanup is the one command allowed past the interruption guard.
  void run('docker', ['compose', 'down', '--volumes'], { allowInterrupted: true })
  expect(spawnCalls).toEqual([['docker', ['compose', 'down', '--volumes']]])
})

test('a successful readiness probe observes queued interruption before build and permits cleanup', async () => {
  const commands = []
  const globals = {
    Date,
    process,
    console: { log() {} },
    interruptedSignal: null,
    runnerEnvironment: {},
    CHILD_COMMAND_TIMEOUT_MS: 90_000,
    setTimeout,
    clearTimeout,
    setImmediate,
    OWNER_TOKEN_VARIABLE: 'CONTROL_PLANE_RUNNER_OWNER',
    randomUUID: () => 'owner-token',
    trackRunnerChild: (child) => child,
    terminateChild: (child) => child.kill(),
    bindChildCompletion: () => {},
    spawnSync: () => {
      // Model a signal queued while the synchronous SQL probe blocked its
      // handler. Promise continuations alone cannot deliver that signal.
      setImmediate(() => {
        globals.interruptedSignal = 'SIGINT'
      })
      return { status: 0, stdout: '1\n' }
    },
    spawn: (command, args) => {
      commands.push([command, args])
      return {
        once(event, callback) {
          if (event === 'close') queueMicrotask(() => callback(0))
        },
        kill() {},
        stdout: { setEncoding() {}, on() {} },
        stderr: { setEncoding() {}, on() {} },
        exitCode: null,
        signalCode: null,
      }
    },
  }
  const { waitForPostgres, run } = readScriptBlock(
    'run-integration-tests.mjs',
    { functions: ['waitForPostgres', 'run'], constants: [] },
    globals,
    '({ waitForPostgres, run })'
  )
  let failure
  try {
    await waitForPostgres(() => globals.interruptedSignal !== null)
    await run('bun', ['run', 'build'])
  } catch (error) {
    failure = error
  } finally {
    await run('docker', ['compose', 'down', '--volumes'], { allowInterrupted: true })
  }
  expect(commands).toEqual([['docker', ['compose', 'down', '--volumes']]])
  expect(failure?.message).toBe('PostgreSQL readiness probe interrupted')
})

for (const script of ['run-integration-tests.mjs', 'run-postgres-disruption-drill.mjs']) {
  test(`${script} cannot spend a full probe beyond its readiness deadline`, async () => {
    let now = 28_000
    let clockReads = 0
    const timeouts = []
    const wait = readScriptFunction(script, 'waitForPostgres', {
      Date: { now: () => (clockReads++ === 0 ? 0 : now) },
      process: { cwd: () => repository },
      runnerEnvironment: {},
      POSTGRES_RECOVERY_CEILING_SECONDS,
      describePostgresProbeFailure,
      isProbeTimeout,
      readContainerState: () => '',
      setImmediate,
      spawnSync: (_command, _args, options) => {
        timeouts.push(options.timeout)
        now += options.timeout ?? 5000
        return { status: 1, stdout: '' }
      },
      setTimeout: (callback, delay) => {
        now += delay
        callback()
      },
    })
    await expect(wait()).rejects.toThrow('30 seconds')
    expect(now).toBeLessThanOrEqual(30_000)
    expect(timeouts).toEqual([2000])
  })
}

for (const [script, name] of [
  ['run-postgres-disruption-drill.mjs', 'docker'],
  ['run-postgres-restore-drill.mjs', 'dockerPostgres'],
]) {
  test(`${script} bounds its nested Docker commands`, () => {
    const options = []
    const docker = readScriptFunction(script, name, {
      process: { cwd: () => repository },
      spawnSync: (_command, _args, supplied) => {
        options.push(supplied)
        return { status: 0, stdout: '' }
      },
    })
    docker([])
    expect(options[0].timeout).toBe(90_000)
  })
}

describe('integration runner owned process tree', () => {
  test(
    'an interruption reaps the owned descendant that holds the inherited pipes',
    async () => {
      // The nested descendant keeps the runner's inherited pipes open, so the
      // direct child's exit is NOT proof that the owned tree was reaped: the
      // runner has to terminate the owned descendants, and its completion has to
      // stay bounded while it does.
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      })
      try {
        await executeRunnerInterrupted(
          { FAKE_BUN_SPAWN_DESCENDANT: 'true' },
          {
            signal: 'SIGINT',
            predicate: ({ program, args }) => program === 'bun' && args.includes('test'),
            description: 'the owned test execution',
            // The default local path: every shard runs concurrently under one runner.
            shard: null,
            inspect: (result) => {
              // The runner settled on the interruption and kept the signal's status.
              expect(result.status).toBe(130)
              // The OWNED descendants are gone: the tree was reaped, not only the
              // direct child.
              expect(result.descendants.length).toBeGreaterThan(0)
              for (const pid of result.descendants) expect(isProcessAlive(pid)).toBe(false)
              // Measured after the bounded settle and before the harness's own
              // teardown, so its reap cannot be what makes it true.
              expect(result.survivorsAtExit).toEqual([])
              // The runner verified its own tree, so it reported no survivor.
              expect(result.stderr).not.toMatch(/owned descendant survived/u)
              // An UNRELATED process was never signalled.
              expect(isProcessAlive(unrelated.pid)).toBe(true)
            },
          }
        )
      } finally {
        try {
          unrelated.kill('SIGKILL')
        } catch {
          // The unrelated process is already gone.
        }
      }
    },
    runnerTestBudgetMs
  )

  test('SIGINT during a rate-limited pull backoff ends the run and starts no further pull', async () => {
    // The backoff delay is 15 s. A runner that waits it out launches another
    // pull AFTER the signal, so the case is deterministic about the wait being
    // cut short by the interruption.
    const result = await executeRunnerInterrupted(
      { FAKE_DOCKER_RATE_LIMIT: 'true' },
      {
        signal: 'SIGINT',
        predicate: ({ program, args }) => program === 'docker' && args.includes('pull'),
        description: 'the rate-limited image pull',
        // The backoff delay is 15 s, so a budget below it still separates a
        // runner that ends the wait from one that waits it out, with room for
        // a loaded host.
        settleMs: 12_000,
      }
    )
    expect(result.status).toBe(130)
    // No pull command was started after the signal.
    const pulls = result.calls.filter(
      ({ program, args }) => program === 'docker' && args.includes('pull')
    )
    expect(pulls).toHaveLength(1)
    // The owned project is still released exactly once, and nothing else is.
    expect(destructiveCalls(result)).toHaveLength(1)
  }, 30_000)

  test('a timed-out owned child settles on the completion bound when a descendant holds the pipes', async () => {
    // A descendant that keeps the inherited pipes open prevents the child's
    // `close` event, so the timeout must not leave the runner waiting for a
    // pipe nobody owns. The runner's OWN internals are evaluated here, with
    // only the process boundary stubbed and the bound shortened for the case.
    const signals = []
    const released = []
    const child = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      once() {},
      kill(signal) {
        signals.push(signal)
      },
      unref() {},
      stdout: {
        setEncoding() {},
        on() {},
        destroy() {
          released.push('stdout')
        },
      },
      stderr: {
        setEncoding() {},
        on() {},
        destroy() {
          released.push('stderr')
        },
      },
    }
    const run = readScriptBlock(
      'run-integration-tests.mjs',
      {
        functions: [
          'run',
          'terminateChild',
          'bindChildCompletion',
          'abandonChildPipes',
          'ownedDescendants',
          'isProcessAlive',
          'sleepSync',
          'survivingOwnedPids',
          'trackRunnerChild',
          'pidsCarryingOwnerToken',
          'armCompletionBound',
          'releaseChild',
          'releaseUnlessOwnedDescendantsRemain',
        ],
        constants: [
          'activeChildren',
          'childStates',
          'CHILD_COMPLETION_TIMEOUT_MS',
          'CHILD_COMMAND_TIMEOUT_MS',
          'OWNED_TREE_EXIT_WAIT_MS',
          'OWNER_TOKEN_VARIABLE',
        ],
        overrides: { CHILD_COMPLETION_TIMEOUT_MS: '150' },
      },
      {
        interruptedSignal: null,
        runnerEnvironment: {},
        console,
        randomUUID: () => 'owner-token',
        readdirSync: () => {
          throw new Error('no /proc')
        },
        readFileSync,
        process: {
          cwd: () => '/tmp',
          kill: () => {
            throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
          },
        },
        setTimeout,
        clearTimeout,
        Atomics,
        SharedArrayBuffer,
        spawn: () => child,
        spawnSync: () => ({ status: 0, stdout: '' }),
      },
      'run'
    )
    // The case waits with its own bound, so a runner that never settles fails
    // the case instead of hanging it.
    const outcome = await Promise.race([
      run('docker', ['compose', 'up'], { timeout: 20 }).then(
        () => ({ settled: true }),
        (error) => ({ settled: true, error })
      ),
      new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 5_000)),
    ])
    expect(outcome.settled).toBe(true)
    expect(outcome.error?.message ?? '').toMatch(
      /did not complete within 150 ms after it was terminated/u
    )
    // The owned child was terminated, and the pipes it held were released, so
    // the runner can finish instead of waiting for the pipe.
    expect(signals).toEqual(['SIGKILL'])
    expect(released.toSorted()).toEqual(['stderr', 'stdout'])
  })

  test.skipIf(!procFilesystem)(
    'a stalled pipe is bounded when the survivor carries no proof of ownership',
    async () => {
      // The descendant is re-parented to init before the runner terminates the
      // direct child and has dropped the owner token, so the runner can no longer
      // attribute it to its own tree and must not kill what it cannot prove it owns. The inherited pipe
      // stays open, so the runner's completion has to be BOUNDED rather than
      // waited on forever.
      await executeRunnerInterrupted(
        { FAKE_BUN_SPAWN_DETACHED_DESCENDANT: 'true', FAKE_DESCENDANT_SCRUBS_OWNER: 'true' },
        {
          signal: 'SIGTERM',
          predicate: ({ program, args }) => program === 'bun' && args.includes('test'),
          description: 'the owned test execution',
          // The survivor holds the runner's pipe, so `close` cannot arrive; the
          // case waits for the runner PROCESS to be gone.
          waitFor: 'exit',
          settleMs: 25_000,
          // The survivor is read while it is still alive; the harness teardown
          // reaps it afterwards, whether or not these assertions pass.
          inspect: (result) => {
            expect(result.status).toBe(143)
            // The completion was bounded and reported instead of hanging.
            expect(result.stderr).toMatch(/did not complete within \d+ ms after it was terminated/u)
            // The un-attributable survivor was not killed: it was never proven to be
            // the runner's own.
            expect(result.descendants.length).toBeGreaterThan(0)
            for (const pid of result.descendants) expect(isProcessAlive(pid)).toBe(true)
            // Measured after the bounded settle and before the harness teardown.
            expect(result.survivorsAtExit).toEqual(result.descendants)
          },
        }
      )
    },
    40_000
  )

  test.skipIf(process.platform !== 'linux')(
    'an interruption reaps an owned descendant that was orphaned before the signal',
    async () => {
      // The direct child's parent links to the descendant are gone by the time
      // the signal arrives, but the descendant still carries the token the
      // runner gave its child, so it is provably owned and is reaped.
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      })
      try {
        await executeRunnerInterrupted(
          { FAKE_BUN_SPAWN_DETACHED_DESCENDANT: 'true' },
          {
            signal: 'SIGTERM',
            predicate: ({ program, args }) => program === 'bun' && args.includes('test'),
            description: 'the owned test execution',
            waitFor: 'exit',
            settleMs: 25_000,
            inspect: (result) => {
              expect(result.status).toBe(143)
              expect(result.descendants.length).toBeGreaterThan(0)
              for (const pid of result.descendants) expect(isProcessAlive(pid)).toBe(false)
              expect(result.stderr).not.toMatch(/owned descendant survived/u)
              expect(isProcessAlive(unrelated.pid)).toBe(true)
            },
          }
        )
      } finally {
        killQuietly(unrelated.pid)
      }
    },
    40_000
  )

  test.skipIf(process.platform !== 'linux')(
    'a wrapper that exits first leaves no unbounded wait and its owned descendant is reaped',
    async () => {
      // Nothing interrupts this run. The direct child exits at once and a
      // descendant keeps the inherited pipes, so `close` can never arrive; the
      // exit itself has to start the bounded wait.
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      })
      try {
        await executeRunnerToExit(
          { FAKE_BUN_WRAPPER_EXITS_FIRST: 'true' },
          {
            // The default local path: every shard runs concurrently under one runner.
            shard: null,
            inspect: (result) => {
              expect(result.status).not.toBe(0)
              expect(result.stderr).toMatch(
                /bun exited but did not complete within \d+ ms; reaped owned descendant\(s\) \d+/u
              )
              expect(result.descendants.length).toBeGreaterThan(0)
              for (const pid of result.descendants) expect(isProcessAlive(pid)).toBe(false)
              expect(isProcessAlive(unrelated.pid)).toBe(true)
            },
          }
        )
      } finally {
        killQuietly(unrelated.pid)
      }
    },
    40_000
  )

  test.skipIf(!procFilesystem)(
    'a wrapper that exits first is bounded and reported even when the descendant proves no ownership',
    async () => {
      const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      })
      try {
        await executeRunnerToExit(
          {
            FAKE_BUN_WRAPPER_EXITS_FIRST: 'true',
            FAKE_DESCENDANT_SCRUBS_OWNER: 'true',
          },
          {
            inspect: (result) => {
              expect(result.status).not.toBe(0)
              expect(result.stderr).toMatch(
                /bun exited but did not complete within \d+ ms; an owned descendant may still hold the inherited pipes/u
              )
              // Nothing proves the holder is the runner's, so it is left alone.
              expect(result.descendants.length).toBeGreaterThan(0)
              for (const pid of result.descendants) expect(isProcessAlive(pid)).toBe(true)
              expect(isProcessAlive(unrelated.pid)).toBe(true)
            },
          }
        )
      } finally {
        killQuietly(unrelated.pid)
      }
    },
    40_000
  )
})

describe('integration runner descendants that outlive a closed wrapper', () => {
  // Each case ends with the wrapper already closed and a token-bearing
  // descendant still running. The runner owns that descendant until it is gone,
  // so it is reaped by the time the runner itself exits, and a process the
  // runner never started is left alone.
  const cases = [
    {
      name: 'an inherited-stdio wrapper that exits first',
      command: 'build',
      environment: {},
    },
    {
      name: 'a wrapper whose descendant closed its inherited pipe ends',
      command: 'build',
      environment: { FAKE_DESCENDANT_CLOSES_PIPES: 'true' },
    },
    {
      name: 'a streaming shard whose descendant closed its pipe ends',
      command: 'test',
      environment: { FAKE_DESCENDANT_CLOSES_PIPES: 'true' },
    },
  ]
  for (const { name, command, environment } of cases) {
    test.skipIf(process.platform !== 'linux')(
      `${name} does not leave its owned descendant running after the runner exits`,
      async () => {
        const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        })
        try {
          await executeRunnerToExit(
            {
              FAKE_BUN_WRAPPER_EXITS_FIRST: 'true',
              FAKE_WRAPPER_EXITS_FIRST_ARG: command,
              ...environment,
            },
            {
              inspect: (result) => {
                // Reaping the descendant is a clean outcome, not a failure.
                expect(result.status).toBe(0)
                expect(result.descendants.length).toBeGreaterThan(0)
                for (const pid of result.descendants) expect(isProcessAlive(pid)).toBe(false)
                expect(isProcessAlive(unrelated.pid)).toBe(true)
              },
            }
          )
        } finally {
          killQuietly(unrelated.pid)
        }
      },
      40_000
    )
  }
})

describe('integration runner lifecycle harness teardown', () => {
  const hold = ['-e', 'setInterval(() => {}, 1000)']

  /** The live processes whose environment carries `CP_TEST_PROBE=<probe>`, from the real /proc. */
  const carryingProbe = (probe) =>
    readdirSync('/proc')
      .filter((entry) => /^\d+$/u.test(entry))
      .map(Number)
      .filter((pid) => {
        try {
          return readFileSync(`/proc/${pid}/environ`, 'latin1').includes(`CP_TEST_PROBE=${probe}`)
        } catch {
          return false
        }
      })

  test.skipIf(!procFilesystem)(
    'reaps fixture processes and removes the directory when an assertion fails',
    async () => {
      const seen = {}
      await expect(
        executeRunnerToExit(
          { FAKE_BUN_WRAPPER_EXITS_FIRST: 'true', FAKE_DESCENDANT_SCRUBS_OWNER: 'true' },
          {
            inspect: (result) => {
              seen.descendants = result.descendants
              // The scrubbed holder is alive here, which is what makes the failing
              // assertion below a real test of the teardown.
              seen.aliveAtInspection = result.descendants.some((pid) => isProcessAlive(pid))
              throw new Error('assertion failed on purpose')
            },
          }
        )
      ).rejects.toThrow('assertion failed on purpose')
      expect(seen.aliveAtInspection).toBe(true)
      for (const pid of seen.descendants) expect(isProcessAlive(pid)).toBe(false)
    },
    40_000
  )

  for (const [name, withProc] of [
    ['with /proc', true],
    ['without /proc', false],
  ]) {
    test.skipIf(withProc && !procFilesystem)(
      `reaps the doubles a runner left behind when a receipt never arrives, ${name}`,
      async () => {
        const probe = `probe-${process.pid}-${Date.now()}-${withProc}`
        const interrupted = () =>
          executeRunnerInterrupted(
            // The hung compose double is spawned by the runner and never recorded in
            // the descendant receipt: /proc proves it by its marker, and without
            // /proc it was retained while it was still part of the runner's tree.
            { FAKE_DOCKER_HANG_ON: 'up', CP_TEST_PROBE: probe },
            {
              signal: 'SIGINT',
              predicate: ({ program }) => program === 'never-invoked',
              description: 'a command that is never invoked',
            }
          )
        await expect(withProc ? interrupted() : withoutProcFilesystem(interrupted)).rejects.toThrow(
          'Timed out waiting for a command that is never invoked'
        )
        // The check reads the real /proc, whichever path the teardown took.
        if (existsSync('/proc/self')) expect(carryingProbe(probe)).toEqual([])
      },
      40_000
    )
  }

  for (const [name, withProc] of [
    ['with /proc', true],
    ['without /proc', false],
  ]) {
    test.skipIf(withProc && !procFilesystem)(
      `owns the direct double the runner started after the last periodic sample, ${name}`,
      async () => {
        const probe = `probe-${process.pid}-${Date.now()}-sig-${withProc}`
        const seen = {}
        const interrupted = () =>
          executeRunnerInterrupted(
            { FAKE_DOCKER_HANG_ON: 'up', CP_TEST_PROBE: probe },
            {
              // SIGKILL cannot be handled, so the runner dies at once and its
              // signal handler never reaps the double: the double is orphaned
              // unless the teardown already owns it.
              signal: 'SIGKILL',
              predicate: ({ program, args }) => program === 'docker' && args.includes('up'),
              description: 'the compose start',
              waitFor: 'exit',
              // The periodic sample never runs, so only the sample taken
              // immediately before the signal can have recorded the double.
              sampleIntervalMs: 600_000,
              inspect: (result) => {
                seen.status = result.status
                seen.signal = result.signal
                if (existsSync('/proc/self')) seen.orphaned = carryingProbe(probe)
              },
            }
          )
        await (withProc ? interrupted() : withoutProcFilesystem(interrupted))
        expect(seen.signal).toBe('SIGKILL')
        // The double really outlived the runner when the teardown began ...
        if (existsSync('/proc/self')) expect(seen.orphaned.length).toBeGreaterThan(0)
        // ... and the teardown reaped it, on either path.
        if (existsSync('/proc/self')) expect(carryingProbe(probe)).toEqual([])
      },
      40_000
    )
  }

  test.skipIf(!procFilesystem)(
    'signals only processes that carry the fixture marker',
    async () => {
      const { directory, descendants, environment } = createRunnerHarness()
      const fixture = spawn(process.execPath, hold, { env: environment, stdio: 'ignore' })
      // A process the fixture's receipt names but that does not carry its marker,
      // as a recycled PID would be.
      const foreign = spawn(process.execPath, hold, { stdio: 'ignore' })
      try {
        writeFileSync(descendants, `${fixture.pid}\n${foreign.pid}\n`)
        const problems = await tearDownRunnerHarness({ directory, descendants })
        expect(isProcessAlive(fixture.pid) && fixture.exitCode === null).toBe(false)
        expect(isProcessAlive(foreign.pid)).toBe(true)
        // The foreign receipt is reported, not ignored, and its receipts are kept.
        expect(problems.join('\n')).toContain(
          `receipt PID(s) ${foreign.pid} could not be verified as fixture-owned`
        )
        expect(existsSync(descendants)).toBe(true)
      } finally {
        killQuietly(fixture.pid)
        killQuietly(foreign.pid)
        rmSync(directory, { recursive: true, force: true })
      }
    },
    20_000
  )

  test('without /proc a receipt PID is never signalled, and a retained identity must still match', async () => {
    await withoutProcFilesystem(async () => {
      const { directory, descendants, environment } = createRunnerHarness()
      const retained = spawn(process.execPath, hold, { env: environment, stdio: 'ignore' })
      const recycled = spawn(process.execPath, hold, { env: environment, stdio: 'ignore' })
      const receipted = spawn(process.execPath, hold, { env: environment, stdio: 'ignore' })
      try {
        const ledger = createFixtureLedger()
        // `retained` was seen while it was part of the runner's tree; `recycled`
        // is remembered under a different identity, as a recycled PID would be.
        ledger.identities.set(retained.pid, processIdentity(retained.pid))
        expect(ledger.owns(retained.pid)).toBe(true)
        ledger.identities.set(recycled.pid, `${recycled.pid}@another-process`)
        writeFileSync(descendants, `${receipted.pid}\n${recycled.pid}\n`)
        const problems = await tearDownRunnerHarness({ directory, descendants, ledger })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(isProcessAlive(retained.pid) && retained.exitCode === null).toBe(false)
        // Neither the unproven receipt nor the identity mismatch was signalled.
        expect(isProcessAlive(recycled.pid)).toBe(true)
        expect(isProcessAlive(receipted.pid)).toBe(true)
        expect(problems.join('\n')).toContain(
          `receipt PID(s) ${receipted.pid}, ${recycled.pid} could not be verified as fixture-owned`
        )
        expect(existsSync(directory)).toBe(true)
      } finally {
        for (const child of [retained, recycled, receipted]) killQuietly(child.pid)
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }, 20_000)

  test('a cleanup problem is appended to the primary failure and never masks it', async () => {
    await withoutProcFilesystem(async () => {
      const seen = {}
      let failure
      try {
        await executeRunnerToExit(
          // Re-parented and token-scrubbed: nothing can prove the holder is the
          // fixture's without /proc, so the teardown must leave it and say so.
          { FAKE_BUN_WRAPPER_EXITS_FIRST: 'true', FAKE_DESCENDANT_SCRUBS_OWNER: 'true' },
          {
            inspect: (result) => {
              seen.descendants = result.descendants
              throw new Error('the primary failure')
            },
          }
        )
      } catch (error) {
        failure = error
      }
      try {
        expect(failure).toBeInstanceOf(Error)
        // The primary failure leads, and the cleanup report follows it.
        expect(failure.message.startsWith('the primary failure\n')).toBe(true)
        expect(failure.message).toContain('Harness cleanup problem(s):')
        expect(failure.message).toMatch(
          /could not be verified as fixture-owned and were left running/u
        )
        // The survivor's receipts are retained for whoever has to clean up.
        const directory = /kept with its receipts at (\S+)/u.exec(failure.message)?.[1]
        expect(directory).toBeDefined()
        expect(existsSync(join(directory, 'descendants.pid'))).toBe(true)
        seen.directory = directory
      } finally {
        for (const pid of seen.descendants ?? []) killQuietly(pid)
        if (seen.directory) rmSync(seen.directory, { recursive: true, force: true })
      }
    })
  }, 40_000)

  test('a cleanup problem fails a case that otherwise passed', async () => {
    await withoutProcFilesystem(async () => {
      let descendantsSeen = []
      let failure
      try {
        await executeRunnerToExit(
          { FAKE_BUN_WRAPPER_EXITS_FIRST: 'true', FAKE_DESCENDANT_SCRUBS_OWNER: 'true' },
          { inspect: (result) => (descendantsSeen = result.descendants) }
        )
      } catch (error) {
        failure = error
      }
      const directory = /kept with its receipts at (\S+)/u.exec(failure?.message ?? '')?.[1]
      try {
        expect(failure?.message).toMatch(/^Harness cleanup problem\(s\):/u)
        expect(directory).toBeDefined()
      } finally {
        for (const pid of descendantsSeen) killQuietly(pid)
        if (directory) rmSync(directory, { recursive: true, force: true })
      }
    })
  }, 40_000)

  test('a case that exceeds its settle budget still reaps what its fixture spawned', async () => {
    // The settle budget is deliberately impossible, so the case FAILS before it
    // can assert anything. The failure path is the property under test: the
    // un-attributable survivor is still reaped in the harness's own bounded
    // cleanup, and the failure is still surfaced instead of being swallowed by
    // that cleanup.
    const outcome = await executeRunnerInterrupted(
      { FAKE_BUN_SPAWN_DETACHED_DESCENDANT: 'true' },
      {
        signal: 'SIGTERM',
        predicate: ({ program, args }) => program === 'bun' && args.includes('test'),
        description: 'the owned test execution',
        waitFor: 'exit',
        settleMs: 1,
      }
    ).then(
      () => ({ error: undefined }),
      (error) => ({ error })
    )
    expect(outcome.error?.message ?? '').toMatch(/Runner did not exit within 1ms after SIGTERM/u)
    // The fixture DID spawn a survivor — named by the failure itself, so the
    // check needs no process-table search — and it is gone once the harness
    // reports, so a failing case cannot leak what it did not own.
    expect(outcome.error?.fixtureDescendants?.length ?? 0).toBeGreaterThan(0)
    for (const pid of outcome.error.fixtureDescendants) expect(isProcessAlive(pid)).toBe(false)
  }, 40_000)
})

describe('integration runner descendant attribution', () => {
  const runnerFunctions = [
    'pidsCarryingOwnerToken',
    'terminateChild',
    'armCompletionBound',
    'ownedDescendants',
    'isProcessAlive',
    'sleepSync',
    'survivingOwnedPids',
    'abandonChildPipes',
    'trackRunnerChild',
    'run',
    'bindChildCompletion',
    'releaseChild',
    'releaseUnlessOwnedDescendantsRemain',
    'releaseSettledChildren',
    'terminateActiveChildren',
    'recordUnreapedOwnedPids',
    'failOnUnreapedOwnedPids',
    'reapOwnedChildrenAtExit',
  ]
  const runnerConstants = [
    'activeChildren',
    'childStates',
    'unreapedOwnedPids',
    'unreapedOwnedPidsReported',
    'CHILD_COMPLETION_TIMEOUT_MS',
    'CHILD_COMMAND_TIMEOUT_MS',
    'OWNED_TREE_EXIT_WAIT_MS',
    'OWNER_TOKEN_VARIABLE',
  ]
  const token = 'token-under-test'

  /** A fake /proc of `pid -> environ` that the runner's own reader code scans. */
  function fakeProc(environments) {
    return {
      readdirSync: (path) => {
        if (path !== '/proc') throw new Error(`unexpected read of ${path}`)
        return [...Object.keys(environments), 'self', 'thread-self']
      },
      readFileSync: (path) => {
        const pid = String(path).split('/')[2]
        if (!(pid in environments)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return environments[pid]
      },
    }
  }

  function load(globals, exportName, overrides = {}) {
    return readScriptBlock(
      'run-integration-tests.mjs',
      { functions: runnerFunctions, constants: runnerConstants, overrides },
      {
        Atomics,
        SharedArrayBuffer,
        setTimeout,
        clearTimeout,
        randomUUID: () => token,
        interruptedSignal: null,
        runnerEnvironment: {},
        console,
        ...globals,
      },
      exportName
    )
  }

  test('only a process carrying this exact token is attributed to the child', () => {
    const find = load(
      {
        process: { pid: 10 },
        ...fakeProc({
          200: `PATH=/bin\0CONTROL_PLANE_RUNNER_OWNER=${token}\0HOME=/root`,
          201: `CONTROL_PLANE_RUNNER_OWNER=${token}`,
          202: 'CONTROL_PLANE_RUNNER_OWNER=another-child',
          203: `XCONTROL_PLANE_RUNNER_OWNER=${token}`,
          204: `CONTROL_PLANE_RUNNER_OWNER=${token}-extended`,
          // The runner itself, init and the direct child are never reported.
          10: `CONTROL_PLANE_RUNNER_OWNER=${token}`,
          1: `CONTROL_PLANE_RUNNER_OWNER=${token}`,
          300: `CONTROL_PLANE_RUNNER_OWNER=${token}`,
        }),
      },
      'pidsCarryingOwnerToken'
    )
    expect(find(token, 300)).toEqual([200, 201])
    expect(find('', 300)).toEqual([])
    expect(find(undefined, 300)).toEqual([])
  })

  test('a platform without /proc attributes nothing by token', () => {
    const find = load(
      {
        process: { pid: 10 },
        readdirSync: () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        },
        readFileSync: () => '',
      },
      'pidsCarryingOwnerToken'
    )
    expect(find(token, 300)).toEqual([])
  })

  test('terminating a child whose wrapper already exited still reaps its orphaned owned descendants', () => {
    const killed = []
    const child = {
      pid: 300,
      exitCode: 0,
      signalCode: null,
      once() {},
      kill() {
        killed.push('direct-child')
      },
    }
    const register = load(
      {
        process: {
          pid: 10,
          kill: (pid) => {
            killed.push(pid)
          },
        },
        // The parent links of an exited child are gone, so no process listing may be needed.
        spawnSync: () => {
          throw new Error('the process tree must not be listed for an exited child')
        },
        ...fakeProc({
          200: `CONTROL_PLANE_RUNNER_OWNER=${token}`,
          201: 'CONTROL_PLANE_RUNNER_OWNER=another-child',
          202: 'PATH=/bin',
        }),
      },
      '({ trackRunnerChild, terminateChild })'
    )
    register.trackRunnerChild(child, 'bun', token)
    expect(register.terminateChild(child)).toEqual([200])
    // The owned descendant is signalled; the unrelated and foreign ones are not,
    // and a child that already exited is not signalled again.
    expect(killed).toEqual([200])
  })

  /**
   * A child that keeps every listener it is given, the way a real ChildProcess
   * does: the runner registers one for ownership tracking and another for the
   * promise that waits for it.
   */
  function fakeChild(pid, released) {
    const child = new EventEmitter()
    const stream = (name) => ({
      setEncoding() {},
      on() {},
      destroy() {
        released.push(name)
      },
    })
    return Object.assign(child, {
      pid,
      exitCode: null,
      signalCode: null,
      kill() {},
      unref() {},
      stdout: stream('stdout'),
      stderr: stream('stderr'),
    })
  }

  /** A fake process table whose kills remove the entry, so a kill is observable. */
  function killableProc(environments, killed) {
    return {
      pid: 10,
      cwd: () => '/tmp',
      kill: (pid, signal) => {
        if (signal === 0) {
          if (!(pid in environments)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
          return true
        }
        killed.push(pid)
        delete environments[pid]
        return true
      },
    }
  }

  const settledWithin = (promise, ms = 3_000) =>
    Promise.race([
      promise.then(
        (value) => ({ settled: true, value }),
        (error) => ({ settled: true, error })
      ),
      new Promise((resolve) => setTimeout(() => resolve({ settled: false }), ms)),
    ])

  test('the exit of a wrapper starts the bounded wait for its completion', async () => {
    const released = []
    const child = fakeChild(301, released)
    const run = load(
      {
        process: {
          pid: 10,
          cwd: () => '/tmp',
          kill: () => {
            throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
          },
        },
        spawn: () => child,
        spawnSync: () => ({ status: 0, stdout: '' }),
        ...fakeProc({}),
      },
      'run',
      { CHILD_COMPLETION_TIMEOUT_MS: '120' }
    )
    const pending = run('bun', ['test'], {})
    // The direct child exits and `close` never arrives.
    child.emit('exit', 0, null)
    const outcome = await settledWithin(pending)
    expect(outcome.settled).toBe(true)
    expect(outcome.error?.message ?? '').toMatch(/bun exited but did not complete within 120 ms/u)
    // The runner's ends of the held pipes are released so the run can finish.
    expect(released.toSorted()).toEqual(['stderr', 'stdout'])
  })

  test('a wrapper whose pipes close normally cancels its bound and fails nothing late', async () => {
    const released = []
    const killed = []
    const logged = []
    const child = fakeChild(302, released)
    const run = load(
      {
        process: killableProc({}, killed),
        console: { error: (message) => logged.push(message) },
        spawn: () => child,
        spawnSync: () => ({ status: 0, stdout: '' }),
        ...fakeProc({}),
      },
      'run',
      { CHILD_COMPLETION_TIMEOUT_MS: '60' }
    )
    const pending = run('bun', ['test'], {})
    // Both listeners are registered: ownership tracking and the run's own.
    expect(child.listenerCount('close')).toBe(2)
    child.emit('exit', 0, null)
    child.emit('close', 0)
    await expect(pending).resolves.toBe('')
    // Past the bound: a closed child must not abandon its pipes, signal anything
    // or report a failure late, which only happens if the timer was not cancelled.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(released).toEqual([])
    expect(killed).toEqual([])
    expect(logged).toEqual([])
  })

  describe('a child that closed while an owned descendant still runs', () => {
    const owned = `PATH=/bin\0CONTROL_PLANE_RUNNER_OWNER=${token}\0`

    function closedWithDescendant(overrides = {}, options = {}) {
      const released = []
      const killed = []
      const logged = []
      const environments = {
        200: owned,
        201: 'PATH=/bin\0CONTROL_PLANE_RUNNER_OWNER=another-child\0',
      }
      const child = fakeChild(303, released)
      const processStub = options.unkillable
        ? {
            ...killableProc(environments, killed),
            kill: (pid, signal) => (signal === 0 ? true : killed.push(pid)),
          }
        : killableProc(environments, killed)
      if (options.exitCode !== undefined) processStub.exitCode = options.exitCode
      const loaded = load(
        {
          process: processStub,
          console: { error: (message) => logged.push(message) },
          spawn: () => child,
          spawnSync: () => ({ status: 0, stdout: '' }),
          ...fakeProc(environments),
        },
        '({ run, activeChildren, terminateActiveChildren, failOnUnreapedOwnedPids, reapOwnedChildrenAtExit })',
        { CHILD_COMPLETION_TIMEOUT_MS: '60', ...overrides }
      )
      return { child, loaded, released, killed, logged, environments, processStub }
    }

    test('stays owned after close and is reaped by an interruption', async () => {
      const { child, loaded, killed, environments } = closedWithDescendant({
        CHILD_COMPLETION_TIMEOUT_MS: '60000',
      })
      const pending = loaded.run('bun', ['build'], {})
      child.emit('exit', 0, null)
      child.emit('close', 0)
      await expect(pending).resolves.toBe('')
      // `close` did not end the ownership: the descendant still carries the token.
      expect(loaded.activeChildren.has(child)).toBe(true)
      expect(loaded.terminateActiveChildren()).toEqual([])
      // Only the token-bearing descendant was signalled; the foreign one was not.
      expect(killed).toEqual([200])
      expect(Object.keys(environments)).toEqual(['201'])
      expect(loaded.activeChildren.has(child)).toBe(false)
    })

    test('is reaped by the completion bound and then released', async () => {
      const { child, loaded, killed, logged } = closedWithDescendant()
      const pending = loaded.run('bun', ['build'], {})
      child.emit('exit', 0, null)
      child.emit('close', 0)
      await expect(pending).resolves.toBe('')
      expect(loaded.activeChildren.has(child)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(killed).toEqual([200])
      expect(loaded.activeChildren.has(child)).toBe(false)
      expect(logged.join('\n')).toMatch(
        /bun closed but left owned descendant\(s\) 200 running; reaped/u
      )
    })

    test('stays owned when the descendant cannot be reaped', async () => {
      const { child, loaded, killed, logged } = closedWithDescendant(
        { OWNED_TREE_EXIT_WAIT_MS: '40' },
        { unkillable: true }
      )
      const pending = loaded.run('bun', ['build'], {})
      child.emit('exit', 0, null)
      child.emit('close', 0)
      await expect(pending).resolves.toBe('')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(killed).toContain(200)
      // A survivor is never forgotten: it is reported and stays tracked for the
      // final cleanup.
      expect(loaded.activeChildren.has(child)).toBe(true)
      expect(logged.join('\n')).toMatch(/still alive: 200/u)
    })

    test('a survivor found after run() resolved still fails the overall outcome', async () => {
      const { child, loaded, logged, processStub } = closedWithDescendant(
        { OWNED_TREE_EXIT_WAIT_MS: '40' },
        { unkillable: true }
      )
      const pending = loaded.run('bun', ['build'], {})
      child.emit('exit', 0, null)
      child.emit('close', 0)
      // The command itself succeeded: nothing in its promise can carry the failure.
      await expect(pending).resolves.toBe('')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(processStub.exitCode).toBeUndefined()
      loaded.failOnUnreapedOwnedPids()
      expect(processStub.exitCode).toBe(1)
      expect(
        logged.filter((line) => /survived the runner's cleanup: 200/u.test(line))
      ).toHaveLength(1)
      // The verdict is reported once, however often it is asked for.
      loaded.failOnUnreapedOwnedPids()
      expect(logged.filter((line) => /survived the runner's cleanup/u.test(line))).toHaveLength(1)
    })

    test('process-exit cleanup that leaves a survivor makes the exit status nonzero', async () => {
      const { child, loaded, logged, processStub } = closedWithDescendant(
        { CHILD_COMPLETION_TIMEOUT_MS: '60000', OWNED_TREE_EXIT_WAIT_MS: '40' },
        { unkillable: true }
      )
      const pending = loaded.run('bun', ['build'], {})
      child.emit('exit', 0, null)
      child.emit('close', 0)
      await expect(pending).resolves.toBe('')
      expect(processStub.exitCode).toBeUndefined()
      loaded.reapOwnedChildrenAtExit()
      expect(processStub.exitCode).toBe(1)
      expect(logged.join('\n')).toMatch(/survived the runner's cleanup: 200/u)
      // The child stays tracked: nothing about it was settled.
      expect(loaded.activeChildren.has(child)).toBe(true)
    })

    test('an interruption status that is already nonzero is kept', async () => {
      const { child, loaded, processStub } = closedWithDescendant(
        { CHILD_COMPLETION_TIMEOUT_MS: '60000', OWNED_TREE_EXIT_WAIT_MS: '40' },
        { unkillable: true, exitCode: 130 }
      )
      const pending = loaded.run('bun', ['build'], {})
      child.emit('exit', 0, null)
      child.emit('close', 0)
      await pending
      loaded.reapOwnedChildrenAtExit()
      expect(processStub.exitCode).toBe(130)
    })

    test('a descendant that was reaped leaves the exit status alone', async () => {
      const { child, loaded, processStub, logged } = closedWithDescendant({
        CHILD_COMPLETION_TIMEOUT_MS: '60000',
      })
      const pending = loaded.run('bun', ['build'], {})
      child.emit('exit', 0, null)
      child.emit('close', 0)
      await pending
      loaded.reapOwnedChildrenAtExit()
      expect(processStub.exitCode).toBeUndefined()
      expect(logged).toEqual([])
    })

    test('is released at once when nothing carries its token', async () => {
      const { child, loaded, environments } = closedWithDescendant()
      delete environments[200]
      const pending = loaded.run('bun', ['build'], {})
      child.emit('exit', 0, null)
      child.emit('close', 0)
      await expect(pending).resolves.toBe('')
      expect(loaded.activeChildren.has(child)).toBe(false)
    })
  })
})
