import { expect, test } from 'bun:test'

import { stripWorkspaceDeepLinkSearch, WORKSPACE_DEEP_LINK_KEYS } from '../src/lib/workspace-search'

/**
 * Regression for the stale deep-link completion (Adea #1207/#1234 task-board
 * failure): @tanstack/solid-router replaces the search with the value of
 * whichever overlapping navigate commits last (reproduced against the real
 * router in apps/web/e2e/workspace-navigation-race.spec.ts). A strip that
 * captures a value before a newer app switch would overwrite the switch and
 * drop `app=kanban`, unmounting the board. The functional updater applied by
 * consumeDeepLink strips only the deep-link keys from the latest search.
 */
test('a late deep-link completion cannot overwrite a newer app switch', () => {
  const beforeSwitch = { channel: 'c1', message: 'm1' }
  const switched = { ...beforeSwitch, app: 'kanban' }

  // The hazard: the old value snapshot, committed last, replaced the search
  // with the pre-switch state.
  const staleSnapshot = stripWorkspaceDeepLinkSearch(beforeSwitch)
  expect(staleSnapshot).not.toHaveProperty('app')

  // The fix: the strip runs against the latest search, so the switch survives
  // no matter when the completion lands.
  expect(stripWorkspaceDeepLinkSearch(switched)).toEqual({ app: 'kanban' })
})

test('the strip removes only the one-shot deep-link keys', () => {
  const stripped = stripWorkspaceDeepLinkSearch({
    app: 'kanban',
    channel: 'c1',
    directory: 'inbox',
    message: 'm1',
    task: 't1',
    thread: 'th1',
    view: 'chat',
    workspace: 'w1',
  })

  expect(stripped).toEqual({ app: 'kanban', directory: 'inbox', view: 'chat' })
  for (const key of WORKSPACE_DEEP_LINK_KEYS) expect(stripped).not.toHaveProperty(key)
})
