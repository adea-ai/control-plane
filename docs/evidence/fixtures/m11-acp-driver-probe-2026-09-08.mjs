// Run with Bun against a separately provisioned, network-isolated disposable container.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { AcpProcessTransport } from '../../../packages/acp-adapter/src/process-transport.ts'
import { AcpDriver } from '../../../packages/acp-adapter/src/index.ts'

const container = process.argv[2]
assert.match(container ?? '', /^control-plane-m11-acp-probe-[a-zA-Z0-9-]+$/)
const docker = process.env.M11_DOCKER_PATH ?? '/usr/local/bin/docker'
const [inspection] = JSON.parse(execFileSync(docker, ['inspect', container], { encoding: 'utf8' }))
assert.equal(inspection.Config.Labels.owner, 'control-plane-m11')
assert.deepEqual(inspection.Mounts, [])
assert.deepEqual(inspection.NetworkSettings.Networks, {})
const transport = new AcpProcessTransport({
  executablePath: docker,
  args: [
    'exec',
    '-i',
    '-e',
    'NO_BROWSER=1',
    container,
    'node',
    '/tmp/acp/node_modules/@agentclientprotocol/codex-acp/dist/index.js',
  ],
  cwd: '/tmp',
  environment: { PATH: '/usr/local/bin:/usr/bin:/bin' },
  requestTimeoutMs: 20000,
  turnTimeoutMs: 30000,
})
const driver = new AcpDriver({
  transport,
  protocolVersion: 1,
  adapterVersion: '1.0.0',
  externalSessionId: () => 'ses_01JABCDEF0123456789ABCDEFG',
  interactionId: () => 'int_01JABCDEF0123456789ABCDEFG',
})
try {
  await transport.open()
  await driver.inspect()
  await transport.request('authenticate', {
    methodId: 'gateway',
    _meta: {
      gateway: {
        baseUrl: 'http://127.0.0.1:8787/v1',
        headers: {},
        providerName: 'isolated-fixture',
      },
    },
  })
  const request = {
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    idempotencyKey: 'real:start',
    executionPlan: {
      schemaVersion: 1,
      executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
      contentDigest: `sha256:${'a'.repeat(64)}`,
      runtimeRequirements: [],
    },
  }
  const handle = await driver.start(request)
  assert.deepEqual(await driver.start(request), handle)
  let outputs = 0
  for await (const event of driver.progress(handle)) {
    if (event.type === 'output') outputs++
    assert.notEqual(event.type, 'interaction', 'UNEXPECTED_INTERACTION')
  }
  const status = await driver.status(handle)
  assert.equal(status.state, 'completed')
  assert.equal(status.result.output.text, 'M11 isolated ACP response.')
  assert.equal(status.result.usage.inputTokens, 11)
  assert.equal(status.result.usage.outputTokens, 3)
  assert.ok(outputs > 0)
  console.log(
    JSON.stringify({
      state: status.state,
      outputs,
      usage: status.result.usage,
      duplicateHandle: true,
    })
  )
} finally {
  await transport.close()
}
