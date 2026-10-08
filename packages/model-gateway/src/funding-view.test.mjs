import { expect, test } from 'bun:test'
import { ModelSelectionFundingViewSchema } from '@control-plane/contracts'
import { resolveModelSelectionFundingView } from './funding-view.ts'
import { createExecutionBoundModelSelectionService } from './execution-selection.ts'
import { ModelSelectionError } from './selection-service.ts'
import { connection, selection } from './selection-fixtures.mjs'

const now = '2026-10-08T12:00:00.000Z'
const later = '2026-10-08T13:00:00.000Z'
const binding = {
  schemaVersion: 'execution-model-selection/v1',
  workspaceId: selection.workspaceId,
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  executionPlanId: 'pln_01JABCDEF0123456789ABCDEFG',
  executionPlanDigest: `sha256:${'a'.repeat(64)}`,
  executionPlanSchemaVersion: 2,
  policySnapshotDigest: `sha256:${'b'.repeat(64)}`,
  principalRef: 'svc_admission',
  canonicalActorPrincipalId: 'actor:product-sender',
  leasePrincipalRef: 'svc_model-lease',
  modelAlias: 'reasoning.standard',
  authorityRevision: 1,
  selectionRef: selection.selectionRef,
  selectionRevision: 1,
}
const decision = {
  schemaVersion: 'recorded-model-funding/v1',
  executionPlanId: binding.executionPlanId,
  executionPlanDigest: binding.executionPlanDigest,
  selectionRef: binding.selectionRef,
  selectionRevision: 1,
  canonicalActorPrincipalId: binding.canonicalActorPrincipalId,
  authorityRevision: 1,
  grant: {
    schemaVersion: 1,
    authorizationId: 'spending:recorded-one',
    evidenceRef: 'spending-proof:1',
    workspaceId: binding.workspaceId,
    executionId: binding.executionId,
    attemptId: binding.attemptId,
    deploymentId: 'deployment:pinned-one',
    credentialRef: selection.credentialRef,
    principalRef: binding.principalRef,
    alias: binding.modelAlias,
    policySnapshotDigest: binding.policySnapshotDigest,
    currency: 'USD',
    fundingSource: 'byo_api',
    maximumMicrounits: 1000,
    maximumTokens: 1000,
    issuedAt: now,
    expiresAt: later,
  },
  price: {
    schemaVersion: 1,
    deploymentId: 'deployment:pinned-one',
    provider: selection.provider,
    model: selection.providerModel,
    version: 'fixture:1',
    currency: 'USD',
    fundingSource: 'byo_api',
    validFrom: now,
    validUntil: '2026-10-08T12:30:00.000Z',
    maximumInputTokens: 1000,
    maximumOutputTokens: 1000,
    ratesMicrounitsPerMillionTokens: { input: 1, cachedInput: 0, output: 2 },
  },
  fundingOwner: {
    ownerRef: 'payer:explicit-record',
    kind: 'workspace_account',
    displayName: 'Fixture payer',
    revision: 1,
    evidenceRef: 'payer-proof:1',
  },
}
function fixture() {
  let record = structuredClone(decision)
  let reason
  let actorActive = true
  let onReady = () => {}
  let reads = 0
  let leases = 0
  const selections = createExecutionBoundModelSelectionService({
    binding,
    selections: {
      resolveSelection: async () => structuredClone(selection),
      assertReady: async () => {
        if (reason) throw new ModelSelectionError(reason)
        onReady()
      },
      withCredential: async () => {
        leases++
        throw new Error('must not lease')
      },
    },
    currentExecutionAuthority: {
      assertCurrent: async () => {
        if (!actorActive) throw new Error('private actor detail')
      },
    },
  })
  return {
    resolve: (patch = {}) =>
      resolveModelSelectionFundingView({
        binding,
        selections,
        fundingAuthority: {
          readCurrent: async () => {
            reads++
            return structuredClone(record)
          },
        },
        now: () => now,
        ...patch,
      }),
    record: (value) => {
      record = value
    },
    reason: (value) => {
      reason = value
    },
    actor: (value) => {
      actorActive = value
    },
    onReady: (operation) => {
      onReady = operation
    },
    reads: () => reads,
    leases: () => leases,
  }
}
test('ready funding view discloses the explicit recorded payer and exact accepted binding without leasing', async () => {
  const f = fixture()
  const result = await f.resolve()
  expect(result.state).toBe('ready')
  expect(result.fundingOwner).toEqual(decision.fundingOwner)
  expect(result.fundingOwner.ownerRef).not.toBe(connection.ownerRef)
  expect(result.fundingOwner.ownerRef).not.toBe(selection.accountRef)
  expect(result).toMatchObject({
    workspaceId: binding.workspaceId,
    executionId: binding.executionId,
    attemptId: binding.attemptId,
    selectionRef: binding.selectionRef,
    selectionRevision: 1,
    provider: selection.provider,
    accountRef: selection.accountRef,
    authKind: 'api_key',
    fundingSource: 'byo_api',
    authorizationRef: decision.grant.authorizationId,
    expiresAt: decision.price.validUntil,
  })
  expect(f.leases()).toBe(0)
  expect(f.reads()).toBe(1)
})
test('missing payer and mismatched, expired or credential-bearing records expose only a bounded blocked binding', async () => {
  const f = fixture()
  const cases = [
    undefined,
    { ...decision, fundingOwner: undefined },
    { ...decision, secret: 'private-canary' },
    { ...decision, authorityRevision: 2 },
    { ...decision, canonicalActorPrincipalId: 'actor:foreign' },
    { ...decision, executionPlanDigest: `sha256:${'c'.repeat(64)}` },
    { ...decision, selectionRevision: 2 },
    ...[
      'workspaceId',
      'executionId',
      'attemptId',
      'principalRef',
      'alias',
      'policySnapshotDigest',
      'credentialRef',
      'fundingSource',
    ].map((key) => ({
      ...decision,
      grant: { ...decision.grant, [key]: key === 'fundingSource' ? 'hq_managed' : 'foreign' },
    })),
    ...['provider', 'model', 'deploymentId', 'fundingSource'].map((key) => ({
      ...decision,
      price: { ...decision.price, [key]: key === 'fundingSource' ? 'hq_managed' : 'foreign' },
    })),
    { ...decision, grant: { ...decision.grant, expiresAt: now } },
    { ...decision, price: { ...decision.price, validUntil: now } },
  ]
  for (const record of cases) {
    f.record(record)
    const result = await f.resolve()
    expect(result.state).toBe('blocked')
    expect(Object.keys(result).toSorted()).toEqual(
      [
        'attemptId',
        'executionId',
        'reasonCode',
        'schemaVersion',
        'selectionRef',
        'selectionRevision',
        'state',
        'workspaceId',
      ].toSorted()
    )
    expect(JSON.stringify(result)).not.toContain('private-canary')
    expect(
      ModelSelectionFundingViewSchema.safeParse({ ...result, fundingOwner: decision.fundingOwner })
        .success
    ).toBe(false)
  }
  expect(f.leases()).toBe(0)
})
test('each display read rechecks account and original actor revocation; foreign execution and reader failures block', async () => {
  const f = fixture()
  expect((await f.resolve()).state).toBe('ready')
  f.reason('QUOTA_EXHAUSTED')
  expect((await f.resolve()).reasonCode).toBe('QUOTA_EXHAUSTED')
  f.reason(undefined)
  f.actor(false)
  expect((await f.resolve()).reasonCode).toBe('PROVIDER_POLICY_DENIED')
  f.actor(true)
  expect((await f.resolve({ binding: { ...binding, authorityRevision: 2 } })).reasonCode).toBe(
    'SELECTION_CHANGED'
  )
  expect(
    (
      await f.resolve({
        fundingAuthority: {
          readCurrent: async () => {
            throw new Error('private-canary')
          },
        },
      })
    ).reasonCode
  ).toBe('READINESS_UNAVAILABLE')
  expect(f.leases()).toBe(0)
})

test('display accepts exact native and revision-qualified HTTP credential references, never another revision', async () => {
  const f = fixture()
  f.record({
    ...decision,
    grant: {
      ...decision.grant,
      credentialRef: `vault://${selection.credentialRef}/${selection.credentialRevision}`,
    },
  })
  expect((await f.resolve()).state).toBe('ready')
  for (const ref of [`vault://${selection.credentialRef}/2`, 'vault://crd_foreign/1']) {
    f.record({ ...decision, grant: { ...decision.grant, credentialRef: ref } })
    expect((await f.resolve()).reasonCode).toBe('PROVIDER_POLICY_DENIED')
  }
})

test('funding expiry during the last current-read boundary cannot produce an expired ready view', async () => {
  const f = fixture()
  let at = now
  let readyChecks = 0
  f.onReady(() => {
    if (++readyChecks === 2) at = later
  })
  const result = await f.resolve({ now: () => at })
  expect(result.state).toBe('blocked')
  expect(result.reasonCode).toBe('PROVIDER_POLICY_DENIED')
  expect(f.leases()).toBe(0)
})
