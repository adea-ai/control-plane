import { describe, expect, test } from 'bun:test'

import { describeWorkspaceCreationContext } from '../../src/workspace-creation-context'

describe('workspace creation context copy', () => {
  test('names a known owner and placement', () => {
    expect(
      describeWorkspaceCreationContext({ ownerLabel: 'Acme', placementLabel: 'Home scene' })
    ).toBe('Owned by Acme · Only you · Located in Home scene')
  })

  test('falls back to the owner sentence without inventing identity', () => {
    expect(describeWorkspaceCreationContext({})).toBe(
      "You'll be the owner · Only you · Location unknown"
    )
    expect(describeWorkspaceCreationContext({ ownerLabel: '  ' })).toContain("You'll be the owner")
  })

  test('labels unknown placement honestly', () => {
    expect(describeWorkspaceCreationContext({ ownerLabel: 'Acme' })).toContain('Location unknown')
    expect(describeWorkspaceCreationContext({ placementLabel: '' })).toContain('Location unknown')
  })

  test('trims padded labels instead of echoing whitespace', () => {
    expect(
      describeWorkspaceCreationContext({ ownerLabel: '  Acme  ', placementLabel: '  Cloud  ' })
    ).toBe('Owned by Acme · Only you · Located in Cloud')
  })

  test('never claims shared access: the audience is always owner-only', () => {
    for (const input of [
      {},
      { ownerLabel: 'Acme' },
      { placementLabel: 'Cloud' },
      { ownerLabel: 'Acme', placementLabel: 'Cloud' },
    ] as const)
      expect(describeWorkspaceCreationContext(input)).toContain('Only you')
  })
})
