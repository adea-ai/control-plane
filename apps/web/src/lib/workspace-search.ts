/**
 * One-shot deep-link search parameters. A surface consumes them exactly once
 * (channel/message/thread/task selection, workspace scoping); they must never
 * ride along into another app's search or be restored by a late completion.
 *
 * The navigation-race regression in `apps/web/test/workspace-search.test.ts`
 * pins the hazard: @tanstack/solid-router replaces the search with the value
 * of whichever overlapping `navigate` commits last, so a strip that captures a
 * value before a newer app switch would replace the switch and drop
 * `app=kanban`, unmounting the task board.
 */
export const WORKSPACE_DEEP_LINK_KEYS = [
  'channel',
  'message',
  'task',
  'thread',
  'workspace',
] as const

export type WorkspaceDeepLinkKey = (typeof WORKSPACE_DEEP_LINK_KEYS)[number]

/**
 * Removes only the one-shot deep-link keys, preserving every other search
 * parameter (app switches, view, directory, scene, …). Use this as a
 * functional `navigate({ search: previous => … })` updater so a completion
 * that lands after a newer navigation strips the latest search instead of
 * overwriting it.
 */
export function stripWorkspaceDeepLinkSearch<T extends object>(search: T): T {
  const next = { ...(search as Record<string, unknown>) }
  for (const key of WORKSPACE_DEEP_LINK_KEYS) delete next[key]
  return next as T
}
