import { expect, test } from 'bun:test'
import { connection } from './selection-fixtures.mjs'

// The eligibility rules are proven here one by one, independently of the reason
// propagation the selection service already covers. Every filter the Control Plane
// PRD names for a BYO lead model - registry membership, harness, location,
// entitlement, budget ownership, expiry, revocation and quota - has to produce its
// own bounded reason from its own evidence.
//
// Every fixture is synthetic. No credential, subscription token, hosted entitlement
// or paid provider is read, and nothing here infers hosted eligibility from a local
// or native token: the entitlement attribution is a rule under test, not an input.

const at = '2026-10-08T12:00:00.000Z'
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}

const trustedRecord = {
  provider: connection.provider,
  providerModel: 'gpt-5',
  authKind: connection.authKind,
  fundingSource: connection.fundingSource,
  target,
  workspaceId: connection.workspaceId,
  accountRef: connection.accountRef,
  policyAllowed: true,
  quotaState: 'available',
  validUntil: '2026-10-09T12:00:00.000Z',
}

const accountEvidence = {
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
  models: ['gpt-5'],
  workspaceGrant: connection.workspaceGrant,
  allowedPrincipalRefs: [connection.ownerRef],
  targets: [target],
  entitlement: 'allowed',
  quota: 'available',
  residencyAllowed: true,
}

/** The configured qualification over trusted records, with a fixed clock. */
async function configured(records) {
  const { ConfiguredModelQualification } = await import('./qualification.ts')
  return new ConfiguredModelQualification(records, () => at)
}

/** The current, authenticated qualification over one account evidence read. */
async function current(evidence) {
  const { createPiDurableAccountAuthority } = await import('./pi-durable-account.ts')
  const { CurrentModelAccountAuthorization } = await import('./current-authority.ts')
  const authority = createPiDurableAccountAuthority({
    registry: {
      piAiVersion: '1.1.0',
      piDurableVersion: '1.1.0',
      sourceRevision: '1cedd32724abfcb0915f76cc61b6827e2c16dbad',
      getModels: () => [{ id: 'gpt-5', provider: 'openai', api: 'openai-responses' }],
    },
    currentAccount: { readCurrent: async () => structuredClone(evidence) },
  })
  return new CurrentModelAccountAuthorization(authority, () => at)
}

