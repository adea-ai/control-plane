import { createHash } from 'node:crypto'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { z } from 'zod'
import {
  PiDurableCommittedCancellationIntentSchema,
  PiDurableCancellationGenerationSchema,
} from './contracts.js'
import type { SqliteDurableJournal, JournalRecord } from './journal.js'

const ResolutionSchema = z.strictObject({
  schemaVersion: z.literal('pi-cancellation-resolution/v1'),
  authorityIntentId: z.uuid(),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  targetKind: z.enum(['active_generation', 'no_active_generation', 'untracked_generation']),
  turnKey: z.string().min(1).max(4096),
  generation: PiDurableCancellationGenerationSchema.nullable(),
  resolution: z.literal('target_generation_superseded'),
  observedGeneration: PiDurableCancellationGenerationSchema.nullable(),
  confirmedAt: z.iso.datetime({ precision: 3 }),
})

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}

function reject(): never {
  throw new Error('PI_CANCELLATION_HISTORY_CONFLICT')
}

/** Internal, effect-free reconciliation of old published #1048 request history. A current or
 * ambiguous target remains unresolved. Even a resolved historical target is never permission:
 * this function cannot abort, change execution state, settle usage or acknowledge an outbox.
 * Nothing calls it during production construction or startup.
 */
export function reconcilePiCancellationHistory(
  journal: SqliteDurableJournal,
  input: unknown,
  now: string
): 'unresolved' | 'superseded' {
  const intent = PiDurableCommittedCancellationIntentSchema.parse(input)
  z.iso.datetime({ precision: 3 }).parse(now)
  return journal.transitionCurrent(intent.handleId, (record: JournalRecord) => {
    const admission = record.admission as {
      request?: { executionId?: string; attemptBudget?: { workspaceId?: string } }
    }
    if (
      record.handleId !== intent.handleId ||
      record.attemptId !== intent.attemptId ||
      admission.request?.executionId !== intent.executionId ||
      admission.request?.attemptBudget?.workspaceId !== intent.workspaceId ||
      digest(record.admission) !== intent.admissionDigest ||
      digest({ idempotencyKey: intent.idempotencyKey, requestedAt: intent.requestedAt }) !==
        intent.requestDigest
    )
      reject()
    const key = `cancel:${intent.idempotencyKey}`
    const resolutions = record.detail['cancellationResolutions']
    if (
      resolutions !== undefined &&
      (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions))
    )
      reject()
    const history = (resolutions ?? {}) as Record<string, unknown>
    const identity = {
      authorityIntentId: intent.intentId,
      requestDigest: intent.requestDigest,
      targetKind: intent.targetKind,
      turnKey: intent.turnKey,
      generation: intent.generation,
    }
    const prior = history[key]
    if (prior !== undefined) {
      const parsed = ResolutionSchema.safeParse(prior)
      if (!parsed.success) reject()
      const {
        schemaVersion: _version,
        resolution: _resolution,
        observedGeneration,
        confirmedAt: _at,
        ...saved
      } = parsed.data
      if (
        canonicalJsonStringify(saved) !== canonicalJsonStringify(identity) ||
        (observedGeneration && observedGeneration.attemptId !== record.attemptId)
      )
        reject()
      return { value: 'superseded' as const }
    }
    const rawActive = record.detail['activeInference']
    const active =
      rawActive === undefined ? undefined : PiDurableCancellationGenerationSchema.parse(rawActive)
    const turn =
      (record.detail['turn'] as { requestId?: string } | undefined)?.requestId ??
      `pi-turn:${record.attemptId}:initial`
    if (active && (active.attemptId !== record.attemptId || active.turnKey !== turn)) reject()
    const actions = record.detail['actions'] as Record<string, unknown> | undefined
    if (actions?.[key] !== undefined && actions[key] !== intent.requestDigest) reject()
    // A null-generation request cannot acquire a generation which appeared later.
    const superseded =
      intent.turnKey !== turn ||
      ['completed', 'failed', 'timed_out', 'cancelled'].includes(record.state) ||
      (active !== undefined &&
        canonicalJsonStringify(active) !== canonicalJsonStringify(intent.generation)) ||
      (intent.generation !== null &&
        (record.detail['inferenceReceipts'] as Record<string, unknown> | undefined)?.[
          intent.generation.inferenceKey
        ] !== undefined)
    if (!superseded) return { value: 'unresolved' as const }
    const resolution = ResolutionSchema.parse({
      schemaVersion: 'pi-cancellation-resolution/v1',
      ...identity,
      resolution: 'target_generation_superseded',
      observedGeneration: active ?? null,
      confirmedAt: now,
    })
    // Read and annotate the fresh row in one journal transaction. Keep state, epoch, actions,
    // generation, current cancellation, terminal output and usage exactly as observed here.
    return {
      value: 'superseded' as const,
      change: {
        detail: { ...record.detail, cancellationResolutions: { ...history, [key]: resolution } },
      },
    }
  }).value
}

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

