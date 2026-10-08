import { test, expect } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { canonicalJsonStringify, PublicContractManifest } from '@control-plane/contracts'
import { ControlPlaneClient, ControlPlaneClientError, ControlApiOperations } from './index.ts'
import {
  createControlApiOpenApiDocument,
  findBreakingContractChanges,
} from '../scripts/openapi.mjs'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T09:00:00.000Z'
const dispatchId = `dispatch_${'a'.repeat(32)}`
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const identity = {
  caller: { servicePrincipalId: 'svc_agent-hq' },
  contractVersion: PublicContractManifest.current,
  requestId: id('req'),
  workspaceId: id('wsp'),
  correlation: { traceId: id('trc') },
}
const command = (operation, payload) => ({
  ...identity,
  operation,
  commandId: id('cmd'),
  issuedAt: at,
  idempotencyKey: 'pi-sdk-dispatch:one',
  payloadHash: createHash('sha256').update(canonicalJsonStringify(payload)).digest('hex'),
  payload,
})
const read = (operation, parameters) => ({ ...identity, operation, requestedAt: at, parameters })
const requests = {
  dispatchPiDurableLead: command('pi-durable.lead.dispatch', { intentId }),
  getPiDurableLeadStatus: read('pi-durable.lead.status', { dispatchId }),
  getPiDurableLeadProgress: read('pi-durable.lead.progress', { dispatchId, afterSequence: 1 }),
  cancelPiDurableLead: command('pi-durable.lead.cancel', { dispatchId }),
}
const receipt = {
  schemaVersion: 'pi-lead-dispatch/v1',
  dispatchId,
  intentId,
  executionId: id('exe'),
  attemptId: id('att'),
  runtimeSessionId: id('ses'),
}
const handle = {
  handleId: 'pi:opaque-handle',
  attemptId: id('att'),
  externalSessionId: id('ses'),
  startedAt: at,
}
const status = { handle, state: 'cancelled', observedAt: at }
const responses = {
  dispatchPiDurableLead: { ...receipt, state: 'running', replayed: false },
  getPiDurableLeadStatus: { ...receipt, state: 'cancelled', status },
  getPiDurableLeadProgress: {
    ...receipt,
    events: [
      {
        handleId: handle.handleId,
        sequence: 2,
        occurredAt: at,
        type: 'status',
        data: { state: 'cancelled' },
      },
    ],
    nextSequence: 2,
  },
  cancelPiDurableLead: { ...receipt, state: 'cancelled', status },
}
const response = (data) => ({
  contractVersion: identity.contractVersion,
  requestId: identity.requestId,
  correlation: identity.correlation,
  data,
})

test('four Pi Durable methods send exact authenticated v3 routes and parse public response schemas', async () => {
  const calls = []
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'test-service-credential',
    fetch: async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, init, body })
      const method = Object.keys(requests).find(
        (name) => requests[name].operation === body.operation
      )
      return Response.json(response(responses[method]), {
        status: method === 'dispatchPiDurableLead' || method === 'cancelPiDurableLead' ? 202 : 200,
      })
    },
  })
  for (const [method, request] of Object.entries(requests)) {
    expect((await client[method](request)).data).toEqual(responses[method])
    expect(ControlApiOperations[method].operation).toBe(request.operation)
  }
  expect(calls.map((call) => new URL(call.url).pathname)).toEqual(
    ['dispatch', 'status', 'progress', 'cancel'].map(
      (route) => `/v3/pi-durable/lead-dispatches/${route}`
    )
  )
  for (const call of calls) {
    expect(call.init.method).toBe('POST')
    expect(call.init.headers.authorization).toBe('Bearer test-service-credential')
    expect(call.init.headers['x-request-id']).toBe(identity.requestId)
    expect(call.init.headers['x-correlation-id']).toBe(identity.correlation.traceId)
    expect(call.init.redirect).toBe('error')
  }
})

