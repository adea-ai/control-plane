import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'bun:test'
import {
  defaultPullBackoffMs,
  isRegistryRateLimit,
  runWithPullBackoff,
} from '../scripts/docker-pull-backoff.mjs'
import { pullPostgresImage } from '../scripts/pull-postgres-image.mjs'

const repositoryRoot = new URL('..', import.meta.url)

// Verbatim signatures from failed integration, image-security, and Postgres CI logs.
const rateLimitOutput = [
  'postgres Pulling\npostgres Error toomanyrequests: Rate exceeded',
  'postgres Error toomanyrequests: You have reached your unauthenticated pull rate limit. https://www.docker.com/increase-rate-limit',
  'Error response from daemon: toomanyrequests: You have reached your unauthenticated pull rate limit.',
  'ERROR: failed to solve: failed to copy: httpReadSeeker: failed open: unexpected status code https://registry-1.docker.io/v2/oven/bun/manifests/sha256:d888: 429 Too Many Requests',
]

function scripted(results) {
  const calls = []
  const attempt = () => {
    calls.push(true)
    return results[Math.min(calls.length - 1, results.length - 1)]
  }
  return { attempt, calls }
}

function recordingSleep() {
  const delays = []
  return { delays, sleep: async (milliseconds) => void delays.push(milliseconds) }
}

const rateLimited = { status: 1, stdout: '', stderr: rateLimitOutput[0] }
const succeeded = { status: 0, stdout: 'Container postgres Healthy', stderr: '' }

test('recognizes registry rate-limit signatures without retrying unrelated pull errors', () => {
  for (const output of rateLimitOutput) assert.equal(isRegistryRateLimit(output), true)
  assert.equal(isRegistryRateLimit('oven/bun:1.4.2: manifest unknown'), false)
  assert.equal(isRegistryRateLimit('failed to connect to the docker API'), false)
  assert.equal(isRegistryRateLimit(''), false)
})

test('retries a rate-limited pull and returns the first success', async () => {
  const { attempt, calls } = scripted([rateLimited, succeeded])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, succeeded)
  assert.equal(calls.length, 2)
  assert.deepEqual(delays, [defaultPullBackoffMs[0]])
})

test('gives up after the bounded backoff and surfaces the last rate-limit result', async () => {
  const { attempt, calls } = scripted([rateLimited])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, rateLimited)
  assert.equal(calls.length, defaultPullBackoffMs.length + 1)
  assert.deepEqual(delays, defaultPullBackoffMs)
})

test('does not retry or delay a non-rate-limit failure', async () => {
  const failure = { status: 1, stdout: '', stderr: 'manifest unknown' }
  const { attempt, calls } = scripted([failure])
  const { delays, sleep } = recordingSleep()
  const result = await runWithPullBackoff(attempt, { sleep, log: () => {} })
  assert.equal(result, failure)
  assert.equal(calls.length, 1)
  assert.deepEqual(delays, [])
})

test('does not retry a successful attempt', async () => {
  const { attempt, calls } = scripted([succeeded])
  const { delays, sleep } = recordingSleep()
  assert.equal(await runWithPullBackoff(attempt, { sleep, log: () => {} }), succeeded)
  assert.equal(calls.length, 1)
  assert.deepEqual(delays, [])
})

test('Postgres pull retries only the image-pull command and preserves the pinned compose source', async () => {
  const calls = []
  const delays = []
  const stdout = []
  const stderr = []
  const results = [
    { status: 1, stdout: '', stderr: 'postgres Error toomanyrequests: Rate exceeded' },
    { status: 0, stdout: 'postgres Pulled\n', stderr: '' },
  ]
  const result = await pullPostgresImage({
    cwd: '/workspace/control-plane',
    environment: { COMPOSE_PROJECT_NAME: 'test-project' },
    spawnSync: (command, dockerArgs, options) => {
      calls.push({ command, dockerArgs, options })
      return results.shift()
    },
    backoffOptions: {
      delaysMs: [1],
      sleep: async (milliseconds) => delays.push(milliseconds),
      log: () => {},
    },
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  })
  assert.equal(result.status, 0)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].command, 'docker')
  assert.deepEqual(calls[0].dockerArgs, ['compose', 'pull', 'postgres'])
  assert.equal(calls[0].options.cwd, '/workspace/control-plane')
  assert.deepEqual(calls[0].options.env, { COMPOSE_PROJECT_NAME: 'test-project' })
  assert.deepEqual(delays, [1])
  assert.deepEqual(stdout, ['postgres Pulled\n'])
  assert.deepEqual(stderr, ['postgres Error toomanyrequests: Rate exceeded'])
})

test('integration and PR workflows pull before starting Postgres', async () => {
  const runnerPath = new URL('scripts/run-integration-tests.mjs', repositoryRoot)
  const runner = await readFile(runnerPath, 'utf8')
  const workflow = await readFile(
    new URL('.github/workflows/postgres-pull-request.yml', repositoryRoot),
    'utf8'
  )
  assert.match(runner, /import \{ pullPostgresImage \} from '\.\/pull-postgres-image\.mjs'/)
  assert.match(runner, /await pullPostgresImage\(\{ environment: runnerEnvironment \}\)/)
  assert.match(runner, /await composeUpPostgres\(\)/)
  assert.match(workflow, /run: bun scripts\/pull-postgres-image\.mjs/)
  assert.match(workflow, /run: docker compose up -d --wait postgres/)
  assert.ok(
    workflow.indexOf('run: bun scripts/pull-postgres-image.mjs') <
      workflow.indexOf('run: docker compose up -d --wait postgres')
  )
})
