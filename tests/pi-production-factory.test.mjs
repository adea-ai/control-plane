import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { createProductionFactoryFixture } from './pi-production-factory.fixture.mjs'

test('real production factory prepares without inference and publishes exact native committed output through actual retained SQLite records', async () => {
  const host = await createProductionFactoryFixture()
  try {
    const intentId = host.setIntent()
    const prepared = (
      await host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).data
    expect(prepared.intentId).toBe(intentId)
    expect(prepared.funding.state).toBe('ready')
    expect(prepared.funding.selectionRef).toBe(host.selection.selectionRef)
    expect(prepared.funding.accountRef).toBe(host.selection.accountRef)
    expect(host.state.physicalSends).toBe(0)
    expect(host.composition.adapter.journal.list()).toHaveLength(0)
    expect(host.models.secretProvider.resolveCount).toBe(0)
    const dispatched = (
      await host.composition.piDurableLeadService.dispatch(
        host.command('pi-durable.lead.dispatch', {
          intentId,
          preparationRef: prepared.preparationRef,
        }),
        host.principal
      )
    ).data
    await host.composition.adapter.drain()
    const status = (
      await host.composition.piDurableLeadService.status(
        host.read('pi-durable.lead.status', { dispatchId: dispatched.dispatchId }),
        host.principal
      )
    ).data.status
    expect(status.state).toBe('completed')
    expect(status.result.output.text).toBe(host.exactText)
    expect(host.state.physicalSends).toBe(1)
    const before = {
      product: host.state.productReads,
      sends: host.state.physicalSends,
      secretResolutions: host.models.secretProvider.resolveCount,
    }
    const request = host.read('pi-durable.lead.publication.current', {
      dispatchId: dispatched.dispatchId,
      preparationRef: prepared.preparationRef,
    })
    const publication = (await host.composition.publicationService.current(request, host.principal))
      .data.publication
    expect(publication).toMatchObject({
      workspaceId: host.workspaceId,
      intentId,
      dispatchId: dispatched.dispatchId,
      preparationRef: prepared.preparationRef,
      executionId: dispatched.executionId,
      attemptId: dispatched.attemptId,
      runtimeSessionId: status.handle.externalSessionId,
      selectionRef: host.selection.selectionRef,
      selectionRevision: host.selection.selectionRevision,
      canonicalActorPrincipalId: host.actorPrincipalId,
      resultContentDigest: `sha256:${createHash('sha256').update(host.exactText, 'utf8').digest('hex')}`,
    })
    expect(host.actorPrincipalId).not.toBe(host.principal.principalId)
    expect(host.state.productReads).toBe(before.product)
    expect(host.state.physicalSends).toBe(before.sends)
    expect(host.models.secretProvider.resolveCount).toBe(before.secretResolutions)
    expect(
      (await host.ledger.entries(host.workspaceId, dispatched.executionId)).filter(
        (entry) => entry.kind === 'model_usage'
      )
    ).toHaveLength(1)
    expect(
      (await host.composition.publicationService.current(request, host.principal)).data.publication
    ).toEqual(publication)
    const recordPath = host.records.get(intentId).recordPath
    const acceptedRecord = await readFile(recordPath, 'utf8')
    for (const mutate of [
      (record) => {
        record.binding.canonicalActorPrincipalId = 'user:f643a115-617d-4bae-8d52-cfe458c0b8ac'
      },
      (record) => {
        record.decision.grant.authorizationId = 'changed:authorization'
      },
      (record) => {
        record.expiresAt = 'invalid'
      },
      (record) => {
        record.decision.price.validUntil = host.at
      },
    ]) {
      const changed = JSON.parse(acceptedRecord)
      mutate(changed)
      await writeFile(recordPath, JSON.stringify(changed), { mode: 0o600 })
      await expect(
        host.composition.publicationService.current(request, host.principal)
      ).rejects.toThrow()
      await writeFile(recordPath, acceptedRecord, { mode: 0o600 })
    }
    host.state.publicationRevoked = true
    await expect(
      host.composition.publicationService.current(request, host.principal)
    ).rejects.toThrow('TEST_PUBLICATION_DENIED')
    expect(host.state.productReads).toBe(before.product)
    expect(host.state.physicalSends).toBe(1)
  } finally {
    await host.close()
  }
}, 30000)

test('actual factory current original actor and account denial never mint a canonical admission or start native work', async () => {
  const host = await createProductionFactoryFixture()
  try {
    const intentId = host.setIntent()
    const empty = { commands: 0, executions: 0, attempts: 0, budgets: 0, usage: 0 }
    expect(host.canonicalCounts()).toEqual(empty)
    host.state.revoked = true
    await expect(
      host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).rejects.toThrow()
    expect(host.state.physicalSends).toBe(0)
    expect(host.composition.adapter.journal.list()).toHaveLength(0)
    expect(host.models.secretProvider.resolveCount).toBe(0)
    expect(host.canonicalCounts()).toEqual(empty)
    host.state.revoked = false
    host.models.setCurrentAccount({ quota: 'exhausted' })
    await expect(
      host.composition.piDurableLeadService.prepare(
        host.command('pi-durable.lead.prepare', { intentId }),
        host.principal
      )
    ).rejects.toThrow()
    expect(host.state.physicalSends).toBe(0)
    expect(host.composition.adapter.journal.list()).toHaveLength(0)
    expect(host.canonicalCounts()).toEqual(empty)
  } finally {
    await host.close()
  }
}, 30000)
