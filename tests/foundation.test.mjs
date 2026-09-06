import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import { test } from 'bun:test'
import { start as startControlApi } from '../apps/control-api/dist/index.js'
import { start as startRuntimeGateway } from '../apps/runtime-gateway/dist/index.js'
import { start as startRuntimeWorker } from '../apps/runtime-worker/dist/index.js'
import { start as startToolGateway } from '../apps/tool-gateway/dist/index.js'
import { start as startWorkflowWorker } from '../apps/workflow-worker/dist/index.js'

const repositoryRoot = new URL('..', import.meta.url)
const readRepositoryFile = (path) => readFile(new URL(path, repositoryRoot), 'utf8')

class FakeProcessAdapter {
  listeners = new Map()
  exitCode

  on(event, listener) {
    this.listeners.set(event, listener)
  }

  off(event, listener) {
    if (this.listeners.get(event) === listener) this.listeners.delete(event)
  }

  setExitCode(code) {
    this.exitCode = code
  }
}

const environmentFor = (serviceName) => ({
  APP_ENV: 'test',
  COMMIT_SHA: 'foundation-acceptance',
  INSTANCE_ID: `${serviceName}-acceptance`,
  SERVICE_CREDENTIALS: 'must-not-appear-in-logs',
  SERVICE_VERSION: '0.0.0-m1',
})

test('boots every service through shared configuration and graceful shutdown', async () => {
  const logs = []
  const logger = { write: (entry) => logs.push(entry) }

  const starters = [
    ['workflow-worker', startWorkflowWorker],
    ['runtime-worker', startRuntimeWorker],
    ['runtime-gateway', startRuntimeGateway],
    ['tool-gateway', startToolGateway],
  ]

  for (const [serviceName, start] of starters) {
    const processAdapter = new FakeProcessAdapter()
    const options = {
      environment: environmentFor(serviceName),
      logger,
      processAdapter,
      ...(serviceName === 'workflow-worker'
        ? {
            traceAdapter: {
              startSpan: () => ({ context: undefined, end: () => undefined }),
            },
          }
        : {}),
    }
    const runtime = await start(options)

    assert.equal(runtime.metadata.instanceId, `${serviceName}-acceptance`)
    assert.equal(runtime.health().status, 'ok')
    assert.equal(runtime.readiness().status, 'ready')
    assert.equal(processAdapter.listeners.size, 4)
    await runtime.shutdown('foundation-acceptance')
    assert.equal(processAdapter.listeners.size, 0)
    assert.equal(runtime.readiness().status, 'not_ready')
  }

  const processAdapter = new FakeProcessAdapter()
  const controlApi = await startControlApi({
    environment: environmentFor('control-api'),
    listen: false,
    logger,
    processAdapter,
  })
  const health = await controlApi.application.inject({ method: 'GET', url: '/health' })
  const readiness = await controlApi.application.inject({ method: 'GET', url: '/ready' })

  assert.equal(health.statusCode, 200)
  assert.equal(readiness.statusCode, 200)
  assert.equal(health.json().metadata.instanceId, 'control-api-acceptance')
  assert.equal(readiness.json().status, 'ready')
  await controlApi.runtime.shutdown('foundation-acceptance')
  assert.equal(processAdapter.listeners.size, 0)

  const serializedLogs = JSON.stringify(logs)
  assert.doesNotMatch(serializedLogs, /must-not-appear-in-logs/)
  for (const serviceName of ['control-api', ...starters.map(([name]) => name)]) {
    assert.match(serializedLogs, new RegExp(`"serviceName":"${serviceName}"`))
  }
})

test('records architecture ownership and adapter decisions', async () => {
  const architecture = await readRepositoryFile('docs/architecture.md')

  for (const term of [
    'Adea',
    'Control Plane',
    'RuntimeNode',
    'concrete harness',
    'TypeScript',
    'NestJS',
    'Fastify',
    'PostgreSQL',
    'Drizzle',
    'Temporal',
    'LangGraph',
    'Pi',
    'ACP',
    'MCP',
    'LiteLLM',
    'E2B',
    'accepted',
    'adapter-bound',
  ]) {
    assert.match(architecture, new RegExp(term, 'i'))
  }
  assert.match(architecture, /Adea.*identity.*workspace authorization/is)
  assert.match(architecture, /Control Plane.*runtime\/tool\/model\/provider policy/is)
  assert.match(architecture, /no-cross-database-access/i)
  assert.match(architecture, /contract.*context.*execution.*runtime/is)
})

test('provides one ancestry-aware local acceptance command and a parallel CI gate', async () => {
  const manifest = JSON.parse(await readRepositoryFile('package.json'))
  const runner = await readRepositoryFile('scripts/run-foundation-acceptance.mjs')
  const workflow = await readRepositoryFile('.github/workflows/foundation-acceptance.yml')
  const testing = await readRepositoryFile('docs/testing.md')
  const milestone = JSON.parse(await readRepositoryFile('docs/m1-foundation.json'))

  assert.match(manifest.scripts['test:acceptance'], /run-foundation-acceptance/)
  assert.match(manifest.scripts['test:unit'], /build.*run-bun-test-group.*unit.*--coverage/)
  assert.match(manifest.scripts.test, /build.*--parallel.*test:group:/)
  assert.match(testing, /bun run test:acceptance/)
  assert.match(runner, /merge-base/)
  assert.match(runner, /--frozen-lockfile/)
  assert.match(runner, /test:foundation/)
  assert.match(runner, /infra:validate/)
  assert.match(runner, /'docker'.*'buildx'.*'bake'/s)
  assert.deepEqual(
    milestone.dependencies.map(({ issue }) => issue),
    [1, 2, 3, 4, 5, 6, 7, 8]
  )
  for (const dependency of milestone.dependencies) {
    assert.match(dependency.commit, /^[0-9a-f]{40}$/)
  }
  assert.match(workflow, /Foundation Acceptance \/ Gate/)
  assert.match(workflow, /needs: \[core, containers\]/)
  assert.match(workflow, /git fetch --no-tags origin '\+refs\/heads\/\*:refs\/remotes\/origin\/\*'/)
  assert.doesNotMatch(workflow, /Terraform|terraform/)
  assert.match(workflow, /default database-migrate/)
  assert.match(workflow, /cancel-in-progress:\s*true/)
})
