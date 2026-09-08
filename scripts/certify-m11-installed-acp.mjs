import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { AcpStdioClient } from '../packages/acp-adapter/src/stdio-client.ts'
import { pinnedAcpBuild } from './install-m11-codex-acp.mjs'
import {
  LocalControlPlaneComposition,
  resolveLocalRuntimeOptions,
} from '../apps/local-control-plane/dist/index.js'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '../packages/execution-plan/src/testing.ts'
import { ControlApiFixtures } from '@control-plane/contracts'
import { ControlPlaneClient } from '@control-plane/sdk'
import {
  createControlApiApplication,
  createPrivateApiAuthentication,
} from '../apps/control-api/dist/index.js'

const event = (type, fields) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`

const [installation, nodeExecutable] = process.argv.slice(2)
assert(
  process.argv.length === 4 && isAbsolute(installation) && isAbsolute(nodeExecutable),
  'Usage: bun scripts/certify-m11-installed-acp.mjs /absolute/installation /absolute/node24'
)
const nodeVersion = execFileSync(nodeExecutable, ['--version'], {
  encoding: 'utf8',
  timeout: 5000,
}).trim()
assert.match(nodeVersion, /^v24\./)
const manifest = JSON.parse(await readFile(join(installation, 'installation.json'), 'utf8'))
for (const [key, value] of Object.entries(pinnedAcpBuild)) assert.equal(manifest[key], value)
assert.equal(manifest.status, 'built')
assert.equal(manifest.executable, 'source/dist/index.js')
const executable = join(installation, manifest.executable)
assert.equal(
  createHash('sha256')
    .update(await readFile(executable))
    .digest('hex'),
  pinnedAcpBuild.bundleSha256
)
const directory = await mkdtemp(join(tmpdir(), 'm11-installed-acp-certification-'))
const approvalMarker = join(directory, 'approval-marker')
let rpc
let server
let local
let application
let requests = 0
let cancellationStreamClosed = false
let cancellationRequestAborted = false
let cancellationCleanupVerified = false
let streamHeartbeat
async function until(predicate, description) {
  const deadline = Date.now() + 20000
  do {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  throw new Error(`ACP_CERTIFICATION_TIMEOUT:${description}`)
}
try {
  const cwd = join(directory, 'workspace')
  const home = join(directory, 'home')
  const codexHome = join(directory, 'codex')
  for (const path of [cwd, home, codexHome]) await mkdir(path, { mode: 0o700 })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/responses')
        return new Response(null, { status: 404 })
      const body = await request.json()
      requests++
      if (requests >= 3) {
        assert.equal(body.model, 'gpt-5.4')
        assert(JSON.stringify(body).includes('Complete the assigned task safely.'))
        assert(JSON.stringify(body).includes('Inspect and update project files.'))
      }
      const permission = requests === 5 || requests === 6
      const item = permission
        ? {
            id: `fc_${requests}`,
            type: 'function_call',
            call_id: `call_${requests}`,
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: `printf 'approved\\n' >> '${approvalMarker}'`,
              shell: '/bin/sh',
              login: false,
              sandbox_permissions: 'require_escalated',
              justification: 'Write the isolated certification marker after approval.',
            }),
            status: 'completed',
          }
        : {
            id: `msg_${requests}`,
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Installed ACP verified.', annotations: [] }],
          }
      const result = {
        id: `resp_${requests}`,
        object: 'response',
        created_at: 1788838800,
        status: 'completed',
        model: 'gpt-5.4',
        output: [item],
        usage: {
          input_tokens: 11,
          output_tokens: 3,
          total_tokens: 14,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      }
      if (requests === 4) {
        request.signal.addEventListener(
          'abort',
          () => {
            cancellationRequestAborted = true
          },
          { once: true }
        )
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  event('response.created', {
                    response: { ...result, status: 'in_progress', output: [] },
                  })
                )
              )
              streamHeartbeat = setInterval(() => {
                controller.enqueue(new TextEncoder().encode(': pending\n\n'))
              }, 100)
            },
            cancel() {
              clearInterval(streamHeartbeat)
              cancellationStreamClosed = true
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }
      if (permission)
        return new Response(
          event('response.created', {
            response: { ...result, status: 'in_progress', output: [] },
          }) +
            event('response.output_item.added', {
              output_index: 0,
              item: { ...item, status: 'in_progress', arguments: '' },
            }) +
            event('response.function_call_arguments.delta', {
              item_id: item.id,
              output_index: 0,
              delta: item.arguments,
            }) +
            event('response.function_call_arguments.done', {
              item_id: item.id,
              output_index: 0,
              arguments: item.arguments,
            }) +
            event('response.output_item.done', { output_index: 0, item }) +
            event('response.completed', { response: result }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      return new Response(
        event('response.created', { response: { ...result, status: 'in_progress', output: [] } }) +
          event('response.output_item.added', {
            output_index: 0,
            item: { ...item, status: 'in_progress', content: [] },
          }) +
          event('response.output_text.delta', {
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: item.content[0].text,
          }) +
          event('response.output_item.done', { output_index: 0, item }) +
          event('response.completed', { response: result }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
  })
  const open = async () => {
    const client = new AcpStdioClient({
      executablePath: nodeExecutable,
      args: [executable],
      cwd,
      environment: {
        PATH: `${dirname(nodeExecutable)}:/usr/bin:/bin`,
        HOME: home,
        CODEX_HOME: codexHome,
        CODEX_PATH: join(installation, 'native/codex'),
      },
      onNotification: () => undefined,
      onRequest: (id) => client.respondError(id, -32601, 'Certification does not authorize tools'),
    })
    rpc = client
    await client.start()
    const initialized = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    })
    assert.equal(initialized.protocolVersion, 1)
    await client.request('authenticate', {
      methodId: 'gateway',
      _meta: {
        gateway: {
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          headers: {},
          providerName: 'isolated-fixture',
        },
      },
    })
    return client
  }
  await open()
  const { sessionId } = await rpc.request('session/new', { cwd, mcpServers: [] })
  const prompt = async () => {
    const result = await rpc.request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: 'Say hello.' }] },
      { timeoutMs: 30000 }
    )
    assert.equal(result.stopReason, 'end_turn')
    assert.equal(result.usage.inputTokens, 11)
    assert.equal(result.usage.outputTokens, 3)
  }
  await prompt()
  await rpc.close()
  await open()
  await rpc.request('session/load', { sessionId, cwd, mcpServers: [] })
  await prompt()
  assert.equal(requests, 2)
  await rpc.close()
  const localCodexHome = join(directory, 'local-codex')
  await mkdir(localCodexHome, { mode: 0o700 })
  await writeFile(
    join(localCodexHome, 'config.toml'),
    `model = "gpt-5.4-mini"\nmodel_provider = "wrong_default"\n[model_providers.wrong_default]\nname = "Wrong default"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n[model_providers.m11_fixture]\nname = "M11 fixture"\nbase_url = "http://127.0.0.1:${server.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
    { mode: 0o600 }
  )
  const launcher = Object.fromEntries(
    Object.entries({
      INSTALLATION: installation,
      NODE: nodeExecutable,
      CWD: cwd,
      HOME: localCodexHome,
      PROVIDER: 'm11_fixture',
      MODEL: 'gpt-5.4',
      MODEL_ALIAS: 'reasoning.standard',
      MODEL_CAPABILITIES: 'tool_calling,structured_output',
      PROVIDER_CLASS: 'managed',
      DATA_RESIDENCY: 'us',
    }).map(([key, value]) => [`CONTROL_PLANE_CODEX_ACP_${key}`, value])
  )
  const runtimeOptions = resolveLocalRuntimeOptions({
    ...launcher,
    CONTROL_PLANE_LOCAL_RUNTIME: 'codex-acp',
  })
  local = new LocalControlPlaneComposition({
    dataDirectory: join(directory, 'local'),
    workflowEndpointPort: 19083,
    runtimeFactory(repositories) {
      const runtime = runtimeOptions.runtimeFactory(repositories)
      const cleanup = runtime.cleanup.bind(runtime)
      runtime.cleanup = async (handle) => {
        try {
          if (requests === 4) {
            try {
              await until(() => cancellationStreamClosed, 'native-stream-close-before-cleanup')
            } catch (error) {
              console.error(
                JSON.stringify({ cancellationStreamClosed, cancellationRequestAborted })
              )
              throw error
            }
            cancellationCleanupVerified = true
          }
        } finally {
          await cleanup(handle)
        }
      }
      return runtime
    },
  })
  const fixtureOptions = {
    profileCapabilityRequirements: ['stream.output'],
    skillRequiredCapabilities: [],
  }
  const inputs = createExecutionPlanTestFixtureInputs(fixtureOptions)
  const plan = createExecutionPlanTestFixture(fixtureOptions)
  await local.start()
  await local.catalog.insertAgentProfileVersion(inputs.profile)
  for (const skill of inputs.skills) await local.catalog.insertSkillVersion(skill)
  await local.contextPackages.put(inputs.contextPackage)
  await local.executionPlans.put(plan)
  const authentication = await createPrivateApiAuthentication(join(directory, 'api-auth'))
  const metadata = {
    serviceName: 'control-api',
    version: 'native-certification',
    commitSha: 'native-certification',
    environment: 'test',
    instanceId: 'installed-acp',
  }
  application = await createControlApiApplication({
    metadata,
    logger: { write: () => undefined },
    health: () => ({ status: 'ok', metadata }),
    readiness: () => ({ status: 'ready', metadata }),
    serviceAuthenticator: authentication.authenticator,
    executionAcceptanceService: local.executionAcceptanceService,
    executionCancellationService: local.executionCancellationService,
    interactionCommandService: local.interactionCommandService,
  })
  await application.listen(0, '127.0.0.1')
  let loseCancellationAck = true
  let loseApprovalAck = true
  const sdk = new ControlPlaneClient({
    baseUrl: `http://127.0.0.1:${application.getHttpServer().address().port}`,
    credential: (await readFile(authentication.credentialFile, 'utf8')).trim(),
    fetch: async (url, init) => {
      const response = await fetch(url, init)
      if (new URL(url).pathname === '/v1/interactions/respond' && response.ok && loseApprovalAck) {
        loseApprovalAck = false
        await response.arrayBuffer()
        throw new Error('ACP_CERTIFICATION_LOST_APPROVAL_ACK')
      }
      if (new URL(url).pathname === '/v1/executions/cancel' && response.ok && loseCancellationAck) {
        loseCancellationAck = false
        await response.arrayBuffer()
        throw new Error('ACP_CERTIFICATION_LOST_CANCEL_ACK')
      }
      return response
    },
  })
  const base = ControlApiFixtures.executionAcceptance.request
  const acceptance = {
    ...base,
    issuedAt: new Date().toISOString(),
    payload: {
      ...base.payload,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
      retentionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    },
  }
  const accepted = await sdk.acceptExecution(acceptance)
  const deadline = Date.now() + 20000
  let execution
  do {
    execution = await local.executions.getExecution(accepted.data.executionId)
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state)) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  } while (Date.now() < deadline)
  assert.equal(execution.state, 'completed')
  assert.equal((await local.executions.listAttempts(execution.executionId)).length, 1)
  const result = await local.objectStore.get(
    `executions/${execution.executionId}/attempts/${execution.latestAttemptId}/result.json`
  )
  assert.equal(JSON.parse(new TextDecoder().decode(result.body)).usage.inputTokens, 11)
  assert.equal(JSON.parse(new TextDecoder().decode(result.body)).usage.outputTokens, 3)
  const attached = await fetch(
    `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${execution.executionId}/attach`,
    { signal: AbortSignal.timeout(10000) }
  )
  assert.equal(attached.ok, true)
  assert.equal((await attached.json()).status, 'completed')
  assert.equal(requests, 3)
  const cancellationIssuedAt = Date.now()
  const cancelled = await sdk.acceptExecution({
    ...acceptance,
    commandId: 'cmd_01JABCDEF0123456789ABCDEFH',
    idempotencyKey: 'installed-acp-cancel-execution',
    issuedAt: new Date(cancellationIssuedAt).toISOString(),
    payload: {
      ...acceptance.payload,
      deadlineAt: new Date(cancellationIssuedAt + 60000).toISOString(),
      retentionExpiresAt: new Date(cancellationIssuedAt + 30 * 86400000).toISOString(),
    },
  })
  await until(() => requests === 4, 'native-cancellation-request')
  const cancellation = {
    ...base,
    commandId: 'cmd_01JABCDEF0123456789ABCDEFJ',
    operation: 'execution.cancel',
    issuedAt: new Date().toISOString(),
    payload: { executionId: cancelled.data.executionId },
  }
  await assert.rejects(sdk.cancelExecution(cancellation), /ACP_CERTIFICATION_LOST_CANCEL_ACK/)
  const replay = await sdk.cancelExecution({
    ...cancellation,
    commandId: 'cmd_01JABCDEF0123456789ABCDEFK',
  })
  assert.equal(replay.data.commandId, cancellation.commandId)
  assert.equal(replay.data.replayed, true)
  const cancelledAttachment = await fetch(
    `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${cancelled.data.executionId}/attach`,
    { signal: AbortSignal.timeout(30000) }
  )
  assert.equal(cancelledAttachment.ok, true)
  assert.equal((await cancelledAttachment.json()).status, 'cancelled')
  const cancelledExecution = await local.executions.getExecution(cancelled.data.executionId)
  assert.equal(cancelledExecution.state, 'cancelled')
  assert.equal(cancelledExecution.terminalResultRef, undefined)
  assert.equal((await local.executions.listAttempts(cancelled.data.executionId)).length, 1)
  assert.equal(cancellationStreamClosed, true)
  assert.equal(cancellationCleanupVerified, true)
  assert.equal(requests, 4)
  const approvalIssuedAt = Date.now()
  const approval = await sdk.acceptExecution({
    ...acceptance,
    commandId: 'cmd_01JABCDEF0123456789ABCDEFA',
    idempotencyKey: 'installed-acp-approval-execution',
    issuedAt: new Date(approvalIssuedAt).toISOString(),
    payload: {
      ...acceptance.payload,
      deadlineAt: new Date(approvalIssuedAt + 60000).toISOString(),
      retentionExpiresAt: new Date(approvalIssuedAt + 30 * 86400000).toISOString(),
    },
  })
  const approvedInteractions = new Set()
  for (let index = 0; index < 2; index++) {
    let pending
    await until(
      async () => {
        const current = await local.executions.getExecution(approval.data.executionId)
        if (!current.latestAttemptId) return false
        pending = (
          await local.interactions.listForAttempt(current.executionId, current.latestAttemptId)
        ).find(
          (entry) => entry.state === 'pending' && !approvedInteractions.has(entry.interactionId)
        )
        return pending !== undefined
      },
      `native-approval-${index + 1}`
    )
    assert.equal(pending.kind, 'permission')
    const marker = await readFile(approvalMarker, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    assert.equal(marker, 'approved\n'.repeat(index), 'NATIVE_ACTION_PRECEDED_APPROVAL')
    const responseCommand = {
      ...ControlApiFixtures.interactionResponse.request,
      commandId: `cmd_01JABCDEF0123456789ABCDE${index === 0 ? 'FB' : 'FC'}`,
      idempotencyKey: `installed-acp-approval-${index}`,
      workspaceId: acceptance.workspaceId,
      projectId: acceptance.projectId,
      issuedAt: new Date().toISOString(),
      payload: {
        executionId: approval.data.executionId,
        attemptId: pending.attemptId,
        interactionId: pending.interactionId,
        expectedVersion: pending.version,
        action: 'grant',
      },
    }
    if (index === 0) {
      await assert.rejects(
        sdk.respondToInteraction(responseCommand),
        /ACP_CERTIFICATION_LOST_APPROVAL_ACK/
      )
    }
    const response = await sdk.respondToInteraction(responseCommand)
    assert.equal(response.data.status, 'accepted')
    if (index === 0) assert.equal(response.data.replayed, true)
    approvedInteractions.add(pending.interactionId)
  }
  let approvedExecution
  await until(async () => {
    approvedExecution = await local.executions.getExecution(approval.data.executionId)
    return ['completed', 'failed', 'cancelled', 'timed_out'].includes(approvedExecution.state)
  }, 'approved-execution-completion')
  assert.equal(approvedExecution.state, 'completed')
  const approvedAttachment = await fetch(
    `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${approval.data.executionId}/attach`,
    { signal: AbortSignal.timeout(10000) }
  )
  assert.equal(approvedAttachment.ok, true)
  assert.equal((await approvedAttachment.json()).status, 'completed')
  assert.equal(await readFile(approvalMarker, 'utf8'), 'approved\napproved\n')
  assert.equal((await local.executions.listAttempts(approval.data.executionId)).length, 1)
  const approvedResult = await local.objectStore.get(
    `executions/${approval.data.executionId}/attempts/${approvedExecution.latestAttemptId}/result.json`
  )
  const approvalUsage = JSON.parse(new TextDecoder().decode(approvedResult.body)).usage
  assert.equal(approvalUsage.inputTokens, 33)
  assert.equal(approvalUsage.outputTokens, 9)
  assert.equal(requests, 7)
  console.log(
    JSON.stringify(
      {
        suite: 'm11-installed-acp',
        bundleSha256: pinnedAcpBuild.bundleSha256,
        nativeSha256: manifest.nativeBuild.executableSha256,
        nodeVersion,
        requests,
        approvalUsage,
        freshPromptUsage: { inputTokens: 11, outputTokens: 3 },
        restartedPromptUsage: { inputTokens: 11, outputTokens: 3 },
        localLauncher:
          'codex-acp; authenticated HTTP API; SQLite; real Restate; completion, cancellation and two approvals; one attempt each',
        approval: 'two gated marker writes; lost ACK replayed; aggregate usage verified',
        cancellation: 'lost ACK replayed; native model stream closed before runtime cleanup',
        scope:
          'native loaded-session accounting and Local HTTP completion/cancellation/approval; not in-flight recovery or full milestone certification',
      },
      null,
      2
    )
  )
} finally {
  try {
    try {
      try {
        await application?.close()
      } finally {
        await local?.close()
      }
    } finally {
      await rpc?.close()
    }
  } finally {
    clearInterval(streamHeartbeat)
    server?.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}
