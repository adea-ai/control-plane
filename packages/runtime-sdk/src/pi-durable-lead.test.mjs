import { test, expect } from 'bun:test'
import { PublicContractManifest } from '@control-plane/contracts'
import {
  PiDurableLeadPrepareRequestSchema,
  PiDurableLeadPrepareResponseSchema,
  PiDurableLeadChildAllowanceSchema,
  PiDurableLeadDispatchRequestSchema,
  PiDurableLeadLookupRequestSchema,
  PiDurableLeadLookupResponseSchema,
  PiDurableLeadChildrenRequestSchema,
  PiDurableLeadChildrenResponseSchema,
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

const childBinding = {
  schemaVersion: 'pi-lead-child-allowance/v1',
  executionPlanDigest: `sha256:${'e'.repeat(64)}`,
  profile: {
    profileId: id('prf'),
    profileVersionId: id('pfv'),
    version: 2,
    revision: 3,
  },
}
const stated = {
  ...childBinding,
  state: 'stated',
  currency: 'USD',
  maximumMicrounits: 400_000,
  maximumTokens: 40_000,
}
const notStated = { ...childBinding, state: 'not_stated' }

test('preparation may disclose a stated child allowance, none stated, or predate the disclosure', () => {
  for (const childAllowance of [stated, notStated]) {
    const withAllowance = { ...response, data: { ...response.data, childAllowance } }
    expect(PiDurableLeadPrepareResponseSchema.parse(withAllowance)).toEqual(withAllowance)
  }
  // A control plane that predates the disclosure omits the field; that parses and is not "none".
  const parsed = PiDurableLeadPrepareResponseSchema.parse(response)
  expect(parsed.data.childAllowance).toBeUndefined()
  expect('childAllowance' in parsed.data).toBe(false)
})

test('a child allowance disclosure is exact: no half statements, no extra authority', () => {
  expect(PiDurableLeadChildAllowanceSchema.safeParse(stated).success).toBe(true)
  const { maximumTokens: _t, ...noTokens } = stated
  const { profile: _p, ...noProfile } = notStated
  for (const invalid of [
    noTokens,
    noProfile,
    { ...stated, maximumMicrounits: 0 },
    { ...stated, maximumTokens: 1.5 },
    { ...stated, currency: 'EUR' },
    { ...notStated, maximumMicrounits: 1 },
    { ...notStated, currency: 'USD' },
    { ...stated, executionPlanDigest: 'sha256:short' },
    { ...stated, profile: { ...childBinding.profile, version: 0 } },
    {
      ...stated,
      profile: { ...childBinding.profile, contentDigest: childBinding.executionPlanDigest },
    },
    { ...stated, authorizationRef: 'spend:test' },
    { ...stated, state: 'unknown' },
    { ...childBinding },
  ]) {
    expect(PiDurableLeadChildAllowanceSchema.safeParse(invalid).success).toBe(false)
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

test('children read is a strict read-only contract of opaque references and bounded outcomes', () => {
  const dispatchId = `dispatch_${'a'.repeat(32)}`
  const read = {
    caller: request.caller,
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    correlation: request.correlation,
    operation: 'pi-durable.lead.children',
    requestedAt: at,
    parameters: { dispatchId },
  }
  expect(PiDurableLeadChildrenRequestSchema.safeParse(read).success).toBe(true)
  expect(PiDurableLeadHttpContract.children).toMatchObject({
    route: 'children',
    operation: 'pi-durable.lead.children',
    scope: 'execution:read',
  })
  const cursor = { acceptedAt: at, delegationId: id('dlg') }
  expect(
    PiDurableLeadChildrenRequestSchema.safeParse({
      ...read,
      parameters: { dispatchId, after: cursor, limit: 256 },
    }).success
  ).toBe(true)
  for (const parameters of [
    { dispatchId, delegationId: id('dlg') },
    { dispatchId: 'dispatch_x' },
    { intentId },
    { dispatchId, limit: 0 },
    { dispatchId, limit: 257 },
    { dispatchId, limit: 1.5 },
    { dispatchId, after: { ...cursor, extra: true } },
    { dispatchId, after: { acceptedAt: 'yesterday', delegationId: cursor.delegationId } },
  ])
    expect(PiDurableLeadChildrenRequestSchema.safeParse({ ...read, parameters }).success).toBe(
      false
    )
  const child = {
    delegationId: id('dlg'),
    childExecutionId: id('exe'),
    role: 'researcher',
    state: 'completed',
    awaitingInput: false,
    stopRequested: false,
    acceptedAt: at,
    updatedAt: at,
    revision: 2,
    outcome: { state: 'completed', resultRef: id('art'), publication: { status: 'pending' } },
  }
  const childrenResponse = {
    contractVersion: request.contractVersion,
    requestId: request.requestId,
    correlation: request.correlation,
    data: {
      schemaVersion: 'pi-lead-dispatch/v1',
      dispatchId,
      intentId,
      executionId: id('exe'),
      attemptId: id('att'),
      runtimeSessionId: id('ses'),
      children: [child],
      totalChildren: 1,
      complete: true,
    },
  }
  expect(PiDurableLeadChildrenResponseSchema.safeParse(childrenResponse).success).toBe(true)
  for (const invalid of [
    { ...child, objective: 'caller or private text' },
    { ...child, planDigest: `sha256:${'a'.repeat(64)}` },
    { ...child, state: 'unknown' },
    { ...child, outcome: { ...child.outcome, credential: 'canary' } },
    { ...child, outcome: { ...child.outcome, failureCode: 'has space or secret' } },
    { ...child, role: 'bad role' },
  ])
    expect(
      PiDurableLeadChildrenResponseSchema.safeParse({
        ...childrenResponse,
        data: { ...childrenResponse.data, children: [invalid] },
      }).success
    ).toBe(false)
  // A page holds at most 256 children; the total says how many exist, and a page is complete
  // exactly when it carries no next cursor.
  const page = (data) =>
    PiDurableLeadChildrenResponseSchema.safeParse({
      ...childrenResponse,
      data: { ...childrenResponse.data, ...data },
    }).success
  const many = (count) => Array.from({ length: count }, () => child)
  expect(page({ children: many(256), totalChildren: 256, complete: true })).toBe(true)
  expect(page({ children: many(257), totalChildren: 257, complete: true })).toBe(false)
  expect(page({ children: many(256), totalChildren: 257, complete: false, next: cursor })).toBe(
    true
  )
  expect(page({ children: many(256), totalChildren: 257, complete: false })).toBe(false)
  expect(page({ children: many(1), totalChildren: 1, complete: true, next: cursor })).toBe(false)
  expect(page({ children: many(2), totalChildren: 1, complete: true })).toBe(false)
})
