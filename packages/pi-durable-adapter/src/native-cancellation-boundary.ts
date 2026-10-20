import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJsonStringify } from '@control-plane/contracts'
import {
  PiCancellationTargetSchema,
  PiCancellationRetainedIntentSchema,
  piCancellationTargetDigest,
  type PiCancellationPermit,
  type PiCancellationRetainedIntent,
} from './cancellation-owner.js'

const Reference = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => value.trim() === value)
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Epoch = z.number().int().nonnegative().safe()
const Instant = z.iso.datetime({ precision: 3 })

/** Candidate pins, not a frozen cut or permission. N must reread persisted facts. */
export const PiNativeCancellationTargetSchema = z
  .strictObject({
    target: PiCancellationTargetSchema,
    nativeSessionId: Reference,
    conversationId: Epoch,
    scopeRevision: Epoch,
    taskRevisionDigest: Digest,
    inputRevisionDigest: Digest,
    processClaimId: Reference,
  })
  .superRefine((candidate, context) => {
    if (candidate.nativeSessionId !== candidate.target.handle.externalSessionId)
      context.addIssue({ code: 'custom', message: 'native session binding mismatch' })
  })
export type PiNativeCancellationTarget = z.infer<typeof PiNativeCancellationTargetSchema>

export function piNativeCancellationTargetDigest(input: PiNativeCancellationTarget): string {
  const target = PiNativeCancellationTargetSchema.parse(input)
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(target)).digest('hex')}`
}

/** Preparation can be stale, forged or retained after revocation; parsing grants nothing. */
export const PiNativeCancellationPreparationSchema = z.strictObject({
  schemaVersion: z.literal('pi-native-cancellation-preparation/v1'),
  preparationId: Reference,
  requestDigest: Digest,
  candidate: PiNativeCancellationTargetSchema,
  preparedAt: Instant,
})
export type PiNativeCancellationPreparation = z.infer<typeof PiNativeCancellationPreparationSchema>

/** Evidence shape only. A parser cannot attest that a native transaction committed. */
export const PiNativeCancellationCommitReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal('pi-native-cancellation-commit-receipt/v1'),
    nativeReceiptId: Reference,
    requestDigest: Digest,
    nativeTargetDigest: Digest,
    processClaimId: Reference,
    restoreGeneration: Reference,
    ownerEpoch: Epoch,
    nativeCommitSequence: Epoch,
    admittedAt: Instant,
    committedAt: Instant,
    earliestAuthorityExpiresAt: Instant,
    outcome: z.enum(['committed_effect', 'committed_no_effect']),
  })
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.admittedAt) >= Date.parse(receipt.earliestAuthorityExpiresAt))
      context.addIssue({ code: 'custom', message: 'native admission expired' })
    if (Date.parse(receipt.committedAt) < Date.parse(receipt.admittedAt))
      context.addIssue({ code: 'custom', message: 'commit predates admission' })
  })
export type PiNativeCancellationCommitReceipt = z.infer<
  typeof PiNativeCancellationCommitReceiptSchema
>

const FenceBody = z.strictObject({
  mutationId: Reference,
  scopeSetDigest: Digest,
  closureGeneration: Reference,
  processClaimId: Reference,
  restoreGeneration: Reference,
  ownerEpoch: Epoch,
  previousEpoch: Epoch,
  fenceEpoch: Epoch,
})
function advancingEpoch(
  input: { previousEpoch: number; fenceEpoch: number },
  context: z.RefinementCtx
): void {
  if (input.fenceEpoch <= input.previousEpoch)
    context.addIssue({ code: 'custom', message: 'native fence epoch must advance' })
}
export const PiNativeCancellationFenceRequestSchema = FenceBody.superRefine(advancingEpoch)
export type PiNativeCancellationFenceRequest = z.infer<
  typeof PiNativeCancellationFenceRequestSchema
>

/** F installation ACK, deliberately distinct from D drain and canonical R commit. */
export const PiNativeCancellationFenceReceiptSchema = FenceBody.extend({
  schemaVersion: z.literal('pi-native-cancellation-fence-receipt/v1'),
  installationReceiptId: Reference,
  nativeCommitSequence: Epoch,
  installedAt: Instant,
}).superRefine(advancingEpoch)
export type PiNativeCancellationFenceReceipt = z.infer<
  typeof PiNativeCancellationFenceReceiptSchema
>

/** Matching installation evidence never proves canonical R, drain D or complete writer coverage. */
export function assertPiNativeCancellationFenceReceiptBinding(
  requestInput: unknown,
  receiptInput: unknown
): void {
  const request = PiNativeCancellationFenceRequestSchema.parse(requestInput)
  const receipt = PiNativeCancellationFenceReceiptSchema.parse(receiptInput)
  for (const key of Object.keys(request) as (keyof PiNativeCancellationFenceRequest)[])
    if (request[key] !== receipt[key])
      throw new Error('PI_NATIVE_CANCELLATION_FENCE_RECEIPT_MISMATCH')
}

/** Historical receipt identity only: observing D must never issue another abort. */
export const PiNativeCancellationReceiptIdentitySchema = z.strictObject({
  nativeReceiptId: Reference,
  requestDigest: Digest,
  nativeTargetDigest: Digest,
  processClaimId: Reference,
  restoreGeneration: Reference,
  ownerEpoch: Epoch,
})
export type PiNativeCancellationReceiptIdentity = z.infer<
  typeof PiNativeCancellationReceiptIdentitySchema
>

/** Snapshot equality only; does not verify authority, commit, expiry completeness or provenance. */
export function assertPiNativeCancellationReceiptBinding(
  intentInput: unknown,
  preparationInput: unknown,
  receiptInput: unknown
): void {
  const intent = PiCancellationRetainedIntentSchema.parse(intentInput)
  const preparation = PiNativeCancellationPreparationSchema.parse(preparationInput)
  const receipt = PiNativeCancellationCommitReceiptSchema.parse(receiptInput)
  const candidate = preparation.candidate
  if (
    preparation.requestDigest !== intent.requestDigest ||
    receipt.requestDigest !== intent.requestDigest ||
    piCancellationTargetDigest(candidate.target) !== piCancellationTargetDigest(intent.target) ||
    receipt.nativeTargetDigest !== piNativeCancellationTargetDigest(candidate) ||
    receipt.processClaimId !== candidate.processClaimId ||
    receipt.restoreGeneration !== intent.target.restoreGeneration ||
    receipt.ownerEpoch !== intent.target.ownerEpoch ||
    Date.parse(preparation.preparedAt) < Date.parse(intent.requestedAt) ||
    Date.parse(receipt.admittedAt) < Date.parse(preparation.preparedAt) ||
    Date.parse(receipt.earliestAuthorityExpiresAt) > Date.parse(intent.target.authorityExpiresAt)
  )
    throw new Error('PI_NATIVE_CANCELLATION_RECEIPT_MISMATCH')
}

/**
 * Dormant reference API, not an SDK capability or production injection point.
 * N must serialize persisted scope/task/input, current authority, claim, restore generation,
 * expiry and receipt with abort writes. F uses that same native write domain and the union
 * of mutation-owned restrictions. Preparation confers no authority. Read/drain resolve only
 * the exact historical generation; neither may abort a successor. N/F never wait for D.
 */
export interface PiNativeCancellationBoundaryPort {
  prepare(
    intent: PiCancellationRetainedIntent,
    candidate: PiNativeCancellationTarget
  ): Promise<PiNativeCancellationPreparation>
  commit(
    intent: PiCancellationRetainedIntent,
    preparation: PiNativeCancellationPreparation,
    permit: PiCancellationPermit
  ): Promise<PiNativeCancellationCommitReceipt>
  installFence(request: PiNativeCancellationFenceRequest): Promise<PiNativeCancellationFenceReceipt>
  readReceipt(
    identity: PiNativeCancellationReceiptIdentity
  ): Promise<PiNativeCancellationCommitReceipt | undefined>
  drain(identity: PiNativeCancellationReceiptIdentity): Promise<'pending' | 'unknown' | 'drained'>
}

/** No successful prepare, receipt, fence ACK or drain can be synthesized by the default port. */
export class UnavailablePiNativeCancellationBoundary implements PiNativeCancellationBoundaryPort {
  async prepare(
    _intent: PiCancellationRetainedIntent,
    _candidate: PiNativeCancellationTarget
  ): Promise<PiNativeCancellationPreparation> {
    return this.unavailable()
  }
  async commit(
    _intent: PiCancellationRetainedIntent,
    _preparation: PiNativeCancellationPreparation,
    _permit: PiCancellationPermit
  ): Promise<PiNativeCancellationCommitReceipt> {
    return this.unavailable()
  }
  async installFence(
    _request: PiNativeCancellationFenceRequest
  ): Promise<PiNativeCancellationFenceReceipt> {
    return this.unavailable()
  }
  async readReceipt(
    _identity: PiNativeCancellationReceiptIdentity
  ): Promise<PiNativeCancellationCommitReceipt | undefined> {
    return this.unavailable()
  }
  async drain(
    _identity: PiNativeCancellationReceiptIdentity
  ): Promise<'pending' | 'unknown' | 'drained'> {
    return this.unavailable()
  }
  private unavailable(): never {
    throw new Error('PI_NATIVE_CANCELLATION_BOUNDARY_UNAVAILABLE')
  }
}
