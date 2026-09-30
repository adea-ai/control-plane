import { describe, expect, test } from 'bun:test'
import { catalogOwnershipAllowsAccess } from './catalog-ownership.ts'

const scope = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  principalId: 'svc_agent-hq',
}

describe('catalog ownership authorization', () => {
  test('allows system-owned entries and an exact workspace match', () => {
    expect(catalogOwnershipAllowsAccess({ scope: 'system' }, scope)).toBe(true)
    expect(
      catalogOwnershipAllowsAccess({ scope: 'workspace', workspaceId: scope.workspaceId }, scope)
    ).toBe(true)
  })

  test('allows private entries only for the exact authenticated principal', () => {
    expect(
      catalogOwnershipAllowsAccess({ scope: 'private', principalRef: scope.principalId }, scope)
    ).toBe(true)
    expect(
      catalogOwnershipAllowsAccess({ scope: 'private', principalRef: 'svc_other' }, scope)
    ).toBe(false)
  })

  test('denies cross-workspace, organization, unknown, and malformed ownership', () => {
    expect(
      catalogOwnershipAllowsAccess(
        { scope: 'workspace', workspaceId: 'wsp_01JOTHERWORKSPACE00000000000' },
        scope
      )
    ).toBe(false)
    expect(
      catalogOwnershipAllowsAccess({ scope: 'organization', organizationRef: 'org:example' }, scope)
    ).toBe(false)
    expect(catalogOwnershipAllowsAccess({ scope: 'unexpected' }, scope)).toBe(false)
    expect(
      catalogOwnershipAllowsAccess({ scope: 'system', principalRef: scope.principalId }, scope)
    ).toBe(false)
    expect(catalogOwnershipAllowsAccess(undefined, scope)).toBe(false)
  })
})
