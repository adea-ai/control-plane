import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import {
  composePostgresImages,
  defaultPullBackoffMs,
  fallbackImages,
  isRegistryRateLimit,
  postgresImageVariable,
  runWithPullBackoff,
  runWithPullFallback,
} from '../scripts/docker-pull-backoff.mjs'
import { exportSelectedImage, pullPostgresImage } from '../scripts/pull-postgres-image.mjs'

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

const pinnedPostgres =
  'public.ecr.aws/docker/library/postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
const mirrorPostgres =
  'mirror.gcr.io/library/postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
const hubPostgres =
  'docker.io/library/postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'
const ecrRateLimited = {
  status: 1,
  stdout: '',
  stderr: 'Error response from daemon: toomanyrequests: Data limit exceeded',
}

test('a pinned ECR Public image falls over to the same digest on the other registries', () => {
  assert.deepEqual(fallbackImages(pinnedPostgres), [mirrorPostgres, hubPostgres])
  // Only a digest-pinned ECR Public reference has a fallback: a tag could name other content.
  assert.deepEqual(fallbackImages(pinnedPostgres.replace(/@sha256:.*/, '')), [])
  assert.deepEqual(fallbackImages(mirrorPostgres), [])
  assert.deepEqual(fallbackImages(undefined), [])
})

function fallbackHarness({ attempts, pulls }) {
  const events = []
  return {
    events,
    options: {
      delaysMs: [5, 7],
      sleep: async (milliseconds) => void events.push(['sleep', milliseconds]),
      log: () => {},
      pull: async (reference) => {
        events.push(['pull', reference])
        return pulls.shift() ?? { status: 0, stdout: '', stderr: '' }
      },
    },
    attempt: async (fallback) => {
      events.push(['attempt', fallback])
      return attempts.shift() ?? succeeded
    },
  }
}

test('a canonical success or an unrelated failure never touches a fallback registry', async () => {
  for (const first of [succeeded, { status: 1, stdout: '', stderr: 'manifest unknown' }]) {
    const harness = fallbackHarness({ attempts: [first], pulls: [] })
    const outcome = await runWithPullFallback(harness.attempt, pinnedPostgres, harness.options)
    assert.equal(outcome.result, first)
    assert.equal(outcome.image, undefined)
    assert.deepEqual(harness.events, [['attempt', undefined]])
  }
})

test('a rate-limited canonical pull uses the first fallback that pulls, without any backoff', async () => {
  const harness = fallbackHarness({ attempts: [ecrRateLimited], pulls: [] })
  const outcome = await runWithPullFallback(harness.attempt, pinnedPostgres, harness.options)
  assert.equal(outcome.image, mirrorPostgres)
  assert.equal(outcome.result.status, 0)
  assert.deepEqual(harness.events, [
    ['attempt', undefined],
    ['pull', mirrorPostgres],
    ['attempt', mirrorPostgres],
  ])
})

test('a fallback that cannot be pulled or used only moves on to the next registry', async () => {
  const harness = fallbackHarness({
    attempts: [ecrRateLimited, { status: 1, stdout: '', stderr: 'unexpected' }],
    pulls: [{ status: 0, stdout: '', stderr: '' }],
  })
  const outcome = await runWithPullFallback(harness.attempt, pinnedPostgres, harness.options)
  assert.equal(outcome.image, hubPostgres)
  assert.deepEqual(harness.events, [
    ['attempt', undefined],
    ['pull', mirrorPostgres],
    ['attempt', mirrorPostgres],
    ['pull', hubPostgres],
    ['attempt', hubPostgres],
  ])
  const unreachable = fallbackHarness({
    attempts: [ecrRateLimited],
    pulls: [
      { status: 1, stdout: '', stderr: 'mirror down' },
      { status: 1, stdout: '', stderr: 'toomanyrequests' },
    ],
  })
  const fallbackOutcome = await runWithPullFallback(
    unreachable.attempt,
    pinnedPostgres,
    unreachable.options
  )
  // Both fallbacks failed to pull, so the round ends in a backoff and the canonical pull is retried.
  assert.equal(fallbackOutcome.image, undefined)
  assert.equal(fallbackOutcome.result.status, 0)
  assert.deepEqual(unreachable.events, [
    ['attempt', undefined],
    ['pull', mirrorPostgres],
    ['pull', hubPostgres],
    ['sleep', 5],
    ['attempt', undefined],
  ])
})

