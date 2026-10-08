import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { startNodePiDurableCandidateHost } from './node-candidate.fixture.mjs'

// Set PI_CANDIDATE_SDK_ENTRY to the locally packed @adea-ai/sdk entry
// for the cross-repository candidate run. No consumer source is copied here.
const { ControlPlaneClient } = await import(
  process.env.PI_CANDIDATE_SDK_ENTRY ?? '@control-plane/sdk'
)

test('public Control SDK crosses authenticated Nest host with canonical Pi admission, replay, progress and cancellation', async () => {
  const host = await startNodePiDurableCandidateHost()
  try {
    const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
    const intentId = randomUUID()
    const product = await host.registerIntent({
      intentId,
      projectId: host.explicitProjectId,
      prompt: 'SDK canonical fixture question',
    })
    expect(product.projectId).toBe(host.explicitProjectId)
    const envelope = host.envelope(
      'pi-durable.lead.dispatch',
      { intentId },
      'sdk-candidate:positive'
    )
    const first = (await sdk.dispatchPiDurableLead(envelope)).data
    await host.drain()
    const status = (
      await sdk.getPiDurableLeadStatus(
        host.read('pi-durable.lead.status', { dispatchId: first.dispatchId })
      )
    ).data.status
    expect(status.state).toBe('completed')
    expect(status.result.output).toEqual({ text: 'Candidate canonical answer' })
    expect(status.result.usage.accounting.chargedMicrounits).toBe(11)
    const events = (
      await sdk.getPiDurableLeadProgress(
        host.read('pi-durable.lead.progress', { dispatchId: first.dispatchId })
      )
    ).data.events
    expect(events.length).toBeGreaterThan(1)
    const tail = (
      await sdk.getPiDurableLeadProgress(
        host.read('pi-durable.lead.progress', {
          dispatchId: first.dispatchId,
          afterSequence: events[0].sequence,
        })
      )
    ).data.events
    expect(tail).toEqual(events.slice(1))
    const replay = (await sdk.dispatchPiDurableLead(envelope)).data
    expect(replay).toMatchObject({ dispatchId: first.dispatchId, replayed: true })
    const evidence = await host.evidence(intentId)
    expect(evidence.execution.executionId).toBe(first.executionId)
    expect(evidence.attempt.attemptId).toBe(first.attemptId)
    expect(evidence.usage.filter((entry) => entry.kind === 'model_usage')).toHaveLength(1)
    expect(host.metrics()).toMatchObject({
      commands: 1,
      executions: 1,
      attempts: 1,
      providerRequests: 1,
      runtimeAdmissions: 1,
    })
    await host.awaitInput(first.dispatchId)
    const cancelled = await sdk.cancelPiDurableLead(
      host.envelope(
        'pi-durable.lead.cancel',
        { dispatchId: first.dispatchId },
        'sdk-candidate:cancel'
      )
    )
    expect(cancelled.data.state).toBe('cancelled')
    expect(host.sourceIdentity).toMatchObject({
      repository: 'adea-ai/control-plane',
      liveProviderVerified: false,
    })
    expect(host.sourceIdentity.wipDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  } finally {
    await host.close()
  }
}, 30000)

test('workspace-only canonical product intent blocks over the public SDK without admission records or provider work', async () => {
  const host = await startNodePiDurableCandidateHost()
  try {
    const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
    const intentId = randomUUID()
    const product = await host.registerIntent({ intentId, projectId: null })
    expect(product.projectId).toBeNull()
    expect(product.profileVersionId).toBe(host.profileVersionId)
    const before = host.inspectAdmissionRecordCounts()
    await expect(
      sdk.dispatchPiDurableLead(
        host.envelope(
          'pi-durable.lead.dispatch',
          { intentId },
          'sdk-candidate:workspace-only',
          null
        )
      )
    ).rejects.toMatchObject({ code: 'PI_LEAD_PROJECT_SCOPE_REQUIRED', status: 503 })
    const counts = host.inspectAdmissionRecordCounts()
    for (const key of [
      'commands',
      'executions',
      'attempts',
      'usageBudgets',
      'usageEntries',
      'intentAdmissions',
      'dispatchReceipts',
      'runtimeAdmissions',
      'runtimeSessions',
      'providerRequests',
      'modelsResolutions',
      'planResolutions',
    ])
      expect(counts[key]).toBe(before[key])
    const evidence = await host.evidence(intentId)
    expect(evidence.execution).toBeNull()
    expect(evidence.attempt).toBeNull()
    expect(evidence.usage).toEqual([])
    const response = await fetch(`${host.baseUrl}/v3/pi-durable/lead-dispatches/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        host.envelope(
          'pi-durable.lead.dispatch',
          { intentId },
          'sdk-candidate:unauthenticated',
          null
        )
      ),
    })
    expect(response.status).toBe(401)
    const registration = await fetch(`${host.baseUrl}/__candidate/intents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intentId: randomUUID(), projectId: host.explicitProjectId }),
    })
    expect(registration.status).toBe(401)
  } finally {
    await host.close()
  }
}, 30000)
