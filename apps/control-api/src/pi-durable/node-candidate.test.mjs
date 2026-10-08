import { test, expect } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { startNodePiDurableCandidateHost } from './node-candidate.fixture.mjs'

// Set PI_CANDIDATE_SDK_ENTRY to the locally packed @adea-ai/sdk entry
// for the cross-repository candidate run. No consumer source is copied here.
const { ControlPlaneClient } = await import(
  process.env.PI_CANDIDATE_SDK_ENTRY ?? '@control-plane/sdk'
)

for (const mode of ['sequential', 'concurrent']) {
  test(`transport command conflict fences canonical admission before side effects (${mode})`, async () => {
    const host = await startNodePiDurableCandidateHost()
    try {
      const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
      const intents = [randomUUID(), randomUUID()]
      for (const intentId of intents)
        await host.registerIntent({ intentId, projectId: host.explicitProjectId })
      const requests = intents.map((intentId) =>
        host.envelope('pi-durable.lead.dispatch', { intentId }, 'candidate:shared-dispatch-key')
      )
      let rejectedIntent
      if (mode === 'sequential') {
        await sdk.dispatchPiDurableLead(requests[0])
        await host.drain()
        const before = host.metrics()
        await expect(sdk.dispatchPiDurableLead(requests[1])).rejects.toMatchObject({
          code: 'PI_LEAD_COMMAND_CONFLICT',
        })
        rejectedIntent = intents[1]
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
          'planResolutions',
          'providerRequests',
        ])
          expect(host.metrics()[key]).toBe(before[key])
      } else {
        const results = await Promise.allSettled(
          requests.map((request) => sdk.dispatchPiDurableLead(request))
        )
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        const loser = results.findIndex((result) => result.status === 'rejected')
        expect(results[loser].reason).toMatchObject({ code: 'PI_LEAD_COMMAND_CONFLICT' })
        rejectedIntent = intents[loser]
        await host.drain()
      }
      const rejected = await host.evidence(rejectedIntent)
      expect(rejected.execution).toBeNull()
      expect(rejected.attempt).toBeNull()
      expect(rejected.usage).toEqual([])
      expect(host.metrics()).toMatchObject({
        commands: 1,
        executions: 1,
        attempts: 1,
        usageBudgets: 1,
        intentAdmissions: 1,
        dispatchReceipts: 1,
        runtimeAdmissions: 1,
        runtimeSessions: 0,
        providerRequests: 1,
        planResolutions: 1,
      })
    } finally {
      await host.close()
    }
  }, 30000)
}

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

test('workspace lead uses canonical scope and current authority through actual SDK and Pi', async () => {
  const host = await startNodePiDurableCandidateHost({ workspaceScope: true })
  try {
    const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
    const intentId = randomUUID()
    await host.registerIntent({ intentId, projectId: null })
    const command = host.envelope(
      'pi-durable.lead.dispatch',
      { intentId },
      'candidate:workspace-positive',
      null
    )
    const admitted = (await sdk.dispatchPiDurableLead(command)).data
    await host.drain()
    const status = (
      await sdk.getPiDurableLeadStatus(
        host.read('pi-durable.lead.status', { dispatchId: admitted.dispatchId }, null)
      )
    ).data.status
    expect(status.state).toBe('completed')
    expect(status.result.output).toEqual({ text: 'Candidate canonical answer' })
    const evidence = await host.evidence(intentId)
    expect(evidence.execution.correlation.executionScope).toEqual({
      schemaVersion: 1,
      kind: 'workspace',
    })
    expect(evidence.execution.correlation.projectId).toBeUndefined()
    expect(evidence.execution.executionPlan.schemaVersion).toBe(2)
    expect(evidence.usage.filter((entry) => entry.kind === 'model_usage')).toHaveLength(1)
    expect((await sdk.dispatchPiDurableLead(command)).data).toMatchObject({
      dispatchId: admitted.dispatchId,
      replayed: true,
    })
    const progress = (
      await sdk.getPiDurableLeadProgress(
        host.read('pi-durable.lead.progress', { dispatchId: admitted.dispatchId }, null)
      )
    ).data.events
    expect(progress.length).toBeGreaterThan(1)
    const tail = (
      await sdk.getPiDurableLeadProgress(
        host.read(
          'pi-durable.lead.progress',
          { dispatchId: admitted.dispatchId, afterSequence: progress[0].sequence },
          null
        )
      )
    ).data.events
    expect(tail).toEqual(progress.slice(1))
    await host.awaitInput(admitted.dispatchId)
    const cancelled = await sdk.cancelPiDurableLead(
      host.envelope(
        'pi-durable.lead.cancel',
        { dispatchId: admitted.dispatchId },
        'candidate:workspace-cancel',
        null
      )
    )
    expect(cancelled.data.state).toBe('cancelled')
    const before = host.metrics()
    host.setScopeFault('revoked-grant')
    await expect(sdk.dispatchPiDurableLead(command)).rejects.toThrow()
    expect(host.metrics().providerRequests).toBe(before.providerRequests)
    expect(host.metrics().commands).toBe(1)
  } finally {
    await host.close()
  }
}, 30000)

