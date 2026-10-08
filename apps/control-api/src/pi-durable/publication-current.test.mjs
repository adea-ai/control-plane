import { expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { PublicContractFixtures } from '@control-plane/contracts'
import { PiLeadPublicationService } from './publication-current.service.ts'
const suffix = '01JABCDEF0123456789ABCDEFG'
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
const status = {
  handle: {
    handleId: 'stored-only',
    attemptId: binding.attemptId,
    externalSessionId: binding.runtimeSessionId,
    startedAt: '2026-10-08T00:00:00.000Z',
  },
  state: 'completed',
  observedAt: '2026-10-08T00:00:01.000Z',
  result: {
    outcome: 'completed',
    output: { text: 'Exact committed output\n' },
    usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
    artifacts: [],
  },
}
const { projectId: _, ...read } = PublicContractFixtures.request
const request = {
  ...read,
  operation: 'pi-durable.lead.publication.current',
  parameters: { dispatchId: binding.dispatchId, preparationRef: binding.preparationRef },
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
    retained: { binding: structuredClone(binding), status: structuredClone(status) },
    denied: false,
    checks: 0,
  }
  const service = new PiLeadPublicationService({
    readRetained: async () => structuredClone(state.retained),
    assertCurrent: async () => {
      state.checks++
      if (state.denied) throw new Error('CP_GRANT_REVOKED')
      return { authorityRevision: 1, expiresAt: '2026-10-08T00:00:20.000Z' }
    },
    now: () => '2026-10-08T00:00:02.000Z',
  })
  return { service, state }
}
test('publication checks retained completion and independent CP authority with exact UTF8 newline digest', async () => {
  const { service, state } = make()
  const response = await service.current(request, principal)
  expect(response.data.publication).toMatchObject(binding)
  expect(response.data.publication.resultContentDigest).toBe(
    `sha256:${createHash('sha256').update(status.result.output.text, 'utf8').digest('hex')}`
  )
  expect(response.data.publication).not.toHaveProperty('output')
  expect(state.checks).toBe(1)
})
test('unconfigured authority, changed bindings, noncompleted result or revoked current CP grant denies', async () => {
  await expect(new PiLeadPublicationService().current(request, principal)).rejects.toThrow()
  for (const fault of ['binding', 'completion', 'grant']) {
    const { service, state } = make()
    if (fault === 'binding') state.retained.binding.preparationRef = `prep_${'d'.repeat(32)}`
    if (fault === 'completion') state.retained.status.state = 'failed'
    if (fault === 'grant') state.denied = true
    await expect(service.current(request, principal)).rejects.toThrow()
  }
})
test('current CP revocation during the final journal read cannot produce a publication', async () => {
  let reads = 0
  let revoked = false
  const service = new PiLeadPublicationService({
    readRetained: async () => {
      if (++reads === 2) revoked = true
      return { binding, status }
    },
    assertCurrent: async () => {
      if (revoked) throw new Error('CP_GRANT_REVOKED')
      return { authorityRevision: 1, expiresAt: '2026-10-08T00:00:20.000Z' }
    },
    now: () => '2026-10-08T00:00:02.000Z',
  })
  await expect(service.current(request, principal)).rejects.toThrow('CP_GRANT_REVOKED')
  expect(reads).toBe(2)
})
test('fuller authority returns cannot override canonical publication pins or committed output digest', async () => {
  const extra = {
    attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
    executionId: 'exe_01JBBCDEF0123456789ABCDEFG',
    canonicalActorPrincipalId: `user:${randomUUID()}`,
    resultContentDigest: `sha256:${'f'.repeat(64)}`,
    output: { text: 'Unrelated output' },
  }
  for (const [field, value] of Object.entries(extra)) {
    const service = new PiLeadPublicationService({
      readRetained: async () => ({ binding, status }),
      assertCurrent: async () => ({
        authorityRevision: 2,
        expiresAt: '2026-10-08T00:00:20.000Z',
        [field]: value,
      }),
      now: () => '2026-10-08T00:00:02.000Z',
    })
    const publication = (await service.current(request, principal)).data.publication
    expect(publication).toMatchObject(binding)
    expect(publication.resultContentDigest).toBe(
      `sha256:${createHash('sha256').update(status.result.output.text, 'utf8').digest('hex')}`
    )
    expect(publication).not.toHaveProperty('output')
    expect(publication.authorityRevision).toBe(2)
  }
})
test('malformed current authority revision or expiry denies publication', async () => {
  for (const authority of [
    { authorityRevision: 0, expiresAt: '2026-10-08T00:00:20.000Z' },
    { authorityRevision: 1, expiresAt: 'invalid' },
    { authorityRevision: 1, expiresAt: '2026-10-08T00:00:01.000Z' },
  ]) {
    const service = new PiLeadPublicationService({
      readRetained: async () => ({ binding, status }),
      assertCurrent: async () => authority,
      now: () => '2026-10-08T00:00:02.000Z',
    })
    await expect(service.current(request, principal)).rejects.toThrow()
  }
})
