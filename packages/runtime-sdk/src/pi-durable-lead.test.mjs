import { test, expect } from 'bun:test'
import { PublicContractManifest } from '@control-plane/contracts'
import {
  PiDurableLeadPrepareRequestSchema,
  PiDurableLeadPrepareResponseSchema,
  PiDurableLeadDispatchRequestSchema,
  PiDurableLeadLookupRequestSchema,
  PiDurableLeadLookupResponseSchema,
  PiDurableLeadHttpContract,
} from './pi-durable-lead.ts'

const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCDEFG`
const at = '2026-10-08T09:00:00.000Z'
const intentId = 'f643a115-617d-4bae-8d52-cfe458c0b8ac'
const preparationRef = `prep_${'b'.repeat(32)}`
const request = {
  caller: { servicePrincipalId: 'svc_prepare-test' },
  contractVersion: PublicContractManifest.current,
  requestId: id('req'),
  commandId: id('cmd'),
  workspaceId: id('wsp'),
  correlation: { traceId: id('trc') },
  operation: 'pi-durable.lead.prepare',
  payload: { intentId },
  issuedAt: at,
  idempotencyKey: 'prepare:test:one',
  payloadHash: 'a'.repeat(64),
}
const funding = {
  schemaVersion: 'model-funding-display/v1',
  state: 'ready',
  workspaceId: id('wsp'),
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
    evidenceRef: 'evidence:test',
  },
  authorizationRef: 'spend:test',
  authorityRevision: 1,
  expiresAt: at,
}
const response = {
  contractVersion: request.contractVersion,
  requestId: request.requestId,
  correlation: request.correlation,
  data: {
    schemaVersion: 'pi-lead-preparation/v1',
    preparationRef,
    intentId,
    executionId: funding.executionId,
    attemptId: funding.attemptId,
    selectionRef: funding.selectionRef,
    selectionRevision: funding.selectionRevision,
    funding,
    expiresAt: at,
    replayed: false,
  },
}

test('preparation exposes ready disclosure without runtime identity or caller grants', () => {
  expect(PiDurableLeadPrepareRequestSchema.parse(request)).toEqual(request)
  expect(PiDurableLeadPrepareResponseSchema.parse(response)).toEqual(response)
  expect(PiDurableLeadHttpContract.prepare.scope).toBe('execution:accept')
  for (const extra of [
    { credential: 'canary' },
    { funding },
    { authorizationRef: 'spend:test' },
    { handle: {} },
    { runtimeSessionId: id('ses') },
  ]) {
    expect(
      PiDurableLeadPrepareRequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, ...extra },
      }).success
    ).toBe(false)
  }
})

test('preparation binds every funding reference and cannot outlive ready evidence', () => {
  for (const [key, value] of [
    ['executionId', id('exe').replace(/G$/, 'H')],
    ['attemptId', id('att').replace(/G$/, 'H')],
    ['selectionRef', `msel_${'d'.repeat(32)}`],
    ['selectionRevision', 2],
  ]) {
    expect(
      PiDurableLeadPrepareResponseSchema.safeParse({
        ...response,
        data: { ...response.data, funding: { ...funding, [key]: value } },
      }).success
    ).toBe(false)
  }
  for (const change of [
    { expiresAt: '2026-10-09T09:00:00.000Z' },
    { runtimeSessionId: id('ses') },
    { preparationRef: 'lease:canary' },
  ]) {
    expect(
      PiDurableLeadPrepareResponseSchema.safeParse({
        ...response,
        data: { ...response.data, ...change },
      }).success
    ).toBe(false)
  }
  expect(
    PiDurableLeadPrepareResponseSchema.safeParse({
      ...response,
      data: { ...response.data, funding: { ...funding, credential: 'canary' } },
    }).success
  ).toBe(false)
})

test('dispatch preserves raw admission and accepts an optional bounded preparation reference', () => {
  const dispatch = { ...request, operation: 'pi-durable.lead.dispatch' }
  expect(PiDurableLeadDispatchRequestSchema.parse(dispatch).payload).toEqual({ intentId })
  expect(
    PiDurableLeadDispatchRequestSchema.parse({ ...dispatch, payload: { intentId, preparationRef } })
      .payload
  ).toEqual({ intentId, preparationRef })
  expect(
    PiDurableLeadDispatchRequestSchema.safeParse({
      ...dispatch,
      payload: { intentId, preparationRef: 'invalid' },
    }).success
  ).toBe(false)
})

test('lookup is a strict read by intent and returns nullable stored receipt metadata', () => {
  const lookupRequest = {
    caller: request.caller,
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    correlation: request.correlation,
    requestedAt: at,
    operation: 'pi-durable.lead.lookup',
    parameters: { intentId },
  }
  expect(PiDurableLeadLookupRequestSchema.parse(lookupRequest)).toEqual(lookupRequest)
  expect(PiDurableLeadHttpContract.lookup.scope).toBe('execution:read')
  const lookupResponse = {
    ...response,
    data: {
      schemaVersion: 'pi-lead-lookup/v1',
      workspaceId: request.workspaceId,
      intentId,
      receipt: null,
    },
  }
  expect(PiDurableLeadLookupResponseSchema.parse(lookupResponse)).toEqual(lookupResponse)
  const receipt = {
    dispatchId: `dispatch_${'a'.repeat(32)}`,
    executionId: funding.executionId,
    attemptId: funding.attemptId,
    state: 'reconciliation_required',
  }
  expect(
    PiDurableLeadLookupResponseSchema.parse({
      ...lookupResponse,
      data: { ...lookupResponse.data, receipt },
    }).data.receipt
  ).toEqual(receipt)
  for (const parameters of [
    { intentId, grant: 'canary' },
    { intentId, preparationRef },
  ]) {
    expect(
      PiDurableLeadLookupRequestSchema.safeParse({ ...lookupRequest, parameters }).success
    ).toBe(false)
  }
  for (const invalid of [
    undefined,
    {},
    { ...receipt, state: 'running' },
    { ...receipt, credential: 'canary' },
  ]) {
    expect(
      PiDurableLeadLookupResponseSchema.safeParse({
        ...lookupResponse,
        data: { ...lookupResponse.data, receipt: invalid },
      }).success
    ).toBe(false)
  }
})