/** Every pin the caller holds must match the receipt, observed or retained. */
function bindsPins(receipt: z.infer<typeof ReceiptSchema>, pins: PiPublicationRecoveryIdentity) {
  return (
    receipt.requestId === pins.requestId &&
    receipt.requestDigest === pins.requestDigest &&
    receipt.metadata.targetDigest === pins.targetDigest &&
    receipt.metadata.expiresAt === pins.expiresAt &&
    receipt.metadata.turnKey === pins.turnKey &&
    receipt.metadata.inferenceId === pins.inferenceId
  )
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

  // Container and generation identity are validated before any classification, including
  // `receipt_absent` and `published`, so a malformed or foreign record never reads as absent.
  const detail = record.detail
  if (
    typeof record.handleId !== 'string' ||
    record.handleId.length === 0 ||
    typeof record.attemptId !== 'string' ||
    record.attemptId.length === 0 ||
    typeof record.state !== 'string' ||
    typeof detail !== 'object' ||
    detail === null ||
    Array.isArray(detail)
  )
    return conflict('PI_PUBLICATION_RECOVERY_RECORD_INVALID')
  for (const key of ['actions', 'inferenceReceipts', 'turn'] as const) {
    const value = detail[key]
    if (
      value !== undefined &&
      (typeof value !== 'object' || value === null || Array.isArray(value))
    )
      return conflict('PI_PUBLICATION_RECOVERY_RECORD_INVALID')
  }
  const turnRequestId = (detail['turn'] as { requestId?: unknown } | undefined)?.requestId
  if (turnRequestId !== undefined && (typeof turnRequestId !== 'string' || turnRequestId === ''))
    return conflict('PI_PUBLICATION_RECOVERY_RECORD_INVALID')
  const currentTurn = (turnRequestId as string | undefined) ?? `pi-turn:${record.attemptId}:initial`
  let active: z.infer<typeof PiDurableCancellationGenerationSchema> | undefined
  if (detail['activeInference'] !== undefined) {
    const parsedActive = PiDurableCancellationGenerationSchema.safeParse(detail['activeInference'])
    if (!parsedActive.success) return conflict('PI_PUBLICATION_RECOVERY_GENERATION_INVALID')
    // Same identity rule the adapter applies to its own active generation.
    if (parsedActive.data.attemptId !== record.attemptId)
      return conflict('PI_PUBLICATION_RECOVERY_CROSS_ATTEMPT')
    if (parsedActive.data.turnKey !== currentTurn)
      return conflict('PI_PUBLICATION_RECOVERY_CROSS_TURN')
    active = parsedActive.data
  }
  // A pinned turn that names another attempt's initial turn is a foreign request, not a successor.
  const pinnedAttempt = /^pi-turn:(.+):initial$/.exec(pins.turnKey)?.[1]
  if (pinnedAttempt !== undefined && pinnedAttempt !== record.attemptId)
    return conflict('PI_PUBLICATION_RECOVERY_CROSS_ATTEMPT')

  let receipt: z.infer<typeof ReceiptSchema> | undefined
  if (receiptInput !== undefined) {
    const parsed = ReceiptSchema.safeParse(receiptInput)
    if (!parsed.success || !bindsPins(parsed.data, pins))
      return conflict('PI_PUBLICATION_RECOVERY_RECEIPT_BINDING_INVALID')
    receipt = parsed.data
  }

  const published = (detail['actions'] as Record<string, unknown> | undefined)?.[pins.requestId]
  if (published !== undefined) {
    // The journal says this request was published. Its digest and retained receipt must agree.
    if (published !== pins.requestDigest) return conflict('PI_PUBLICATION_RECOVERY_ACTION_DIGEST')
    const retained = ReceiptSchema.safeParse(detail['nativeCancellationReceipt'])
    if (
      !retained.success ||
      !bindsPins(retained.data, pins) ||
      (receipt && digest(receipt) !== digest(retained.data))
    )
      return conflict('PI_PUBLICATION_RECOVERY_RETAINED_RECEIPT')
    return Object.freeze({ outcome: 'published' })
  }
  if (detail['nativeCancellationReceipt'] !== undefined)
    return conflict('PI_PUBLICATION_RECOVERY_RETAINED_RECEIPT')
  if (receipt === undefined) return Object.freeze({ outcome: 'receipt_absent' })

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