test('a trusted record that describes no identity refuses the model', async () => {
  const qualify = await configured([trustedRecord])
  for (const patch of [
    { provider: 'anthropic' },
    { providerModel: 'gpt-4' },
    { workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
    { accountRef: 'account:byo-two' },
  ]) {
    expect(
      await qualify.evaluate({
        connection,
        providerModel: 'gpt-5',
        target,
      })
    ).toBe('READY')
    const foreign = await configured([{ ...trustedRecord, ...patch }])
    expect(await foreign.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
      'MODEL_UNAVAILABLE'
    )
  }
})

test('ambiguous, stale and unknown trusted records refuse the model', async () => {
  const ambiguous = await configured([trustedRecord, { ...trustedRecord }])
  expect(await ambiguous.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'READINESS_UNAVAILABLE'
  )

  const stale = await configured([{ ...trustedRecord, validUntil: '2026-10-08T11:00:00.000Z' }])
  expect(await stale.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'READINESS_UNAVAILABLE'
  )

  const unknown = await configured([{ ...trustedRecord, quotaState: 'unknown' }])
  expect(await unknown.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'READINESS_UNAVAILABLE'
  )
})

test('an exhausted trusted quota refuses the model', async () => {
  const exhausted = await configured([{ ...trustedRecord, quotaState: 'exhausted' }])
  expect(await exhausted.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'QUOTA_EXHAUSTED'
  )
})

test('a native subscription entitlement never satisfies a hosted or BYO API inference', async () => {
  // The connection claims a native subscription; the trusted record is a BYO API key.
  const native = await configured([trustedRecord])
  expect(
    await native.evaluate({
      connection: {
        ...connection,
        authKind: 'provider_subscription',
        fundingSource: 'external_subscription',
      },
      providerModel: 'gpt-5',
      target,
    })
  ).toBe('AUTH_MODE_UNSUPPORTED')

  // And the other direction: a BYO API key never satisfies a native subscription record.
  const subscription = await configured([
    {
      ...trustedRecord,
      authKind: 'provider_subscription',
      fundingSource: 'external_subscription',
    },
  ])
  expect(await subscription.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'AUTH_MODE_UNSUPPORTED'
  )
})

test('a revoked or expired workspace grant refuses the current account', async () => {
  const revoked = await current({
    ...accountEvidence,
    workspaceGrant: { ...connection.workspaceGrant, status: 'revoked' },
  })
  expect(await revoked.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'WORKSPACE_GRANT_REVOKED'
  )

  const expired = await current({
    ...accountEvidence,
    workspaceGrant: { ...connection.workspaceGrant, expiresAt: '2026-10-08T11:00:00.000Z' },
  })
  expect(await expired.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'WORKSPACE_GRANT_EXPIRED'
  )
})

test('a stale or expired account snapshot refuses the current account', async () => {
  const stale = await current({ ...accountEvidence, observedAt: '2026-10-08T11:00:00.000Z' })
  expect(await stale.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'READINESS_UNAVAILABLE'
  )

  const expired = await current({ ...accountEvidence, expiresAt: '2026-10-08T12:00:00.000Z' })
  expect(await expired.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'READINESS_UNAVAILABLE'
  )
})

test('a foreign credential read refuses the current account', async () => {
  const foreign = await current({
    ...accountEvidence,
    credentialRef: 'crd_01JABCDEF0123456789ABCDEFH',
  })
  expect(await foreign.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'SELECTION_CHANGED'
  )
})

test('a principal that is not allowed refuses the current account', async () => {
  const principal = await current({ ...accountEvidence, allowedPrincipalRefs: ['svc_other'] })
  expect(await principal.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'PROVIDER_POLICY_DENIED'
  )
})

test('an ambiguous target projection refuses the current account', async () => {
  const ambiguous = await current({ ...accountEvidence, targets: [target, { ...target }] })
  expect(await ambiguous.evaluate({ connection, providerModel: 'gpt-5', target })).toBe(
    'READINESS_UNAVAILABLE'
  )
})

test('an eligibility read asks only for the scoped reference it owns', async () => {
  const { createPiDurableAccountAuthority } = await import('./pi-durable-account.ts')
  const { CurrentModelAccountAuthorization } = await import('./current-authority.ts')
  const registryCalls = []
  const accountCalls = []
  const authority = createPiDurableAccountAuthority({
    registry: {
      piAiVersion: '1.1.0',
      piDurableVersion: '1.1.0',
      sourceRevision: '1cedd32724abfcb0915f76cc61b6827e2c16dbad',
      getModels: (...args) => {
        registryCalls.push(args)
        return [{ id: 'gpt-5', provider: 'openai', api: 'openai-responses' }]
      },
    },
    currentAccount: {
      readCurrent: async (input) => {
        accountCalls.push(input)
        return structuredClone(accountEvidence)
      },
    },
  })
  const qualified = new CurrentModelAccountAuthorization(authority, () => at)

  expect(await qualified.evaluate({ connection, providerModel: 'gpt-5', target })).toBe('READY')
  // The pinned registry is read without arguments, so no credential, lease or provider
  // object can reach it, and the account authority is asked only for the scoped
  // credential reference it owns.
  expect(registryCalls).toEqual([[]])
  expect(accountCalls).toEqual([
    {
      schemaVersion: 'model-account-authority/v1',
      workspaceId: connection.workspaceId,
      credentialRef: connection.credentialRef,
      credentialRevision: 1,
      requestedAt: at,
    },
  ])
})
