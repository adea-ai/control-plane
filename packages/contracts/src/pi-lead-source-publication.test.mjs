import { expect, test } from 'bun:test'
import { piLeadConversationAgentContextRef } from './pi-lead-source-authority.ts'
import { PiLeadSourcePublicationSchema } from './pi-lead-source-publication.ts'

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
    profileVersionId: id('pfv', '4'),
    profileContentDigest: `sha256:${'b'.repeat(64)}`,
    selectionRef: `msel_${'c'.repeat(32)}`,
    selectionRevision: 2,
    executionId: id('exe', '5'),
    attemptId: id('att', '6'),
    runtimeSessionId: id('ses', '7'),
  }
  return {
    schemaVersion: 'pi-lead-source-publication/v1',
    binding,
    publication: {
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
    },
  }
}
test('source publication metadata retains the host target and exact source execution pins without output', () => {
  const value = fixture()
  expect(PiLeadSourcePublicationSchema.parse(value)).toEqual(value)
  expect(
    PiLeadSourcePublicationSchema.safeParse({ ...value, output: 'Private answer' }).success
  ).toBe(false)
})
test.each([
  'workspaceId',
  'intentId',
  'executionId',
  'attemptId',
  'runtimeSessionId',
  'selectionRef',
  'selectionRevision',
  'canonicalActorPrincipalId',
])('substituted publication %s cannot authorize a retained host/source result', (pin) => {
  const value = fixture()
  const substitutions = {
    workspaceId: value.binding.authority.host.workspaceId,
    intentId: uuid('8'),
    executionId: id('exe', '8'),
    attemptId: id('att', '8'),
    runtimeSessionId: id('ses', '8'),
    selectionRef: `msel_${'8'.repeat(32)}`,
    selectionRevision: 3,
    canonicalActorPrincipalId: `user:${uuid('8')}`,
  }
  value.publication[pin] = substitutions[pin]
  expect(PiLeadSourcePublicationSchema.safeParse(value).success).toBe(false)
})
