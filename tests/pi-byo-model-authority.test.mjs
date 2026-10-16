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
]
// Revoking the vault credential cannot be undone, so it gets its own host in each test below.
const REVOKED = [
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
]

// Reversible faults share one host per test, each undone before the next. Isolation is checked,
// not assumed: the account evidence must equal the original after every reset, and an unfaulted
// operation on the same host must still succeed once every fault has been applied and undone.
const restore = (host, original) => {
  host.models.setCurrentAccount(structuredClone(original))
  host.models.state.accountAvailable = true
  expect(host.models.currentAccountEvidence()).toEqual(original)
  expect(host.models.state.accountAvailable).toBe(true)
}

test('prepare refuses every model fault with its bounded reason, before any allocation or send', async () => {
  const refuseAll = async (host, faults, original) => {
    const intentId = host.setIntent()
    const empty = host.canonicalCounts()
    for (const [name, inject, reasonCode] of faults) {
      await inject(host)
      const refused = await refusal(prepare(host, intentId))
      expect({ name, ...refused }).toEqual({ name, code: 'PI_LEAD_MODEL_NOT_READY', reasonCode })
      expect(host.state.physicalSends).toBe(0)
      expect(host.models.secretProvider.resolveCount).toBe(0)
      expect(host.composition.adapter.journal.list()).toHaveLength(0)
      expect(host.canonicalCounts()).toEqual(empty)
      if (original) restore(host, original)
    }
    return intentId
  }
  const shared = await createProductionFactoryFixture()
  try {
    const intentId = await refuseAll(shared, FAULTS, shared.models.currentAccountEvidence())
    // Reset isolation: with every fault undone, the same host prepares normally.
    expect((await prepare(shared, intentId)).data.funding.state).toBe('ready')
  } finally {
    await shared.close()
  }
  const revoked = await createProductionFactoryFixture()
  try {
    await refuseAll(revoked, [REVOKED])
  } finally {
    await revoked.close()
  }
}, 120000)

