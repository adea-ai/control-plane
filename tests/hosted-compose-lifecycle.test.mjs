import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { removeHostedComposeFixture } from '../scripts/remove-hosted-compose-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
// The acceptance script launches many fakes. Keep those fakes shell-native so
// each command does not boot Node; the 25s watchdog bounds a wedged run while
// sequential invocations stay inside the smoke lane's 30s test cap.
const runWatchdogMs = 25_000
const fixtureTestBudgetMs = 30_000

for (const failure of ['none', 'provision', 'simple-start', 'server-start', 'signal']) {
  test(
    `Hosted Compose cleans its own fixture after ${failure}`,
    async () => {
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
          expect(downs.at(-1)[downs.at(-1).indexOf('--project-name') + 1]).not.toBe(
            'caller-project'
          )
          expect(calls.every((args) => args.includes('--project-name'))).toBe(true)
        }
      })
    },
    fixtureTestBudgetMs
  )
}

test(
  'Hosted Compose reports failed teardown and preserves its fixture for reconciliation',
  async () => {
    await fixture(async (context) => {
      const result = await context.run('cleanup')
      expect(result.code).toBe(71)
      expect(result.stderr).toContain('cleanup failed')
      expect(
        (await readdir(context.runnerTemp)).filter((name) => name !== 'caller-data')
      ).toHaveLength(1)
      expect(await readFile(context.callerFile, 'utf8')).toBe('caller-owned')
    })
  },
  fixtureTestBudgetMs
)

test(
  'Hosted Compose gives sequential invocations distinct owned projects',
  async () => {
    await fixture(async (context) => {
      expect((await context.run('none')).code).toBe(0)
      expect((await context.run('none')).code).toBe(0)
      const projects = new Set(
        (await context.calls()).map((args) => args[args.indexOf('--project-name') + 1])
      )
      expect(projects.size).toBe(2)
      expect(await readdir(context.runnerTemp)).toEqual(['caller-data'])
    })
  },
  fixtureTestBudgetMs
)

test(
  'startup and teardown failure preserve the original failure and report cleanup',
  async () => {
    await fixture(async (context) => {
      const result = await context.run('simple-start', { FAKE_DOWN_FAILURE: 'true' })
      expect(result.code).toBe(42)
      expect(result.stderr).toContain('cleanup failed')
      expect(result.stderr).toContain('code=71')
      expect(await readFile(context.callerFile, 'utf8')).toBe('caller-owned')
    })
  },
  fixtureTestBudgetMs
)

test(
  'Hosted Compose rejects an invalid runner root or run identity before creating resources',
  async () => {
    await fixture(async (context) => {
      expect((await context.run('none', { RUNNER_TEMP: 'relative-path' })).code).not.toBe(0)
      expect((await context.run('none', { GITHUB_RUN_ID: '../unowned' })).code).not.toBe(0)
      expect(await context.calls()).toEqual([])
      expect(await readdir(context.runnerTemp)).toEqual(['caller-data'])
    })
  },
  fixtureTestBudgetMs
)

test(
  'watchdog kills a wedged fixture run within its bound',
  async () => {
    await fixture(async (context) => {
      const startedAt = Date.now()
      const result = await context.run('hang', {}, 500)
      expect(result.code).toBeNull()
      expect(result.signal).toBe('SIGKILL')
      expect(Date.now() - startedAt).toBeLessThan(10_000)
    })
  },
  fixtureTestBudgetMs
)

test(
  'fixture removal requires its owner marker and never follows links into caller data',
  async () => {
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
  },
  fixtureTestBudgetMs
)

