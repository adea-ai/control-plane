import { describe, expect, test } from 'bun:test'
import { parse } from 'acorn'
import { runInNewContext } from 'node:vm'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
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
  // still holds the inherited pipes.
  const { spawn } = await import('node:child_process')
  spawn(process.execPath, [
    '-e',
    "const { spawn } = require('node:child_process'); const { appendFileSync } = require('node:fs'); const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); appendFileSync(process.env.DESCENDANT_RECEIPT, String(holder.pid) + '\\\\n'); process.exit(0)",
  ], { stdio: ['ignore', 'inherit', 'inherit'] })
  await new Promise(() => {})
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
      ...overrides,
    },
  }
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

// The bounded wait a fixture-owned descendant is given to disappear after its
// own SIGKILL, before that reap is reported as failed.
const FIXTURE_REAP_WAIT_MS = 5_000
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

/**
 * Reaps the descendants the FIXTURE spawned, by the exact PIDs its receipt named.
 *
 * Only those PIDs are signalled — never a lookup by name and never a process
 * group — so the harness touches nothing it did not create. The PIDs still
 * alive after the bounded wait are returned: their reap is not certain, and the
 * caller then retains their receipt instead of deleting the identity along with
 * the scratch directory.
 */
async function reapFixtureDescendants(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  return survivingAfterSettle(pids, FIXTURE_REAP_WAIT_MS)
}

/**
 * Disposes of everything the harness spawned, on EVERY path.
 *
 * The direct runner is reaped, and the fixture-owned descendants named in its
 * own receipt are reaped by that exact PID. The scratch directory — and with it
 * the receipt that names those PIDs — is removed only when every reap is
 * certain: a descendant that is still alive after the bounded wait keeps its
 * identity on disk and is surfaced, instead of being deleted while it runs.
 */
async function disposeHarnessState(child, descendantsFile, directory) {
  reapHarnessChild(child)
  const unreaped = await reapFixtureDescendants(readDescendantPids(descendantsFile))
  if (unreaped.length === 0) {
    rmSync(directory, { recursive: true, force: true })
    return
  }
  throw new Error(
    `the fixture descendants ${unreaped.join(', ')} were still alive after ` +
      `${FIXTURE_REAP_WAIT_MS} ms; their receipt is retained at ${descendantsFile}`
  )
}

