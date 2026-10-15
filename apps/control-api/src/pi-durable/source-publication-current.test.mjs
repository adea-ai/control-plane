import { expect, test } from 'bun:test'
import { piLeadConversationAgentContextRef } from './source-authority-contract.ts'
import { createSourcePiLeadPublicationReader } from './source-publication-current.ts'

const id = (kind, char) => `${kind}_${char.repeat(26)}`
const uuid = (char) =>
  `${char.repeat(8)}-${char.repeat(4)}-4${char.repeat(3)}-8${char.repeat(3)}-${char.repeat(12)}`
function fixture() {
  const authority = {
    schemaVersion: 'pi-lead-host-source-authority/v1',
    intentId: uuid('1'),
    host: {
      workspaceId: id('wsp', '1'),
      productWorkspaceId: uuid('2'),
      conversationId: uuid('3'),
      conversationVersion: 1,
      messageId: uuid('4'),
      messageVersion: 1,
      canonicalActorPrincipalId: `user:${uuid('5')}`,
      audienceDigest: `sha256:${'a'.repeat(64)}`,
      enlistmentGrantId: 'gra_source',
      enlistmentRevision: 1,
    },
    source: {
      workspaceId: id('wsp', '2'),
      productWorkspaceId: uuid('6'),
      agentId: id('agt', '3'),
      productAgentId: uuid('7'),
      profileId: 'source-profile',
      profileVersion: '1.0.0',
      profileRevision: 1,
    },
    contextRef: '',
  }
  authority.contextRef = piLeadConversationAgentContextRef(authority)
  const binding = {
    schemaVersion: 'pi-lead-source-execution-binding/v1',
    authority,
    intentExpiresAt: '2026-10-13T12:04:00.000Z',
    profileVersionId: id('pfv', '4'),
    profileContentDigest: `sha256:${'b'.repeat(64)}`,
    selectionRef: `msel_${'c'.repeat(32)}`,
    selectionRevision: 2,
    executionId: id('exe', '5'),
    attemptId: id('att', '6'),
    runtimeSessionId: id('ses', '7'),
  }
  const publication = {
    schemaVersion: 'pi-lead-publication/v1',
    workspaceId: authority.source.workspaceId,
    intentId: authority.intentId,
    dispatchId: `dispatch_${'d'.repeat(32)}`,
    preparationRef: `prep_${'e'.repeat(32)}`,
    executionId: binding.executionId,
    attemptId: binding.attemptId,
    runtimeSessionId: binding.runtimeSessionId,
    selectionRef: binding.selectionRef,
    selectionRevision: binding.selectionRevision,
    canonicalActorPrincipalId: authority.host.canonicalActorPrincipalId,
    authorityRevision: 1,
    resultContentDigest: `sha256:${'f'.repeat(64)}`,
    expiresAt: '2026-10-13T12:00:30.000Z',
  }
  const input = {
    contractVersion: { major: 1, minor: 0 },
    requestId: id('req', '8'),
    correlation: { traceId: id('trc', '8') },
    caller: { servicePrincipalId: 'svc_source-test' },
    workspaceId: authority.source.workspaceId,
    operation: 'pi-durable.lead.publication.current',
    requestedAt: '2026-10-13T12:00:00.000Z',
    parameters: { dispatchId: publication.dispatchId, preparationRef: publication.preparationRef },
  }
  const principal = {
    kind: 'agent_hq_service',
    principalId: 'svc_source-test',
    workspaceIds: [authority.source.workspaceId],
    projectIds: [],
    scopes: ['execution:read'],
  }
  const state = { checks: 0, reads: 0, revoked: false, now: input.requestedAt }
  const options = {
    now: () => state.now,
    withCurrentAuthorization: async (_input, accept) => {
      if (state.revoked) throw new Error('SOURCE_PUBLICATION_REVOKED')
      return accept()
    },
    core: {
      current: async () => {
        state.checks++
        if (state.revoked) throw new Error('SOURCE_PUBLICATION_REVOKED')
        return {
          contractVersion: input.contractVersion,
          requestId: input.requestId,
          correlation: input.correlation,
          data: { publication: structuredClone(publication) },
        }
      },
    },
    readBinding: async (intentId) => {
      state.reads++
      expect(intentId).toBe(authority.intentId)
      return structuredClone(binding)
    },
  }
  return {
    input,
    principal,
    state,
    options,
    binding,
    publication,
    reader: createSourcePiLeadPublicationReader(options),
  }
}
test('metadata joins the exact host target with a freshly revalidated source publication', async () => {
  const f = fixture()
  const result = await f.reader.current(f.input, f.principal)
  expect(result.binding).toEqual(f.binding)
  expect(result.publication).toEqual(f.publication)
  expect(f.state.checks).toBe(2)
  expect(f.state.reads).toBe(1)
  expect(result).not.toHaveProperty('output')
})
test('source revocation during the retained metadata read cannot use the earlier publication assertion', async () => {
  const f = fixture()
  f.options.readBinding = async () => {
    f.state.revoked = true
    return f.binding
  }
  await expect(f.reader.current(f.input, f.principal)).rejects.toThrow('SOURCE_PUBLICATION_REVOKED')
  expect(f.state.checks).toBe(2)
})
test('publication cannot renew the fixed intent deadline and expiry during awaited metadata denies', async () => {
  const shortened = fixture()
  shortened.binding.intentExpiresAt = '2026-10-13T12:00:10.000Z'
  expect(
    (await shortened.reader.current(shortened.input, shortened.principal)).publication.expiresAt
  ).toBe(shortened.binding.intentExpiresAt)
  const expired = fixture()
  expired.options.readBinding = async () => {
    expired.state.now = expired.binding.intentExpiresAt
    return expired.binding
  }
  await expect(expired.reader.current(expired.input, expired.principal)).rejects.toThrow(
    'PI_LEAD_SOURCE_PUBLICATION_UNAVAILABLE'
  )
})
test('host workspace or a changed native session cannot replace source publication scope', async () => {
  for (const fault of ['host', 'session']) {
    const f = fixture()
    if (fault === 'host') f.publication.workspaceId = f.binding.authority.host.workspaceId
    else f.publication.runtimeSessionId = id('ses', '9')
    await expect(f.reader.current(f.input, f.principal)).rejects.toThrow()
  }
})
test('the final combined CP fence is required and expiry can lapse while it acquires authority', async () => {
  const missing = fixture()
  const { withCurrentAuthorization: _fence, ...unfenced } = missing.options
  expect(() => createSourcePiLeadPublicationReader(unfenced)).toThrow(
    'PI_LEAD_SOURCE_PUBLICATION_REQUIRED'
  )
  const expired = fixture()
  expired.options.withCurrentAuthorization = async (_input, accept) => {
    expired.state.now = expired.binding.intentExpiresAt
    return accept()
  }
  await expect(expired.reader.current(expired.input, expired.principal)).rejects.toThrow(
    'PI_LEAD_SOURCE_PUBLICATION_UNAVAILABLE'
  )
})
test.each([0, 30_001])(
  'publication at now + %d milliseconds is rejected at final acceptance',
  async (offset) => {
    const f = fixture()
    f.publication.expiresAt = new Date(Date.parse(f.state.now) + offset).toISOString()
    await expect(f.reader.current(f.input, f.principal)).rejects.toThrow(
      'PI_LEAD_SOURCE_PUBLICATION_UNAVAILABLE'
    )
  }
)
test('publication expiry crossing a delayed final authorization fence denies exactly at expiry', async () => {
  const f = fixture()
  let waited = false
  f.options.withCurrentAuthorization = async (_input, accept) => {
    await Promise.resolve()
    waited = true
    f.state.now = f.publication.expiresAt
    return accept()
  }
  await expect(f.reader.current(f.input, f.principal)).rejects.toThrow(
    'PI_LEAD_SOURCE_PUBLICATION_UNAVAILABLE'
  )
  expect(waited).toBe(true)
})