async function fixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-hosted-compose-lifecycle-'))
  const bin = join(directory, 'bin')
  const runnerTemp = join(directory, 'runner')
  const callsPath = join(directory, 'docker.jsonl')
  const statePath = join(directory, 'state')
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
    const fake = fakeCommands
    for (const name of ['docker', 'curl', 'node', 'openssl']) {
      await writeFile(join(bin, name), fake, { mode: 0o700 })
    }
    // timeout and sudo run once per compose call, so they stay interpreter-free
    // shell exec shims: a script run launches ~65 fakes, and every bun boot is
    // spawn overhead the watchdog would otherwise have to absorb.
    await writeFile(join(bin, 'timeout'), timeoutShim, { mode: 0o700 })
    await writeFile(join(bin, 'sudo'), sudoShim, { mode: 0o700 })
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
      run: async (failure, overrides = {}, runBound = runWatchdogMs) => {
        await rm(statePath, { recursive: true, force: true })
        await mkdir(statePath)
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
              FAKE_STATE_DIR: statePath,
              FAKE_CALLS: callsPath,
              FAKE_FAILURE: failure,
              FAKE_REPOSITORY: repository,
              FAKE_REAL_NODE: process.execPath,
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
        const timeout = setTimeout(stop, runBound)
        const completion = new Promise((onClose, reject) => {
          child.once('error', reject)
          child.once('close', onClose)
        })
        try {
          await writeFile(processRecord, JSON.stringify({ ...planned, pid: child.pid }))
          const code = await completion
          return { code, signal: child.signalCode, stdout, stderr }
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

// POSIX-sh doubles for the two wrappers the acceptance script invokes once per
// compose call. They keep those calls interpreter-free and preserve the
// original fakes' contract: timeout only ever wraps docker or sudo, sudo only
// runs the fixture-removal node call, and FAKE_BASH_PID still points at the
// script shell for the signal failure mode.
const timeoutShim = `#!/bin/sh
while :; do
  case "$1" in
    --signal=*|--kill-after=*|[0-9]*s) shift ;;
    *) break ;;
  esac
done
case "$1" in
  docker|sudo|*/docker|*/sudo) ;;
  *) echo 'timeout only wraps docker or sudo' >&2; exit 99 ;;
esac
export FAKE_BASH_PID="$PPID"
exec "$@"
`
const sudoShim = `#!/bin/sh
case "$1" in
  node|*/node) exec "$@" ;;
  *) exit 0 ;;
esac
`

const fakeCommands = String.raw`#!/bin/bash

has_arg() {
  local wanted="$1" value
  shift
  for value in "$@"; do
    [[ "$value" == "$wanted" ]] && return 0
  done
  return 1
}

json_quote() {
  printf '"%s"' "$1"
}

case "$0" in
  */node)
    case "$1" in
      *remove-hosted-compose-fixture.mjs)
        shift
        exec "$FAKE_REAL_NODE" "$FAKE_REPOSITORY/scripts/remove-hosted-compose-fixture.mjs" "$@"
        ;;
    esac
    [[ "$FAKE_FAILURE" == provision ]] && exit 42
    printf 'fixture-public-key\n'
    exit 0
    ;;
  */openssl)
    password_file="$FAKE_STATE_DIR/password"
    password_number=0
    if [[ -f "$password_file" ]]; then read -r password_number < "$password_file"; fi
    password_number=$((password_number + 1))
    printf '%s\n' "$password_number" > "$password_file"
    printf 'fixture-password-%s\n' "$password_number"
    exit 0
    ;;
  */curl)
    if [[ -f "$FAKE_STATE_DIR/unhealthy" ]]; then printf '503\n'; else printf '200\n'; fi
    exit 0
    ;;
  */docker) ;;
  *) exit 0 ;;
esac

{
  printf '['
  separator=''
  for value in "$@"; do
    printf '%s' "$separator"
    json_quote "$value"
    separator=,
  done
  printf ']\n'
} >> "$FAKE_CALLS"

if has_arg up "$@"; then
  if [[ "$FAKE_FAILURE" == hang ]]; then sleep 60; fi
  rm -f "$FAKE_STATE_DIR/unhealthy"
  if has_arg server "$@"; then : > "$FAKE_STATE_DIR/server"; fi
  if [[ "$FAKE_FAILURE" == signal ]] && has_arg simple "$@"; then
    kill -TERM "$FAKE_BASH_PID"
    exit 143
  fi
  if [[ "$FAKE_FAILURE" == simple-start ]] && has_arg simple "$@"; then exit 42; fi
  if [[ "$FAKE_FAILURE" == server-start ]] && has_arg server "$@"; then exit 42; fi
fi

if has_arg stop "$@"; then : > "$FAKE_STATE_DIR/unhealthy"; fi
if has_arg down "$@" && { [[ "$FAKE_DOWN_FAILURE" == true ]] ||
    { [[ "$FAKE_FAILURE" == cleanup ]] && [[ -f "$FAKE_STATE_DIR/server" ]]; }; }; then
  exit 71
fi
if has_arg sha256sum "$@"; then printf 'fixture-hash file\n'; exit 0; fi

sql=''
for value in "$@"; do sql="$value"; done
if [[ "$sql" == *'create table runtime_role_must_not_create_objects'* ]]; then exit 1
elif [[ "$sql" == *'drizzle.__drizzle_migrations'* ]]; then
  find "$FAKE_REPOSITORY/packages/database/drizzle" -maxdepth 1 -type f -name '*.sql' -print | wc -l | tr -d ' '
elif [[ "$sql" == *'select current_user'* ]]; then
  if has_arg control_plane_migrator "$@"; then printf 'control_plane_migrator\n'; else printf 'control_plane_app\n'; fi
elif [[ "$sql" == *'rolsuper'* || "$sql" == *'pg_get_userbyid'* ]]; then printf 'f\n'
elif [[ "$sql" == *'select tableowner'* ]]; then printf 'control_plane_migrator\n'
elif [[ "$sql" == *'select count(*)'* ]]; then printf '0\n'
fi
if has_arg run "$@" && has_arg database-bootstrap "$@"; then exit 1; fi
`
