// Real native harness + Local Restate + SQLite; model responses remain deterministic fixtures.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ControlApiFixtures } from '@control-plane/contracts'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  createLocalAcpRuntime,
  LocalControlPlaneComposition,
} from '../../../apps/local-control-plane/src/index.ts'

const container = process.argv[2]
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
      interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
      requestTimeoutMs: 20000,
      turnTimeoutMs: 30000,
    }),
  workflowEndpointPort: 19083,
})
try {
  await composition.start()
  const runtime = composition.runtimeTransport
  assert.equal((await runtime.inspect()).health, 'healthy')
  const plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: ['stream.output'],
    skillRequiredCapabilities: [],
  })
  await composition.executionPlans.put(plan)
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
  const accepted = await composition.executionAcceptanceService.accept(request, 'svc_m11-acp-local')
  let execution
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    execution = await composition.executions.getExecution(accepted.data.executionId)
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(execution?.state)) break
    await delay(50)
  }
  assert.equal(execution.state, 'completed')
  const workflowResult = await fetch(
    `http://127.0.0.1:8080/restate/workflow/execution-lifecycle/${execution.executionId}/attach`,
    { signal: AbortSignal.timeout(15000) }
  )
  assert.equal(workflowResult.ok, true)
  assert.equal((await workflowResult.json()).status, 'completed')
  const replay = await composition.executionAcceptanceService.accept(request, 'svc_m11-acp-local')
  assert.equal(replay.data.executionId, execution.executionId)
  assert.equal((await composition.executions.listAttempts(execution.executionId)).length, 1)
  const stored = await composition.objectStore.get(
    `executions/${execution.executionId}/attempts/${execution.latestAttemptId}/result.json`
  )
  const result = JSON.parse(new TextDecoder().decode(stored.body))
  assert.equal(result.output.text, 'M11 isolated ACP response.')
  assert.equal(result.usage.inputTokens, 11)
  assert.equal(result.usage.outputTokens, 3)
  console.log(
    JSON.stringify({
      state: execution.state,
      persistedUsage: result.usage,
      acceptanceReplay: true,
      attempts: 1,
      realRestate: true,
      workflowCompleted: true,
    })
  )
} finally {
  await composition.close()
  composition.persistence.close()
  await rm(directory, { recursive: true, force: true })
}
