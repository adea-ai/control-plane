import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { removeHostedComposeFixture } from '../scripts/remove-hosted-compose-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))

for (const failure of ['none', 'provision', 'simple-start', 'server-start', 'signal']) {
  test(`Hosted Compose cleans its own fixture after ${failure}`, async () => {
    await fixture(async (context) => {
      const result = await context.run(failure)
      expect(result.code).toBe(failure === 'none' ? 0 : failure === 'signal' ? 143 : 42)
      expect(await readdir(context.runnerTemp)).toEqual(['caller-data'])
      expect(await readFile(context.callerFile, 'utf8')).toBe('caller-owned')
      const calls = await context.calls()
      const downs = calls.filter((args) => args.includes('down'))
      if (failure === 'provision') expect(calls).toHaveLength(0)
      else {
        expect(downs.length).toBeGreaterThan(0)
        expect(downs.at(-1)).toContain('--volumes')
        expect(downs.at(-1)).toContain('--remove-orphans')
        expect(downs.at(-1)).toContain('--project-name')
        expect(downs.at(-1)[downs.at(-1).indexOf('--project-name') + 1]).not.toBe('caller-project')
        expect(calls.every((args) => args.includes('--project-name'))).toBe(true)
      }
    })
  })
}

test('Hosted Compose reports failed teardown and preserves its fixture for reconciliation', async () => {
  await fixture(async (context) => {
    const result = await context.run('cleanup')
    expect(result.code).toBe(71)
    expect(result.stderr).toContain('cleanup failed')
    expect(
      (await readdir(context.runnerTemp)).filter((name) => name !== 'caller-data')
    ).toHaveLength(1)
    expect(await readFile(context.callerFile, 'utf8')).toBe('caller-owned')
  })
})

test('Hosted Compose gives sequential invocations distinct owned projects', async () => {
  await fixture(async (context) => {
    expect((await context.run('none')).code).toBe(0)
    expect((await context.run('none')).code).toBe(0)
    const projects = new Set(
      (await context.calls()).map((args) => args[args.indexOf('--project-name') + 1])
    )
    expect(projects.size).toBe(2)
    expect(await readdir(context.runnerTemp)).toEqual(['caller-data'])
  })
})

test('startup and teardown failure preserve the original failure and report cleanup', async () => {
  await fixture(async (context) => {
    const result = await context.run('simple-start', { FAKE_DOWN_FAILURE: 'true' })
    expect(result.code).toBe(42)
    expect(result.stderr).toContain('cleanup failed')
    expect(result.stderr).toContain('code=71')
    expect(await readFile(context.callerFile, 'utf8')).toBe('caller-owned')
  })
})

test('Hosted Compose rejects an invalid runner root or run identity before creating resources', async () => {
  await fixture(async (context) => {
    expect((await context.run('none', { RUNNER_TEMP: 'relative-path' })).code).not.toBe(0)
    expect((await context.run('none', { GITHUB_RUN_ID: '../unowned' })).code).not.toBe(0)
    expect(await context.calls()).toEqual([])
    expect(await readdir(context.runnerTemp)).toEqual(['caller-data'])
  })
})

