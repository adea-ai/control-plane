import { test, expect } from 'bun:test'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { createPiDurableProviderResolver } from './provider.ts'

function fixture() {
  const plan = createExecutionPlanTestFixture()
  const selection = {
    selectionRef: `msel_${'a'.repeat(32)}`,
    selectionRevision: 1,
    workspaceId: plan.correlation.workspaceId,
    provider: 'openai',
    providerModel: openaiProvider().getModels()[0].id,
    location: 'remote_host',
    harness: 'pi_durable',
    harnessVersion: '1.1.0',
    providerBinding: 'pi_durable_models',
    authKind: 'api_key',
    fundingSource: 'byo_api',
    credentialRef: 'crd_01JABCDEF0123456789ABCDEFG',
    credentialRevision: 1,
  }
  const authority = {
    request: { executionPlan: plan, attemptBudget: { workspaceId: plan.correlation.workspaceId } },
    admission: { selection: { selectionRef: selection.selectionRef, selectionRevision: 1 } },
  }
  let ready = true,
    entered = false,
    leaseAuthority
  const service = {
    resolveSelection: async () => structuredClone(selection),
    assertReady: async () => {
      if (!ready) throw new Error('CONNECTION_REVOKED')
    },
    withCredential: async (_snapshot, leaseScope, operation) => {
      entered = true
      leaseAuthority = leaseScope
      try {
        return await operation('provider-secret-canary')
      } finally {
        entered = false
      }
    },
  }
  return {
    selection,
    authority,
    service,
    revoke: () => {
      ready = false
    },
    entered: () => entered,
    leaseAuthority: () => leaseAuthority,
  }
}

test('Models are recreated within the vault callback and cannot retain auth after disposal', async () => {
  const f = fixture()
  const resolve = createPiDurableProviderResolver({
    selectionService: f.service,
    leasePrincipalRef: 'service:model',
  })
  const access = await resolve(f.authority.admission.selection, f.authority)
  expect(JSON.stringify(access)).not.toContain('provider-secret-canary')
  let retained
  const answer = await access.withModels(async (models) => {
    retained = models
    expect(f.entered()).toBe(true)
    expect(models.getProviders()).toHaveLength(1)
    expect(models.getProvider('openai').auth.oauth).toBeUndefined()
    const auth = await models.getAuth('openai')
    expect(auth.auth.apiKey).toBe('provider-secret-canary')
    return { model: models.getModel('openai', f.selection.providerModel).id }
  })
  expect(answer).toEqual({ model: f.selection.providerModel })
  expect(retained.getProviders()).toHaveLength(0)
  expect(await retained.getAuth('openai')).toBeUndefined()
  expect(f.leaseAuthority().principalRef).toBe('service:model')
  expect(f.leaseAuthority().policySnapshot).toEqual(
    f.authority.request.executionPlan.constraints.policySnapshot
  )
  let another
  await access.withModels(async (models) => {
    another = models
    return { ok: true }
  })
  expect(another).not.toBe(retained)
})

test('revocation, full pinned credential revision change and unsupported auth/provider fail without fallback', async () => {
  const f = fixture()
  const resolve = createPiDurableProviderResolver({
    selectionService: f.service,
    leasePrincipalRef: 'service:model',
  })
  const access = await resolve(f.authority.admission.selection, f.authority)
  f.selection.credentialRevision++
  await expect(access.withModels(async () => ({ ok: true }))).rejects.toThrow(
    'PI_PROVIDER_BINDING_CHANGED'
  )
  f.selection.credentialRevision--
  f.revoke()
  await expect(access.withModels(async () => ({ ok: true }))).rejects.toThrow('CONNECTION_REVOKED')
  const g = fixture()
  g.selection.authKind = 'provider_subscription'
  await expect(
    createPiDurableProviderResolver({
      selectionService: g.service,
      leasePrincipalRef: 'service:model',
    })(g.authority.admission.selection, g.authority)
  ).rejects.toThrow('PI_PROVIDER_BINDING_UNSUPPORTED')
  g.selection.authKind = 'api_key'
  g.selection.provider = 'anthropic'
  await expect(
    createPiDurableProviderResolver({
      selectionService: g.service,
      leasePrincipalRef: 'service:model',
    })(g.authority.admission.selection, g.authority)
  ).rejects.toThrow('PI_PROVIDER_BINDING_UNSUPPORTED')
})