test('invalid current workspace authority denies before canonical markers, attempts or budget', async () => {
  for (const fault of [
    'revoked-grant',
    'inactive-principal',
    'no-audience',
    'expired',
    'stale-plan',
    'cross-scope',
    'cross-workspace',
    'unsupported-adapter',
    'provider-revoked',
  ]) {
    const host = await startNodePiDurableCandidateHost({ workspaceScope: true })
    try {
      const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
      const intentId = randomUUID()
      await host.registerIntent({ intentId, projectId: null })
      host.setScopeFault(fault)
      await expect(
        sdk.dispatchPiDurableLead(
          host.envelope(
            'pi-durable.lead.dispatch',
            { intentId },
            `candidate:workspace-denied:${fault}`,
            null
          )
        )
      ).rejects.toThrow()
      expect(host.metrics()).toMatchObject({
        commands: 0,
        executions: 0,
        attempts: 0,
        usageBudgets: 0,
        intentAdmissions: 0,
        dispatchReceipts: 0,
        runtimeAdmissions: 0,
        providerRequests: 0,
      })
    } finally {
      await host.close()
    }
  }
}, 30000)

test('explicit project plan2 retains its original product actor and scope through admission and Pi', async () => {
  const host = await startNodePiDurableCandidateHost({ workspaceScope: true })
  try {
    const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
    const intentId = randomUUID()
    await host.registerIntent({
      intentId,
      projectId: host.explicitProjectId,
      explicitProjectScope: true,
    })
    const admitted = (
      await sdk.dispatchPiDurableLead(
        host.envelope('pi-durable.lead.dispatch', { intentId }, 'candidate:project2')
      )
    ).data
    await host.drain()
    const status = (
      await sdk.getPiDurableLeadStatus(
        host.read('pi-durable.lead.status', { dispatchId: admitted.dispatchId })
      )
    ).data.status
    expect(status.state).toBe('completed')
    const evidence = await host.evidence(intentId)
    expect(evidence.execution.correlation.executionScope).toEqual({
      schemaVersion: 1,
      kind: 'project',
      projectId: host.explicitProjectId,
    })
    expect(evidence.execution.executionPlan.schemaVersion).toBe(2)
    expect(evidence.product.canonicalActorPrincipalId).not.toBe(host.principalId)
    expect(host.metrics().providerRequests).toBe(1)
  } finally {
    await host.close()
  }
}, 30000)

test('workspace cancellation fences an actual in-flight provider send and retains its uncertain usage hold', async () => {
  const host = await startNodePiDurableCandidateHost({ workspaceScope: true })
  try {
    const sdk = new ControlPlaneClient({ baseUrl: host.baseUrl, credential: host.testCredential })
    const intentId = randomUUID()
    await host.registerIntent({ intentId, projectId: null })
    host.holdProviderResponse()
    const admitted = (
      await sdk.dispatchPiDurableLead(
        host.envelope(
          'pi-durable.lead.dispatch',
          { intentId },
          'candidate:cancel-active:dispatch',
          null
        )
      )
    ).data
    const deadline = Date.now() + 5000
    while (host.metrics().providerRequests === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(host.metrics().providerRequests).toBe(1)
    const cancel = host.envelope(
      'pi-durable.lead.cancel',
      { dispatchId: admitted.dispatchId },
      'candidate:cancel-active:cancel',
      null
    )
    const result = (await sdk.cancelPiDurableLead(cancel)).data
    expect(result.state).toBe('cancelling')
    host.releaseProviderResponse()
    await host.drain()
    const replay = (await sdk.cancelPiDurableLead(cancel)).data
    expect(replay.state).toBe('cancelling')
    const evidence = await host.evidence(intentId)
    expect(evidence.usage.filter((entry) => entry.kind === 'model_usage')).toHaveLength(0)
    expect(evidence.usage.filter((entry) => entry.kind === 'model_reservation')).toHaveLength(1)
    expect(evidence.modelHolds).toHaveLength(1)
    expect(evidence.modelHolds[0].status).toBe('open')
    expect(host.metrics()).toMatchObject({
      commands: 1,
      executions: 1,
      attempts: 1,
      providerRequests: 1,
    })
    expect(result.runtimeSessionId).toBe(admitted.runtimeSessionId)
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
