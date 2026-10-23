import assert from 'node:assert/strict'
import { spawnSync as realSpawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'bun:test'
import {
  composePostgresImages,
  defaultPullBackoffMs,
  fallbackImages,
  isRegistryRateLimit,
  postgresImageVariable,
  pullInterruptedMessage,
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

test('an interrupted backoff launches no further command', async () => {
  // A signal during the backoff must not start another pull: the next attempt
  // would be a new command launched after the interruption.
  const { attempt, calls } = scripted([rateLimited])
  const { sleep } = recordingSleep()
  let interrupted = false
  const result = await runWithPullBackoff(attempt, {
    // The signal arrives while the runner is waiting out the backoff.
    sleep: async (milliseconds) => {
      interrupted = true
      await sleep(milliseconds)
    },
    log: () => {},
    isInterrupted: () => interrupted,
  })
  assert.equal(calls.length, 1)
  assert.equal(result.stderr, pullInterruptedMessage)
})

test('an interrupted fallback loop launches no further pull', async () => {
  const attempts = []
  const pulls = []
  const attempt = () => {
    attempts.push(true)
    return rateLimited
  }
  const pull = (reference) => {
    pulls.push(reference)
    return { status: 1, stdout: '', stderr: 'mirror unavailable' }
  }
  let interrupted = false
  const { result } = await runWithPullFallback(
    attempt,
    'public.ecr.aws/docker/library/postgres@sha256:aa',
    {
      sleep: async () => {},
      log: () => {},
      // The signal arrives while the first fallback pull is running.
      pull: (reference) => {
        const outcome = pull(reference)
        interrupted = true
        return outcome
      },
      isInterrupted: () => interrupted,
    }
  )
  // The canonical attempt ran, the first fallback pull ran, and then the
  // interruption stopped the loop: no second fallback pull was started.
  assert.equal(attempts.length, 1)
  assert.equal(pulls.length, 1)
  assert.equal(result.stderr, pullInterruptedMessage)
})

test('an interruption ends the backoff wait instead of running it out', async () => {
  // The wait is consumed in slices, so the runner does not sit out a 15 s
  // delay after it was told to stop.
  const { attempt, calls } = scripted([rateLimited])
  const waited = []
  let interrupted = false
  const result = await runWithPullBackoff(attempt, {
    sleep: async (milliseconds) => {
      waited.push(milliseconds)
      interrupted = true
    },
    log: () => {},
    isInterrupted: () => interrupted,
  })
  assert.equal(calls.length, 1)
  assert.equal(result.stderr, pullInterruptedMessage)
  // The wait was consumed in slices and ended with the interruption, instead of
  // running out the whole 15 s delay.
  assert.ok(waited.length < defaultPullBackoffMs[0], 'the wait was not cut short')
  assert.equal(waited.reduce((sum, slice) => sum + slice, 0) <= defaultPullBackoffMs[0], true)
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
      // Compose cannot say which image it resolves, so there is no fallback to consider.
      if (dockerArgs[1] === 'config') return { status: 1, stdout: '', stderr: 'no configuration' }
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
  assert.equal(result.image, undefined)
  assert.equal(calls.length, 3)
  assert.equal(calls[0].command, 'docker')
  assert.deepEqual(calls[0].dockerArgs, ['compose', 'config', '--format', 'json', 'postgres'])
  for (const call of calls.slice(1)) {
    assert.equal(call.command, 'docker')
    assert.deepEqual(call.dockerArgs, ['compose', 'pull', 'postgres'])
  }
  for (const call of calls) {
    assert.equal(call.options.cwd, '/workspace/control-plane')
    assert.deepEqual(call.options.env, { COMPOSE_PROJECT_NAME: 'test-project' })
  }
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
  // The pull runs with the runner's own environment, and it is told about an
  // interruption, so no pull command is started after the signal.
  assert.match(runner, /await pullPostgresImage\(\{/)
  assert.match(runner, /environment: runnerEnvironment/)
  assert.match(runner, /isInterrupted: \(\) => interruptedSignal !== null/)
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

// Answers `docker compose config` like Compose would for a project whose postgres image is
// `effective`, unless the variable is set to something else and `ignoresVariable` is false.
function fakeCompose({ effective, ignoresVariable = false, pulls = [] }) {
  const calls = []
  const environments = []
  let composePulls = 0
  const spawnSync = (command, dockerArgs, options) => {
    calls.push([command, ...dockerArgs])
    environments.push(options.env)
    if (dockerArgs[1] === 'config') {
      const image = ignoresVariable ? effective : (options.env[postgresImageVariable] ?? effective)
      return {
        status: 0,
        stdout: JSON.stringify({ services: { postgres: { image } } }),
        stderr: '',
      }
    }
    if (dockerArgs[0] === 'compose') {
      // Rate limited once; the retry after the backoff goes through.
      composePulls += 1
      return composePulls === 1 ? ecrRateLimited : { status: 0, stdout: '', stderr: '' }
    }
    pulls.push(dockerArgs[2])
    return { status: 0, stdout: '', stderr: '' }
  }
  return { calls, environments, spawnSync }
}

const quiet = {
  backoffOptions: { delaysMs: [1], sleep: async () => {}, log: () => {} },
  stdout: { write: () => {} },
  stderr: { write: () => {} },
}

test('Postgres pull falls over to the same digest and reports it without a credential', async () => {
  const compose = fakeCompose({ effective: pinnedPostgres })
  const result = await pullPostgresImage({
    cwd: '/workspace/control-plane',
    environment: { COMPOSE_PROJECT_NAME: 'test-project' },
    spawnSync: compose.spawnSync,
    ...quiet,
  })
  assert.equal(result.status, 0)
  assert.equal(result.image, mirrorPostgres)
  assert.deepEqual(compose.calls, [
    ['docker', 'compose', 'config', '--format', 'json', 'postgres'],
    ['docker', 'compose', 'pull', 'postgres'],
    ['docker', 'compose', 'config', '--format', 'json', 'postgres'],
    ['docker', 'pull', '--quiet', mirrorPostgres],
  ])
  // Only the verification of the fallback sees the variable; nothing carries a credential.
  assert.deepEqual(
    compose.environments.map((env) => Object.keys(env)),
    [
      ['COMPOSE_PROJECT_NAME'],
      ['COMPOSE_PROJECT_NAME'],
      ['COMPOSE_PROJECT_NAME', postgresImageVariable],
      ['COMPOSE_PROJECT_NAME'],
    ]
  )
})

test('a fallback derives from the image Compose resolves, not from the default in compose.yaml', async () => {
  // `.env`, COMPOSE_FILE or an override selected another digest: the fallback keeps that digest.
  const selected = 'public.ecr.aws/docker/library/postgres:17.2-alpine@sha256:' + 'a'.repeat(64)
  const pulls = []
  const compose = fakeCompose({ effective: selected, pulls })
  const result = await pullPostgresImage({
    cwd: '/workspace/control-plane',
    environment: {},
    spawnSync: compose.spawnSync,
    ...quiet,
  })
  assert.equal(result.image, `mirror.gcr.io/library/postgres:17.2-alpine@sha256:${'a'.repeat(64)}`)
  assert.deepEqual(pulls, [result.image])
  assert.ok(result.image.endsWith(selected.slice(selected.indexOf('@sha256:'))))
  assert.ok(!result.image.includes('18.6'))
})

test('a fallback is disabled when exporting the variable would not select that image', async () => {
  // An override file pins its own image, so CONTROL_PLANE_POSTGRES_IMAGE would change nothing.
  const pulls = []
  const compose = fakeCompose({ effective: pinnedPostgres, ignoresVariable: true, pulls })
  const result = await pullPostgresImage({
    cwd: '/workspace/control-plane',
    environment: {},
    spawnSync: compose.spawnSync,
    ...quiet,
  })
  assert.equal(result.image, undefined)
  assert.deepEqual(pulls, [])
  // Both mirrors are refused, then the canonical pull is retried once after the backoff.
  const composePulls = compose.calls.filter(
    (call) => call.slice(1, 4).join(' ') === 'compose pull postgres'
  )
  assert.equal(composePulls.length, 2)
  assert.equal(compose.calls.filter((call) => call[1] === 'pull').length, 0)
})

test('an image Compose resolves that is not a pinned ECR reference has no fallback', async () => {
  for (const effective of [
    'public.ecr.aws/docker/library/postgres:18.6-alpine',
    'example.com/library/postgres:18@sha256:' + 'b'.repeat(64),
    mirrorPostgres,
  ]) {
    const pulls = []
    const compose = fakeCompose({ effective, pulls })
    const result = await pullPostgresImage({
      cwd: '/workspace/control-plane',
      environment: {},
      spawnSync: compose.spawnSync,
      ...quiet,
    })
    assert.equal(result.image, undefined)
    assert.deepEqual(pulls, [])
  }
})

test('unusable Compose configuration output leaves only the bounded backoff', async () => {
  for (const config of [
    { status: 1, stdout: '', stderr: 'invalid compose file' },
    { status: 0, stdout: 'not json', stderr: '' },
    { status: 0, stdout: JSON.stringify({ services: {} }), stderr: '' },
    { status: 0, stdout: JSON.stringify({ services: { postgres: { image: '' } } }), stderr: '' },
    { status: 0, stdout: JSON.stringify({ services: { postgres: { image: 7 } } }), stderr: '' },
    { status: null, stdout: '', stderr: '', error: new Error('spawn docker ENOENT') },
  ]) {
    const calls = []
    const result = await pullPostgresImage({
      cwd: '/workspace/control-plane',
      environment: {},
      spawnSync: (command, dockerArgs) => {
        calls.push(dockerArgs)
        if (dockerArgs[1] === 'config') return config
        return calls.filter((args) => args[1] === 'pull').length === 1
          ? ecrRateLimited
          : { status: 0, stdout: '', stderr: '' }
      },
      ...quiet,
    })
    assert.equal(result.image, undefined)
    assert.deepEqual(
      calls.filter((args) => args[0] === 'pull'),
      []
    )
  }
})

// These run the real `docker compose config` against temporary projects, so the claim that Compose's
// own resolution (`.env`, COMPOSE_FILE, overrides) selects the fallback's digest is tested, not assumed.
const composeAvailable =
  realSpawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0

async function realComposeProject(files) {
  const directory = await mkdtemp(join(tmpdir(), 'pull-postgres-compose-'))
  await mkdir(join(directory, 'docker/postgres'), { recursive: true })
  await writeFile(join(directory, 'docker/postgres/init.sql'), '')
  await writeFile(
    join(directory, 'compose.yaml'),
    `services:\n  postgres:\n    image: \${CONTROL_PLANE_POSTGRES_IMAGE:-${pinnedPostgres}}\n`
  )
  for (const [name, content] of Object.entries(files))
    await writeFile(join(directory, name), content)
  return directory
}

// Real `compose config`; the registry commands are scripted so nothing leaves the machine.
function realConfigSpawn(pulls) {
  let composePulls = 0
  return (command, dockerArgs, options) => {
    if (dockerArgs[1] === 'config') return realSpawnSync(command, dockerArgs, options)
    if (dockerArgs[0] === 'compose') {
      composePulls += 1
      return composePulls === 1 ? ecrRateLimited : { status: 0, stdout: '', stderr: '' }
    }
    pulls.push(dockerArgs[2])
    return { status: 0, stdout: '', stderr: '' }
  }
}

const composeEnvironment = (extra = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  ...extra,
})

test.skipIf(!composeAvailable)(
  'with real Compose, a .env-selected digest is the one the fallback keeps',
  async () => {
    const digest = 'c'.repeat(64)
    const directory = await realComposeProject({
      '.env': `CONTROL_PLANE_POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:17.2-alpine@sha256:${digest}\n`,
    })
    try {
      const pulls = []
      const result = await pullPostgresImage({
        cwd: directory,
        environment: composeEnvironment(),
        spawnSync: realConfigSpawn(pulls),
        ...quiet,
      })
      assert.equal(result.image, `mirror.gcr.io/library/postgres:17.2-alpine@sha256:${digest}`)
      assert.deepEqual(pulls, [result.image])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test.skipIf(!composeAvailable)(
  'with real Compose, an override file that fixes the image disables the fallback',
  async () => {
    const directory = await realComposeProject({
      'override.yaml': `services:\n  postgres:\n    image: public.ecr.aws/docker/library/postgres:17.2-alpine@sha256:${'d'.repeat(64)}\n`,
    })
    try {
      const pulls = []
      const result = await pullPostgresImage({
        cwd: directory,
        environment: composeEnvironment({ COMPOSE_FILE: 'compose.yaml:override.yaml' }),
        spawnSync: realConfigSpawn(pulls),
        ...quiet,
      })
      assert.equal(result.image, undefined)
      assert.deepEqual(pulls, [])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test.skipIf(!composeAvailable)(
  'with real Compose, the default digest still falls over to both mirrors in order',
  async () => {
    const directory = await realComposeProject({})
    try {
      const pulls = []
      const result = await pullPostgresImage({
        cwd: directory,
        environment: composeEnvironment(),
        spawnSync: realConfigSpawn(pulls),
        ...quiet,
      })
      assert.equal(result.image, mirrorPostgres)
      assert.deepEqual(pulls, [mirrorPostgres])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('an image already chosen through the variable is never replaced by a fallback', async () => {
  const pulls = []
  const compose = fakeCompose({ effective: mirrorPostgres, pulls })
  const result = await pullPostgresImage({
    cwd: '/workspace/control-plane',
    environment: { [postgresImageVariable]: mirrorPostgres },
    spawnSync: compose.spawnSync,
    ...quiet,
  })
  assert.equal(result.image, undefined)
  assert.deepEqual(pulls, [])
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
