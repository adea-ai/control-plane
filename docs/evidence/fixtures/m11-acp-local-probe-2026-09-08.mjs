// Real native harness + Local process ownership + SQLite effects; workflow host is a stub.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createLocalAcpRuntime,
  LocalControlPlaneComposition,
  DirectRuntimeActivityPort,
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
  workflowRuntime: { profile: 'local', start: async () => {}, stop: async () => {} },
  endpointFactory: { create: async () => ({ run: async () => {}, shutdown: async () => {} }) },
})
try {
  await composition.start()
  const runtime = composition.runtimeTransport
  assert.equal((await runtime.inspect()).health, 'healthy')
  const activities = new DirectRuntimeActivityPort(
    composition.persistence,
    composition.objectStore,
    runtime
  )
  const input = {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    effectKey: 'local-native:dispatch',
    executionPlan: {
      schemaVersion: 1,
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      runtimeRequirements: [],
    },
  }
  const outcome = await activities.dispatch(input)
  assert.equal(outcome.outcome, 'completed')
  // A fresh activity instance must replay the SQLite outcome without another native prompt.
  assert.deepEqual(
    await new DirectRuntimeActivityPort(
      composition.persistence,
      composition.objectStore,
      runtime
    ).dispatch(input),
    outcome
  )
  const stored = await composition.objectStore.get(
    `executions/${input.executionId}/attempts/${input.attemptId}/result.json`
  )
  const result = JSON.parse(new TextDecoder().decode(stored.body))
  assert.equal(result.output.text, 'M11 isolated ACP response.')
  assert.equal(result.usage.inputTokens, 11)
  assert.equal(result.usage.outputTokens, 3)
  await activities.cleanup({
    executionId: input.executionId,
    attemptId: input.attemptId,
    effectKey: 'local-native:cleanup',
  })
  console.log(
    JSON.stringify({
      state: outcome.outcome,
      persistedUsage: result.usage,
      sqliteReplay: true,
      nativeCleanup: true,
    })
  )
} finally {
  await composition.close()
  composition.persistence.close()
  await rm(directory, { recursive: true, force: true })
}
