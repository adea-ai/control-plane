import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createExecutionPlanTestFixture } from '../packages/execution-plan/src/testing.ts'
import { ManagedPiAdapter, ManagedPiDriver } from '../packages/managed-pi-adapter/src/index.ts'
import { ManagedPiProcessClient } from '../packages/managed-pi-adapter/src/process-client.ts'
import { DirectLocalRuntimeTransport } from '../packages/runtime-sdk/src/index.ts'

// Explicit release lane: missing runtime is a failure, never a skipped test.
const executablePath = process.argv[2]
assert(
  executablePath && process.argv.length === 3,
  'Usage: bun scripts/certify-m11-managed-pi.mjs /absolute/path/to/pi'
)
assert.equal(resolve(executablePath), executablePath, 'Pi executable must be an absolute path')
const directory = await mkdtemp(join(tmpdir(), 'control-plane-real-pi-'))
const requests = []
const cancellationRequest = Promise.withResolvers()
const handles = []
let server
let adapter
let report

function chunk(choices, usage) {
  return `data: ${JSON.stringify({ id: 'm11-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices, usage })}\n\n`
}

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('PI_CERTIFICATION_TIMEOUT')), 20000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

try {
  const node = spawnSync('node', ['--version'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    encoding: 'utf8',
  })
  assert.equal(node.status, 0, 'The Pi subprocess requires Node on PATH')
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response(null, { status: 404 })
      const body = await request.json()
      requests.push({ body, authorization: request.headers.get('authorization') })
      if (requests.length === 2) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                chunk([
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'waiting' },
                    finish_reason: null,
                  },
                ])
              )
            )
            cancellationRequest.resolve()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(
        chunk([
          {
            index: 0,
            delta: { role: 'assistant', content: 'verified real Pi' },
            finish_reason: null,
          },
        ]) +
          chunk([{ index: 0, delta: {}, finish_reason: 'stop' }], {
            prompt_tokens: 11,
            completion_tokens: 3,
            total_tokens: 14,
          }) +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })
  const agentDirectory = join(directory, 'agent')
  await mkdir(agentDirectory, { mode: 0o700 })
  await writeFile(
    join(agentDirectory, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: 'openai-completions',
          apiKey: 'fixture-only',
          models: [
            {
              id: 'fixture',
              reasoning: false,
              input: ['text'],
              contextWindow: 32000,
              maxTokens: 128,
            },
          ],
        },
      },
    }),
    { mode: 0o600 }
  )
  const client = new ManagedPiProcessClient({
    executablePath,
    dataDirectory: join(directory, 'executions'),
    environment: { PATH: process.env.PATH ?? '/usr/bin:/bin', PI_CODING_AGENT_DIR: agentDirectory },
    inputResolver: {
      resolve: async () => ({
        systemPrompt: 'Return the bounded response.',
        prompt: 'Say hello.',
        provider: 'fixture',
        model: 'fixture',
      }),
    },
  })
  adapter = new ManagedPiAdapter({
    transport: new DirectLocalRuntimeTransport(
      new ManagedPiDriver({
        client,
        adapterVersion: '1.2.0',
        minimumRuntimeVersion: '0.84.0',
        maximumRuntimeVersionExclusive: '0.85.0',
      })
    ),
  })
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: ['stream.output'],
    skillRequiredCapabilities: [],
  })
  const inspection = await adapter.inspect(plan.runtimeRequirements)
  assert.equal(inspection.health, 'healthy')
  assert.equal(inspection.metadata.harnessVersion, '0.84.2')
  assert.equal(inspection.metadata.transportKind, 'direct-local')
  assert.equal(inspection.capabilityEvaluation.eligible, true)
  const approval = await adapter.inspect([
    { capability: 'interaction.approval', necessity: 'required', minimumSupport: 'supported' },
  ])
  assert.equal(approval.capabilityEvaluation.eligible, false)
  const command = {
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'real-pi-certification',
    executionPlan: plan,
  }
  const handle = await adapter.start(command)
  handles.push(handle)
  assert.deepEqual(await adapter.start(command), handle)
  const events = []
  await bounded(
    (async () => {
      for await (const event of adapter.progress(handle)) events.push(event)
    })()
  )
  const status = await adapter.status(handle)
  assert.equal(status.state, 'completed')
  assert.deepEqual(status.result.output, { text: 'verified real Pi' })
  assert.equal(status.result.usage.inputTokens, 11)
  assert.equal(status.result.usage.outputTokens, 3)
  assert(events.some((event) => event.type === 'output' && event.data.text === 'verified real Pi'))
  assert.equal(requests.length, 1)
  const cancelled = await adapter.start({
    ...command,
    attemptId: 'att_01JBCDEF0123456789ABCDEFGH',
    idempotencyKey: 'real-pi-cancellation',
  })
  handles.push(cancelled)
  await bounded(cancellationRequest.promise)
  await adapter.cancel(cancelled, {
    idempotencyKey: 'real-pi-cancel',
    requestedAt: new Date().toISOString(),
  })
  assert.equal((await adapter.status(cancelled)).state, 'cancelled')
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.authorization, 'Bearer fixture-only')
    assert.equal(request.body.model, 'fixture')
    assert.equal(request.body.stream, true)
    assert.equal(request.body.tools?.length ?? 0, 0)
  }
  report = {
    schemaVersion: 1,
    suite: 'm11-real-pi-process',
    runtimeVersion: inspection.metadata.harnessVersion,
    nodeVersion: node.stdout.trim(),
    bunVersion: process.versions.bun,
    transport: 'direct-local',
    model: 'local-deterministic-http-fixture',
    requests: requests.length,
    completed: true,
    cancellation: true,
    duplicateStart: 'same-handle-one-request',
    usage: { inputTokens: 11, outputTokens: 3 },
    limitations: inspection.limitations,
  }
} finally {
  try {
    if (adapter) await Promise.all(handles.map((handle) => adapter.cleanup(handle)))
  } finally {
    try {
      await server?.stop(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
console.log(JSON.stringify({ ...report, cleanup: 'completed' }, null, 2))
