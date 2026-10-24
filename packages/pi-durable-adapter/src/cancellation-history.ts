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