// Spawn the real runner asynchronously, wait until its receipt records the
// injected command, deliver a real signal, and report how it exited. A runner
// without an installed handler dies from the signal (status null, signal name);
// a handled interruption exits with 128 + signal number.
//
// Whatever the path — a passing case, a failing case or a settle timeout — the
// harness disposes of what it spawned before it reports: the direct runner and
// the fixture's own recorded descendants, by those exact PIDs. A reap that is
// not certain retains the receipt that names the PIDs instead of deleting it,
// and is surfaced rather than swallowed.
async function executeRunnerInterrupted(
  overrides,
  { signal, predicate, description, settleMs = 15_000, waitFor = 'close' }
) {
  const { directory, commands, descendants, environment } = createRunnerHarness(overrides)
  let child
  let outcome
  let bodyFailure
  try {
    child = spawn(process.execPath, [runner], {
      cwd: repository,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
    child.kill(signal)
    const settled = await Promise.race([
      exited,
      new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ status: null, signal: 'settle-timeout' }),
          settleMs
        )
        timer.unref?.()
      }),
    ])
    if (settled.signal === 'settle-timeout') {
      reapHarnessChild(child)
      await exited
      const failure = new Error(`Runner did not exit within ${settleMs}ms after ${signal}`)
      // The identities the fixture recorded stay attached to the failure, so a
      // case that fails here can still name exactly what must be reaped, and
      // never has to search the process table for it.
      failure.fixtureDescendants = readDescendantPids(descendants)
      throw failure
    }
    // Liveness is measured after a bounded settle, and BEFORE this harness's
    // own disposal below: it is what the runner left behind, which a
    // post-disposal reading could not show. The settle is what makes the
    // reading mean "survived" rather than "was still being reaped".
    const survivorsAtExit = await survivingAfterSettle(
      readDescendantPids(descendants),
      FIXTURE_LIVENESS_SETTLE_MS
    )
    outcome = {
      ...settled,
      stdout,
      stderr,
      calls: readCommandReceipts(commands),
      descendants: readDescendantPids(descendants),
      survivorsAtExit,
    }
  } catch (error) {
    bodyFailure = error
  }
  // The disposal runs on EVERY path — a passing case, a failing case and a
  // settle timeout alike — because the body's outcome is already captured above.
  // A cleanup that itself fails is surfaced: on its own when the case passed,
  // and appended to the case's own failure when both failed, so neither is lost.
  try {
    await disposeHarnessState(child, descendants, directory)
  } catch (cleanupError) {
    if (bodyFailure === undefined) throw cleanupError
    bodyFailure.message += `\nHarness cleanup also failed: ${cleanupError.message}`
    bodyFailure.cleanupFailure = cleanupError
  }
  if (bodyFailure !== undefined) throw bodyFailure
  return outcome
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
    trackRunnerChild: (child) => child,
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
        const result = await executeRunnerInterrupted(
          { FAKE_BUN_SPAWN_DESCENDANT: 'true' },
          {
            signal: 'SIGINT',
            predicate: ({ program, args }) => program === 'bun' && args.includes('test'),
            description: 'the owned test execution',
          }
        )
        // The runner settled on the interruption and kept the signal's status.
        expect(result.status).toBe(130)
        // The OWNED descendants were already gone when the runner settled: the
        // tree was reaped, not only the direct child. Measured before this
        // harness's own disposal, so its reap cannot be what makes it true.
        expect(result.descendants.length).toBeGreaterThan(0)
        expect(result.survivorsAtExit).toEqual([])
        // The runner verified its own tree, so it reported no survivor.
        expect(result.stderr).not.toMatch(/owned descendant survived/u)
        // An UNRELATED process was never signalled.
        expect(isProcessAlive(unrelated.pid)).toBe(true)
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
        ],
        constants: [
          'activeChildren',
          'childStates',
          'CHILD_COMPLETION_TIMEOUT_MS',
          'CHILD_COMMAND_TIMEOUT_MS',
          'OWNED_TREE_EXIT_WAIT_MS',
        ],
        overrides: { CHILD_COMPLETION_TIMEOUT_MS: '150' },
      },
      {
        interruptedSignal: null,
        runnerEnvironment: {},
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

  test('a stalled pipe is bounded when the survivor can no longer be attributed to the owned tree', async () => {
    // The descendant is re-parented to init before the runner terminates the
    // direct child, so the runner can no longer attribute it to its own tree
    // and must not kill what it cannot prove it owns. The inherited pipe
    // stays open, so the runner's completion has to be BOUNDED rather than
    // waited on forever.
    const result = await executeRunnerInterrupted(
      { FAKE_BUN_SPAWN_DETACHED_DESCENDANT: 'true' },
      {
        signal: 'SIGTERM',
        predicate: ({ program, args }) => program === 'bun' && args.includes('test'),
        description: 'the owned test execution',
        // The survivor holds the runner's pipe, so `close` cannot arrive; the
        // case waits for the runner PROCESS to be gone.
        waitFor: 'exit',
        settleMs: 25_000,
      }
    )
    expect(result.status).toBe(143)
    // The completion was bounded and reported instead of hanging.
    expect(result.stderr).toMatch(/did not complete within \d+ ms after it was terminated/u)
    // The un-attributable survivor was still alive once the runner had settled:
    // the runner never killed what it could not prove it owned. Measured before
    // this harness's own disposal of it.
    expect(result.descendants.length).toBeGreaterThan(0)
    expect(result.survivorsAtExit).toEqual(result.descendants)
    // The case disposed of what it spawned, in its own bounded cleanup, so the
    // survivor is already gone by the time the harness reports back.
    for (const pid of result.descendants) expect(isProcessAlive(pid)).toBe(false)
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
