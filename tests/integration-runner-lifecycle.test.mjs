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
if (program === 'docker') {
  if (process.env.FAKE_DOCKER_DISABLED === 'true') process.exit(90)
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
    environment: {
      ...environment,
      PATH: `${directory}${delimiter}${process.env.PATH}`,
      COMMAND_RECEIPT: commands,
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

// Spawn the real runner asynchronously, wait until its receipt records the
// injected command, deliver a real signal, and report how it exited. A runner
// without an installed handler dies from the signal (status null, signal name);
// a handled interruption exits with 128 + signal number.
async function executeRunnerInterrupted(
  overrides,
  { signal, predicate, description, settleMs = 15_000 }
) {
  const { directory, commands, environment } = createRunnerHarness(overrides)
  let child
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
    const exited = new Promise((resolve) =>
      child.once('close', (status, closeSignal) => resolve({ status, signal: closeSignal }))
    )
    await waitForReceipt(commands, predicate, description)
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
    if (outcome.signal === 'settle-timeout') {
      reapHarnessChild(child)
      await exited
      throw new Error(`Runner did not exit within ${settleMs}ms after ${signal}`)
    }
    return { ...outcome, stdout, stderr, calls: readCommandReceipts(commands) }
  } finally {
    reapHarnessChild(child)
    rmSync(directory, { recursive: true, force: true })
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
    'remote Neon connection drops remain failed checks without automatic retries',
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
    'remote Neon does not retry assertion failures even when their output mentions a connection code',
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
    'remote Neon does not retry a mixed unknown failure that mentions a connection code',
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
    'remote Neon streams oversized output completely and retains only bounded failure tails',
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

for (const script of ['run-integration-tests.mjs', 'run-postgres-disruption-drill.mjs']) {
  test(`${script} cannot spend a full probe beyond its readiness deadline`, async () => {
    let now = 28_000
    let clockReads = 0
    const timeouts = []
    const wait = readScriptFunction(script, 'waitForPostgres', {
      Date: { now: () => (clockReads++ === 0 ? 0 : now) },
      process: { cwd: () => repository },
      runnerEnvironment: {},
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
