import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertFundingCandidateProvenance } from './candidate-provenance.fixture.mjs'

// Explicit candidate qualification: no installed-version inference or ambient host fallback.
// Provenance is checked before either candidate module is imported.
const entry = process.env.PI_FUNDING_CANDIDATE_HOST_ENTRY
const qualify = entry ? test : test.skip
let startHost, ControlPlaneClient, provenance
if (entry) {
  provenance = assertFundingCandidateProvenance({
    hostEntry: entry,
    head: process.env.PI_FUNDING_CANDIDATE_HEAD,
    manifestPath: process.env.PI_CANDIDATE_MANIFEST,
    manifestSha256: process.env.PI_CANDIDATE_MANIFEST_SHA256,
    sdkEntry: process.env.PI_CANDIDATE_SDK_ENTRY,
  })
  ;({ startNodePiDurableCandidateHost: startHost } = await import(
    pathToFileURL(resolve(entry)).href
  ))
  ;({ ControlPlaneClient } = await import(
    pathToFileURL(resolve(process.env.PI_CANDIDATE_SDK_ENTRY)).href
  ))
}

qualify('candidate provenance binds the pinned head, manifest hash and installed SDK', () => {
  expect(provenance.head).toBe(process.env.PI_FUNDING_CANDIDATE_HEAD)
  expect(provenance.manifestSha256).toBe(process.env.PI_CANDIDATE_MANIFEST_SHA256)
  expect(provenance.artifacts.sdk.name).toBe('@adea-ai/sdk')
  expect(provenance.artifacts.contracts.name).toBe('@adea-ai/contracts')
})

async function fixture(body) {
  const host = await startHost({ workspaceScope: true, prepareFunding: true })
  try {
    const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
    const intentId = randomUUID()
    await host.registerIntent({
      intentId,
      projectId: null,
      canonicalActorPrincipalId: 'user:r2-original',
    })
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
    host.releaseBeforePhysicalSend()
    await host.close()
  }
}

qualify(
  'actual prepare and repeated intent preserve one payer confirmation and one physical inference',
  async () =>
    fixture(async (f) => {
      const first = (await f.prepare()).data
      const repeat = (await f.prepare()).data
      expect(repeat).toEqual({ ...first, replayed: true })
      expect(first.replayed).toBe(false)
      expect(f.host.metrics()).toMatchObject({
        providerRequests: 0,
        modelsResolutions: 0,
        fixtureCredentialUses: 0,
        runtimeAdmissions: 0,
        fundingConfirmations: 1,
      })
      const retained = f.host.fundingEvidence()[0]
      expect(retained.binding.canonicalActorPrincipalId).toBe('user:r2-original')
      expect(retained.binding.canonicalActorPrincipalId).not.toBe(retained.binding.principalRef)
      expect(retained.binding.canonicalActorPrincipalId).not.toBe(
        retained.binding.leasePrincipalRef
      )
      expect(retained.funding).toEqual(first.funding)
      const envelope = f.host.envelope(
        'pi-durable.lead.dispatch',
        { intentId: f.intentId, preparationRef: first.preparationRef },
        'r2:repeat-dispatch',
        null
      )
      const accepted = (await f.sdk.dispatchPiDurableLead(envelope)).data
      await f.host.drain()
      const before = f.host.metrics()
      expect(before.modelsResolutions).toBeGreaterThan(0)
      expect(before.fixtureCredentialUses).toBeGreaterThan(0)
      expect(before).toMatchObject({
        providerRequests: 1,
        fundingConfirmations: 1,
        runtimeAdmissions: 1,
      })
      expect((await f.sdk.dispatchPiDurableLead(envelope)).data).toMatchObject({
        dispatchId: accepted.dispatchId,
        executionId: accepted.executionId,
        attemptId: accepted.attemptId,
        runtimeSessionId: accepted.runtimeSessionId,
        replayed: true,
        state: 'completed',
      })
      await f.host.drain()
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

qualify(
  'actual prepared payer revision cannot refresh or fallback on the same attempt',
  async () =>
    fixture(async (f) => {
      const first = (await f.prepare()).data
      await f.host.changePayer(f.intentId)
      await expect(f.prepare()).rejects.toMatchObject({
        code: 'PI_LEAD_FUNDING_CONFIRMATION_STALE',
      })
      await expect(f.dispatch(first.preparationRef)).rejects.toMatchObject({
        code: 'PI_LEAD_FUNDING_CONFIRMATION_STALE',
      })
      expect(f.host.metrics()).toMatchObject({
        providerRequests: 0,
        modelsResolutions: 0,
        fixtureCredentialUses: 0,
        runtimeAdmissions: 0,
        fundingConfirmations: 1,
      })
      expect(f.host.fundingEvidence()[0].funding).toEqual(first.funding)
    }),
  30000
)

for (const fault of [
  'payer-revision',
  'expired',
  'inactive-principal',
  'revoked-grant',
  'transport-revoked',
]) {
  qualify(
    `actual confirmed physical-send boundary denies ${fault} after await`,
    async () =>
      fixture(async (f) => {
        const first = (await f.prepare()).data
        const reached = f.host.holdBeforePhysicalSend()
        const accepted = (await f.dispatch(first.preparationRef)).data
        await Promise.race([
          reached,
          f.host.drain().then(() => {
            throw new Error('CANDIDATE_FINISHED_BEFORE_SEND_GATE')
          }),
        ])
        expect(f.host.metrics()).toMatchObject({
          providerRequests: 0,
          runtimeAdmissions: 1,
          fundingConfirmations: 1,
        })
        const before = await f.host.evidence(f.intentId)
        expect(before.modelHolds.some((hold) => hold.status === 'open')).toBe(true)
        if (fault === 'payer-revision') await f.host.changePayer(f.intentId)
        else if (fault === 'transport-revoked') f.host.revoke()
        else f.host.setScopeFault(fault)
        f.host.releaseBeforePhysicalSend()
        await f.host.drain()
        expect(f.host.metrics().providerRequests).toBe(0)
        expect(f.host.metrics().fundingConfirmations).toBe(1)
        expect(f.host.fundingEvidence()[0].funding).toEqual(first.funding)
        const after = await f.host.evidence(f.intentId)
        const retainedHoldPins = (holds) => holds.map(({ status: _status, ...pin }) => pin)
        expect(retainedHoldPins(after.modelHolds)).toEqual(retainedHoldPins(before.modelHolds))
        expect(after.metrics.providerRequests).toBe(0)
        expect(JSON.stringify(after)).not.toContain('test-only-not-provider-credential')
        const readStatus = () =>
          f.sdk.getPiDurableLeadStatus(
            f.host.read('pi-durable.lead.status', { dispatchId: accepted.dispatchId }, null)
          )
        if (fault === 'payer-revision') {
          const status = (await readStatus()).data.status
          expect(status.state).not.toBe('completed')
          expect(JSON.stringify(status)).not.toContain('test-only-not-provider-credential')
        } else if (fault === 'transport-revoked') {
          await expect(readStatus()).rejects.toMatchObject({
            code: 'SERVICE_CREDENTIAL_REVOKED',
            status: 401,
          })
        } else {
          // Expired/revoked actors have no authority to inspect runtime status.
          await expect(readStatus()).rejects.toMatchObject({ code: 'PI_LEAD_UNAVAILABLE' })
        }
      }),
    30000
  )
}
