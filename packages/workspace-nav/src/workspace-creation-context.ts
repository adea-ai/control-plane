/**
 * Workspace creation context (#1261): who owns, who can access, and where it
 * lives — stated from existing contracts only, never invented.
 *
 * The server creates exactly one membership row (role owner) for the
 * creator, so the initial audience is always owner-only. Placement has no
 * server contract behind these surfaces: a host that knows it passes
 * `placementLabel`, everyone else gets the honest unknown label. The same
 * copy contract lives in apps/web for the empty-state surface; both are
 * pinned by unit tests so the wording cannot drift apart silently.
 */
export type WorkspaceCreationContext = Readonly<{
  /** Signed-in account label when the host knows it; omitted for guests/unknowns. */
  ownerLabel?: string
  /** Actual placement when the host knows it; unknown is labeled honestly. */
  placementLabel?: string
}>

export function describeWorkspaceCreationContext(context: WorkspaceCreationContext = {}): string {
  const owner =
    context.ownerLabel !== undefined && context.ownerLabel.trim() !== ''
      ? `Owned by ${context.ownerLabel.trim()}`
      : `You'll be the owner`
  const placement =
    context.placementLabel !== undefined && context.placementLabel.trim() !== ''
      ? `Located in ${context.placementLabel.trim()}`
      : `Location unknown`
  return `${owner} · Only you · ${placement}`
}