test('strict opaque-reference requests reject caller prompt, credentials, native state and unsafe cursors before fetch', async () => {
  let calls = 0
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'test-service-credential',
    fetch: async () => {
      calls++
      throw new Error('must not send')
    },
  })
  for (const payload of [
    { intentId, prompt: 'caller prompt' },
    { intentId, credential: 'secret-canary' },
    { intentId, runtimeSessionId: id('ses') },
    { intentId: 'not-a-uuid' },
  ]) {
    await expect(
      client.dispatchPiDurableLead({ ...requests.dispatchPiDurableLead, payload })
    ).rejects.toThrow()
  }
  await expect(
    client.getPiDurableLeadStatus({
      ...requests.getPiDurableLeadStatus,
      parameters: { dispatchId, nativeState: {} },
    })
  ).rejects.toThrow()
  await expect(
    client.getPiDurableLeadProgress({
      ...requests.getPiDurableLeadProgress,
      parameters: { dispatchId, afterSequence: -1 },
    })
  ).rejects.toThrow()
  await expect(
    client.cancelPiDurableLead({
      ...requests.cancelPiDurableLead,
      payload: { dispatchId, executionId: id('exe') },
    })
  ).rejects.toThrow()
  await expect(
    client.dispatchPiDurableLead({ ...requests.dispatchPiDurableLead, credential: 'secret-canary' })
  ).rejects.toThrow()
  expect(calls).toBe(0)
})

test('invalid or secret-bearing successful responses are rejected without exposing their payload', async () => {
  const canary = 'provider-credential-canary'
  let data = { ...responses.dispatchPiDurableLead, credential: canary }
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'test-service-credential',
    fetch: async () => Response.json(response(data)),
  })
  for (const invalid of [
    data,
    { ...responses.dispatchPiDurableLead, runtimeSessionId: 'native-session' },
    { ...responses.dispatchPiDurableLead, replayed: 'yes' },
  ]) {
    data = invalid
    try {
      await client.dispatchPiDurableLead(requests.dispatchPiDurableLead)
      throw new Error('unexpected response')
    } catch (error) {
      expect(error).toBeInstanceOf(ControlPlaneClientError)
      expect(error.code).toBe('INVALID_CONTROL_PLANE_RESPONSE')
      expect(JSON.stringify(error)).not.toContain(canary)
    }
  }
})

test('Pi Durable errors preserve normalized codes while keeping provider-native diagnostic fields out of SDK errors', async () => {
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'test-service-credential',
    fetch: async () =>
      Response.json(
        {
          ...response(undefined),
          error: {
            class: 'capability_mismatch',
            code: 'PI_LEAD_PROJECT_SCOPE_REQUIRED',
            message: 'An admitted project scope is required',
            retryable: false,
            source: 'policy',
            providerNativeDiagnostic: 'private-diagnostic-canary',
          },
        },
        { status: 409 }
      ),
  })
  try {
    await client.dispatchPiDurableLead(requests.dispatchPiDurableLead)
    throw new Error('unexpected response')
  } catch (error) {
    expect(error).toBeInstanceOf(ControlPlaneClientError)
    expect(error.toJSON()).toMatchObject({
      code: 'PI_LEAD_PROJECT_SCOPE_REQUIRED',
      errorClass: 'capability_mismatch',
      status: 409,
      retryable: false,
    })
    expect(JSON.stringify(error)).not.toContain('private-diagnostic-canary')
  }
})

test('Pi Durable OpenAPI routes remain additive to the frozen v3 baseline with strict payload canaries', async () => {
  const baseline = JSON.parse(
    await readFile(
      new URL('../compatibility/control-plane.v3.baseline.json', import.meta.url),
      'utf8'
    )
  )
  const generated = createControlApiOpenApiDocument()
  expect(findBreakingContractChanges(baseline, generated)).toEqual([])
  for (const route of ['dispatch', 'status', 'progress', 'cancel']) {
    const operation = generated.paths[`/v3/pi-durable/lead-dispatches/${route}`].post
    expect(operation.operationId).toBe(`pi-durable.lead.${route}`)
    expect(operation.security).toEqual([{ serviceBearer: [] }])
    expect(Object.keys(operation.responses)).toContain(
      route === 'dispatch' || route === 'cancel' ? '202' : '200'
    )
    const schema = operation.requestBody.content['application/json'].schema
    expect(schema.additionalProperties).toBe(false)
    const body =
      schema.properties[route === 'dispatch' || route === 'cancel' ? 'payload' : 'parameters']
    expect(body.additionalProperties).toBe(false)
    expect(body.properties.credential).toBeUndefined()
    expect(body.properties.prompt).toBeUndefined()
    expect(body.properties.executionPlan).toBeUndefined()
  }
})
