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
