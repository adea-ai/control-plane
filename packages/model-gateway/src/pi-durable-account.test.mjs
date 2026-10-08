import { expect, test } from 'bun:test'
import { CurrentModelAccountAuthorization } from './current-authority.ts'
import { createPiDurableAccountAuthority } from './pi-durable-account.ts'
import { connection } from './selection-fixtures.mjs'

const at = '2026-10-08T12:00:00.000Z'
const target = {
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
  location: 'remote_host',
}
function fixture() {
  let reads = 0
  let evidence = {
    schemaVersion: 'model-account-authority/v1',
    evidenceRef: 'account:current',
    observedAt: at,
    expiresAt: '2026-10-08T13:00:00.000Z',
    workspaceId: connection.workspaceId,
    credentialRef: connection.credentialRef,
    credentialRevision: 1,
    provider: connection.provider,
    accountRef: connection.accountRef,
    authKind: connection.authKind,
    fundingSource: connection.fundingSource,
    models: ['gpt-5', 'not-in-pi'],
    workspaceGrant: connection.workspaceGrant,
    allowedPrincipalRefs: [connection.ownerRef],
    targets: [target],
    entitlement: 'allowed',
    quota: 'available',
    residencyAllowed: true,
  }
  let models = [{ id: 'gpt-5', provider: 'openai', api: 'openai-responses' }]
  const registry = {
    piAiVersion: '1.1.0',
    piDurableVersion: '1.1.0',
    sourceRevision: '1cedd32724abfcb0915f76cc61b6827e2c16dbad',
    getModels: () => models,
  }
  const authority = createPiDurableAccountAuthority({
    registry,
    currentAccount: {
      readCurrent: async () => {
        reads++
        return structuredClone(evidence)
      },
    },
  })
  const qualified = new CurrentModelAccountAuthorization(authority, () => at)
  return {
    authority,
    qualified,
    registry,
    reads: () => reads,
    evidence,
    setEvidence: (value) => {
      evidence = value
    },
    setModels: (value) => {
      models = value
    },
  }
}
test('pinned Pi catalog qualifies only registered Responses models and never creates credentials or entitlement', async () => {
  const f = fixture()
  const grant = await f.qualified.authorize({
    workspaceId: connection.workspaceId,
    credentialRef: connection.credentialRef,
    credentialRevision: 1,
    principalRef: connection.ownerRef,
  })
  expect(grant.models).toEqual(['gpt-5'])
  expect(await f.qualified.evaluate({ connection, providerModel: 'gpt-5', target })).toBe('READY')
  expect(f.reads()).toBe(2)
  expect(await f.qualified.evaluate({ connection, providerModel: 'not-in-pi', target })).toBe(
    'MODEL_UNAVAILABLE'
  )
})
test('current scripted quota, entitlement and residency refresh denies even when catalog remains registered', async () => {
  for (const [patch, code] of [
    [{ quota: 'unknown' }, 'READINESS_UNAVAILABLE'],
    [{ quota: 'exhausted' }, 'QUOTA_EXHAUSTED'],
    [{ entitlement: 'unknown' }, 'READINESS_UNAVAILABLE'],
    [{ entitlement: 'denied' }, 'PROVIDER_POLICY_DENIED'],
    [{ residencyAllowed: false }, 'INCOMPATIBLE_LOCATION'],
  ]) {
    const f = fixture()
    expect(await f.qualified.evaluate({ connection, providerModel: 'gpt-5', target })).toBe('READY')
    f.setEvidence({ ...f.evidence, ...patch })
    expect(await f.qualified.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(code)
    expect(f.reads()).toBe(2)
  }
})
test('registry package/API/auth mismatch or ambiguity fails closed without ambient auth or provider fallback', async () => {
  for (const models of [
    [{ id: 'gpt-5', provider: 'openai', api: 'openai-completions' }],
    [{ id: 'gpt-5', provider: 'other', api: 'openai-responses' }],
    [
      { id: 'gpt-5', provider: 'openai', api: 'openai-responses' },
      { id: 'gpt-5', provider: 'openai', api: 'openai-responses' },
    ],
  ]) {
    const f = fixture()
    f.setModels(models)
    expect(await f.qualified.evaluate({ connection, providerModel: 'gpt-5', target })).not.toBe(
      'READY'
    )
  }
  const f = fixture()
  f.setEvidence({ ...f.evidence, authKind: 'provider_subscription' })
  expect(await f.qualified.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'AUTH_MODE_UNSUPPORTED'
  )
  expect(() =>
    createPiDurableAccountAuthority({
      registry: { ...f.registry, piAiVersion: '1.1.1' },
      currentAccount: f.authority,
    })
  ).toThrow('INCOMPATIBLE_HARNESS')
})

test('registry version mutation after construction cannot authorize a later request boundary', async () => {
  const f = fixture()
  expect(await f.qualified.evaluate({ connection, providerModel: 'gpt-5', target })).toBe('READY')
  f.registry.piDurableVersion = '1.1.1'
  expect(await f.qualified.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'INCOMPATIBLE_HARNESS'
  )
})
