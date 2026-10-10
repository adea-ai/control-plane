import type { MigrationSnapshotSection, NativeSessionSnapshotRecord } from '@adea-ai/types'
import type { RuntimeSession } from '@adea-ai/types/dev-runtime'

/**
 * Bounded read-only composition adapter for the runtime-owned session
 * inventory.
 *
 * The canonical authority is the execution host's `dev.session.list` read
 * (registry `packages/types/src/dev-runtime-registry.ts`, capability
 * `dev.session.read`, reply `Page<RuntimeSession>`), consumed by Adea through
 * the desktop bridge (`apps/web/src/lib/desktop-dev-runtime.ts`). This module
 * composes that read into the migration snapshot contract: it owns no
 * catalogue, caches nothing, resolves no credentials and derives nothing from
 * the wall clock. The caller injects the authenticated source; a deployment
 * without that source keeps the domain `unknown`/`unsupported_family` instead
 * of reading an absent inventory as empty.
 */

/** One page of the canonical runtime session read. */
export type NativeSessionInventoryPage = Readonly<{
  items: readonly RuntimeSession[]
  nextCursor?: string
}>

/**
 * The canonical registry bound for `dev.session.list`:
 * `limit integer(1..500)` (`packages/types/src/dev-runtime-registry.ts`).
 * Every composed request is capped here so a large snapshot bound never
 * produces a call the canonical validator would refuse.
 */
export const NATIVE_SESSION_INVENTORY_PAGE_LIMIT = 500

/**
 * The injected authoritative read. Authentication and transport belong to the
 * source; `authorizedScopes` is the source's explicit declaration of the
 * scope(s) it is authorized to read. The adapter validates every record
 * against that declaration — it never infers a scope, and an empty
 * declaration is refused rather than silently disabling the check. A source
 * that composes several authenticated scopes lists each one.
 */
export type NativeSessionInventorySource = Readonly<{
  authorizedScopes: readonly NativeSessionInventoryScope[]
  listRuntimeSessions: (
    input: Readonly<{ cursor?: string; limit: number }>
  ) => Promise<NativeSessionInventoryPage>
}>

/** Why the runtime session inventory could not be composed. */
export type NativeSessionInventoryFailure = 'denied' | 'invalid' | 'unavailable'

/** The account/workspace/node scope an authoritative read must stay inside. */
export type NativeSessionInventoryScope = Readonly<{
  accountId: string
  runtimeNodeId: string
  workspaceId: string
}>

export class NativeSessionInventoryError extends Error {
  readonly kind: NativeSessionInventoryFailure

  constructor(kind: NativeSessionInventoryFailure, message: string) {
    super(message)
    this.name = 'NativeSessionInventoryError'
    this.kind = kind
  }
}

const nativeSessionLifecycles = new Set([
  'preparing',
  'ready',
  'active',
  'disconnected',
  'completed',
  'failed',
  'cancelled',
])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || isNonEmptyString(value)
}

function isNullableCount(value: unknown): boolean {
  return (
    value === undefined || value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
  )
}

function isAuthorizedScope(
  scope: NativeSessionInventoryScope,
  authorizedScopes: readonly NativeSessionInventoryScope[]
): boolean {
  return authorizedScopes.some(
    (authorized) =>
      authorized.accountId === scope.accountId &&
      authorized.workspaceId === scope.workspaceId &&
      authorized.runtimeNodeId === scope.runtimeNodeId
  )
}

/**
 * Map one canonical `RuntimeSession` to its frozen snapshot record. A payload
 * that leaves the canonical contract — a bridge is an untrusted boundary — is
 * refused as `invalid` so the domain stays unknown instead of capturing a
 * fabricated row.
 */
