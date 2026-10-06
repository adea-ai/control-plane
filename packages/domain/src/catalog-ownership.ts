export interface CatalogOwnershipAccessScope {
  readonly workspaceId: string
  readonly principalId: string
}

/**
 * Catalog ownership is resource authority, separate from a service credential's
 * workspace/project claims. Organization entries remain inaccessible until a
 * trusted organization-membership source is wired into the request path.
 */
export function catalogOwnershipAllowsAccess(
  value: unknown,
  scope: CatalogOwnershipAccessScope
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ownership = value as Record<string, unknown>
  switch (ownership['scope']) {
    case 'system':
      return Object.keys(ownership).length === 1
    case 'workspace':
      return Object.keys(ownership).length === 2 && ownership['workspaceId'] === scope.workspaceId
    case 'private':
      return Object.keys(ownership).length === 2 && ownership['principalRef'] === scope.principalId
    case 'organization':
    default:
      return false
  }
}

export type WorkspaceCatalogVisibility = 'owned' | 'system'

/** `owned` for the exact workspace, `system` for read-only system entries, else invisible. */
export function workspaceCatalogVisibility(
  ownership: unknown,
  workspaceId: string
): WorkspaceCatalogVisibility | undefined {
  if (ownership === null || typeof ownership !== 'object' || Array.isArray(ownership)) {
    return undefined
  }
  const value = ownership as Record<string, unknown>
  if (value['scope'] === 'system' && Object.keys(value).length === 1) return 'system'
  if (
    value['scope'] === 'workspace' &&
    Object.keys(value).length === 2 &&
    value['workspaceId'] === workspaceId
  ) {
    return 'owned'
  }
  return undefined
}

/** Shared by the record-store adapters; PostgreSQL applies the same filter in SQL. */
export function visiblePage<Item extends { readonly ownership: unknown }>(
  items: readonly Item[],
  idOf: (item: Item) => string,
  query: {
    readonly workspaceId: string
    readonly after?: string | undefined
    readonly limit: number
  }
): Item[] {
  return items
    .filter(
      (item) =>
        workspaceCatalogVisibility(item.ownership, query.workspaceId) !== undefined &&
        (query.after === undefined || idOf(item) > query.after)
    )
    .toSorted((left, right) => (idOf(left) < idOf(right) ? -1 : idOf(left) > idOf(right) ? 1 : 0))
    .slice(0, query.limit)
}
