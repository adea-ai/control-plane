import { expect, test } from 'bun:test'
import { CredentialApiFixtures } from './control-api.ts'
import { ReadRequestEnvelopeSchema } from './envelopes.ts'
import {
  ModelSelectionFundingRequestSchema,
  ModelSelectionFundingViewSchema,
} from './model-funding.ts'

const parameters = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  selectionRef: `msel_${'2'.repeat(32)}`,
  selectionRevision: 1,
}
const request = {
  ...CredentialApiFixtures.get.request,
  caller: { servicePrincipalId: 'svc_transport' },
  operation: 'model-selection.funding.get',
  parameters,
}
test('funding contract requires workspace/caller and exact accepted execution/selection references within the existing envelope', () => {
  expect(ModelSelectionFundingRequestSchema.safeParse(request).success).toBe(true)
  expect(ReadRequestEnvelopeSchema.safeParse(request).success).toBe(true)
  for (const field of Object.keys(parameters)) {
    const missing = structuredClone(request)
    delete missing.parameters[field]
    expect(ModelSelectionFundingRequestSchema.safeParse(missing).success).toBe(false)
  }
  expect(
    ModelSelectionFundingRequestSchema.safeParse({ ...request, caller: undefined }).success
  ).toBe(false)
  expect(
    ModelSelectionFundingRequestSchema.safeParse({
      ...request,
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    }).success
  ).toBe(false)
  expect(
    ModelSelectionFundingRequestSchema.safeParse({
      ...request,
      parameters: { ...parameters, actorPrincipalId: 'actor:untrusted' },
    }).success
  ).toBe(false)
})
test('blocked funding view carries only binding and a bounded denial, never payer fallback metadata', () => {
  const blocked = {
    schemaVersion: 'model-funding-display/v1',
    workspaceId: request.workspaceId,
    ...parameters,
    state: 'blocked',
    reasonCode: 'READINESS_UNAVAILABLE',
  }
  expect(ModelSelectionFundingViewSchema.safeParse(blocked).success).toBe(true)
  for (const patch of [
    { reasonCode: 'READY' },
    { reasonCode: 'private provider error' },
    { fundingOwner: { ownerRef: 'admin:inferred' } },
    { secret: 'private-canary' },
  ]) {
    expect(ModelSelectionFundingViewSchema.safeParse({ ...blocked, ...patch }).success).toBe(false)
  }
})
