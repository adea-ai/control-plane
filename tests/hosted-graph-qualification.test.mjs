import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  realpath,
  appendFile,
  symlink,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('..', import.meta.url))
// The production entry point is Linux CI-only. Keep command-double tests
// available on macOS even when optional GNU coreutils are not installed.
const timeoutExecutable = Bun.which('gtimeout') ?? Bun.which('timeout')

test('Neon requires a real Hosted PostgreSQL/Restate graph qualification', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/neon_workflow.yml', import.meta.url),
    'utf8'
  )
  const gate = readFileSync(
    new URL('../.github/scripts/neon-migration-gate.mjs', import.meta.url),
    'utf8'
  )
  const step = workflow
    .split('      - name: Verify Hosted PostgreSQL and Restate graph')[1]
    ?.split('\n      - name:')[0]
  expect(step).toBeDefined()
  expect(step).toContain("if: steps.credentials.outputs.available == 'true' && matrix.shard == 3")
  expect(step).toContain('bash scripts/run-hosted-graph-qualification.sh')
  expect(gate).toContain("const HOSTED_GRAPH_STEP = 'Verify Hosted PostgreSQL and Restate graph'")
})

for (const failure of [
  'none',
  'provision',
  'start',
  'test',
  'skipped',
  'empty',
  'unrelated',
  'signal',
  'signal-active',
]) {
  test(`Hosted graph qualifier cleans its own resources after ${failure}`, async () => {
    await fixture(async (context) => {
      const result = await context.run(failure)
      expect(result.exitCode).toBe(
        failure === 'none'
          ? 0
          : ['signal', 'signal-active'].includes(failure)
            ? 143
            : ['skipped', 'empty', 'unrelated'].includes(failure)
              ? 1
              : 42
      )
      expect(await readdir(context.runner)).toEqual(['caller-data'])
      const calls = await context.calls()
      if (failure === 'provision') expect(calls).toHaveLength(0)
      else {
        const start = calls.find((call) => call[0] === 'run')
        const removal = calls.find((call) => call[0] === 'container' && call[1] === 'rm')
        expect(removal.at(-1)).toBe(start[start.indexOf('--name') + 1])
        expect(start).toContain('--memory')
        expect(start).toContain('1g')
        expect(start).toContain('--pids-limit')
        expect(start[start.indexOf('--user') + 1]).toBe(`${process.getuid()}:${process.getgid()}`)
        expect(start).toContain(
          `/restate-data:rw,nosuid,nodev,size=256m,uid=${process.getuid()},gid=${process.getgid()},mode=0700`
        )
        expect(calls.every((call) => !call.includes('prune'))).toBe(true)
      }
      if (failure === 'signal-active') {
        const lifecycle = await context.lifecycle()
        expect(lifecycle.some((entry) => entry.state === 'terminated')).toBe(true)
        expect(
          lifecycle.filter((entry) => entry.state === 'running').map((entry) => entry.id)
        ).toEqual(lifecycle.filter((entry) => entry.state === 'reaped').map((entry) => entry.id))
      }
      expect(await readFile(context.caller, 'utf8')).toBe('caller-owned')
    })
  })
}

test.skipIf(!timeoutExecutable)(
  'Hosted graph qualifier forwards active cancellation through real GNU timeout',
  async () => {
    await fixture(async (context) => {
      const result = await context.run('signal-active', {}, true)
      expect(result.exitCode).toBe(143)
      expect(await readdir(context.runner)).toEqual(['caller-data'])
      expect((await context.lifecycle()).some((entry) => entry.state === 'terminated')).toBe(true)
      expect(await readFile(context.caller, 'utf8')).toBe('caller-owned')
    })
  }
)

test('Hosted graph qualifier keeps ownership readable during a slow state write', async () => {
  await fixture(async (context) => {
    const result = await context.run('signal-active', { FAKE_SLOW_LEDGER: 'true' })
    if (result.exitCode !== 143) console.error(result.stdout, result.stderr)
    expect(result.exitCode).toBe(143)
    expect(await readdir(context.runner)).toEqual(['caller-data'])
    expect((await context.lifecycle()).some((entry) => entry.state === 'terminated')).toBe(true)
    expect(await readFile(context.caller, 'utf8')).toBe('caller-owned')
  })
})

for (const failure of ['remove', 'wrong-owner', 'lookup', 'lingering']) {
  test(`Hosted graph qualifier preserves reconciliation data after ${failure}`, async () => {
    await fixture(async (context) => {
      const result = await context.run(failure)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('cleanup failed')
      expect((await readdir(context.runner)).filter((name) => name !== 'caller-data')).toHaveLength(
        1
      )
      if (['wrong-owner', 'lookup'].includes(failure)) {
        expect((await context.calls()).some((call) => call.includes('rm'))).toBe(false)
      }
      expect(await readFile(context.caller, 'utf8')).toBe('caller-owned')
    })
  })
}

