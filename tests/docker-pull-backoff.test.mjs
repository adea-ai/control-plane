import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'bun:test'
import {
  defaultPullBackoffMs,
  isDockerHubRateLimit,
  runWithPullBackoff,
} from '../scripts/docker-pull-backoff.mjs'

const repositoryRoot = new URL('..', import.meta.url)

// Verbatim signatures from the failed integration and image-security logs.
const rateLimitOutput = [
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

test('recognizes only the Docker Hub rate-limit signature', () => {
  for (const output of rateLimitOutput) assert.equal(isDockerHubRateLimit(output), true)
  assert.equal(isDockerHubRateLimit('oven/bun:1.4.2: manifest unknown'), false)
  assert.equal(isDockerHubRateLimit('failed to connect to the docker API'), false)
  assert.equal(isDockerHubRateLimit(''), false)
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

test('integration runner starts PostgreSQL through the pull-backoff path', async () => {
  const runnerPath = new URL('scripts/run-integration-tests.mjs', repositoryRoot)
  const runner = await readFile(runnerPath, 'utf8')
  // A bare compose-up call would skip the pull backoff, so pin the wiring here.
  assert.match(runner, /import \{ runWithPullBackoff \} from '\.\/docker-pull-backoff\.mjs'/)
  assert.match(runner, /await composeUpPostgres\(\)/)
  assert.doesNotMatch(runner, /run\('docker', \['compose', 'up'/)
})
