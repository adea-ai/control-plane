import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { ControlPlaneClient } from '@control-plane/sdk'
import { startSelectedModelCandidateHost } from './selected-model-candidate.fixture.mjs'

test('same actual metadata selection survives prepared payer review and one native send', async () => {
  const currentEvidence = new Map()
  const host = await startSelectedModelCandidateHost({
    workspaceScope: true,
    prepareFunding: true,
    currentProductReader: { readCurrent: async ({ intentId }) => currentEvidence.get(intentId) },
  })
  let phase = 'host-ready'
  const diagnostic = process.env.PI_SELECTED_HOST_DIAGNOSTIC === 'true'
  const checkpoint = (next) => {
    phase = next
    if (diagnostic) console.error(JSON.stringify({ phase, metrics: host.metrics() }))
  }
  const timer = diagnostic ? setInterval(() => checkpoint(phase), 5000) : undefined
  try {
    const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
    const connection = (
      await sdk.createModelConnection(
        host.envelope(
          'model-connections.create',
          {
            credentialRef: host.credentialRef,
            credentialRevision: 1,
          },
          undefined,
          null
        )
      )
    ).data.connection
    const choice = { connectionRef: connection.connectionRef, providerModel: 'fixture-model-small' }
    await sdk.setModelDefaults(
      host.envelope('model-defaults.set', { expectedRevision: 0, lead: choice }, undefined, null)
    )
    const selected = (
      await sdk.resolveModelSelection(
        host.read(
          'model-selection.resolve',
          {
            role: 'lead',
            target: host.target,
          },
          null
        )
      )
    ).data.selection
    expect(selected.providerModel).toBe('fixture-model-small')
    const intentId = randomUUID()
    const actor = `user:${randomUUID()}`
    const evidence = {
      intentId,
      projectId: null,
      canonicalActorPrincipalId: actor,
      selectionRef: selected.selectionRef,
      selectionRevision: selected.selectionRevision,
    }
    await expect(
      host.registerIntent({ ...evidence, canonicalActorPrincipalId: `user:${'-'.repeat(36)}` })
    ).rejects.toThrow()
    await expect(
      host.registerIntent({ ...evidence, workspaceId: `${host.workspaceId.slice(0, -1)}H` })
    ).rejects.toThrow()
    currentEvidence.set(intentId, await host.registerIntent(evidence))
    expect(host.metrics()).toMatchObject({
      providerRequests: 0,
      runtimeAdmissions: 0,
      fixtureCredentialUses: 0,
    })
    const prepared = (
      await sdk.preparePiDurableLead(
        host.envelope('pi-durable.lead.prepare', { intentId }, undefined, null)
      )
    ).data
    expect(prepared.funding).toMatchObject({
      state: 'ready',
      selectionRef: selected.selectionRef,
      selectionRevision: selected.selectionRevision,
      provider: selected.provider,
      accountRef: selected.accountRef,
      authKind: selected.authKind,
      fundingSource: selected.fundingSource,
    })
    expect(host.fundingEvidence()[0].binding.canonicalActorPrincipalId).toBe(actor)
    expect(actor).not.toBe(host.principalId)
    expect(host.metrics()).toMatchObject({
      providerRequests: 0,
      runtimeAdmissions: 0,
      fixtureCredentialUses: 0,
    })
    const funding = (
      await sdk.getModelSelectionFunding(
        host.read(
          'model-selection.funding.get',
          {
            executionId: prepared.executionId,
            attemptId: prepared.attemptId,
            selectionRef: selected.selectionRef,
            selectionRevision: selected.selectionRevision,
          },
          null
        )
      )
    ).data.funding
    expect(funding).toEqual(prepared.funding)
    const dispatchRequest = host.envelope(
      'pi-durable.lead.dispatch',
      { intentId, preparationRef: prepared.preparationRef },
      undefined,
      null
    )
    checkpoint('dispatch-request')
    const dispatched = (await sdk.dispatchPiDurableLead(dispatchRequest)).data
    checkpoint('dispatch-returned')
    await host.drain()
    checkpoint('drain-returned')
    const status = (
      await sdk.getPiDurableLeadStatus(
        host.read('pi-durable.lead.status', { dispatchId: dispatched.dispatchId }, null)
      )
    ).data.status
    expect(status.state).toBe('completed')
    const trusted = await host.evidence(intentId)
    expect(trusted.product.canonicalActorPrincipalId).toBe(actor)
    expect(trusted.selection).toEqual(selected)
    expect(trusted.usage.filter((entry) => entry.kind === 'model_usage')).toHaveLength(1)
    expect(host.metrics().providerRequests).toBe(1)
    const replay = (await sdk.dispatchPiDurableLead(dispatchRequest)).data
    expect(replay.dispatchId).toBe(dispatched.dispatchId)
    expect(host.metrics().providerRequests).toBe(1)
    const other = (
      await sdk.resolveModelSelection(
        host.read(
          'model-selection.resolve',
          {
            role: 'lead',
            target: host.target,
            override: { ...choice, providerModel: 'fixture-model' },
          },
          null
        )
      )
    ).data.selection
    await expect(
      host.registerIntent({ ...evidence, selectionRef: other.selectionRef })
    ).rejects.toThrow()
    const raceIntentId = randomUUID()
    const races = await Promise.allSettled(
      [actor, `user:${randomUUID()}`].map((canonicalActorPrincipalId) =>
        host.registerIntent({ ...evidence, intentId: raceIntentId, canonicalActorPrincipalId })
      )
    )
    expect(races.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(races.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const winner = races.find((result) => result.status === 'fulfilled').value
    currentEvidence.set(raceIntentId, winner)
    const racePrepared = (
      await sdk.preparePiDurableLead(
        host.envelope('pi-durable.lead.prepare', { intentId: raceIntentId }, undefined, null)
      )
    ).data
    const beforeDenial = host.metrics()
    currentEvidence.delete(raceIntentId) // Fresh host-owned product reader denies after preparation.
    await expect(
      sdk.dispatchPiDurableLead(
        host.envelope(
          'pi-durable.lead.dispatch',
          { intentId: raceIntentId, preparationRef: racePrepared.preparationRef },
          undefined,
          null
        )
      )
    ).rejects.toMatchObject({ code: 'PI_LEAD_UNAVAILABLE', status: 503 })
    expect(host.metrics()).toMatchObject({
      providerRequests: beforeDenial.providerRequests,
      runtimeAdmissions: beforeDenial.runtimeAdmissions,
      fixtureCredentialUses: beforeDenial.fixtureCredentialUses,
    })
    expect(host.metrics().providerRequests).toBe(1)
  } finally {
    if (timer) clearInterval(timer)
    checkpoint('closing')
    await host.close()
  }
}, 30000)
