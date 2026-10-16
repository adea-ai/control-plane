// BYO lead model authority (control-plane #931): production composition, scripted account/payer/transport.
// Nothing here is live-provider qualification: the account reader, vault secret and OpenAI transport are fixtures.
import { expect, test } from 'bun:test'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'

const lead = (host) => host.composition.piDurableLeadService
const prepare = (host, intentId) =>
  lead(host).prepare(host.command('pi-durable.lead.prepare', { intentId }), host.principal)
const dispatch = (host, intentId, preparationRef) =>
  lead(host).dispatch(
    host.command('pi-durable.lead.dispatch', { intentId, preparationRef }),
    host.principal
  )
const refusal = async (promise) => {
  try {
    await promise
  } catch (error) {
    return { code: error.code, reasonCode: error.reasonCode }
  }
  throw new Error('TEST_EXPECTED_REFUSAL')
}
const pastGrant = (host) => ({
  ...host.models.currentAccountEvidence().workspaceGrant,
  expiresAt: '2000-01-01T00:00:00.000Z',
})

const FAULTS = [
  [
    'quota exhausted',
    (host) => host.models.setCurrentAccount({ quota: 'exhausted' }),
    'QUOTA_EXHAUSTED',
  ],
  [
    'entitlement denied',
    (host) => host.models.setCurrentAccount({ entitlement: 'denied' }),
    'PROVIDER_POLICY_DENIED',
  ],
  [
    'quota unknown',
    (host) => host.models.setCurrentAccount({ quota: 'unknown' }),
    'READINESS_UNAVAILABLE',
  ],
  [
    'workspace grant revoked',
    (host) =>
      host.models.setCurrentAccount({
        workspaceGrant: {
          ...host.models.currentAccountEvidence().workspaceGrant,
          status: 'revoked',
        },
      }),
    'WORKSPACE_GRANT_REVOKED',
  ],
  [
    'workspace grant expired',
    (host) => host.models.setCurrentAccount({ workspaceGrant: pastGrant(host) }),
    'WORKSPACE_GRANT_EXPIRED',
  ],
  [
    'residency denied',
    (host) => host.models.setCurrentAccount({ residencyAllowed: false }),
    'INCOMPATIBLE_LOCATION',
  ],
  [
    'model removed from the account',
    (host) => host.models.setCurrentAccount({ models: ['gpt-5-mini'] }),
    'MODEL_UNAVAILABLE',
  ],
  [
    'account authority unreadable',
    (host) => {
      host.models.state.accountAvailable = false
    },
    'READINESS_UNAVAILABLE',
  ],
  [
    'credential revoked in the vault',
    (host) =>
      host.models.vault.revoke(
        host.models.refs.credentialRef,
        host.models.refs.administratorPrincipalRef,
        {
          workspaceId: host.workspaceId,
        }
      ),
    'CREDENTIAL_REVOKED',
  ],
]

test('prepare refuses every model fault with its bounded reason, before any allocation or send', async () => {
  for (const [name, inject, reasonCode] of FAULTS) {
    const host = await createProductionFactoryFixture()
    try {
      const intentId = host.setIntent()
      const empty = host.canonicalCounts()
      await inject(host)
      const refused = await refusal(prepare(host, intentId))
      expect({ name, ...refused }).toEqual({ name, code: 'PI_LEAD_MODEL_NOT_READY', reasonCode })
      expect(host.state.physicalSends).toBe(0)
      expect(host.models.secretProvider.resolveCount).toBe(0)
      expect(host.composition.adapter.journal.list()).toHaveLength(0)
      expect(host.canonicalCounts()).toEqual(empty)
    } finally {
      await host.close()
    }
  }
}, 120000)

test('dispatch refuses a model fault that appears after a successful prepare, and sends nothing', async () => {
  for (const [name, inject, reasonCode] of FAULTS) {
    const host = await createProductionFactoryFixture()
    try {
      const intentId = host.setIntent()
      const prepared = (await prepare(host, intentId)).data
      expect(prepared.funding.state).toBe('ready')
      await inject(host)
      const refused = await refusal(dispatch(host, intentId, prepared.preparationRef))
      expect({ name, ...refused }).toEqual({ name, code: 'PI_LEAD_MODEL_NOT_READY', reasonCode })
      expect(host.state.physicalSends).toBe(0)
      expect(host.models.secretProvider.resolveCount).toBe(0)
    } finally {
      await host.close()
    }
  }
}, 120000)

