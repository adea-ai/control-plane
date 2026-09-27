import { z } from 'zod'

const TimestampSchema = z.iso.datetime()

/**
 * Conservative post-reference retention clock. The storage adapter must read
 * and persist this metadata under the same lifetime lock as reference writers
 * and deletion. A first observation can be later than the actual release, but
 * must never use compilation time as a substitute for that release.
 *
 * Every new reference writer clears the persisted clock atomically, including
 * references created and removed between maintenance passes. Dry-run callers
 * may calculate this result but must not persist it.
 */
export function observeReferenceRetentionWindow(input: {
  readonly now: string
  readonly unreferencedSince: string | null
  readonly pendingReferences: number
  readonly policyRetainMs: number | null
}): { readonly unreferencedSince: string | null; readonly retentionExpiresAt?: string } {
  const now = TimestampSchema.parse(input.now)
  if (!Number.isSafeInteger(input.pendingReferences) || input.pendingReferences < 0)
    throw new Error('REFERENCE_RETENTION_INVALID_REFERENCE_COUNT')
  if (input.policyRetainMs === null || input.pendingReferences > 0)
    return { unreferencedSince: null }
  if (!Number.isSafeInteger(input.policyRetainMs) || input.policyRetainMs <= 0)
    throw new Error('REFERENCE_RETENTION_INVALID_DURATION')
  const unreferencedSince = TimestampSchema.parse(input.unreferencedSince ?? now)
  const expiry = Date.parse(unreferencedSince) + input.policyRetainMs
  if (!Number.isFinite(new Date(expiry).getTime()))
    throw new Error('REFERENCE_RETENTION_INVALID_EXPIRY')
  return { unreferencedSince, retentionExpiresAt: new Date(expiry).toISOString() }
}