function toRecord(
  session: RuntimeSession,
  authorizedScopes: readonly NativeSessionInventoryScope[]
): NativeSessionSnapshotRecord {
  const candidate = session as unknown as Record<string, unknown>
  const recordScope = candidate.scope as Record<string, unknown> | undefined
  if (
    !isNonEmptyString(candidate.id) ||
    !recordScope ||
    !isNonEmptyString(recordScope.accountId) ||
    !isNonEmptyString(recordScope.workspaceId) ||
    !isNonEmptyString(recordScope.runtimeNodeId) ||
    !isNonEmptyString(candidate.projectId) ||
    !isNonEmptyString(candidate.worktreeId) ||
    typeof candidate.lifecycle !== 'string' ||
    !nativeSessionLifecycles.has(candidate.lifecycle) ||
    typeof candidate.archived !== 'boolean' ||
    !Number.isSafeInteger(candidate.generation) ||
    (candidate.generation as number) < 0 ||
    !Number.isSafeInteger(candidate.version) ||
    (candidate.version as number) < 0 ||
    !isNullableString(candidate.agentProfileId) ||
    !isNullableCount(candidate.agentProfileVersion) ||
    !isNullableString(candidate.harnessInstallationId) ||
    !isNullableString(candidate.activeHarnessRunId)
  ) {
    throw new NativeSessionInventoryError(
      'invalid',
      'runtime session inventory returned a record outside the canonical contract'
    )
  }
  if (
    !isAuthorizedScope(
      {
        accountId: recordScope.accountId,
        runtimeNodeId: recordScope.runtimeNodeId,
        workspaceId: recordScope.workspaceId,
      },
      authorizedScopes
    )
  ) {
    throw new NativeSessionInventoryError(
      'invalid',
      'runtime session inventory returned a record outside the source authorized scopes'
    )
  }
  return Object.freeze({
    accountId: recordScope.accountId,
    activeHarnessRunId: (candidate.activeHarnessRunId as string | undefined) ?? null,
    agentProfileId: (candidate.agentProfileId as string | undefined) ?? null,
    agentProfileVersion: (candidate.agentProfileVersion as number | undefined) ?? null,
    archived: candidate.archived,
    family: 'nativeSessions',
    generation: candidate.generation as number,
    harnessInstallationId: (candidate.harnessInstallationId as string | undefined) ?? null,
    lifecycle: candidate.lifecycle,
    projectId: candidate.projectId,
    runtimeNodeId: recordScope.runtimeNodeId,
    sessionRef: candidate.id,
    version: candidate.version as number,
    workspaceId: recordScope.workspaceId,
    worktreeId: candidate.worktreeId,
  })
}

async function readPage(
  source: NativeSessionInventorySource,
  input: Readonly<{ cursor?: string; limit: number }>
): Promise<NativeSessionInventoryPage> {
  try {
    return await source.listRuntimeSessions(input)
  } catch (error) {
    if (error instanceof NativeSessionInventoryError) throw error
    throw new NativeSessionInventoryError(
      'unavailable',
      'the runtime session inventory read failed'
    )
  }
}

/**
 * Read the canonical inventory to exhaustion or the section bound and map it
 * to a frozen snapshot section. The read is bounded (one probe row past the
 * bound observes truncation), deterministic (records sorted by stable id) and
 * read-only. A source failure propagates as `NativeSessionInventoryError` so
 * the capture reports a typed unknown instead of an empty section.
 */
export async function captureNativeSessionSection(
  source: NativeSessionInventorySource,
  bound: number
): Promise<MigrationSnapshotSection> {
  const authorizedScopes = source.authorizedScopes
  if (
    !Array.isArray(authorizedScopes) ||
    authorizedScopes.length === 0 ||
    !authorizedScopes.every(
      (scope) =>
        isNonEmptyString(scope?.accountId) &&
        isNonEmptyString(scope?.workspaceId) &&
        isNonEmptyString(scope?.runtimeNodeId)
    )
  ) {
    throw new NativeSessionInventoryError(
      'invalid',
      'runtime session inventory source declared no authorized scope'
    )
  }
  const records: NativeSessionSnapshotRecord[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let truncated = false
  for (;;) {
    const remaining = bound - records.length
    // One probe row past the remaining budget observes exact truncation; the
    // canonical registry caps every request at 500, so large bounds page.
    const requestLimit = Math.min(remaining + 1, NATIVE_SESSION_INVENTORY_PAGE_LIMIT)
    const page = await readPage(source, { cursor, limit: requestLimit })
    // An empty page that claims a continuation can never terminate and would
    // stream forever; a cursor that repeats is a loop. Both fail closed.
    if (page.items.length === 0 && page.nextCursor !== undefined) {
      throw new NativeSessionInventoryError(
        'invalid',
        'runtime session inventory returned an empty page with a continuation cursor'
      )
    }
    let overflow = false
    for (const session of page.items) {
      if (records.length >= bound) {
        overflow = true
        break
      }
      records.push(toRecord(session, authorizedScopes))
    }
    // Truncation is exact: the probe row overflowed, or the bound is met while
    // the canonical read still declares a continuation.
    if (overflow || (records.length >= bound && page.nextCursor !== undefined)) {
      truncated = true
      break
    }
    if (page.nextCursor === undefined) break
    if (seenCursors.has(page.nextCursor)) {
      throw new NativeSessionInventoryError(
        'invalid',
        'runtime session inventory repeated a cursor; refusing to loop'
      )
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  records.sort((left, right) =>
    left.sessionRef < right.sessionRef ? -1 : left.sessionRef > right.sessionRef ? 1 : 0
  )
  return Object.freeze({
    limit: bound,
    records: Object.freeze(records),
    truncated,
  })
}
