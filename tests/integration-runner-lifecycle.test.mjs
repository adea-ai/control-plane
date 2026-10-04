import { describe, expect, test } from 'bun:test'
import { parse } from 'acorn'
import { runInNewContext } from 'node:vm'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('..', import.meta.url))
const runner = join(repository, 'scripts/run-integration-tests.mjs')

// These executable doubles exercise the real runner without a Docker engine,
// network target, database, install, build, or integration suite.
function executeRunner(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cp-integration-lifecycle-'))
  const commands = join(directory, 'commands.jsonl')
  try {
    const fake = `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
const program = basename(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(process.env.COMMAND_RECEIPT, JSON.stringify({ program, args, project: process.env.COMPOSE_PROJECT_NAME ?? null }) + '\\n')
if (program === 'docker') {
  if (process.env.FAKE_DOCKER_DISABLED === 'true') process.exit(90)
  if (args.includes('ps') && process.env.FAKE_POSTGRES_RUNNING === 'true') console.log('postgres')
  if (args.includes('exec')) console.log('1')
  if (args.includes('up') && process.env.FAKE_DOCKER_ECHO_PROJECT === 'true') console.log('Created ' + process.env.COMPOSE_PROJECT_NAME + '-postgres')
  if (args.includes(process.env.FAKE_DOCKER_FAIL_ON)) process.exit(7)
} else if (process.env.FAKE_BUN_FAIL === 'true') process.exit(9)
`
    for (const name of ['docker', 'bun']) {
      writeFileSync(join(directory, name), fake, { mode: 0o700 })
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
    const result = spawnSync(process.execPath, [runner], {
      cwd: repository,
      encoding: 'utf8',
      timeout: 2000,
      env: {
        ...environment,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        COMMAND_RECEIPT: commands,
        ...overrides,
      },
    })
    if (result.error) throw result.error
    const calls = existsSync(commands)
      ? readFileSync(commands, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : []
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls }
  } finally {
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
  test('remote verification needs no Docker command even when the engine is unavailable', () => {
    const result = executeRunner(remoteTarget)
    expect(result.status).toBe(0)
    expect(result.calls.filter(({ program }) => program === 'docker')).toEqual([])
    expect(result.calls.filter(({ program }) => program === 'bun')).toHaveLength(3)
  })

  test('remote configuration rejection does not contact Docker', () => {
    const result = executeRunner({ ...remoteTarget, DATABASE_ADMIN_URL: '' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('explicit DATABASE_ADMIN_URL')
    expect(result.calls).toEqual([])
  })

  test('a runner-owned PostgreSQL project removes its volume after success', () => {
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
  })

  test('separate invocations cannot reuse an owned fixture volume', () => {
    const first = executeRunner()
    const second = executeRunner()
    const startedProject = (result) =>
      result.calls.find(({ program, args }) => program === 'docker' && args.includes('up')).project
    expect(first.status).toBe(0)
    expect(second.status).toBe(0)
    expect(startedProject(first)).not.toBe(startedProject(second))
  })

  for (const [label, overrides] of [
    ['partial startup failure', { FAKE_DOCKER_FAIL_ON: 'up' }],
    ['integration failure', { FAKE_BUN_FAIL: 'true' }],
  ]) {
    test(`owned volume cleanup runs after ${label}`, () => {
      const result = executeRunner(overrides)
      expect(result.status).not.toBe(0)
      const start = result.calls.find(
        ({ program, args }) => program === 'docker' && args.includes('up')
      )
      const [cleanup] = destructiveCalls(result)
      expect(cleanup.project).toBe(start.project)
      expect(cleanup.args).toContain('down')
      expect(cleanup.args).toContain('--volumes')
    })
  }

  test('a previously running PostgreSQL service is preserved', () => {
    const result = executeRunner({ FAKE_POSTGRES_RUNNING: 'true' })
    expect(result.status).toBe(0)
    expect(destructiveCalls(result)).toEqual([])
    expect(
      result.calls.some(({ program, args }) => program === 'docker' && args.includes('up'))
    ).toBe(false)
  })

  test('caller project is omitted from the startup receipt while command diagnostics stay visible', () => {
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
  })

  test('an explicit caller project retains its volume and original project identity', () => {
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
  })

  test('a failed engine query creates no cleanup authority', () => {
    const result = executeRunner({ FAKE_DOCKER_DISABLED: 'true' })
    expect(result.status).not.toBe(0)
    expect(destructiveCalls(result)).toEqual([])
    expect(result.calls.some(({ args }) => args.includes('up'))).toBe(false)
  })

  test('both verification and cleanup errors remain observable', () => {
    const result = executeRunner({ FAKE_BUN_FAIL: 'true', FAKE_DOCKER_FAIL_ON: 'down' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('bun exited with status 9')
    expect(result.stderr).toContain('docker exited with status 7')
  })

  test('IPv6 loopback keeps the local lifecycle', () => {
    const result = executeRunner({
      DATABASE_URL: 'postgresql://app:fixture@[::1]:54329/control_plane',
    })
    expect(result.status).toBe(0)
    expect(
      result.calls.some(({ program, args }) => program === 'docker' && args.includes('up'))
    ).toBe(true)
    expect(destructiveCalls(result)[0].args).toContain('--volumes')
  })

  test('cleanup failure makes the verification fail', () => {
    const result = executeRunner({ FAKE_DOCKER_FAIL_ON: 'down' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('docker exited with status 7')
  })
})

function readScriptFunction(path, name, globals) {
  const source = readFileSync(new URL(`../scripts/${path}`, import.meta.url), 'utf8')
  const declaration = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === name
  )
  expect(declaration).toBeDefined()
  return runInNewContext(`(${source.slice(declaration.start, declaration.end)})`, globals)
}

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