test('dispatch refuses a model fault that appears after a successful prepare, and sends nothing', async () => {
  const refuseAll = async (host, faults, original) => {
    const intentId = host.setIntent()
    const prepared = (await prepare(host, intentId)).data
    expect(prepared.funding.state).toBe('ready')
    for (const [name, inject, reasonCode] of faults) {
      await inject(host)
      const refused = await refusal(dispatch(host, intentId, prepared.preparationRef))
      expect({ name, ...refused }).toEqual({ name, code: 'PI_LEAD_MODEL_NOT_READY', reasonCode })
      expect(host.state.physicalSends).toBe(0)
      expect(host.models.secretProvider.resolveCount).toBe(0)
      if (original) restore(host, original)
    }
    return { intentId, prepared }
  }
  const shared = await createProductionFactoryFixture()
  try {
    const { intentId, prepared } = await refuseAll(
      shared,
      FAULTS,
      shared.models.currentAccountEvidence()
    )
    // Reset isolation: the refused dispatches consumed nothing, so the same host dispatches once.
    await dispatch(shared, intentId, prepared.preparationRef)
    await shared.composition.adapter.drain()
    expect(shared.state.physicalSends).toBe(1)
  } finally {
    await shared.close()
  }
  const revoked = await createProductionFactoryFixture()
  try {
    await refuseAll(revoked, [REVOKED])
  } finally {
    await revoked.close()
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

test('sweep: a quota fault at every named authority boundary stops every later provider send', async () => {
  // One host serves every run, each with a new intent; the fault is undone after each run.
  // A boundary is named by observable state: the lead stage, how many credential leases and
  // secret resolutions the run has made, and whether a provider send has begun. The fault is
  // injected at a chosen occurrence of a named boundary, and the run records the boundary it
  // actually observed at that read, so the proof is of the boundary hit, not of a read index.
  const host = await createProductionFactoryFixture()
  try {
    const original = host.models.currentAccountEvidence()
    const run = async (target) => {
      const startedWith = {
        sends: host.state.physicalSends,
        resolves: host.models.secretProvider.resolveCount,
        leases: host.models.state.leasePolicyChecks,
        reads: host.models.state.accountReads,
      }
      let stage = 'prepare'
      const boundaries = []
      const seen = new Map()
      let faulted
      host.models.state.onAccountRead = (absolute) => {
        const name = JSON.stringify({
          stage,
          sends: host.state.physicalSends - startedWith.sends,
          resolves: host.models.secretProvider.resolveCount - startedWith.resolves,
          leases: host.models.state.leasePolicyChecks - startedWith.leases,
        })
        boundaries.push(name)
        const occurrence = (seen.get(name) ?? 0) + 1
        seen.set(name, occurrence)
        if (faulted || target?.name !== name || target.occurrence !== occurrence) return
        faulted = {
          name,
          occurrence,
          read: absolute - startedWith.reads,
          sendsAtFault: host.state.physicalSends - startedWith.sends,
        }
        host.models.setCurrentAccount({ quota: 'exhausted' })
      }
      let outcome = 'completed'
      try {
        const intentId = host.setIntent()
        const prepared = (await prepare(host, intentId)).data
        stage = 'dispatch'
        await dispatch(host, intentId, prepared.preparationRef)
        stage = 'drain'
        await host.composition.adapter.drain()
      } catch (error) {
        outcome = error.code ?? 'ERROR'
      }
      host.models.state.onAccountRead = undefined
      const sends = host.state.physicalSends - startedWith.sends
      const result = {
        reads: host.models.state.accountReads - startedWith.reads,
        boundaries,
        counts: Object.fromEntries(seen),
        faulted,
        sendsAfterFault: faulted ? sends - faulted.sendsAtFault : 0,
        sends,
        outcome,
      }
      restore(host, original)
      return result
    }
    // Two unfaulted runs on the reused host must agree on the boundaries, which also shows
    // that a finished run leaves nothing behind that changes the next one.
    const baseline = await run()
    expect(baseline).toMatchObject({ outcome: 'completed', sends: 1 })
    expect(baseline.faulted).toBeUndefined()
    const second = await run()
    expect(second).toMatchObject({ outcome: 'completed', sends: 1 })
    expect(Object.keys(second.counts).toSorted()).toEqual(Object.keys(baseline.counts).toSorted())
    const names = Object.keys(baseline.counts).map((name) => JSON.parse(name))
    // The production path must cross every claimed authority boundary.
    const has = (match) =>
      names.some((name) => Object.entries(match).every(([k, v]) => name[k] === v))
    for (const stage of ['prepare', 'dispatch', 'drain']) expect(has({ stage })).toBe(true)
    expect(has({ leases: 1, resolves: 0 })).toBe(true) // first credential lease
    expect(has({ leases: 1, resolves: 1 })).toBe(true) // first secret resolved
    expect(has({ leases: 2, resolves: 1 })).toBe(true) // second credential lease
    expect(has({ leases: 2, resolves: 2, sends: 0 })).toBe(true) // second secret, before the send
    expect(has({ sends: 1 })).toBe(true) // after the provider send began
    const cases = []
    for (const name of Object.keys(baseline.counts)) {
      const stable = Math.min(baseline.counts[name], second.counts[name])
      // First occurrence, and a late one that still tolerates a read landing on either side of a
      // state change in another run.
      for (const occurrence of new Set([1, Math.max(1, stable - 2)]))
        cases.push({ name, occurrence })
    }
    for (const target of cases) {
      const result = await run(target)
      // The fault landed on exactly the targeted boundary: the observed name at that read matches.
      expect(result.faulted).toBeDefined()
      expect(result.boundaries[result.faulted.read - 1]).toBe(target.name)
      expect({ name: result.faulted.name, occurrence: result.faulted.occurrence }).toEqual(target)
      // Nothing is sent after the fault, and a fault before the send means no provider call at all.
      expect({ target, sendsAfterFault: result.sendsAfterFault }).toEqual({
        target,
        sendsAfterFault: 0,
      })
      if (JSON.parse(target.name).sends === 0)
        expect({ target, sends: result.sends }).toEqual({ target, sends: 0 })
      else expect(result.sends).toBe(1)
    }
    // Reset isolation: after every fault was applied and undone, an unfaulted run is unchanged.
    const again = await run()
    expect(again).toMatchObject({ outcome: 'completed', sends: 1, reads: baseline.reads })
    expect(Object.keys(again.counts).toSorted()).toEqual(Object.keys(baseline.counts).toSorted())
  } finally {
    await host.close()
  }
}, 180000)