test('when every registry is rate limited the bounded backoff applies and the last result surfaces', async () => {
  const harness = fallbackHarness({
    attempts: [ecrRateLimited, ecrRateLimited, ecrRateLimited],
    pulls: Array.from({ length: 6 }, () => ({ status: 1, stdout: '', stderr: 'toomanyrequests' })),
  })
  const outcome = await runWithPullFallback(harness.attempt, pinnedPostgres, harness.options)
  assert.equal(outcome.result, ecrRateLimited)
  assert.equal(outcome.image, undefined)
  assert.deepEqual(
    harness.events.filter(([kind]) => kind === 'sleep'),
    [
      ['sleep', 5],
      ['sleep', 7],
    ]
  )
  assert.equal(harness.events.filter(([kind]) => kind === 'attempt').length, 3)
  // Each round tries both fallbacks before it waits.
  assert.deepEqual(
    harness.events.slice(0, 4).map(([kind]) => kind),
    ['attempt', 'pull', 'pull', 'sleep']
  )
})

test('Postgres pull falls over to the same digest and reports it without a credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pull-postgres-fallback-'))
  try {
    await writeFile(
      join(directory, 'compose.yaml'),
      `services:\n  postgres:\n    image: \${CONTROL_PLANE_POSTGRES_IMAGE:-${pinnedPostgres}}\n`
    )
    const calls = []
    const environments = []
    const result = await pullPostgresImage({
      cwd: directory,
      environment: { COMPOSE_PROJECT_NAME: 'test-project' },
      spawnSync: (command, dockerArgs, options) => {
        calls.push([command, ...dockerArgs])
        environments.push(options.env)
        return dockerArgs[0] === 'compose' ? ecrRateLimited : { status: 0, stdout: '', stderr: '' }
      },
      backoffOptions: { sleep: async () => {}, log: () => {} },
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    })
    assert.equal(result.status, 0)
    assert.equal(result.image, mirrorPostgres)
    assert.deepEqual(calls, [
      ['docker', 'compose', 'pull', 'postgres'],
      ['docker', 'pull', '--quiet', mirrorPostgres],
    ])
    for (const environment of environments)
      assert.deepEqual(environment, { COMPOSE_PROJECT_NAME: 'test-project' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an image already chosen through the variable is never replaced by a fallback', async () => {
  const calls = []
  const result = await pullPostgresImage({
    cwd: '/workspace/control-plane',
    environment: { [postgresImageVariable]: mirrorPostgres },
    spawnSync: (command, dockerArgs) => {
      calls.push(dockerArgs)
      return calls.length === 1 ? ecrRateLimited : { status: 0, stdout: '', stderr: '' }
    },
    backoffOptions: { delaysMs: [1], sleep: async () => {}, log: () => {} },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  })
  assert.equal(result.image, undefined)
  assert.deepEqual(calls, [
    ['compose', 'pull', 'postgres'],
    ['compose', 'pull', 'postgres'],
  ])
})

test('the selected fallback reaches later GitHub steps through the job environment file only', () => {
  const writes = []
  const append = (file, text) => writes.push([file, text])
  assert.equal(exportSelectedImage(mirrorPostgres, { environment: {}, append }), false)
  assert.equal(
    exportSelectedImage(undefined, { environment: { GITHUB_ENV: '/tmp/env' }, append }),
    false
  )
  assert.equal(
    exportSelectedImage(mirrorPostgres, { environment: { GITHUB_ENV: '/tmp/env' }, append }),
    true
  )
  assert.deepEqual(writes, [['/tmp/env', `${postgresImageVariable}=${mirrorPostgres}\n`]])
})

test('every compose Postgres image is the same pinned digest behind the fallback variable', async () => {
  const sources = await Promise.all(
    ['compose.yaml', 'infrastructure/compose/compose.yaml'].map((path) =>
      readFile(new URL(path, repositoryRoot), 'utf8')
    )
  )
  const images = sources.flatMap(composePostgresImages)
  assert.equal(images.length, 3)
  for (const image of images) assert.equal(image, pinnedPostgres)
  // No ECR Public reference may bypass the variable, or a fallback would not reach it.
  for (const source of sources)
    assert.equal(
      (source.match(/public\.ecr\.aws\/docker\//g) ?? []).length,
      composePostgresImages(source).length
    )
})

test('the hosted compose acceptance script starts Postgres from the pulled image', async () => {
  const script = await readFile(
    new URL('scripts/run-hosted-compose-acceptance.sh', repositoryRoot),
    'utf8'
  )
  assert.match(
    script,
    /postgres_image="\$\("\$node_bin" \.\.\/\.\.\/scripts\/pull-postgres-image\.mjs --print-image\)"/
  )
  assert.match(script, /export CONTROL_PLANE_POSTGRES_IMAGE="\$postgres_image"/)
  assert.ok(
    script.indexOf('export CONTROL_PLANE_POSTGRES_IMAGE') < script.indexOf('compose_started=true')
  )
  const runner = await readFile(
    new URL('scripts/run-integration-tests.mjs', repositoryRoot),
    'utf8'
  )
  assert.match(runner, /runnerEnvironment\[postgresImageVariable\] = image/)
})
