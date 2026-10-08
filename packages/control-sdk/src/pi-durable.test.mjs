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
const preparationRef = `prep_${'b'.repeat(32)}`
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
  preparePiDurableLead: command('pi-durable.lead.prepare', { intentId }),
  dispatchPiDurableLead: command('pi-durable.lead.dispatch', { intentId }),
  lookupPiDurableLead: read('pi-durable.lead.lookup', { intentId }),
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
  preparePiDurableLead: {
    schemaVersion: 'pi-lead-preparation/v1',
    preparationRef,
    intentId,
    executionId: id('exe'),
    attemptId: id('att'),
    selectionRef: `msel_${'c'.repeat(32)}`,
    selectionRevision: 1,
    funding: {
      schemaVersion: 'model-funding-display/v1',
      state: 'ready',
      workspaceId: identity.workspaceId,
      executionId: id('exe'),
      attemptId: id('att'),
      selectionRef: `msel_${'c'.repeat(32)}`,
      selectionRevision: 1,
      provider: 'openai',
      providerModel: 'gpt-test',
      accountRef: 'account:test',
      authKind: 'api_key',
      fundingSource: 'byo_api',
      fundingOwner: {
        ownerRef: 'payer:test',
        kind: 'provider_account',
        displayName: 'Test payer',
        revision: 1,
        evidenceRef: 'payer-evidence:test',
      },
      authorizationRef: 'spend:test',
      authorityRevision: 1,
      expiresAt: at,
    },
    expiresAt: at,
    replayed: false,
  },
  dispatchPiDurableLead: { ...receipt, state: 'running', replayed: false },
  lookupPiDurableLead: {
    schemaVersion: 'pi-lead-lookup/v1',
    workspaceId: identity.workspaceId,
    intentId,
    receipt: {
      dispatchId,
      executionId: receipt.executionId,
      attemptId: receipt.attemptId,
      state: 'dispatched',
      runtimeSessionId: receipt.runtimeSessionId,
    },
  },
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

test('Pi Durable preparation and execution methods send exact authenticated v3 routes and parse public response schemas', async () => {
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
    ['prepare', 'dispatch', 'lookup', 'status', 'progress', 'cancel'].map(
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

test('preparation discloses ready funding without accepting caller grants or runtime state', async () => {
  const calls = []
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'test-service-credential',
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body)
      calls.push(request)
      return Response.json(
        response(
          request.operation === 'pi-durable.lead.prepare'
            ? responses.preparePiDurableLead
            : responses.dispatchPiDurableLead
        )
      )
    },
  })
  const prepared = (await client.preparePiDurableLead(requests.preparePiDurableLead)).data
  expect(prepared.funding.fundingOwner.displayName).toBe('Test payer')
  expect(prepared.preparationRef).toBe(preparationRef)
  expect(prepared.runtimeSessionId).toBeUndefined()
  expect(prepared.handle).toBeUndefined()
  const payload = { intentId, preparationRef }
  await client.dispatchPiDurableLead(command('pi-durable.lead.dispatch', payload))
  expect(calls[1].payload).toEqual(payload)
  for (const invalid of [
    { intentId, funding: prepared.funding },
    { intentId, authorizationRef: 'spend:test' },
    { intentId, preparationRef },
    { intentId, runtimeSessionId: id('ses') },
  ]) {
    await expect(
      client.preparePiDurableLead({ ...requests.preparePiDurableLead, payload: invalid })
    ).rejects.toThrow()
  }
  await expect(
    client.dispatchPiDurableLead(
      command('pi-durable.lead.dispatch', { intentId, preparationRef: 'invalid' })
    )
  ).rejects.toThrow()
  expect(calls).toHaveLength(2)
})

test('preparation rejects blocked, mismatched or capability-bearing funding disclosures', async () => {
  let data
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'test-service-credential',
    fetch: async () => Response.json(response(data)),
  })
  const preparation = responses.preparePiDurableLead
  for (const invalid of [
    {
      ...preparation,
      funding: {
        schemaVersion: 'model-funding-display/v1',
        state: 'blocked',
        workspaceId: identity.workspaceId,
        executionId: id('exe'),
        attemptId: id('att'),
        selectionRef: preparation.selectionRef,
        selectionRevision: 1,
        reasonCode: 'READINESS_UNAVAILABLE',
      },
    },
    { ...preparation, funding: { ...preparation.funding, selectionRevision: 2 } },
    { ...preparation, funding: { ...preparation.funding, credential: 'secret-canary' } },
    { ...preparation, runtimeSessionId: id('ses') },
    { ...preparation, expiresAt: '2026-10-09T09:00:00.000Z' },
  ]) {
    data = invalid
    await expect(client.preparePiDurableLead(requests.preparePiDurableLead)).rejects.toMatchObject({
      code: 'INVALID_CONTROL_PLANE_RESPONSE',
    })
  }
})

