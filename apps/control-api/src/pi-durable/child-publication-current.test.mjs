import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { PublicContractFixtures } from '@control-plane/contracts'
import { PiChildPublicationService } from './child-publication-current.service.ts'

const suffix = '01JABCDEF0123456789ABCDEFG'
const instant = '2026-10-08T00:00:01.000Z'
const binding = {
  schemaVersion: 'pi-lead-publication/v1',
  workspaceId: `wsp_${suffix}`,
  intentId: randomUUID(),
  dispatchId: `dispatch_${'a'.repeat(32)}`,
  preparationRef: `prep_${'b'.repeat(32)}`,
  executionId: `exe_${suffix}`,
  attemptId: `att_${suffix}`,
  runtimeSessionId: `ses_${suffix}`,
  selectionRef: `msel_${'c'.repeat(32)}`,
  selectionRevision: 1,
  canonicalActorPrincipalId: `user:${randomUUID()}`,
}
const record = {
  delegationId: `dlg_${suffix}`,
  parentExecutionId: binding.executionId,
  parentAttemptId: binding.attemptId,
  childExecutionId: `exe_01JBBCDEF0123456789ABCDEFG`,
  childAttemptId: `att_01JBBCDEF0123456789ABCDEFG`,
  parentExecutionPlanId: `pln_${suffix}`,
  parentExecutionPlanDigest: `sha256:${'a'.repeat(64)}`,
  childExecutionPlanId: `pln_01JBBCDEF0123456789ABCDEFG`,
  childExecutionPlanDigest: `sha256:${'b'.repeat(64)}`,
  contextPackageId: `ctx_${suffix}`,
  contextPackageDigest: `sha256:${'c'.repeat(64)}`,
  role: 'researcher',
  profileVersionId: `pfv_${suffix}`,
  objective: 'Research',
  policy: {
    cancellation: 'independent',
    deadline: 'independent_within_plan',
    failure: 'fail_parent',
    maximumRetries: 0,
  },
  state: 'completed',
  retryCount: 0,
  inputDigest: `sha256:${'d'.repeat(64)}`,
  revision: 3,
  acceptedAt: instant,
  updatedAt: instant,
  terminalResultRef: `art_${suffix}`,
  terminalConclusion: 'The bounded question is resolved.',
  terminalPublication: { status: 'published', idempotencyKey: `delegation:dlg_${suffix}:terminal` },
}
const event = {
  type: 'delegation.completed',
  delegationId: record.delegationId,
  parentExecutionId: record.parentExecutionId,
  childExecutionId: record.childExecutionId,
  occurredAt: instant,
  details: {
    state: 'completed',
    childAttemptId: record.childAttemptId,
    terminalResultRef: record.terminalResultRef,
    conclusion: record.terminalConclusion,
  },
}
const { projectId: _, ...read } = PublicContractFixtures.request
const request = {
  ...read,
  operation: 'pi-durable.child.publication.current',
  parameters: {
    dispatchId: binding.dispatchId,
    preparationRef: binding.preparationRef,
    delegationId: record.delegationId,
  },
}
const principal = {
  principalId: read.caller.servicePrincipalId,
  kind: 'agent_hq_service',
  projectIds: [],
  workspaceIds: [binding.workspaceId],
  scopes: ['execution:read'],
}
function make() {
  const state = {
    binding: structuredClone(binding),
    record: structuredClone(record),
    events: [structuredClone(event)],
    reads: 0,
    checks: 0,
    denied: false,
  }
  const service = new PiChildPublicationService({
    readRetained: async () => {
      state.reads++
      return { binding: structuredClone(state.binding), status: {} }
    },
    listChildren: async () => [structuredClone(state.record)],
    listParentEvents: async () => structuredClone(state.events),
    assertCurrent: async () => {
      state.checks++
      if (state.denied) throw new Error('CP_GRANT_REVOKED')
      return { authorityRevision: 1, expiresAt: '2026-10-08T00:00:20.000Z' }
    },
    now: () => '2026-10-08T00:00:02.000Z',
  })
  return { state, service }
}
test('retained terminal event and current CP grant yield only the attested conclusion', async () => {
  const { service, state } = make()
  const output = (await service.current(request, principal)).data.publication
  expect(output).toMatchObject({
    delegationId: record.delegationId,
    state: 'completed',
    resultRef: record.terminalResultRef,
    conclusion: record.terminalConclusion,
    attemptId: binding.attemptId,
  })
  expect(output).not.toHaveProperty('content')
  expect(state.reads).toBe(2)
  expect(state.checks).toBe(1)
})
test('missing/out-of-order/contradictory inbox, stale attempt and revoked grant fail closed', async () => {
  for (const fault of [
    'missing',
    'pending',
    'wrong-attempt',
    'wrong-event',
    'wrong-result',
    'wrong-conclusion',
    'revoked',
  ]) {
    const { service, state } = make()
    if (fault === 'missing') state.events = []
    if (fault === 'pending') state.record.terminalPublication.status = 'pending'
    if (fault === 'wrong-attempt') state.record.parentAttemptId = `att_01JBBCDEF0123456789ABCDEFG`
    if (fault === 'wrong-event') state.events[0].details.childAttemptId = binding.attemptId
    if (fault === 'wrong-result')
      state.events[0].details.terminalResultRef = `art_01JBBCDEF0123456789ABCDEFG`
    if (fault === 'wrong-conclusion') state.events[0].details.conclusion = 'Forged answer.'
    if (fault === 'revoked') state.denied = true
    await expect(service.current(request, principal)).rejects.toThrow()
  }
})
test('failed and cancelled child metadata survives lead outcome, with exact event replay', async () => {
  for (const terminal of ['failed', 'cancelled']) {
    const { service, state } = make()
    state.record.state = terminal
    delete state.record.terminalResultRef
    delete state.record.terminalConclusion
    state.events[0].type = `delegation.${terminal}`
    state.events[0].details.state = terminal
    delete state.events[0].details.terminalResultRef
    delete state.events[0].details.conclusion
    if (terminal === 'failed') {
      state.record.failureCode = 'RUNTIME_ERROR'
      state.events[0].details.failureCode = 'RUNTIME_ERROR'
    }
    expect((await service.current(request, principal)).data.publication.state).toBe(terminal)
    expect((await service.current(request, principal)).data.publication).not.toHaveProperty(
      'resultRef'
    )
  }
})