test('fixture removal requires its owner marker and never follows links into caller data', async () => {
  await fixture(async (context) => {
    const root = await mkdtemp(join(context.runnerTemp, 'control-plane-m10-compose.'))
    const project = 'control-plane-m10-12345-1-abcdef'
    await writeFile(join(root, '.fixture-owner.json'), JSON.stringify({ project }))
    await symlink(join(context.runnerTemp, 'caller-data'), join(root, 'foreign-link'))
    await expect(
      removeHostedComposeFixture(context.runnerTemp, root, 'control-plane-m10-12345-1-f00bad')
    ).rejects.toThrow('HOSTED_COMPOSE_FIXTURE_OWNER_INVALID')
    await removeHostedComposeFixture(context.runnerTemp, root, project)
    expect(await readFile(context.callerFile, 'utf8')).toBe('caller-owned')
    expect(await readdir(context.runnerTemp)).toEqual(['caller-data'])
    await expect(
      removeHostedComposeFixture(
        context.runnerTemp,
        join(context.runnerTemp, 'caller-data'),
        project
      )
    ).rejects.toThrow('HOSTED_COMPOSE_FIXTURE_SCOPE_INVALID')
  })
})

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-hosted-compose-lifecycle-'))
  const bin = join(directory, 'bin')
  const runnerTemp = join(directory, 'runner')
  const callsPath = join(directory, 'docker.jsonl')
  const statePath = join(directory, 'state.json')
  const callerFile = join(runnerTemp, 'caller-data', 'keep.txt')
  const cwd = join(directory, 'work/infrastructure/compose')
  try {
    await mkdir(bin)
    await mkdir(join(runnerTemp, 'caller-data'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    const migrations = join(directory, 'work/packages/database/drizzle')
    await mkdir(migrations, { recursive: true })
    for (const name of await readdir(join(repository, 'packages/database/drizzle'))) {
      if (name.endsWith('.sql')) await writeFile(join(migrations, name), '')
    }
    await writeFile(callerFile, 'caller-owned')
    const fake = `#!${process.execPath}\n${fakeCommands}`
    for (const name of ['docker', 'curl', 'node', 'openssl', 'sudo', 'timeout']) {
      await writeFile(join(bin, name), fake, { mode: 0o700 })
    }
    await operation({
      runnerTemp,
      callerFile,
      calls: async () => {
        try {
          return (await readFile(callsPath, 'utf8'))
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(JSON.parse)
        } catch (error) {
          if (error.code === 'ENOENT') return []
          throw error
        }
      },
      run: async (failure, overrides = {}) => {
        await writeFile(statePath, '{}')
        const processRecord = join(directory, 'process.json')
        const planned = {
          pid: null,
          cwd,
          command: 'bash run-hosted-compose-acceptance.sh',
          owner: 'hosted-compose-lifecycle test',
          ownerTag: process.env.M11_RESOURCE_OWNER,
        }
        await writeFile(processRecord, JSON.stringify(planned))
        const child = spawn(
          '/bin/bash',
          [resolve(repository, 'scripts/run-hosted-compose-acceptance.sh')],
          {
            cwd,
            detached: true,
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              RUNNER_TEMP: runnerTemp,
              GITHUB_RUN_ID: '12345',
              GITHUB_RUN_ATTEMPT: '1',
              COMPOSE_PROJECT_NAME: 'caller-project',
              CONTROL_PLANE_DATA_PATH: join(runnerTemp, 'caller-data'),
              FAKE_ROOT: directory,
              FAKE_STATE: statePath,
              FAKE_CALLS: callsPath,
              FAKE_FAILURE: failure,
              FAKE_REPOSITORY: repository,
              ...overrides,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (data) => {
          stdout += data
        })
        child.stderr.on('data', (data) => {
          stderr += data
        })
        const stop = () => {
          if (!Number.isSafeInteger(child.pid)) return
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
        const timeout = setTimeout(stop, 5000)
        const completion = new Promise((onClose, reject) => {
          child.once('error', reject)
          child.once('close', onClose)
        })
        try {
          await writeFile(processRecord, JSON.stringify({ ...planned, pid: child.pid }))
          const code = await completion
          return { code, stdout, stderr }
        } finally {
          clearTimeout(timeout)
          if (child.exitCode === null && child.signalCode === null) stop()
          await completion.catch(() => {})
        }
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const fakeCommands = String.raw`
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
const command = basename(process.argv[1])
const args = process.argv.slice(2)
const env = process.env
const state = JSON.parse(readFileSync(env.FAKE_STATE, 'utf8'))
const save = () => writeFileSync(env.FAKE_STATE, JSON.stringify(state))
if (command === 'timeout') {
  const index = args.findIndex(arg => /^\d+s$/.test(arg)) + 1
  if (!['docker', 'sudo'].includes(args[index])) process.exit(99)
  const result = spawnSync(join(env.FAKE_ROOT, 'bin', args[index]), args.slice(index + 1), {
    env: { ...env, FAKE_BASH_PID: String(process.ppid) }, stdio: 'inherit',
  })
  process.exit(result.status ?? 99)
}
if (command === 'sudo') {
  if (basename(args[0]) === 'node') {
    const result = spawnSync(join(env.FAKE_ROOT, 'bin/node'), args.slice(1), { env, stdio: 'inherit' })
    process.exit(result.status ?? 99)
  }
  process.exit(0)
}
if (command === 'node') {
  if (args[0]?.endsWith('remove-hosted-compose-fixture.mjs')) {
    const result = spawnSync(process.execPath, [join(env.FAKE_REPOSITORY, 'scripts/remove-hosted-compose-fixture.mjs'), ...args.slice(1)], { env, stdio: 'inherit' })
    process.exit(result.status ?? 99)
  }
  if (env.FAKE_FAILURE === 'provision') process.exit(42)
  console.log('fixture-public-key')
  process.exit(0)
}
if (command === 'openssl') {
  state.password = (state.password ?? 0) + 1; save()
  console.log('fixture-password-' + state.password)
  process.exit(0)
}
if (command === 'curl') { console.log(state.unhealthy ? '503' : '200'); process.exit(0) }
appendFileSync(env.FAKE_CALLS, JSON.stringify(args) + '\n')
if (args.includes('up')) {
  state.unhealthy = false
  if (args.includes('server')) state.server = true
  save()
  if (env.FAKE_FAILURE === 'signal' && args.includes('simple')) {
    process.kill(Number(env.FAKE_BASH_PID ?? process.ppid), 'SIGTERM'); process.exit(143)
  }
  if ((env.FAKE_FAILURE === 'simple-start' && args.includes('simple')) ||
      (env.FAKE_FAILURE === 'server-start' && args.includes('server'))) process.exit(42)
}
if (args.includes('stop')) { state.unhealthy = true; save() }
if (args.includes('down') && (env.FAKE_DOWN_FAILURE === 'true' || (env.FAKE_FAILURE === 'cleanup' && state.server))) process.exit(71)
if (args.includes('sha256sum')) console.log('fixture-hash file')
const sql = args.at(-1)
if (typeof sql === 'string') {
  if (sql.includes('create table runtime_role_must_not_create_objects')) process.exit(1)
  if (sql.includes('drizzle.__drizzle_migrations')) console.log(readdirSync(join(env.FAKE_REPOSITORY, 'packages/database/drizzle')).filter(name => name.endsWith('.sql')).length)
  else if (sql.includes('select current_user')) console.log(args.includes('control_plane_migrator') ? 'control_plane_migrator' : 'control_plane_app')
  else if (sql.includes('rolsuper') || sql.includes('pg_get_userbyid')) console.log('f')
  else if (sql.includes('select tableowner')) console.log('control_plane_migrator')
  else if (sql.includes('select count(*)')) console.log('0')
}
if (args.includes('run') && args.includes('database-bootstrap')) process.exit(1)
`
