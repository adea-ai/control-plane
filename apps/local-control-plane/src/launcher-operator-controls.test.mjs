import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { ControlApiFixtures, canonicalJsonStringify } from '@control-plane/contracts'
import { start } from './index.ts'

// Launcher-level proofs for the operator controls on the composed Local entrypoint. These
// run the real `start()` path, so the routes exist only if `index.ts` wires them. Each test
// uses its own disposable data directory and loopback port.

const ADMISSION_REASON = 'Launcher operator-controls proof'
// The launcher's private API admits only the agent-hq service principal.
const CALLER = { servicePrincipalId: 'svc_agent-hq' }
// Crockford base32 IDs: no I, L, O or U.
const STOP_COMMAND_ID = 'cmd_01JADMSTKP0000000000000001'
const RESUME_COMMAND_ID = 'cmd_01JADMRESM0000000000000001'
const CANCEL_COMMAND_ID = 'cmd_01JCANCTXA0000000000000001'
const UNKNOWN_EXECUTION_ID = `exe_01JKNWNEXEC${'0'.repeat(15)}`
const UNKNOWN_TOOL_CALL_ID = `tlc_01JKNWNTCA${'0'.repeat(16)}`

function createProcessAdapter() {
  const listeners = new Map()
  return {
    on(event, listener) {
      const bucket = listeners.get(event) ?? new Set()
      bucket.add(listener)
      listeners.set(event, bucket)
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener)
    },
    setExitCode() {},
  }
}

async function freeLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('LOCAL_TEST_PORT_UNAVAILABLE')
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}

async function launch(dataDirectory, instanceId) {
  const port = await freeLoopbackPort()
  const service = await start({
    apiHost: '127.0.0.1',
    environment: {
      APP_ENV: 'test',
      INSTANCE_ID: instanceId,
      LOCAL_CONTROL_PLANE_PORT: String(port),
    },
    logger: { write() {} },
    processAdapter: createProcessAdapter(),
    compositionOptions: {
      dataDirectory,
      runtimeTransport: { transportKind: 'direct-local' },
    },
  })
  const token = (await readFile(join(dataDirectory, 'auth', 'local-api.token'), 'utf8')).trim()
  return { service, baseUrl: `http://127.0.0.1:${port}`, token }
}

async function post(baseUrl, url, payload, token) {
  const response = await fetch(new URL(url, baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, body: JSON.parse(await response.text()) }
}

function payloadHash(payload) {
  return createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex')
}

/** An admission command bound to the canonical payload hash, as the control API verifies it. */
function admissionCommand(commandId, idempotencyKey, operation) {
  const payload = { reasonClass: 'incident_response', reason: ADMISSION_REASON }
  return {
    ...ControlApiFixtures.executionAcceptance.request,
    operation,
    commandId,
    idempotencyKey,
    payloadHash: payloadHash(payload),
    payload,
  }
}

function requireAccepted(response, label) {
  if (response.status !== 202)
    throw new Error(`${label} ${response.status}: ${JSON.stringify(response.body)}`)
  return response
}

test('a Local launcher admission stop survives a real relaunch, replays its receipt, and resume reopens admission', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'launcher-admission-restart-'))
  const stopKey = 'launcher-admission-stop-0001'
  let first
  let second
  try {
    first = await launch(dataDirectory, 'launcher-operator-controls-a')
    const stopped = requireAccepted(
      await post(
        first.baseUrl,
        '/v1/executions/admission-stop',
        admissionCommand(STOP_COMMAND_ID, stopKey, 'execution.admission-stop'),
        first.token
      ),
      'stop'
    )
    expect(stopped.body.data).toMatchObject({ outcome: 'applied', admission: 'stopped' })
    await first.service.shutdown('launcher-operator-controls-relaunch')
    first = undefined

    second = await launch(dataDirectory, 'launcher-operator-controls-b')
    const replayed = requireAccepted(
      await post(
        second.baseUrl,
        '/v1/executions/admission-stop',
        admissionCommand(STOP_COMMAND_ID, stopKey, 'execution.admission-stop'),
        second.token
      ),
      'replay'
    )
    expect(replayed.body.data).toMatchObject({ outcome: 'replayed', admission: 'stopped' })

    const resumed = requireAccepted(
      await post(
        second.baseUrl,
        '/v1/executions/admission-resume',
        admissionCommand(
          RESUME_COMMAND_ID,
          'launcher-admission-resume-0001',
          'execution.admission-resume'
        ),
        second.token
      ),
      'resume'
    )
    expect(resumed.body.data).toMatchObject({ outcome: 'applied', admission: 'open' })
  } finally {
    if (first) await first.service.shutdown('launcher-operator-controls-finally-a')
    if (second) await second.service.shutdown('launcher-operator-controls-finally-b')
    await rm(dataDirectory, { recursive: true, force: true })
  }
})

test('a Local launcher refuses an unknown cancel with a typed scope refusal and an unconfigured tool-effect reconcile with a typed 503', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'launcher-operator-refusals-'))
  let launched
  try {
    launched = await launch(dataDirectory, 'launcher-operator-controls-refusals')
    const base = ControlApiFixtures.executionAcceptance.request
    const cancelPayload = { executionId: UNKNOWN_EXECUTION_ID }
    const cancel = await post(
      launched.baseUrl,
      '/v1/executions/cancel',
      {
        ...base,
        executionScope: undefined,
        operation: 'execution.cancel',
        caller: CALLER,
        commandId: CANCEL_COMMAND_ID,
        idempotencyKey: 'launcher-cancel-unknown-0001',
        payloadHash: payloadHash(cancelPayload),
        payload: cancelPayload,
      },
      launched.token
    )
    // An execution outside the caller's scope is refused as a scope rejection, not as a lookup.
    expect(cancel.status).toBe(403)
    expect(cancel.body.error.code).toBe('EXECUTION_CANCELLATION_SCOPE_REJECTED')

    const reconcilePayload = {
      executionId: UNKNOWN_EXECUTION_ID,
      toolCallId: UNKNOWN_TOOL_CALL_ID,
      expectedRevision: 1,
      action: 'resume',
    }
    const reconcile = await post(
      launched.baseUrl,
      '/v1/executions/tool-effects/reconcile',
      {
        ...base,
        executionScope: undefined,
        operation: 'execution.tool-effect.reconcile',
        caller: CALLER,
        commandId: 'cmd_01JRCNTKMZ0000000000000001',
        idempotencyKey: 'launcher-reconcile-unknown-0001',
        payloadHash: payloadHash(reconcilePayload),
        payload: reconcilePayload,
      },
      launched.token
    )
    // The Local profile without a configured graph tool reports reconciliation as unavailable.
    expect(reconcile.status).toBe(503)
    expect(reconcile.body.error.code).toBe('TOOL_EFFECT_RECOVERY_NOT_CONFIGURED')
  } finally {
    if (launched) await launched.service.shutdown('launcher-operator-controls-finally')
    await rm(dataDirectory, { recursive: true, force: true })
  }
})