test('preparation rejects otherwise valid transport responses bound to a foreign workspace or intent', async () => {
  let data
  const calls = []
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'test-service-credential',
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body))
      return Response.json(response(data))
    },
  })
  const preparation = responses.preparePiDurableLead
  for (const invalid of [
    { ...preparation, intentId: '447bcb01-7aee-4c25-9f99-a75e1c36b3bf' },
    {
      ...preparation,
      funding: { ...preparation.funding, workspaceId: id('wsp').replace(/G$/, 'H') },
    },
  ]) {
    data = invalid
    expect(
      ControlApiOperations.preparePiDurableLead.responseSchema.safeParse(response(data)).success
    ).toBe(true)
    await expect(client.preparePiDurableLead(requests.preparePiDurableLead)).rejects.toMatchObject({
      code: 'INVALID_CONTROL_PLANE_RESPONSE',
      requestId: identity.requestId,
      status: 200,
    })
  }
  expect(calls).toEqual([requests.preparePiDurableLead, requests.preparePiDurableLead])
  data = preparation
  expect((await client.preparePiDurableLead(requests.preparePiDurableLead)).data).toEqual(
    preparation
  )
})

test('lookup recovers stored metadata by intent without preparation, grants or invented sessions', async () => {
  let data = responses.lookupPiDurableLead
  const calls = []
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'test-service-credential',
    fetch: async (_url, init) => {
      calls.push(JSON.parse(init.body))
      return Response.json(response(data))
    },
  })
  expect((await client.lookupPiDurableLead(requests.lookupPiDurableLead)).data).toEqual(data)
  for (const state of ['dispatching', 'dispatched', 'reconciliation_required']) {
    const { runtimeSessionId: _session, ...stored } = data.receipt
    data = { ...data, receipt: { ...stored, state } }
    const result = (await client.lookupPiDurableLead(requests.lookupPiDurableLead)).data
    expect(result.receipt.state).toBe(state)
    expect(result.receipt.runtimeSessionId).toBeUndefined()
  }
  data = { ...data, receipt: null }
  expect((await client.lookupPiDurableLead(requests.lookupPiDurableLead)).data.receipt).toBeNull()
  for (const extra of [
    { grant: 'caller-grant' },
    { preparationRef },
    { funding: responses.preparePiDurableLead.funding },
    { runtimeSessionId: id('ses') },
    { dispatchId },
  ]) {
    await expect(
      client.lookupPiDurableLead({
        ...requests.lookupPiDurableLead,
        parameters: { intentId, ...extra },
      })
    ).rejects.toThrow()
  }
  expect(calls).toEqual(Array(5).fill(requests.lookupPiDurableLead))
})

test('lookup rejects foreign resources and malformed or capability-bearing stored receipts', async () => {
  let data
  const client = new ControlPlaneClient({
    baseUrl: 'https://control-plane.example',
    credential: 'test-service-credential',
    fetch: async () => Response.json(response(data)),
  })
  const lookup = responses.lookupPiDurableLead
  for (const foreign of [
    { ...lookup, intentId: '447bcb01-7aee-4c25-9f99-a75e1c36b3bf' },
    { ...lookup, workspaceId: identity.workspaceId.replace(/G$/, 'H') },
    { ...lookup, workspaceId: identity.workspaceId.replace(/G$/, 'H'), receipt: null },
  ]) {
    data = foreign
    expect(
      ControlApiOperations.lookupPiDurableLead.responseSchema.safeParse(response(data)).success
    ).toBe(true)
    await expect(client.lookupPiDurableLead(requests.lookupPiDurableLead)).rejects.toMatchObject({
      code: 'INVALID_CONTROL_PLANE_RESPONSE',
      requestId: identity.requestId,
    })
  }
  for (const malformed of [
    { ...lookup, receipt: undefined },
    { ...lookup, receipt: {} },
    { ...lookup, receipt: { ...lookup.receipt, state: 'running' } },
    { ...lookup, receipt: { ...lookup.receipt, runtimeSessionId: 'invented-session' } },
    { ...lookup, receipt: { ...lookup.receipt, grant: 'secret-canary' } },
    { ...lookup, funding: responses.preparePiDurableLead.funding },
  ]) {
    data = malformed
    await expect(client.lookupPiDurableLead(requests.lookupPiDurableLead)).rejects.toMatchObject({
      code: 'INVALID_CONTROL_PLANE_RESPONSE',
    })
  }
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
  for (const route of ['prepare', 'dispatch', 'lookup', 'status', 'progress', 'cancel']) {
    const operation = generated.paths[`/v3/pi-durable/lead-dispatches/${route}`].post
    expect(operation.operationId).toBe(`pi-durable.lead.${route}`)
    expect(operation.security).toEqual([{ serviceBearer: [] }])
    expect(Object.keys(operation.responses)).toContain(
      route === 'dispatch' || route === 'cancel' ? '202' : '200'
    )
    const schema = operation.requestBody.content['application/json'].schema
    expect(schema.additionalProperties).toBe(false)
    const body =
      schema.properties[
        route === 'prepare' || route === 'dispatch' || route === 'cancel' ? 'payload' : 'parameters'
      ]
    expect(body.additionalProperties).toBe(false)
    expect(body.properties.credential).toBeUndefined()
    expect(body.properties.prompt).toBeUndefined()
    expect(body.properties.executionPlan).toBeUndefined()
  }
})
