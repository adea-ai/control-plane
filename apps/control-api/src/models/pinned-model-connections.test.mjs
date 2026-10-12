import { expect, test } from 'bun:test'
import { InMemoryModelSelectionRepository } from '@control-plane/model-gateway'
import { piDurableRegistryMetadata } from '@control-plane/pi-durable-adapter'
import { createCurrentModelConnectionComposition } from './current-model-composition.ts'
import { pinModelConnectionOptions } from './pinned-model-connections.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const at = '2026-10-08T12:00:00.000Z'
const target = {
  location: 'remote_host',
  harness: 'pi_durable',
  harnessVersion: '1.1.0',
  providerBinding: 'pi_durable_models',
}
const connection = {
  connectionRef: `mconn_${'1'.repeat(32)}`,
  revision: 1,
  workspaceId,
  ownerRef: 'svc_workspace-admin',
  credentialRef: 'crd_01JABCDEF0123456789ABCDEFG',
  credentialRevision: 1,
  provider: 'openai',
  accountRef: 'account:byo-one',
  authKind: 'api_key',
  fundingSource: 'byo_api',
  status: 'active',
  // The stored connection may still name a model the pinned catalog no longer lists.
  models: ['gpt-5', 'not-in-pi'],
  workspaceGrant: {
    grantRef: 'grant:one',
    revision: 1,
    status: 'active',
    expiresAt: '2026-10-09T12:00:00.000Z',
  },
}
const vault = {
  metadata: async (credentialRef) => ({
    credentialId: credentialRef,
    workspaceId,
    provider: 'openai',
    revision: 1,
    status: 'active',
  }),
}
function currentEvidence(overrides) {
  return {
    schemaVersion: 'model-account-authority/v1',
    evidenceRef: 'account:current',
    observedAt: at,
    expiresAt: '2026-10-08T13:00:00.000Z',
    workspaceId,
    credentialRef: connection.credentialRef,
    credentialRevision: 1,
    provider: 'openai',
    accountRef: connection.accountRef,
    authKind: 'api_key',
    fundingSource: 'byo_api',
    models: ['gpt-5', 'not-in-pi'],
    workspaceGrant: connection.workspaceGrant,
    allowedPrincipalRefs: [connection.ownerRef],
    targets: [target],
    entitlement: 'allowed',
    quota: 'available',
    residencyAllowed: true,
    ...overrides,
  }
}
async function composition({ evidence = {}, lead = 'gpt-5', child = 'gpt-5', registry } = {}) {
  const repository = new InMemoryModelSelectionRepository()
  await repository.saveConnection(0, connection)
  await repository.saveDefaults(0, {
    workspaceId,
    revision: 1,
    lead: { connectionRef: connection.connectionRef, providerModel: lead },
    child: { connectionRef: connection.connectionRef, providerModel: child },
  })
  const currentAccountAuthority = {
    readCurrent: async (input) => {
      if (input.workspaceId !== workspaceId || input.credentialRef !== connection.credentialRef)
        return undefined
      return currentEvidence({ ...evidence, observedAt: input.requestedAt })
    },
  }
  const composed = createCurrentModelConnectionComposition(
    pinModelConnectionOptions(
      { repository, vault, currentAccountAuthority, now: () => at },
      registry
    )
  )
  return { ...composed, repository }
}

test('product BYO selection intersects host-listed models with the pinned catalog and never substitutes', async () => {
  const f = await composition({ lead: 'not-in-pi', child: 'gpt-5' })
  let inserted = 0
  const insert = f.repository.insertSelection.bind(f.repository)
  f.repository.insertSelection = async (next) => {
    inserted++
    return insert(next)
  }
  await expect(f.selections.select({ workspaceId, role: 'lead', target })).rejects.toThrow(
    'MODEL_UNAVAILABLE'
  )
  expect(inserted).toBe(0)
  expect((await f.selections.select({ workspaceId, role: 'child', target })).providerModel).toBe(
    'gpt-5'
  )
})

test('pinned product composition fails closed for host evidence outside the reviewed Durable binding', async () => {
  for (const [evidence, code] of [
    [{ targets: [{ ...target, location: 'local_device' }] }, 'INCOMPATIBLE_LOCATION'],
    [{ targets: [{ ...target, harnessVersion: '1.0.0' }] }, 'INCOMPATIBLE_HARNESS'],
    [{ authKind: 'provider_subscription' }, 'AUTH_MODE_UNSUPPORTED'],
    [{ quota: 'exhausted' }, 'QUOTA_EXHAUSTED'],
    [{ entitlement: 'denied' }, 'PROVIDER_POLICY_DENIED'],
  ]) {
    const f = await composition({ evidence })
    await expect(f.selections.select({ workspaceId, role: 'lead', target })).rejects.toThrow(code)
  }
})

test('a pinned registry mismatch cannot construct the product model composition', () => {
  expect(() =>
    pinModelConnectionOptions(
      {
        repository: new InMemoryModelSelectionRepository(),
        vault,
        currentAccountAuthority: { readCurrent: async () => undefined },
        now: () => at,
      },
      { ...piDurableRegistryMetadata, piAiVersion: '1.1.1' }
    )
  ).toThrow('INCOMPATIBLE_HARNESS')
})
