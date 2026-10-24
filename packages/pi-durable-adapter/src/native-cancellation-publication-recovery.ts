import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { z } from 'zod'
import { PiDurableCancellationGenerationSchema } from './contracts.js'
import type { JournalRecord } from './journal.js'

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Reference = z.string().min(1).max(8192)

/** The pins a caller holds for one historical cancellation request. They name evidence only. */
export const PiPublicationRecoveryIdentitySchema = z.strictObject({
  requestId: Reference,
  requestDigest: Digest,
  targetDigest: Digest,
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  turnKey: Reference,
  inferenceId: Reference.nullable(),
})
export type PiPublicationRecoveryIdentity = z.infer<typeof PiPublicationRecoveryIdentitySchema>

const ReceiptSchema = z.strictObject({
  version: z.literal(1),
  requestId: Reference,
  requestDigest: Digest,
  conversationId: z.number().int().positive().safe(),
  background: z.literal(false),
  taskIds: z.array(z.number().int().positive().safe()),
  queuedInputIds: z.array(z.number().int().positive().safe()),
  metadata: z.strictObject({
    targetDigest: Digest,
    expiresAt: z.string(),
    fenceRevision: z.number().int().nonnegative().safe(),
    inferenceId: z.string().nullable(),
    turnKey: z.string(),
    scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
})

export type PiPublicationRecoveryOutcome =
  /** The journal already retains this cancellation and the matching native receipt. */
  | 'published'
  /** No native receipt in the observed store. This is not proof of zero native effect. */
  | 'receipt_absent'
  /** A matching native receipt exists but the journal retains no such cancellation. */
  | 'receipt_unpublished'
  /** A matching native receipt exists, but the journal has moved on (successor turn or generation, or terminal). */
  | 'receipt_superseded'
  /** Evidence contradicts itself. Nothing may be inferred. */
  | 'conflict'

export interface PiPublicationRecoveryDecision {
  readonly outcome: PiPublicationRecoveryOutcome
  /** Stable code naming the first contradiction when `outcome` is `conflict`. */
  readonly code?: string
}

const TERMINAL = ['completed', 'failed', 'timed_out', 'cancelled']

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}
function conflict(code: string): PiPublicationRecoveryDecision {
  return Object.freeze({ outcome: 'conflict', code })
}

/**
 * Effect-free classification of a native cancellation whose journal publication may have been
 * lost. It reads a journal record and an already-observed historical native receipt and returns
 * a label. It cannot abort, publish, settle, acknowledge or authorize anything, and a label is
 * never permission: `receipt_unpublished` only says that a separately authorized recovery path
 * would have something to act on. Malformed or contradictory input fails closed as `conflict`.
 * Nothing calls this during construction, startup or recovery.
 */
export function classifyPiNativeCancellationPublication(
  record: Pick<JournalRecord, 'handleId' | 'attemptId' | 'state' | 'detail'>,
  identityInput: unknown,
  receiptInput: unknown
): PiPublicationRecoveryDecision {
  const identity = PiPublicationRecoveryIdentitySchema.safeParse(identityInput)
  if (!identity.success) return conflict('PI_PUBLICATION_RECOVERY_IDENTITY_INVALID')
  const pins = identity.data
  const detail = record.detail
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail))
    return conflict('PI_PUBLICATION_RECOVERY_RECORD_INVALID')

  let receipt: z.infer<typeof ReceiptSchema> | undefined
  if (receiptInput !== undefined) {
    const parsed = ReceiptSchema.safeParse(receiptInput)
    if (
      !parsed.success ||
      parsed.data.requestId !== pins.requestId ||
      parsed.data.requestDigest !== pins.requestDigest ||
      parsed.data.metadata.targetDigest !== pins.targetDigest ||
      parsed.data.metadata.expiresAt !== pins.expiresAt ||
      parsed.data.metadata.turnKey !== pins.turnKey ||
      parsed.data.metadata.inferenceId !== pins.inferenceId
    )
      return conflict('PI_PUBLICATION_RECOVERY_RECEIPT_BINDING_INVALID')
    receipt = parsed.data
  }

  const actions = detail['actions']
  if (actions !== undefined && (typeof actions !== 'object' || actions === null))
    return conflict('PI_PUBLICATION_RECOVERY_RECORD_INVALID')
  const published = (actions as Record<string, unknown> | undefined)?.[pins.requestId]
  if (published !== undefined) {
    // The journal says this request was published. Its digest and retained receipt must agree.
    if (published !== pins.requestDigest) return conflict('PI_PUBLICATION_RECOVERY_ACTION_DIGEST')
    const retained = ReceiptSchema.safeParse(detail['nativeCancellationReceipt'])
    if (
      !retained.success ||
      retained.data.requestId !== pins.requestId ||
      retained.data.requestDigest !== pins.requestDigest ||
      retained.data.metadata.targetDigest !== pins.targetDigest ||
      (receipt && digest(receipt) !== digest(retained.data))
    )
      return conflict('PI_PUBLICATION_RECOVERY_RETAINED_RECEIPT')
    return Object.freeze({ outcome: 'published' })
  }
  if (detail['nativeCancellationReceipt'] !== undefined)
    return conflict('PI_PUBLICATION_RECOVERY_RETAINED_RECEIPT')
  if (receipt === undefined) return Object.freeze({ outcome: 'receipt_absent' })

  const currentTurn =
    (detail['turn'] as { requestId?: string } | undefined)?.requestId ??
    `pi-turn:${record.attemptId}:initial`
  const rawActive = detail['activeInference']
  let active: z.infer<typeof PiDurableCancellationGenerationSchema> | undefined
  if (rawActive !== undefined) {
    const parsedActive = PiDurableCancellationGenerationSchema.safeParse(rawActive)
    if (!parsedActive.success) return conflict('PI_PUBLICATION_RECOVERY_RECORD_INVALID')
    active = parsedActive.data
  }
  if (
    currentTurn !== pins.turnKey ||
    TERMINAL.includes(record.state) ||
    (active !== undefined && active.inferenceId !== pins.inferenceId) ||
    (pins.inferenceId !== null &&
      (detail['inferenceReceipts'] as Record<string, unknown> | undefined)?.[
        `${pins.turnKey}:${pins.inferenceId}`
      ] !== undefined)
  )
    return Object.freeze({ outcome: 'receipt_superseded' })
  return Object.freeze({ outcome: 'receipt_unpublished' })
}
