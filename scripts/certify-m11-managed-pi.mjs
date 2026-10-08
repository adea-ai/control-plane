import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
const durableExecution = process.env.M11_REAL_PI_DURABLE_EXECUTION ?? 'embedded-sqlite'
assert(
  durableExecution === 'embedded-sqlite' || durableExecution === 'restate',
  'M11_REAL_PI_DURABLE_EXECUTION must be embedded-sqlite or restate'
)
const localTestPattern = `runs the packaged managed Pi RPC client through Local ${durableExecution}`
const directory = await mkdtemp(join(tmpdir(), 'control-plane-real-pi-'))
const externalAgentConfigDirectory = process.env.M11_REAL_PI_AGENT_CONFIG_DIRECTORY
const externalAgentDirectory = process.env.M11_REAL_PI_AGENT_DIRECTORY
assert.equal(
  Boolean(externalAgentConfigDirectory),
  Boolean(externalAgentDirectory),
  'Both M11_REAL_PI_AGENT_CONFIG_DIRECTORY and M11_REAL_PI_AGENT_DIRECTORY must be set together'
)
if (externalAgentConfigDirectory) {
  assert.equal(externalAgentConfigDirectory, '/run/control-plane/pi-agent-config')
  assert.equal(externalAgentDirectory, '/var/lib/control-plane/pi-agent')
}
const agentSourceDirectory = externalAgentConfigDirectory ?? join(directory, 'agent-source')
const agentDirectory = externalAgentDirectory ?? join(directory, 'agent')
const requests = []
const cancellationRequest = Promise.withResolvers()
const localCancellationClosed = Promise.withResolvers()
let localStreamClosed = false
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
      if (
        request.method === 'GET' &&
        new URL(request.url).pathname === '/m11/local-cancellation-ready'
      )
        return Response.json({ ready: requests.length === 4, closed: localStreamClosed })
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions')
        return new Response(null, { status: 404 })
      const body = await request.json()
      requests.push({
        body,
        authorization: request.headers.get('authorization'),
        retries: request.headers.get('x-litellm-num-retries'),
      })
      if (requests.length === 2 || requests.length === 4) {
        const localCancellation = requests.length === 4
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
          cancel() {
            if (localCancellation) {
              localStreamClosed = true
              localCancellationClosed.resolve()
            }
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
  if (!externalAgentConfigDirectory) {
    await mkdir(agentSourceDirectory, { mode: 0o700 })
    await writeFile(
      join(agentSourceDirectory, 'auth.json'),
      JSON.stringify({ fixture: { type: 'api_key', key: 'fixture-only' } }),
      { mode: 0o600 }
    )
  }
  const configSync = spawnSync(
    'node',
    ['/usr/local/bin/sync-managed-pi-config.mjs', agentSourceDirectory, agentDirectory],
    {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      encoding: 'utf8',
    }
  )
  assert.equal(configSync.status, 0, `MANAGED_PI_CONFIG_SYNC_FAILED: ${configSync.stderr}`)
  await writeFile(
    join(agentDirectory, 'models.json'),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          api: 'openai-completions',
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
  const startupPreflight = spawnSync(
    'node',
    ['/usr/local/lib/control-plane/managed-pi-version-preflight.mjs', executablePath],
    {
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        PI_CODING_AGENT_DIR: agentDirectory,
      },
      encoding: 'utf8',
      maxBuffer: 16_384,
      timeout: 32_000,
    }
  )
  assert.equal(startupPreflight.status, 0, 'PI_VERSION_PREFLIGHT_FAILED')
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
        minimumRuntimeVersion: '1.0.0',
        maximumRuntimeVersionExclusive: '1.1.0',
      })
    ),
  })
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: ['stream.output'],
    skillRequiredCapabilities: [],
  })
  const inspection = await adapter.inspect(plan.runtimeRequirements)
  assert.equal(inspection.health, 'healthy')
  assert.equal(inspection.metadata.harnessVersion, '1.0.0')
  assert.equal(inspection.metadata.transportKind, 'direct-local')
  assert.equal(inspection.capabilityEvaluation.eligible, true)
  const executableSha256 = createHash('sha256')
    .update(await readFile(executablePath))
    .digest('hex')
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
      localTestPattern,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        M11_REAL_PI_EXECUTABLE: executablePath,
        M11_REAL_PI_AGENT_DIRECTORY: agentDirectory,
        M11_REAL_PI_DURABLE_EXECUTION: durableExecution,
        M11_REAL_PI_CANCELLATION_READY_URL: `http://127.0.0.1:${server.port}/m11/local-cancellation-ready`,
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
  assert.equal(
    requests.length,
    4,
    'Local completion and cancellation must each reach the deterministic model fixture once'
  )
  await bounded(localCancellationClosed.promise)
  assert(JSON.stringify(requests[2].body.messages).includes('Complete the assigned task safely.'))
  for (const request of requests) {
    assert.equal(request.authorization, 'Bearer fixture-only')
    assert.equal(request.body.model, 'fixture')
    assert.equal(request.body.stream, true)
    assert.equal(request.body.tools?.length ?? 0, 0)
  }
  for (const request of requests.slice(2)) {
    assert.equal(request.retries, '0', 'Local broker disables opaque proxy retries')
    assert.equal(request.body.num_retries, 0)
    assert.equal(request.body.disable_fallbacks, true)
  }
  const originalEvents = []
  for await (const event of client.progress(handle)) originalEvents.push(event)
  await adapter.cleanup(handle)
  handles.splice(handles.indexOf(handle), 1)
  const recreated = new ManagedPiProcessClient(clientOptions)
  assert.deepEqual(await recreated.start(nativeCommand), handle)
  const recovered = await recreated.reconcile(handle)
  assert.equal(recovered.state, 'succeeded')
  assert.deepEqual(recovered.result.output, status.result.output)
  assert.deepEqual(recovered.result.usage, status.result.usage)
  const replayedCancellations = await Promise.all(
    Array.from({ length: 8 }, () => recreated.cancel(handle))
  )
  assert.deepEqual(
    replayedCancellations,
    Array.from({ length: 8 }, () => recovered)
  )
  const recoveredEvents = []
  for await (const event of recreated.progress(handle)) recoveredEvents.push(event)
  assert.deepEqual(recoveredEvents, originalEvents)
  const resumedEvents = []
  for await (const event of recreated.progress(handle, 2)) resumedEvents.push(event)
  assert.deepEqual(
    resumedEvents,
    originalEvents.filter((event) => event.sequence > 2)
  )
  await adapter.cleanup(cancelled)
  handles.splice(handles.indexOf(cancelled), 1)
  assert.equal((await recreated.reconcile(cancelled)).state, 'cancelled')
  assert.equal((await recreated.cancel(cancelled)).state, 'cancelled')
  assert.equal(requests.length, 4, 'A recreated client must not repeat the cleaned native attempt')
  report = {
    schemaVersion: 1,
    suite: 'm11-real-pi-process',
    runtimeVersion: inspection.metadata.harnessVersion,
    runtimeExecutableSha256: executableSha256,
    nodeVersion: node.stdout.trim(),
    bunVersion: process.versions.bun,
    transport: 'direct-local',
    model: 'local-deterministic-http-fixture',
    durableExecution,
    requests: requests.length,
    completed: true,
    cancellation: true,
    duplicateStart: 'same-handle-one-request',
    concurrentNativeStarts: 8,
    changedNativeCommand: 'rejected',
    clientRecreationAfterCleanup: 'original-terminal-handle-no-new-request',
    terminalRecoveryAfterCleanup: ['succeeded-with-original-output-and-usage', 'cancelled'],
    terminalCancellationAfterCleanup: 'original-terminal-state-no-new-request',
    eventRecoveryAfterCleanup: 'exact-history-and-cursor-filtering',
    localComposition: {
      persistence: 'sqlite',
      workflow: durableExecution === 'restate' ? 'local-restate' : 'embedded-sqlite',
      externalServices: 0,
      ...(durableExecution === 'restate'
        ? { restateIngressAttach: 'confirmed-completed-and-cancelled' }
        : { restateDiscovery: 'unavailable-and-unused-by-workflow' }),
      execution: 'completed',
      cancellation: 'authenticated-sdk-lost-ack-replay-single-attempt',
      cancellationModelStream: 'closed-before-runtime-cleanup',
      e2eTest: { exitCode, stdout: stdout.trim(), stderr: stderr.trim() },
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