test('Hosted graph qualifier refuses local Docker and invalid ownership inputs before resource creation', async () => {
  await fixture(async (context) => {
    for (const overrides of [
      { GITHUB_ACTIONS: '' },
      { GITHUB_RUN_ID: '../caller' },
      { RUNNER_TEMP: 'relative' },
      { DATABASE_ADMIN_URL: '' },
    ]) {
      expect((await context.run('none', overrides)).exitCode).toBe(2)
      expect(await context.calls()).toEqual([])
      expect(await readdir(context.runner)).toEqual(['caller-data'])
    }
  })
})

async function fixture(operation) {
  const fixtureId = crypto.randomUUID()
  const prefix = join(tmpdir(), 'm11-hosted-graph-qualifier-')
  const record = async (state, path) => {
    if (process.env.M11_RESOURCE_LEDGER)
      await appendFile(
        process.env.M11_RESOURCE_LEDGER,
        JSON.stringify({ fixtureId, state, path, owner: 'Hosted graph qualifier test' }) + '\n'
      )
  }
  await record('planned', prefix)
  const directory = await realpath(await mkdtemp(prefix))
  await record('created', directory)
  const runner = join(directory, 'runner')
  const bin = join(directory, 'bin')
  const caller = join(runner, 'caller-data/keep.txt')
  const calls = join(directory, 'docker.jsonl')
  const state = join(directory, 'state.json')
  try {
    await mkdir(join(runner, 'caller-data'), { recursive: true })
    await mkdir(bin)
    await writeFile(caller, 'caller-owned')
    for (const command of ['docker', 'bun', 'node', 'timeout', 'curl', 'sleep']) {
      await writeFile(join(bin, command), `#!${process.execPath}\n${fakeCommands}`, { mode: 0o700 })
    }
    const ledgerDelay = join(directory, 'ledger-delay.sh')
    await writeFile(
      ledgerDelay,
      `printf() {
  if [[ "\${FAKE_SLOW_LEDGER:-}" == true && "$1" == *'"test":'* && "\${@: -2:1}" == running ]]; then
    : > "$FAKE_STATE.ledger-writing"
    while [[ ! -f "$FAKE_STATE.ownership-read" ]]; do /bin/sleep 0.01; done
    /bin/sleep 0.05
  fi
  builtin printf "$@"
}\n`
    )
    await operation({
      runner,
      caller,
      lifecycle: async () =>
        (await readFile(join(directory, 'children.jsonl'), 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse),
      calls: async () => {
        try {
          return (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
        } catch (error) {
          if (error.code === 'ENOENT') return []
          throw error
        }
      },
      run: async (failure, overrides = {}, realTimeout = false) => {
        if (realTimeout) {
          const executable = timeoutExecutable
          if (!executable) throw new Error('GNU timeout required for cancellation regression')
          await rm(join(bin, 'timeout'))
          await symlink(executable, join(bin, 'timeout'))
        }
        await writeFile(state, '{}')
        const planned = {
          command: '/bin/bash scripts/run-hosted-graph-qualification.sh',
          cwd: repository,
          owner: 'Hosted graph qualifier test',
          state: 'planned',
          port: null,
        }
        const ledger = join(directory, 'process.json')
        await writeFile(ledger, JSON.stringify(planned))
        const child = Bun.spawn(['/bin/bash', 'scripts/run-hosted-graph-qualification.sh'], {
          cwd: repository,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GITHUB_ACTIONS: 'true',
            RUNNER_TEMP: runner,
            GITHUB_RUN_ID: '12345',
            GITHUB_RUN_ATTEMPT: '1',
            DATABASE_URL: 'postgresql://fake.invalid/application',
            DATABASE_ADMIN_URL: 'postgresql://fake.invalid/admin',
            DATABASE_MIGRATION_URL: 'postgresql://fake.invalid/migration',
            FAKE_FAILURE: failure,
            FAKE_CALLS: calls,
            FAKE_STATE: state,
            FAKE_PROCESSES: join(directory, 'children.jsonl'),
            BASH_ENV: ledgerDelay,
            ...overrides,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await writeFile(ledger, JSON.stringify({ ...planned, pid: child.pid, state: 'running' }))
        const timer = setTimeout(() => child.kill(), 5_000)
        try {
          const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ])
          await writeFile(
            ledger,
            JSON.stringify({ ...planned, pid: child.pid, state: 'reaped', exitCode })
          )
          return { exitCode, stdout, stderr }
        } finally {
          clearTimeout(timer)
          child.kill()
          await child.exited
        }
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
    await record('removed', directory)
  }
}

const fakeCommands = String.raw`
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const command = basename(process.argv[1])
const args = process.argv.slice(2)
const failure = process.env.FAKE_FAILURE
if (command === 'timeout') {
  const childArgs = args.slice(args.findIndex((value) => /^\d+s$/.test(value)) + 1)
  if (failure === 'signal' && childArgs[0] === 'bun') { process.kill(process.ppid, 'SIGTERM'); process.exit(0) }
  const id = crypto.randomUUID()
  appendFileSync(process.env.FAKE_PROCESSES, JSON.stringify({ id, command: childArgs, state: 'planned' }) + '\n')
  const child = Bun.spawn(childArgs, { env: process.env, stdout: 'pipe', stderr: 'pipe' })
  process.on('SIGTERM', () => child.kill('SIGTERM'))
  appendFileSync(process.env.FAKE_PROCESSES, JSON.stringify({ id, pid: child.pid, state: 'running' }) + '\n')
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  appendFileSync(process.env.FAKE_PROCESSES, JSON.stringify({ id, pid: child.pid, state: 'reaped', exitCode: code }) + '\n')
  process.stdout.write(stdout); process.stderr.write(stderr); process.exit(code)
}
if (command === 'node') {
  if (failure === 'provision' && args[0].includes('provision-restate')) process.exit(42)
  const module = await import(pathToFileURL(resolve(args[0])).href)
  if (args[0].includes('provision-restate')) console.log(await module.provisionRestateIdentity(args[1]))
  else await module.removeHostedComposeFixture(...args.slice(1))
  process.exit(0)
}
if (command === 'docker') {
  appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\n')
  const state = JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8'))
  if (args[0] === 'run') {
    const mount = args[args.indexOf('--mount') + 1]
    const key = mount.split(',').find((part) => part.startsWith('source=')).slice('source='.length)
    const ledger = JSON.parse(readFileSync(resolve(key, '../..', 'resources.json'), 'utf8'))
    if (ledger.state !== 'planned' || ledger.container !== args[args.indexOf('--name') + 1]) throw new Error('container was not recorded before startup')
    if (ledger.ports.length !== 4) throw new Error('listener ownership missing')
    state.name = args[args.indexOf('--name') + 1]
    state.owner = args[args.indexOf('--label') + 1].split('=')[1]
    state.exists = true
    writeFileSync(process.env.FAKE_STATE, JSON.stringify(state))
    if (failure === 'start') process.exit(42)
    console.log('fake-container-id')
  } else if (args[1] === 'ls') {
    if (failure === 'lookup') process.exit(42)
    if (state.exists) console.log(args.at(-1).includes('Label') ? state.name + '|' + (failure === 'wrong-owner' ? 'caller-owner' : state.owner) : state.name)
  } else if (args[1] === 'rm') {
    if (failure === 'signal-active') {
      const lifecycle = readFileSync(process.env.FAKE_PROCESSES, 'utf8').trim().split('\n').map(JSON.parse)
      const terminated = lifecycle.find((entry) => entry.state === 'terminated')
      if (terminated) {
        try { process.kill(terminated.pid, 0); throw new Error('removal before test process exit') }
        catch (error) { if (error.code !== 'ESRCH') throw error }
      }
      if (lifecycle.filter((entry) => entry.state === 'running' && lifecycle.some((plan) => plan.id === entry.id && plan.command?.[0] === 'bun')).some((entry) => !lifecycle.some((other) => other.id === entry.id && other.state === 'reaped'))) throw new Error('removal before child reaping')
    }
    if (failure === 'remove') process.exit(42)
    state.exists = failure === 'lingering'
    writeFileSync(process.env.FAKE_STATE, JSON.stringify(state))
  } else throw new Error('unexpected Docker command')
}
if (command === 'bun') {
  if (process.env.FAKE_SLOW_LEDGER === 'true') {
    while (!existsSync(process.env.FAKE_STATE + '.ledger-writing')) await Bun.sleep(1)
    writeFileSync(process.env.FAKE_STATE + '.ownership-read', '')
  }
  const testLedger = JSON.parse(readFileSync(resolve(process.env.HOSTED_GRAPH_TEST_PUBLIC_KEY_FILE, '..', 'resources.json'), 'utf8'))
  if (!['planned', 'running'].includes(testLedger.test?.state)) throw new Error('test not recorded before startup')
  if (process.env.RUN_DATABASE_INTEGRATION !== 'true' || process.env.RUN_HOSTED_GRAPH_RESTATE_INTEGRATION !== 'true') throw new Error('qualification flags missing')
  if (failure === 'signal-active') {
    const ledger = JSON.parse(readFileSync(resolve(process.env.HOSTED_GRAPH_TEST_PUBLIC_KEY_FILE, '..', 'resources.json'), 'utf8'))
    setTimeout(() => process.kill(ledger.scriptPid, 'SIGTERM'), 20)
    await new Promise((done) => {
      const timer = setTimeout(done, 2000)
      process.on('SIGTERM', () => {
        clearTimeout(timer)
        appendFileSync(process.env.FAKE_PROCESSES, JSON.stringify({ state: 'terminated', pid: process.pid }) + '\n')
        done()
      })
    })
    process.exit(0)
  }
  if (failure === 'test') process.exit(42)
  if (failure === 'skipped') console.error(' 0 pass\n 3 skip\n 0 fail')
  else if (failure === 'empty') console.error(' 0 pass\n 0 fail')
  else {
    console.error(failure === 'unrelated' ? '(pass) unrelated scenario' : '(pass) Hosted Server graph over PostgreSQL and Restate > accepts, checkpoints, parks, cold-resumes, writes one artifact, and charges once')
    console.error(' 1 pass\n 0 fail')
  }
}
`
