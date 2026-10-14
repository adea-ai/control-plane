import { expect, test } from 'bun:test'
import {
  PiLeadHostSourceAuthoritySchema,
  PiLeadSourceExecutionBindingSchema,
  piLeadConversationAgentContextRef,
  assertPiLeadSourceExecutionBindingCurrent,
} from './source-authority-contract.ts'

const id = (prefix, char) => `${prefix}_${char.repeat(26)}`
const uuid = (char) =>
  `${char.repeat(8)}-${char.repeat(4)}-4${char.repeat(3)}-8${char.repeat(3)}-${char.repeat(12)}`
export function sourceAuthorityFixture() {
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
      profileId: 'canonical-source-profile',
      profileVersion: '1.0.0',
      profileRevision: 1,
    },
    contextRef: '',
  }
  authority.contextRef = piLeadConversationAgentContextRef(authority)
  return authority
}
function bindingFixture() {
  return {
    schemaVersion: 'pi-lead-source-execution-binding/v1',
    authority: sourceAuthorityFixture(),
    intentExpiresAt: '2026-10-13T12:04:00.000Z',
    profileVersionId: id('pfv', '4'),
    profileContentDigest: `sha256:${'b'.repeat(64)}`,
    selectionRef: `msel_${'c'.repeat(32)}`,
    selectionRevision: 2,
    executionId: id('exe', '5'),
    attemptId: id('att', '6'),
    runtimeSessionId: id('ses', '7'),
  }
}
test('the complete foreign binding validates without conferring execution authority', () => {
  expect(PiLeadSourceExecutionBindingSchema.parse(bindingFixture())).toEqual(bindingFixture())
})
test('missing source identity and caller-added authorization fields fail closed', () => {
  const authority = sourceAuthorityFixture()
  for (const missing of [
    'workspaceId',
    'productWorkspaceId',
    'agentId',
    'productAgentId',
    'profileId',
    'profileVersion',
    'profileRevision',
  ]) {
    const changed = structuredClone(authority)
    delete changed.source[missing]
    expect(PiLeadHostSourceAuthoritySchema.safeParse(changed).success).toBe(false)
  }
  expect(
    PiLeadHostSourceAuthoritySchema.safeParse({ ...authority, sourceAuthorized: true }).success
  ).toBe(false)
  expect(
    PiLeadHostSourceAuthoritySchema.safeParse({
      ...authority,
      source: { ...authority.source, grants: ['host-grant'] },
    }).success
  ).toBe(false)
})
test('host workspace cannot replace a foreign source workspace mapping', () => {
  const authority = sourceAuthorityFixture()
  for (const key of ['workspaceId', 'productWorkspaceId']) {
    const changed = structuredClone(authority)
    changed.source[key] = changed.host[key]
    changed.contextRef = piLeadConversationAgentContextRef(changed)
    expect(PiLeadHostSourceAuthoritySchema.safeParse(changed).success).toBe(false)
  }
})
test('two host groups and same-name Agents use qualified isolated context identities', () => {
  const original = sourceAuthorityFixture()
  for (const [part, key, value] of [
    ['host', 'conversationId', uuid('8')],
    ['source', 'productAgentId', uuid('8')],
    ['source', 'agentId', id('agt', '8')],
    ['source', 'workspaceId', id('wsp', '8')],
  ]) {
    const changed = structuredClone(original)
    changed[part][key] = value
    expect(piLeadConversationAgentContextRef(changed)).not.toBe(original.contextRef)
    expect(PiLeadHostSourceAuthoritySchema.safeParse(changed).success).toBe(false)
  }
})
test('a new message retains conversation+Agent context without retaining turn authority', () => {
  const original = sourceAuthorityFixture()
  const changed = structuredClone(original)
  changed.intentId = uuid('9')
  changed.host.messageId = uuid('9')
  changed.host.conversationVersion++
  expect(piLeadConversationAgentContextRef(changed)).toBe(original.contextRef)
  expect(() => assertPiLeadSourceExecutionBindingCurrent(bindingFixture(), changed)).toThrow(
    'PI_LEAD_SOURCE_BINDING_CHANGED'
  )
})
test('source, actor, audience, enlistment or immutable profile changes deny retained execution', () => {
  const binding = bindingFixture()
  for (const [part, key, value] of [
    ['source', 'profileId', 'host-profile'],
    ['source', 'profileVersion', '2.0.0'],
    ['source', 'profileRevision', 2],
    ['source', 'productWorkspaceId', uuid('8')],
    ['host', 'canonicalActorPrincipalId', `user:${uuid('8')}`],
    ['host', 'audienceDigest', `sha256:${'d'.repeat(64)}`],
    ['host', 'enlistmentGrantId', 'gra_reenlisted'],
    ['host', 'enlistmentRevision', 2],
    ['host', 'messageVersion', 2],
  ]) {
    const changed = structuredClone(binding.authority)
    changed[part][key] = value
    changed.contextRef = piLeadConversationAgentContextRef(changed)
    expect(() => assertPiLeadSourceExecutionBindingCurrent(binding, changed)).toThrow(
      'PI_LEAD_SOURCE_BINDING_CHANGED'
    )
  }
})
test('a current metadata binding is returned as an isolated parsed value', () => {
  const binding = bindingFixture()
  const current = assertPiLeadSourceExecutionBindingCurrent(binding, binding.authority)
  binding.authority.source.profileId = 'changed-after-check'
  expect(current.authority.source.profileId).toBe('canonical-source-profile')
})
