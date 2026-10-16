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
  // Boundaries are named by observable state, not by a read count: the lead stage, how many
  // credential leases and secret resolutions the run has made, whether a provider send has begun,
  // and the journal state. Each boundary is faulted at its first and last account read.
  const host = await createProductionFactoryFixture()
  try {
    const original = host.models.currentAccountEvidence()
    const run = async (faultAt) => {
      const startedWith = {
        sends: host.state.physicalSends,
        resolves: host.models.secretProvider.resolveCount,
        leases: host.models.state.leasePolicyChecks,
        reads: host.models.state.accountReads,
        records: new Set(host.composition.adapter.journal.list().map((record) => record.handleId)),
      }
      let stage = 'prepare'
      const boundaries = []
      let sendsAtFault
      host.models.state.onAccountRead = (absolute) => {
        const read = absolute - startedWith.reads
        boundaries.push(
          JSON.stringify({
            stage,
            sends: host.state.physicalSends - startedWith.sends,
            resolves: host.models.secretProvider.resolveCount - startedWith.resolves,
            leases: host.models.state.leasePolicyChecks - startedWith.leases,
            journal: host.composition.adapter.journal
              .list()
              .filter((record) => !startedWith.records.has(record.handleId))
              .map((record) => record.state)
              .join('|'),
          })
        )
        if (read !== faultAt) return
        sendsAtFault = host.state.physicalSends - startedWith.sends
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
        fired: sendsAtFault !== undefined,
        sendsAtFault,
        sendsAfterFault: sendsAtFault === undefined ? 0 : sends - sendsAtFault,
        sends,
        outcome,
      }
      restore(host, original)
      return result
    }
    const never = Number.MAX_SAFE_INTEGER
    const baseline = await run(never)
    expect(baseline).toMatchObject({ outcome: 'completed', sends: 1, fired: false })
    const named = new Map()
    baseline.boundaries.forEach((name, index) => {
      const read = index + 1
      const entry = named.get(name) ?? { name, reads: [] }
      entry.reads.push(read)
      named.set(name, entry)
    })
    // The production path crosses lead stages, two lease and secret steps, and the send itself.
    expect(named.size).toBeGreaterThanOrEqual(8)
    for (const stage of ['prepare', 'dispatch', 'drain'])
      expect([...named.keys()].some((name) => JSON.parse(name).stage === stage)).toBe(true)
    const cases = []
    for (const { name, reads } of named.values())
      for (const read of new Set([reads[0], reads.at(-1)]))
        cases.push({ boundary: JSON.parse(name), read })
    for (const { boundary, read } of cases) {
      const result = await run(read)
      expect({ boundary, read, fired: result.fired }).toEqual({ boundary, read, fired: true })
      // The fault is observed at that exact boundary, and nothing is sent after it.
      expect({ boundary, read, sendsAfterFault: result.sendsAfterFault }).toEqual({
        boundary,
        read,
        sendsAfterFault: 0,
      })
      // A fault before the send boundary means the provider is never called at all.
      if (boundary.sends === 0)
        expect({ boundary, read, sends: result.sends }).toEqual({ boundary, read, sends: 0 })
      else expect(result.sends).toBe(1)
    }
    // Reset isolation: after every fault was applied and undone, an unfaulted run is unchanged.
    // A read next to a state change can land on either side of it, so compare the run's shape.
    const again = await run(never)
    expect(again).toMatchObject({
      outcome: 'completed',
      sends: 1,
      fired: false,
      reads: baseline.reads,
    })
    expect(new Set(again.boundaries)).toEqual(new Set(baseline.boundaries))
  } finally {
    await host.close()
  }
}, 180000)
