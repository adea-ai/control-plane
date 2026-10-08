import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { ControlPlaneClient } from '@control-plane/sdk'
import { startNodePiDurableCandidateHost } from './node-candidate.fixture.mjs'

async function fixture(body) {
  const host = await startNodePiDurableCandidateHost({ workspaceScope: true, prepareFunding: true })
  try {
    const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
    const intentId = randomUUID()
    await host.registerIntent({ intentId, projectId: null })
    const prepare = () =>
      sdk.preparePiDurableLead(
        host.envelope('pi-durable.lead.prepare', { intentId }, undefined, null)
      )
    const dispatch = (preparationRef) =>
      sdk.dispatchPiDurableLead(
        host.envelope('pi-durable.lead.dispatch', { intentId, preparationRef }, undefined, null)
      )
    await body({ host, sdk, intentId, prepare, dispatch })
  } finally {
    await host.close()
  }
}

test(
  'actual canonical payer preparation persists a SQLite confirmation without a model or credential callback',
  async () =>
    fixture(async (f) => {
      const prepared = (await f.prepare()).data
      expect(prepared.funding).toMatchObject({
        state: 'ready',
        provider: 'scripted-http',
        fundingSource: 'byo_api',
        fundingOwner: { displayName: 'Synthetic scripted-provider payer', revision: 1 },
      })
      expect(f.host.metrics()).toMatchObject({
        providerRequests: 0,
        modelsResolutions: 0,
        fixtureCredentialUses: 0,
        runtimeAdmissions: 0,
        fundingConfirmations: 1,
      })
      const confirmations = f.host.fundingEvidence()
      expect(confirmations).toHaveLength(1)
      expect(confirmations[0].funding).toEqual(prepared.funding)
      expect(confirmations[0].binding.canonicalActorPrincipalId).toBe('product:candidate-sender')
      expect(JSON.stringify(confirmations)).not.toContain('test-only-not-provider-credential')
    }),
  30000
)

test(
  'a private recorded payer change after preparation blocks dispatch before runtime start',
  async () =>
    fixture(async (f) => {
      const prepared = (await f.prepare()).data
      await f.host.changePayer(f.intentId)
      await expect(f.dispatch(prepared.preparationRef)).rejects.toMatchObject({
        code: 'PI_LEAD_FUNDING_CONFIRMATION_STALE',
      })
      expect(f.host.metrics()).toMatchObject({
        providerRequests: 0,
        modelsResolutions: 0,
        fixtureCredentialUses: 0,
        runtimeAdmissions: 0,
        fundingConfirmations: 1,
      })
      expect(f.host.fundingEvidence()[0].funding.fundingOwner.revision).toBe(1)
    }),
  30000
)

test(
  'a private recorded payer change after runtime admission but before physical fetch blocks scripted send',
  async () =>
    fixture(async (f) => {
      const prepared = (await f.prepare()).data
      const reached = f.host.holdBeforePhysicalSend()
      const dispatched = (await f.dispatch(prepared.preparationRef)).data
      await reached
      expect(f.host.metrics().runtimeAdmissions).toBe(1)
      expect(f.host.metrics().providerRequests).toBe(0)
      const before = await f.host.evidence(f.intentId)
      expect(before.execution.state).toBe('running')
      expect(before.attempt.state).toBe('running')
      expect(before.modelHolds.some((hold) => hold.status === 'open')).toBe(true)
      await f.host.changePayer(f.intentId)
      f.host.releaseBeforePhysicalSend()
      await f.host.drain()
      expect(f.host.metrics().providerRequests).toBe(0)
      const status = (
        await f.sdk.getPiDurableLeadStatus(
          f.host.read('pi-durable.lead.status', { dispatchId: dispatched.dispatchId }, null)
        )
      ).data.status
      expect(status.state).not.toBe('completed')
      expect(JSON.stringify(status)).not.toContain('test-only-not-provider-credential')
    }),
  30000
)

test(
  'lost dispatch acknowledgment is recovered by actual SDK lookup without another inference or funding preparation',
  async () =>
    fixture(async (f) => {
      const prepared = (await f.prepare()).data
      const physicalFetch = globalThis.fetch.bind(globalThis)
      const losingSdk = new ControlPlaneClient({
        baseUrl: f.host.baseUrl,
        credential: f.host.testCredential,
        fetch: async (url, options) => {
          const response = await physicalFetch(url, options)
          if (new URL(url).pathname.endsWith('/dispatch') && response.ok) {
            await response.text()
            throw new Error('SCRIPTED_ACK_LOSS')
          }
          return response
        },
      })
      await expect(
        losingSdk.dispatchPiDurableLead(
          f.host.envelope(
            'pi-durable.lead.dispatch',
            { intentId: f.intentId, preparationRef: prepared.preparationRef },
            undefined,
            null
          )
        )
      ).rejects.toThrow('SCRIPTED_ACK_LOSS')
      await f.host.drain()
      expect(f.host.metrics().providerRequests).toBe(1)
      const before = f.host.metrics()
      const found = (
        await f.sdk.lookupPiDurableLead(
          f.host.read('pi-durable.lead.lookup', { intentId: f.intentId }, null)
        )
      ).data
      expect(found.receipt).not.toBeNull()
      expect(found.receipt.state).toBe('dispatched')
      for (const field of [
        'providerRequests',
        'modelsResolutions',
        'fixtureCredentialUses',
        'fundingConfirmations',
        'runtimeAdmissions',
        'usageEntries',
        'commands',
        'executions',
        'attempts',
      ])
        expect(f.host.metrics()[field]).toBe(before[field])
    }),
  30000
)
