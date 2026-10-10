import { createSignal } from 'solid-js'

/**
 * Per-workspace change marker for lead setup. Any lead-relevant change (a saved
 * default, a registered or revoked connection, an explicit refresh) bumps it, so
 * every mounted lead status for that workspace reloads, including one behind an
 * open settings dialog and one whose dialog closed during a delayed save.
 */
const [revisions, setRevisions] = createSignal<Readonly<Record<string, number>>>({})

export function markWorkspaceLeadChanged(workspaceId: string): void {
  setRevisions((current) => ({ ...current, [workspaceId]: (current[workspaceId] ?? 0) + 1 }))
}

export function workspaceLeadRevision(workspaceId: string): number {
  return revisions()[workspaceId] ?? 0
}
