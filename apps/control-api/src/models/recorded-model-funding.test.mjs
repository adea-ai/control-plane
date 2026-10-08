import { expect, test } from 'bun:test'
import { createRecordedModelFundingViewResolver } from './recorded-model-funding.ts'

const reader = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  selectionRef: `msel_${'2'.repeat(32)}`,
  selectionRevision: 1,
  principalId: 'svc_transport',
}
const binding = {
  schemaVersion: 'execution-model-selection/v1',
  ...reader,
  principalRef: 'svc_admission',
  canonicalActorPrincipalId: 'actor:original-sender',
  leasePrincipalRef: 'svc_lease',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
  executionPlanDigest: `sha256:${'a'.repeat(64)}`,
  executionPlanSchemaVersion: 2,
  policySnapshotDigest: `sha256:${'b'.repeat(64)}`,
  authorityRevision: 1,
  modelAlias: 'reasoning.standard',
}
delete binding.principalId
const selection = {
  schemaVersion: 'model-selection/v1',
  selectionRef: reader.selectionRef,
  selectionRevision: 1,
  workspaceId: reader.workspaceId,
  connectionRef: `mconn_${'1'.repeat(32)}`,
  connectionRevision: 1,
  credentialRef: 'crd_01JABCDEF0123456789ABCDEFG',
  credentialRevision: 1,
  provider: 'openai',
  providerModel: 'fixture',
  accountRef: 'account:one',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
  workspaceGrant: { grantRef: 'grant:one', revision: 1 },
  configurationRevision: 1,
}
test('recorded funding composition derives binding from authenticated accepted records and preserves separate actor roles', async () => {
  let accepted = binding
  let current = true
  let spendingReads = 0
  let selectionReads = 0
  const resolver = createRecordedModelFundingViewResolver({
    executionAuthority: {
      resolveForReader: async (input) => {
        expect(input).toEqual(reader)
        return accepted
      },
      assertCurrent: async (pin) => {
        expect(pin.canonicalActorPrincipalId).toBe('actor:original-sender')
        expect(pin.principalRef).toBe('svc_admission')
        expect(pin.leasePrincipalRef).toBe('svc_lease')
        if (!current) throw new Error('private-canary')
      },
    },
    selections: {
      resolveSelection: async () => {
        selectionReads++
        return selection
      },
      assertReady: async () => {},
      withCredential: async () => {
        throw new Error('no lease permitted')
      },
    },
    fundingAuthority: {
      readCurrent: async () => {
        spendingReads++
        return undefined
      },
    },
  })
  const unavailable = await resolver.resolve(reader)
  const { principalId: _principalId, ...publicBinding } = reader
  expect(unavailable).toMatchObject({
    state: 'blocked',
    reasonCode: 'READINESS_UNAVAILABLE',
    ...publicBinding,
  })
  expect(spendingReads).toBe(1)
  accepted = { ...binding, attemptId: 'att_01JABCDEF0123456789ABCDEFH' }
  await expect(resolver.resolve(reader)).rejects.toThrow('SELECTION_CHANGED')
  expect(spendingReads).toBe(1)
  accepted = undefined
  await expect(resolver.resolve(reader)).rejects.toThrow('PROVIDER_POLICY_DENIED')
  accepted = binding
  current = false
  expect((await resolver.resolve(reader)).reasonCode).toBe('PROVIDER_POLICY_DENIED')
  expect(selectionReads).toBe(1)
  expect(spendingReads).toBe(1)
})
