// Real native harness + Local Restate + SQLite; model responses remain deterministic fixtures.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ControlApiFixtures } from '@control-plane/contracts'
import { ControlPlaneClient } from '@control-plane/sdk'
import {
  createControlApiApplication,
  createPrivateApiAuthentication,
} from '../../../apps/control-api/src/index.ts'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  createLocalAcpRuntime,
  LocalControlPlaneComposition,
} from '../../../apps/local-control-plane/src/index.ts'

const container = process.argv[2]
const cancel = process.argv[3] === 'cancel'
const permissionCount = process.argv[3] === 'repeated-permission' ? 2 : 1
const permission = process.argv[3] === 'permission' || permissionCount === 2
const interactionId = (index) => `int_01JABCDEF0123456789ABCDE${index === 1 ? 'FG' : 'FH'}`
assert.ok(process.argv[3] === undefined || cancel || permission)
assert.match(container ?? '', /^control-plane-m11-acp-local-[a-zA-Z0-9-]+$/)
const docker = process.env.M11_DOCKER_PATH ?? '/usr/local/bin/docker'
const [inspection] = JSON.parse(execFileSync(docker, ['inspect', container], { encoding: 'utf8' }))
assert.equal(inspection.Config.Labels.owner, 'control-plane-m11')
assert.deepEqual(inspection.Mounts, [])
assert.deepEqual(inspection.NetworkSettings.Networks, {})
const directory = await mkdtemp(join(tmpdir(), 'control-plane-acp-local-'))
const composition = new LocalControlPlaneComposition({
  dataDirectory: directory,
  runtimeFactory: () =>
    createLocalAcpRuntime({
      executablePath: docker,
      args: [
        'exec',
        '-i',
        '-e',
        'NO_BROWSER=1',
        ...(permission ? ['-e', 'INITIAL_AGENT_MODE=read-only'] : []),
        '-e',
        `DEFAULT_AUTH_REQUEST=${JSON.stringify({
          methodId: 'gateway',
          _meta: {
            gateway: {
              baseUrl: 'http://127.0.0.1:8787/v1',
              headers: {},
              providerName: 'isolated-fixture',
            },
          },
        })}`,
        container,
        'node',
        '/tmp/acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js',
      ],
      cwd: '/tmp',
      environment: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      externalSessionId: () => 'ses_01JABCDEF0123456789ABCDEFG',
      interactionId,
      requestTimeoutMs: 20000,
      turnTimeoutMs: 30000,
    }),
  workflowEndpointPort: Number(process.env.M11_WORKFLOW_PORT ?? 19083),
})
let application, sdk, responseCommand, cancellationCommand
const responseCommands = []
try {
  await composition.start()
  const runtime = composition.runtimeTransport
  assert.equal((await runtime.inspect()).health, 'healthy')
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: ['stream.output'],
    skillRequiredCapabilities: [],
  })
  await composition.executionPlans.put(plan)
  if (permission || cancel) {
    const authentication = await createPrivateApiAuthentication(directory)
    const credential = (await readFile(authentication.credentialFile, 'utf8')).trim()
    const metadata = {
      serviceName: 'control-api',
      version: 'probe',
      commitSha: 'probe',
      environment: 'test',
      instanceId: 'native-permission',
    }
    application = await createControlApiApplication({
      metadata,
      logger: { write: () => undefined },
      health: () => ({ status: 'ok', metadata }),
      readiness: () => ({ status: 'ready', metadata }),
      serviceAuthenticator: authentication.authenticator,
      executionAcceptanceService: composition.executionAcceptanceService,
      interactionCommandService: composition.interactionCommandService,
      executionCancellationService: composition.executionCancellationService,
    })
    await application.listen(0, '127.0.0.1')
    sdk = new ControlPlaneClient({
      baseUrl: `http://127.0.0.1:${application.getHttpServer().address().port}`,
      credential,
    })
  }
  const issuedAt = new Date().toISOString()
  const request = {
    ...ControlApiFixtures.executionAcceptance.request,
    requestId: plan.correlation.requestId,
    workspaceId: plan.correlation.workspaceId,
    projectId: plan.correlation.projectId,
    issuedAt,
    payload: {
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
      retentionExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    },
  }
  const modelState = () =>
    JSON.parse(
      execFileSync(
        docker,
        [
          'exec',
          container,
          'node',
          '-e',
          'fetch("http://127.0.0.1:8787/probe").then(r=>r.text()).then(x=>console.log(x))',
        ],
        { encoding: 'utf8' }
      ).trim()
    )
  const modelCalls = () => modelState().calls
  const baselineCalls = cancel ? modelCalls() : 0
  let cancellationStartedAt
  const accepted = sdk
    ? await sdk.acceptExecution(request)
    : await composition.executionAcceptanceService.accept(request, 'svc_m11-acp-local')
  if (permission) {
    for (let index = 1; index <= permissionCount; index++) {
      const deadline = Date.now() + 20000
      let pending
      while (Date.now() < deadline) {
        pending = await composition.interactions.get(interactionId(index))
        if (pending) break
        await delay(50)
      }
      assert.equal(pending?.state, 'pending', 'NATIVE_PERMISSION_NOT_OBSERVED')
      assert.equal(pending.kind, 'permission')
      const marker = execFileSync(
        docker,
        [
          'exec',
          container,
          'node',
          '-e',
          'const fs=require("node:fs");process.stdout.write(fs.existsSync("/tmp/m11-permission-proof")?fs.readFileSync("/tmp/m11-permission-proof","utf8"):"")',
        ],
        { encoding: 'utf8' }
      )
      assert.equal(marker, 'approved\n'.repeat(index - 1), 'NATIVE_ACTION_PRECEDED_APPROVAL')
      responseCommand = {
        ...ControlApiFixtures.interactionResponse.request,
        commandId: `cmd_01JABCDEF0123456789ABCDE${index === 1 ? 'FG' : 'FH'}`,
        idempotencyKey: `native-permission:${index}`,
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        issuedAt,
        payload: {
          executionId: accepted.data.executionId,
          attemptId: pending.attemptId,
          interactionId: pending.interactionId,
          expectedVersion: pending.version,
          action: 'grant',
        },
      }
      assert.equal((await sdk.respondToInteraction(responseCommand)).data.status, 'accepted')
      responseCommands.push(responseCommand)
    }
  }
  if (cancel) {
    // Wait for the actual model request, not just the persisted starting state.
    const pendingDeadline = Date.now() + 15000
    let calls = baselineCalls
    while (Date.now() < pendingDeadline && calls === baselineCalls) {
      calls = Number(
        execFileSync(
          docker,
          [
            'exec',
            container,
            'node',
            '-e',
            'fetch("http://127.0.0.1:8787/probe").then(r=>r.json()).then(x=>console.log(x.calls))',
          ],
          { encoding: 'utf8' }
        ).trim()
      )
      if (calls === baselineCalls) await delay(50)
    }
    assert.equal(calls, baselineCalls + 1)
    assert.equal(modelState().activeRequests, 1, 'NATIVE_MODEL_REQUEST_NOT_PENDING')
    cancellationStartedAt = Date.now()
    cancellationCommand = {
      ...request,
      operation: 'execution.cancel',
      idempotencyKey: 'native-acp-cancellation-probe',
      payload: { executionId: accepted.data.executionId },
    }
    const cancellation = await sdk.cancelExecution(cancellationCommand)
    assert.equal(cancellation.data.status, 'accepted')
    assert.equal(cancellation.data.replayed, false)
  }
  let execution
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    execution = await composition.executions.getExecution(accepted.data.executionId)
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(execution?.state)) break
    await delay(50)
  }
  assert.equal(execution.state, cancel ? 'cancelled' : 'completed')
  const workflowResult = await fetch(
    `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${execution.executionId}/attach`,
    { signal: AbortSignal.timeout(15000) }
  )
  assert.equal(workflowResult.ok, true)
  assert.equal((await workflowResult.json()).status, cancel ? 'cancelled' : 'completed')
  const cancellationElapsedMs =
    cancellationStartedAt === undefined ? undefined : Date.now() - cancellationStartedAt
  if (cancel) {
    const abortDeadline = Date.now() + 5000
    while (modelState().activeRequests !== 0 && Date.now() < abortDeadline) await delay(50)
    assert.equal(modelState().activeRequests, 0, 'NATIVE_MODEL_REQUEST_STILL_ACTIVE')
    assert.equal(modelState().abortedRequests, 1, 'NATIVE_MODEL_ABORT_NOT_OBSERVED')
  }
  const replay = sdk
    ? await sdk.acceptExecution(request)
    : await composition.executionAcceptanceService.accept(request, 'svc_m11-acp-local')
  assert.equal(replay.data.executionId, execution.executionId)
  assert.equal((await composition.executions.listAttempts(execution.executionId)).length, 1)
  let result
  if (!cancel) {
    const stored = await composition.objectStore.get(
      `executions/${execution.executionId}/attempts/${execution.latestAttemptId}/result.json`
    )
    result = JSON.parse(new TextDecoder().decode(stored.body))
    assert.equal(result.output.text, 'M11 isolated ACP response.')
    // Pinned codex-acp 1.7.0 exposes lastTokenUsage, not the sum of the
    // two model calls. Assert faithful persistence, not aggregate cost coverage.
    assert.equal(result.usage.inputTokens, 11)
    assert.equal(result.usage.outputTokens, 3)
  }
  if (permission) {
    for (const command of responseCommands)
      assert.equal((await sdk.respondToInteraction(command)).data.replayed, true)
    assert.equal(
      execFileSync(
        docker,
        [
          'exec',
          container,
          'node',
          '-e',
          'process.stdout.write(require("node:fs").readFileSync("/tmp/m11-permission-proof","utf8"))',
        ],
        { encoding: 'utf8' }
      ),
      'approved\n'.repeat(permissionCount)
    )
    assert.equal(modelCalls(), permissionCount + 1)
  }
  console.log(
    JSON.stringify({
      state: execution.state,
      ...(result === undefined ? {} : { persistedUsage: result.usage }),
      acceptanceReplay: true,
      attempts: 1,
      realRestate: true,
      workflowCompleted: true,
      ...(permission
        ? {
            nativePermission: true,
            publicSdk: true,
            markerWrites: permissionCount,
            modelCalls: permissionCount + 1,
            aggregateUsageVerified: false,
          }
        : {}),
      ...(cancellationElapsedMs === undefined ? {} : { cancellationElapsedMs }),
      ...(cancel ? { nativeModelConnectionClosed: true, publicSdk: true } : {}),
    })
  )
  if (cancel) {
    assert.equal(modelCalls(), baselineCalls + 1)
    const cancellationReplay = await sdk.cancelExecution({
      ...cancellationCommand,
      commandId: 'cmd_01JABCDEF0123456789ABCDEFH',
    })
    assert.equal(cancellationReplay.data.replayed, true)
    assert.equal(cancellationReplay.data.commandId, cancellationCommand.commandId)
    assert.equal(modelCalls(), baselineCalls + 1)
    assert.ok(cancellationElapsedMs < 5000, 'CANCELLATION_WAITED_FOR_NATIVE_PROMPT_TIMEOUT')
  }
} finally {
  await application?.close()
  await composition.close()
  composition.persistence.close()
  await rm(directory, { recursive: true, force: true })
}
