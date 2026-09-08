import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createExecutionPlanTestFixture } from '../packages/execution-plan/src/testing.ts'
import {
  ManagedPiAdapter,
  ManagedPiDriver,
  translateExecutionPlanToManagedPi,
} from '../packages/managed-pi-adapter/src/index.ts'
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
  const clientOptions = {
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
  }
  const client = new ManagedPiProcessClient(clientOptions)
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
  const nativeCommand = {
    attemptId: command.attemptId,
    idempotencyKey: command.idempotencyKey,
    configuration: translateExecutionPlanToManagedPi(plan, '1.2.0'),
  }
  const admitted = await Promise.all(Array.from({ length: 8 }, () => client.start(nativeCommand)))
  const handle = admitted[0]
  handles.push(handle)
  for (const entry of admitted) assert.deepEqual(entry, handle)
  const changed = structuredClone(nativeCommand)
  changed.configuration.limits.duration.maximumMs += 1
  await assert.rejects(client.start(changed), /PI_START_IDEMPOTENCY_CONFLICT/)
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
  const local = Bun.spawn(
    [
      process.execPath,
      'test',
      'tests/m11-standalone-e2e.test.mjs',
      '--test-name-pattern',
      'runs the packaged managed Pi RPC client through Local Restate',
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        M11_REAL_PI_EXECUTABLE: executablePath,
        M11_REAL_PI_AGENT_DIRECTORY: agentDirectory,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    local.exited,
    new Response(local.stdout).text(),
    new Response(local.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`LOCAL_PI_CERTIFICATION_FAILED\n${stdout}\n${stderr}`)
  assert.equal(requests.length, 3, 'Local composition must reach the real Pi model endpoint once')
  assert(JSON.stringify(requests[2].body.messages).includes('Complete the assigned task safely.'))
  for (const request of requests) {
    assert.equal(request.authorization, 'Bearer fixture-only')
    assert.equal(request.body.model, 'fixture')
    assert.equal(request.body.stream, true)
    assert.equal(request.body.tools?.length ?? 0, 0)
  }
  await adapter.cleanup(handle)
  handles.splice(handles.indexOf(handle), 1)
  const recreated = new ManagedPiProcessClient(clientOptions)
  await assert.rejects(recreated.start(nativeCommand), {
    code: 'PI_START_RECONCILIATION_REQUIRED',
    classification: 'unknown',
    retryable: false,
  })
  const recovered = await recreated.reconcile(handle)
  assert.equal(recovered.state, 'succeeded')
  assert.deepEqual(recovered.result.output, status.result.output)
  assert.deepEqual(recovered.result.usage, status.result.usage)
  await adapter.cleanup(cancelled)
  handles.splice(handles.indexOf(cancelled), 1)
  assert.equal((await recreated.reconcile(cancelled)).state, 'cancelled')
  assert.equal(requests.length, 3, 'A recreated client must not repeat the cleaned native attempt')
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
    concurrentNativeStarts: 8,
    changedNativeCommand: 'rejected',
    clientRecreationAfterCleanup: 'reconciliation-required-no-new-request',
    terminalRecoveryAfterCleanup: ['succeeded-with-original-output-and-usage', 'cancelled'],
    localComposition: {
      persistence: 'sqlite',
      workflow: 'real-local-restate',
      execution: 'completed',
    },
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
