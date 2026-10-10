import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'bun:test'
import {
  captureCommand,
  defaultPullBackoffMs,
  isRegistryRateLimit,
  runWithPullBackoff,
} from './docker-pull-backoff.mjs'

// Verbatim signature from the failed Host CI compose pull.
const rateLimited = { status: 1, stdout: '', stderr: 'postgres toomanyrequests: Rate exceeded' }
const succeeded = { status: 0, stdout: 'Container postgres Healthy', stderr: '' }
const permanent = { status: 1, stdout: '', stderr: 'manifest unknown' }
const e2eSetup = fileURLToPath(new URL('./e2e-setup.mjs', import.meta.url))
const testLocal = fileURLToPath(new URL('../apps/web/start/test-local.mjs', import.meta.url))

type Result = { status: number | null; stdout?: string; stderr?: string; error?: Error }

// Each call returns the next scripted result; the last one repeats.
function scripted(results: Result[]) {
  const calls: number[] = []
  const attempt = () => {
    calls.push(calls.length)
    return results[Math.min(calls.length - 1, results.length - 1)]
  }
  return { attempt, calls }
}

function recordingSleep() {
  const delays: number[] = []
  return { delays, sleep: async (milliseconds: number) => void delays.push(milliseconds) }
}

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'adea-pull-backoff-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// A stand-in `docker` executable that runs `body` on every call.
async function writeDockerStub(dir: string, body: string) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'docker')
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
}

test('retries a transient 429 and returns the eventual success', async () => {
  const { attempt, calls } = scripted([rateLimited, succeeded])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, succeeded)
  assert.equal(calls.length, 2)
  assert.deepEqual(delays, [defaultPullBackoffMs[0]])
})

test('awaits an asynchronous attempt before judging its result', async () => {
  const { attempt, calls } = scripted([rateLimited, succeeded])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(async () => attempt(), { sleep, log: () => {} })
  assert.equal(result, succeeded)
  assert.equal(calls.length, 2)
  assert.deepEqual(delays, [defaultPullBackoffMs[0]])
})

test('returns a permanent error on the first attempt without delay', async () => {
  const { attempt, calls } = scripted([permanent])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, permanent)
  assert.equal(calls.length, 1)
  assert.deepEqual(delays, [])
})

test('bounds persistent 429s and surfaces the last rate-limit result', async () => {
  const { attempt, calls } = scripted([rateLimited])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, rateLimited)
  assert.equal(calls.length, defaultPullBackoffMs.length + 1)
  assert.deepEqual(delays, defaultPullBackoffMs)
})

test('recognizes only the registry rate-limit signature', () => {
  assert.equal(isRegistryRateLimit(rateLimited.stderr), true)
  assert.equal(isRegistryRateLimit('429 Too Many Requests'), true)
  assert.equal(isRegistryRateLimit('manifest unknown'), false)
  assert.equal(isRegistryRateLimit(''), false)
})

test('captures a real child output and exit status', async () => {
  const result = await captureCommand(process.execPath, [
    '-e',
    "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
  ])
  assert.equal(result.status, 3)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
  assert.equal(result.error, undefined)
})

test('reports a spawn failure as a result instead of rejecting', async () => {
  const result = await captureCommand('/nonexistent/adea-docker-missing', [])
  assert.equal(result.error?.code, 'ENOENT')
  assert.notEqual(result.status, 0)
})

test('retries a real rate-limited child to eventual success', async () => {
  await withTempDir(async (dir) => {
    // First run prints the registry rejection; later runs succeed.
    const flag = join(dir, 'pulled')
    const script =
      "const fs = require('node:fs'); if (fs.existsSync(process.env.FLAG)) process.exit(0); " +
      "fs.writeFileSync(process.env.FLAG, ''); " +
      "console.error('postgres toomanyrequests: Rate exceeded'); process.exit(1)"
    const { delays, sleep } = recordingSleep()
    const result = await runWithPullBackoff(
      () =>
        captureCommand(process.execPath, ['-e', script], {
          env: { ...process.env, FLAG: flag },
        }),
      { sleep, log: () => {} }
    )
    assert.equal(result.status, 0)
    assert.deepEqual(delays, [defaultPullBackoffMs[0]])
  })
})

test('returns a real permanent child failure without retrying', async () => {
  await withTempDir(async (dir) => {
    const calls = join(dir, 'calls')
    const script =
      "require('node:fs').appendFileSync(process.env.CALLS, 'x'); " +
      "console.error('manifest unknown'); process.exit(1)"
    const { delays, sleep } = recordingSleep()
    const result = await runWithPullBackoff(
      () =>
        captureCommand(process.execPath, ['-e', script], {
          env: { ...process.env, CALLS: calls },
        }),
      { sleep, log: () => {} }
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /manifest unknown/)
    assert.equal(await readFile(calls, 'utf8'), 'x')
    assert.deepEqual(delays, [])
  })
})

test('both Postgres entrypoints start the database through the pull-backoff helper', async () => {
  for (const path of [testLocal, e2eSetup]) {
    const source = await readFile(path, 'utf8')
    assert.match(
      source,
      /import \{[^}]*\brunWithPullBackoff\b[^}]*\} from '[\w./-]*docker-pull-backoff\.mjs'/,
      path
    )
    assert.match(source, /await runWithPullBackoff\(/, path)
    assert.match(source, /await composeUpPostgres\(\)/, path)
    // A bare `up` through run() would bypass the backoff.
    assert.doesNotMatch(source, /run\(\s*'docker',\s*\[[^\]]*'up'/, path)
  }
})

test('e2e setup surfaces a permanent docker failure once, with its output', async () => {
  await withTempDir(async (dir) => {
    const bin = join(dir, 'bin')
    const calls = join(dir, 'calls')
    await writeDockerStub(
      bin,
      'echo call >> "$CALLS"\necho "Error response from daemon: manifest unknown" >&2\nexit 1'
    )
    const result = spawnSync(process.execPath, [e2eSetup], {
      encoding: 'utf8',
      env: { PATH: bin, CALLS: calls },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Error response from daemon: manifest unknown/)
    assert.match(
      result.stderr,
      /docker compose up -d --wait --wait-timeout 60 postgres failed with exit code 1/
    )
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1)
  })
})

test('e2e setup surfaces a missing docker executable as a spawn error', async () => {
  await withTempDir(async (dir) => {
    const empty = join(dir, 'empty')
    await mkdir(empty)
    const result = spawnSync(process.execPath, [e2eSetup], {
      encoding: 'utf8',
      env: { PATH: empty },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ENOENT/)
  })
})