test('status, progress, lookup and cancel keep working for a running lead after every model fault', async () => {
  let sendStarted
  const started = new Promise((resolve) => {
    sendStarted = resolve
  })
  const host = await createProductionFactoryFixture({
    // The provider holds the request open, so the lead stays running while the account changes.
    physicalResponder: ({ request }) => {
      sendStarted()
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(new Error('TEST_HELD_SEND_ABORTED')),
          {
            once: true,
          }
        )
      )
    },
  })
  try {
    const intentId = host.setIntent()
    const prepared = (await prepare(host, intentId)).data
    const dispatched = (await dispatch(host, intentId, prepared.preparationRef)).data
    await started
    for (const [, inject] of FAULTS) await inject(host)
    const service = lead(host)
    const status = (
      await service.status(
        host.read('pi-durable.lead.status', { dispatchId: dispatched.dispatchId }),
        host.principal
      )
    ).data.status
    expect(['accepted', 'queued', 'starting', 'running']).toContain(status.state)
    await service.progress(
      host.read('pi-durable.lead.progress', {
        dispatchId: dispatched.dispatchId,
        afterSequence: 0,
      }),
      host.principal
    )
    expect(
      (await service.lookup(host.read('pi-durable.lead.lookup', { intentId }), host.principal)).data
        .receipt.dispatchId
    ).toBe(dispatched.dispatchId)
    await service.cancel(
      host.command('pi-durable.lead.cancel', { dispatchId: dispatched.dispatchId }),
      host.principal
    )
    await host.composition.adapter.drain()
    const final = (
      await service.status(
        host.read('pi-durable.lead.status', { dispatchId: dispatched.dispatchId }),
        host.principal
      )
    ).data.status
    // The fixture cannot prove the held provider call unbilled, so the honest settled state is
    // `cancelling` (reconciliation required); the point is that cancel was accepted, not refused.
    expect(['cancelling', 'cancelled']).toContain(final.state)
  } finally {
    await host.close()
  }
}, 60000)

test('a recorded Adea payer cannot fund a bring-your-own key, but a workspace payer can', async () => {
  const adea = await createProductionFactoryFixture({ payerKind: 'adea_account' })
  try {
    const refused = await refusal(prepare(adea, adea.setIntent()))
    expect(refused).toEqual({
      code: 'PI_LEAD_MODEL_NOT_READY',
      reasonCode: 'PROVIDER_POLICY_DENIED',
    })
    expect(adea.state.physicalSends).toBe(0)
    expect(adea.models.secretProvider.resolveCount).toBe(0)
  } finally {
    await adea.close()
  }
  const workspace = await createProductionFactoryFixture({ payerKind: 'workspace_account' })
  try {
    const prepared = (await prepare(workspace, workspace.setIntent())).data
    expect(prepared.funding.state).toBe('ready')
    expect(prepared.funding.fundingOwner.kind).toBe('workspace_account')
  } finally {
    await workspace.close()
  }
}, 60000)

test('sweep: a quota fault at any account read stops every later provider send', async () => {
  const sweep = async (faultAt) => {
    const host = await createProductionFactoryFixture()
    try {
      let sendsAtFault
      const firstRead = host.models.state.accountReads
      host.models.state.onAccountRead = (read) => {
        if (read - firstRead !== faultAt) return
        sendsAtFault = host.state.physicalSends
        host.models.setCurrentAccount({ quota: 'exhausted' })
      }
      let outcome = 'completed'
      try {
        const intentId = host.setIntent()
        const prepared = (await prepare(host, intentId)).data
        await dispatch(host, intentId, prepared.preparationRef)
        await host.composition.adapter.drain()
      } catch (error) {
        outcome = error.code ?? 'ERROR'
      }
      return {
        reads: host.models.state.accountReads - firstRead,
        fired: sendsAtFault !== undefined,
        sendsAfterFault: sendsAtFault === undefined ? 0 : host.state.physicalSends - sendsAtFault,
        sends: host.state.physicalSends,
        outcome,
      }
    } finally {
      await host.close()
    }
  }
  const baseline = await sweep(Number.MAX_SAFE_INTEGER)
  expect(baseline).toMatchObject({ outcome: 'completed', sends: 1, fired: false })
  expect(baseline.reads).toBeGreaterThan(5)
  // One exhaustive pass over every read (about 400) was run once by hand; CI keeps the first and last
  // boundaries plus a fixed stride, which still crosses prepare, dispatch, lease and the send itself.
  const sampled = []
  for (let read = 1; read <= baseline.reads; read++)
    if (read <= 10 || read > baseline.reads - 10 || read % 23 === 0) sampled.push(read)
  const outcomes = []
  for (const read of sampled) {
    const result = await sweep(read)
    expect({ read, fired: result.fired }).toEqual({ read, fired: true })
    expect({ read, sendsAfterFault: result.sendsAfterFault }).toEqual({ read, sendsAfterFault: 0 })
    outcomes.push(result.sends)
  }
  // Early faults prevent the send; only a fault after the send began can leave it in place.
  expect(outcomes[0]).toBe(0)
  expect(outcomes.at(-1)).toBe(1)
}, 180000)
