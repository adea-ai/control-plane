import { createHash } from 'node:crypto'
import {
  canonicalJsonStringify,
  compareCodePointOrder,
  IdentifierSchemas,
} from '@control-plane/contracts'
import type { AttemptId } from '@control-plane/contracts'
import { ExecutionFailureClassificationSchema } from '@control-plane/domain'
import type { DelegationEvent } from './delegation.js'
import { z } from 'zod'

/**
 * Bounded, provenance-preserving evidence packets for coalesced child progress
 * (M13.04 partial slice, refs adea-ai/control-plane#937).
 *
 * The workspace lead must stay responsive while children run, so repetitive
 * child progress is coalesced into per-child snapshots inside a bounded
 * packet. The observations that can never be dropped by batching are retained
 * verbatim as packet entries: terminal outcomes (`completed`, `failed`,
 * `cancelled`, including cancellation transitions), failure metadata, and
 * approval / human-input requests (`awaiting_input`). When a packet bound
 * would be exceeded, the open packet is sealed and a fresh one is started —
 * bounds shrink packet size, never the retained evidence set. The serialized
 * byte limit covers the whole packet (headers, sequence, digest, all
 * entries/snapshots and the delivery counters), including the very first
 * observation of a window, and every emitted packet satisfies its own parser
 * and bound. Every recorded change is size-checked against that limit —
 * entry and snapshot placement, child-count pressure (counted across
 * snapshots and entry-only children alike), delivery-counter growth, and
 * observation-window span extensions; a timestamp that cannot fit any bounded
 * packet is refused at ingest before any state mutates.
 *
 * Every observation carries the full job/attempt identity (`delegationId`,
 * `childExecutionId`, `childAttemptId`, owner-owned `generation`) and
 * provenance (`eventId`, `observedAt`). Duplicate deliveries are deduplicated
 * by `eventId` against a content fingerprint that is committed only after an
 * event is actually retained, so a delivery that failed placement is retried
 * instead of misreported as a duplicate; a reused `eventId` with changed
 * content, or a changed child/attempt identity inside an existing delegation
 * generation (the first `childAttemptId` observed within a generation binds
 * it, with the binding committing only once its observation is placed), is
 * rejected with an explicit receipt rather than folded silently — as
 * are events from a superseded generation, events arriving after a generation
 * went terminal, and events for a foreign parent. All
 * payload-shaped fields are opaque identifiers, digests, enums, timestamps or
 * bounded integers: evidence travels as authorized references (artifact,
 * interaction, result), never as copied secrets or unrelated private context.
 */

const TimestampSchema = z.iso.datetime()
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
/** Bounded reference string. Never free-form payloads. */
const ReferenceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)

const PhaseSchema = z.enum(['running', 'awaiting_input', 'completed', 'failed', 'cancelled'])
const InteractionKindSchema = z.enum(['input', 'approval', 'grant', 'runtime'])
const CancelReasonSchema = z.enum([
  'user_request',
  'parent_cancelled',
  'deadline',
  'policy',
  'shutdown',
])

const InteractionReferenceSchema = z
  .object({
    interactionId: IdentifierSchemas.interactionId,
    kind: InteractionKindSchema,
  })
  .strict()

const FailureEvidenceSchema = z
  .object({
    classification: ExecutionFailureClassificationSchema,
    code: ReferenceSchema,
  })
  .strict()

const MetricsSchema = z.record(ReferenceSchema, z.number().int().nonnegative())

type EvidenceMetrics = z.output<typeof MetricsSchema>

/**
 * Own-property-safe, overflow-safe accumulation of metric counters. Inherited
 * keys such as `toString` are never read, and sums saturate at
 * `Number.MAX_SAFE_INTEGER` instead of losing integer precision.
 */
function accumulateMetrics(base: EvidenceMetrics, addition: EvidenceMetrics | undefined) {
  const merged: EvidenceMetrics = { ...base }
  if (addition === undefined) return merged
  for (const [key, value] of Object.entries(addition)) {
    const prior = Object.hasOwn(merged, key) ? (merged[key] as number) : 0
    const sum = prior + value
    merged[key] = sum > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : sum
  }
  return merged
}

/**
 * A single child progress observation as delivered by the child-job owner.
 * `generation` is the owner-owned monotonic attempt/revision mark for the
 * delegation (for example the delegation record revision or the attempt
 * sequence); events below the high-water mark are stale by definition.
 * `cancelReason` is present when the producer knows it (for example
 * parent-initiated cascade cancels); a child-originated cancellation may
 * legitimately carry no reason — that uncertainty is preserved, never
 * papered over with an invented reason.
 */
export const ChildProgressEvidenceEventSchema = z
  .object({
    eventId: IdentifierSchemas.eventId,
    parentExecutionId: IdentifierSchemas.executionId,
    delegationId: IdentifierSchemas.delegationId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId.optional(),
    generation: z.number().int().positive(),
    phase: PhaseSchema,
    observedAt: TimestampSchema,
    terminalResultRef: IdentifierSchemas.artifactId.optional(),
    failure: FailureEvidenceSchema.optional(),
    cancelReason: CancelReasonSchema.optional(),
    interaction: InteractionReferenceSchema.optional(),
    /** Nonnegative integer counters (steps, bytes, calls); summed on coalesce. */
    metrics: MetricsSchema.optional(),
  })
  .strict()
  .superRefine((event, context) => {
    const requireFor = (
      field: 'terminalResultRef' | 'failure' | 'interaction',
      present: boolean,
      message: string
    ) => {
      if (!present) {
        context.addIssue({ code: 'custom', path: [field], message })
      }
    }
    const requireAbsent = (
      field: 'terminalResultRef' | 'failure' | 'cancelReason' | 'interaction',
      present: boolean
    ) => {
      if (present) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} is not allowed on phase ${event.phase}`,
        })
      }
    }
    if (event.phase === 'completed') {
      requireFor(
        'terminalResultRef',
        event.terminalResultRef !== undefined,
        'Completed child progress requires the terminal result reference'
      )
    } else {
      requireAbsent('terminalResultRef', event.terminalResultRef !== undefined)
    }
    if (event.phase === 'failed') {
      requireFor(
        'failure',
        event.failure !== undefined,
        'Failed child progress requires failure metadata'
      )
    } else {
      requireAbsent('failure', event.failure !== undefined)
    }
    // A cancellation keeps its reason when the producer knows it; the
    // absence of a reason is a valid, explicitly uncertain cancellation.
    requireAbsent('cancelReason', event.phase !== 'cancelled' && event.cancelReason !== undefined)
    if (event.phase === 'awaiting_input') {
      requireFor(
        'interaction',
        event.interaction !== undefined,
        'Awaiting-input child progress requires the interaction reference'
      )
    } else {
      requireAbsent('interaction', event.interaction !== undefined)
    }
  })

export type ChildProgressEvidenceEvent = z.output<typeof ChildProgressEvidenceEventSchema>

/** A critical observation retained verbatim inside a packet. */
export const ChildProgressEvidenceEntrySchema = z
  .object({
    kind: z.enum(['terminal', 'awaiting_input']),
    eventId: IdentifierSchemas.eventId,
    delegationId: IdentifierSchemas.delegationId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId.optional(),
    generation: z.number().int().positive(),
    phase: z.enum(['awaiting_input', 'completed', 'failed', 'cancelled']),
    observedAt: TimestampSchema,
    terminalResultRef: IdentifierSchemas.artifactId.optional(),
    failure: FailureEvidenceSchema.optional(),
    /** Present when known; absent means the cancellation reason is unknown. */
    cancelReason: CancelReasonSchema.optional(),
    interaction: InteractionReferenceSchema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const terminal =
      entry.phase === 'completed' || entry.phase === 'failed' || entry.phase === 'cancelled'
    if (entry.kind === 'terminal' && !terminal) {
      context.addIssue({ code: 'custom', message: 'Terminal entries require a terminal phase' })
    }
    if (entry.kind === 'awaiting_input' && entry.phase !== 'awaiting_input') {
      context.addIssue({
        code: 'custom',
        message: 'Awaiting-input entries require the awaiting_input phase',
      })
    }
    if (entry.phase === 'completed' && entry.terminalResultRef === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Completed entries require the result reference',
      })
    }
    if (entry.phase === 'failed' && entry.failure === undefined) {
      context.addIssue({ code: 'custom', message: 'Failed entries require failure metadata' })
    }
    if (entry.phase === 'awaiting_input' && entry.interaction === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Awaiting-input entries require the interaction reference',
      })
    }
  })

export type ChildProgressEvidenceEntry = z.output<typeof ChildProgressEvidenceEntrySchema>

/** Latest coalesced view of one child inside the packet window. */
export const ChildProgressSnapshotSchema = z
  .object({
    delegationId: IdentifierSchemas.delegationId,
    childExecutionId: IdentifierSchemas.executionId,
    childAttemptId: IdentifierSchemas.attemptId.optional(),
    generation: z.number().int().positive(),
    phase: PhaseSchema,
    lastObservedAt: TimestampSchema,
    /** Events folded into this snapshot since the generation started. */
    observedEventCount: z.number().int().positive(),
    /** Metric totals summed across every folded event of this generation. */
    metrics: MetricsSchema,
  })
  .strict()

export type ChildProgressSnapshot = z.output<typeof ChildProgressSnapshotSchema>

/**
 * Packet format v2: the content digest covers every field except the digest
 * itself, including the sequence — re-sequencing a packet cannot re-derive a
 * valid digest. v1 packets (digest over the body without sequence) are
 * refused by the parser.
 */
export const ChildProgressEvidencePacketSchema = z
  .object({
    schemaVersion: z.literal(2),
    parentExecutionId: IdentifierSchemas.executionId,
    /** Monotonic per-buffer sequence; gaps mean a packet was consumed elsewhere. */
    sequence: z.number().int().positive(),
    /** sha256 over the canonical JSON of every other field; tamper-evident. */
    contentDigest: DigestSchema,
    firstEventAt: TimestampSchema,
    lastEventAt: TimestampSchema,
    entries: z.array(ChildProgressEvidenceEntrySchema),
    childSnapshots: z.array(ChildProgressSnapshotSchema),
    coalescedEventCount: z.number().int().nonnegative(),
    duplicateEventCount: z.number().int().nonnegative(),
    rejectedEventCount: z.number().int().nonnegative(),
  })
  .strict()

export type ChildProgressEvidencePacket = z.output<typeof ChildProgressEvidencePacketSchema>

export type ChildProgressEvidenceErrorCode = 'CONFIGURATION' | 'BOUNDS_EXCEEDED' | 'DIGEST_MISMATCH'

export class ChildProgressEvidenceError extends Error {
  constructor(
    readonly code: ChildProgressEvidenceErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChildProgressEvidenceError'
  }
}

export type ChildProgressEvidenceRejectionReason =
  | 'stale_generation'
  | 'terminated_generation'
  | 'foreign_parent'
  | 'conflicting_event'
  | 'conflicting_child_identity'

export type ChildProgressEvidenceReceipt =
  | {
      readonly outcome: 'coalesced'
      readonly delegationId: string
      readonly generation: number
      /** Present when accepting this event sealed a full packet. */
      readonly sealedPacket?: ChildProgressEvidencePacket
    }
  | {
      readonly outcome: 'retained'
      readonly entryKind: 'terminal' | 'awaiting_input'
      readonly delegationId: string
      readonly generation: number
      readonly sealedPacket?: ChildProgressEvidencePacket
    }
  | { readonly outcome: 'duplicate'; readonly eventId: string }
  | {
      readonly outcome: 'rejected'
      readonly reason: ChildProgressEvidenceRejectionReason
      readonly eventId: string
      readonly delegationId?: string
    }

export interface ChildProgressEvidenceBufferOptions {
  readonly parentExecutionId: string
  /** Critical entries per packet before the packet seals. Default 32. */
  readonly maximumEntries?: number
  /**
   * Distinct children per packet before the packet seals — counted across
   * snapshots and entry-only children alike. Default 64.
   */
  readonly maximumChildren?: number
  /** Serialized byte budget per packet (whole packet, not just the payload).
   * Default 16384; 2048..1048576. */
  readonly maximumBytes?: number
  /** Bounded memory for duplicate detection. Default 8192; oldest evicted. */
  readonly maximumTrackedEventIds?: number
}

interface DelegationWindow {
  generation: number
  terminal: boolean
  /** Attempt identity bound to this generation; undefined until first observed. */
  attemptId: AttemptId | undefined
  snapshot: ChildProgressSnapshot
}

interface OpenWindow {
  firstEventAt: string
  lastEventAt: string
  entries: ChildProgressEvidenceEntry[]
  childSnapshots: ChildProgressSnapshot[]
  coalescedEventCount: number
  duplicateEventCount: number
  rejectedEventCount: number
}

const DEFAULTS = {
  maximumEntries: 32,
  maximumChildren: 64,
  maximumBytes: 16_384,
  maximumTrackedEventIds: 8_192,
  maximumCoalescedEventsPerDelivery: 128,
} as const

const encoder = new TextEncoder()

/** Only these phases close a generation; awaiting_input keeps it open for resume. */
const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled'])

function isTerminalPhase(phase: ChildProgressEvidenceEvent['phase']): boolean {
  return TERMINAL_PHASES.has(phase)
}

/**
 * One chronological ordering rule for every evidence timestamp boundary.
 *
 * Evidence timestamps are schema-validated ISO-8601 instants with variable
 * fractional-second precision, and lexical order is not chronological across
 * that variation: `…T00:00:00Z` sorts after `…T00:00:00.100Z` even though it
 * is earlier. Comparing parsed instants (not raw strings) keeps a later
 * terminal observation able to supersede an earlier running snapshot. The
 * stored evidence strings, provenance and digests are unchanged — only the
 * comparison is normalized.
 */
function compareChronologicalTimestamps(left: string, right: string): number {
  const a = Date.parse(left)
  const b = Date.parse(right)
  if (!Number.isFinite(a) || !Number.isFinite(b))
    throw new Error('CHILD_PROGRESS_EVIDENCE_TIMESTAMP_UNORDERABLE')
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Placeholder digest with the exact serialized length of a real one, so size
 * projection includes the digest field without computing it twice.
 */
const DIGEST_PLACEHOLDER = `sha256:${'0'.repeat(64)}`

/** Same length as a real ISO timestamp; only used for sizing a fresh window. */
const TIMESTAMP_PLACEHOLDER = '2026-01-01T00:00:00.000Z'

/**
 * Longest ingestible evidence timestamp. `z.iso.datetime()` accepts arbitrary
 * fractional-second precision, so a syntactically valid instant can carry
 * thousands of digits — far more than any packet budget could hold once the
 * value is reflected in a window span. Timestamps longer than this bound are
 * refused at ingest (`BOUNDS_EXCEEDED`) before any buffer state mutates;
 * ordinary ISO 8601 instants, including offset forms and generously padded
 * fractions, stay far below it.
 */
const MAX_TIMESTAMP_LENGTH = 64

function isEmptyWindow(window: OpenWindow): boolean {
  return (
    window.entries.length === 0 &&
    window.childSnapshots.length === 0 &&
    window.coalescedEventCount === 0 &&
    window.duplicateEventCount === 0 &&
    window.rejectedEventCount === 0
  )
}

/**
 * Fresh-window projection with placeholder timestamps of real length. Used
 * when no window is open yet, and whenever a candidate must be checked
 * against an otherwise-empty packet.
 */
function freshProjectionWindow(): OpenWindow {
  return {
    firstEventAt: TIMESTAMP_PLACEHOLDER,
    lastEventAt: TIMESTAMP_PLACEHOLDER,
    entries: [],
    childSnapshots: [],
    coalescedEventCount: 0,
    duplicateEventCount: 0,
    rejectedEventCount: 0,
  }
}

function eventFingerprint(event: ChildProgressEvidenceEvent): string {
  return createHash('sha256').update(canonicalJsonStringify(event)).digest('hex')
}

/**
 * Batches child progress observations for one parent execution into sealed,
 * size-bounded {@link ChildProgressEvidencePacket}s. One buffer instance
 * serves one parent execution (the workspace lead's batching window); the
 * owner delivers sealed packets via `readyPackets()` and `flush()`.
 */
export class ChildProgressEvidenceBuffer {
  readonly #parentExecutionId
  readonly #maximumEntries: number
  readonly #maximumChildren: number
  readonly #maximumBytes: number
  readonly #maximumTrackedEventIds: number
  readonly #seenEventIds = new Map<string, string>()
  readonly #windows = new Map<string, DelegationWindow>()
  readonly #ready: ChildProgressEvidencePacket[] = []
  #open: OpenWindow | undefined
  /** Observation time of the accept in flight; seeds windows it creates. */
  #pendingEventTime: string | undefined
  #sequence = 0
  #lifetimeDuplicates = 0
  #lifetimeRejections = 0

  constructor(options: ChildProgressEvidenceBufferOptions) {
    this.#parentExecutionId = IdentifierSchemas.executionId.parse(options.parentExecutionId)
    this.#maximumEntries = options.maximumEntries ?? DEFAULTS.maximumEntries
    this.#maximumChildren = options.maximumChildren ?? DEFAULTS.maximumChildren
    this.#maximumBytes = options.maximumBytes ?? DEFAULTS.maximumBytes
    this.#maximumTrackedEventIds = options.maximumTrackedEventIds ?? DEFAULTS.maximumTrackedEventIds
    if (this.#maximumEntries < 1) {
      throw new ChildProgressEvidenceError('CONFIGURATION', 'maximumEntries must be at least 1')
    }
    if (this.#maximumChildren < 1) {
      throw new ChildProgressEvidenceError('CONFIGURATION', 'maximumChildren must be at least 1')
    }
    if (this.#maximumBytes < 2048 || this.#maximumBytes > 1_048_576) {
      throw new ChildProgressEvidenceError(
        'CONFIGURATION',
        'maximumBytes must be between 2048 and 1048576'
      )
    }
    if (this.#maximumTrackedEventIds < 128) {
      throw new ChildProgressEvidenceError(
        'CONFIGURATION',
        'maximumTrackedEventIds must be at least 128'
      )
    }
  }

  /**
   * Validates and folds one observation. Malformed events throw (Zod parse);
   * semantic outcomes are returned as receipts so batch loops never need
   * exception control flow for at-least-once delivery. A single observation
   * that cannot fit any packet within the configured bounds throws
   * `BOUNDS_EXCEEDED` rather than being silently truncated.
   */
  accept(event: unknown): ChildProgressEvidenceReceipt {
    const parsed = ChildProgressEvidenceEventSchema.parse(event)
    // An observation whose timestamp cannot be reflected in any bounded
    // packet fails loudly while the buffer is untouched — including its
    // rejection/duplicate accounting and any window it would have seeded.
    if (parsed.observedAt.length > MAX_TIMESTAMP_LENGTH) {
      throw new ChildProgressEvidenceError(
        'BOUNDS_EXCEEDED',
        `Evidence timestamp exceeds the ingestible length bound (${MAX_TIMESTAMP_LENGTH})`
      )
    }
    // Timestamp of the observation in flight: it extends the open window's
    // span (see #noteEventTime) and seeds any window created mid-accept, so
    // projections can rely on it from here on.
    this.#pendingEventTime = parsed.observedAt
    if (parsed.parentExecutionId !== this.#parentExecutionId) {
      return this.#reject('foreign_parent', parsed)
    }
    const fingerprint = eventFingerprint(parsed)
    const seenFingerprint = this.#seenEventIds.get(parsed.eventId)
    if (seenFingerprint !== undefined) {
      if (seenFingerprint !== fingerprint) {
        // Same delivery identity, different content: never treat as a
        // duplicate — one of the two deliveries is lying.
        return this.#reject('conflicting_event', parsed)
      }
      this.#lifetimeDuplicates += 1
      this.#foldDeliveryCount('duplicateEventCount', parsed.observedAt)
      return { outcome: 'duplicate', eventId: parsed.eventId }
    }

    const window = this.#windows.get(parsed.delegationId)
    if (window) {
      if (parsed.generation < window.generation) {
        return this.#reject('stale_generation', parsed)
      }
      if (parsed.childExecutionId !== window.snapshot.childExecutionId) {
        return this.#reject('conflicting_child_identity', parsed)
      }
      if (parsed.generation === window.generation) {
        if (window.terminal) {
          return this.#reject('terminated_generation', parsed)
        }
        if (
          parsed.childAttemptId !== undefined &&
          window.attemptId !== undefined &&
          parsed.childAttemptId !== window.attemptId
        ) {
          return this.#reject('conflicting_child_identity', parsed)
        }
      }
    }
    // The first attempt identity observed within a generation binds it — but
    // only once its observation is actually placed (see #mergeSnapshot), so a
    // placement failure never consumes the attempt identity. Any later
    // different attempt inside the same generation is the conflict rejected
    // above; a new generation rebinds freely (retries may use a new attempt).

    const critical = parsed.phase !== 'running'
    const entry: ChildProgressEvidenceEntry | undefined = critical ? toEntry(parsed) : undefined

    // A critical entry must fit some packet before any state mutates: an
    // observation that can never be placed fails loudly while the buffer is
    // untouched, keeping accept atomic for at-least-once redelivery (the
    // dedupe fingerprint below is committed only on success).
    if (entry !== undefined && !this.#fitsInPacket({ entry }, { freshWindow: true })) {
      throw new ChildProgressEvidenceError(
        'BOUNDS_EXCEEDED',
        `A single evidence entry exceeds the configured maximumBytes budget (${this.#maximumBytes})`
      )
    }

    // Timestamp the observation before any placement decision: every packet
    // sealed from here on — including a window freshly created by a
    // mid-accept seal-and-retry — carries a valid observation window.
    this.#noteEventTime(parsed.observedAt)

    // Critical observations must survive packet pressure: seal the open
    // packet first, then place the entry into a fresh one.
    let sealedPacket =
      entry !== undefined && this.#isEntryCapacity() ? this.#sealToQueue() : undefined
    if (!this.#mergeSnapshot(parsed)) {
      sealedPacket = this.#sealToQueue() ?? sealedPacket
      if (!this.#mergeSnapshot(parsed)) {
        throw new ChildProgressEvidenceError(
          'BOUNDS_EXCEEDED',
          `A single child snapshot exceeds the configured maximumBytes budget (${this.#maximumBytes})`
        )
      }
    }
    if (entry && !this.#appendEntry(entry)) {
      sealedPacket = this.#sealToQueue() ?? sealedPacket
      // The fresh-window pre-check above already proved this entry fits an
      // otherwise-empty packet, so the retry after a pressure seal fits too.
      if (!this.#appendEntry(entry)) {
        throw new ChildProgressEvidenceError(
          'BOUNDS_EXCEEDED',
          `A single evidence entry exceeds the configured maximumBytes budget (${this.#maximumBytes})`
        )
      }
    }

    // Retained successfully — only now commit the dedupe fingerprint, so a
    // redelivery after a failed placement re-attempts placement instead of
    // returning a phantom `duplicate` for evidence nothing kept.
    this.#trackEventId(parsed.eventId, fingerprint)

    if (!critical) {
      return {
        outcome: 'coalesced',
        delegationId: parsed.delegationId,
        generation: parsed.generation,
        ...(sealedPacket ? { sealedPacket } : {}),
      }
    }
    return {
      outcome: 'retained',
      entryKind: parsed.phase === 'awaiting_input' ? 'awaiting_input' : 'terminal',
      delegationId: parsed.delegationId,
      generation: parsed.generation,
      ...(sealedPacket ? { sealedPacket } : {}),
    }
  }

  /**
   * Takes every sealed packet waiting for delivery. Packets sealed under
   * packet pressure are queued here; each sealed packet is delivered exactly
   * once (either from this queue or from `flush()`), never both.
   */
  readyPackets(): ChildProgressEvidencePacket[] {
    const ready = [...this.#ready]
    this.#ready.length = 0
    return ready
  }

  /** Seals the open packet now (batch deadline, lead wake-up). */
  flush(): ChildProgressEvidencePacket | undefined {
    return this.#seal()
  }

  /** Delivery-side counters for telemetry and tests. */
  stats(): {
    readonly readyPacketCount: number
    readonly openPacket: boolean
    readonly trackedDelegations: number
    readonly pendingEntries: number
    readonly pendingCoalescedEventCount: number
    readonly lifetimeDuplicateCount: number
    readonly lifetimeRejectionCount: number
  } {
    return {
      readyPacketCount: this.#ready.length,
      openPacket: this.#open !== undefined,
      trackedDelegations: this.#windows.size,
      pendingEntries: this.#open?.entries.length ?? 0,
      pendingCoalescedEventCount: this.#open?.coalescedEventCount ?? 0,
      lifetimeDuplicateCount: this.#lifetimeDuplicates,
      lifetimeRejectionCount: this.#lifetimeRejections,
    }
  }

  #isEntryCapacity(): boolean {
    return this.#open !== undefined && this.#open.entries.length >= this.#maximumEntries
  }

  #reject(
    reason: ChildProgressEvidenceRejectionReason,
    parsed: ChildProgressEvidenceEvent
  ): ChildProgressEvidenceReceipt {
    this.#lifetimeRejections += 1
    this.#foldDeliveryCount('rejectedEventCount', parsed.observedAt)
    return {
      outcome: 'rejected',
      reason,
      eventId: parsed.eventId,
      delegationId: parsed.delegationId,
    }
  }

  /**
   * Folds a duplicate/rejection delivery into the open packet's counters. The
   * serialized projection includes the counter's growth AND the span the
   * delivery's timestamp gives the observation window — a counter gaining a
   * digit or a longer timestamp at the byte limit must not overflow the
   * packet — so the window is sealed under pressure first and the fold lands
   * in a fresh window seeded with that timestamp. A delivery that cannot be
   * recorded within bounds anywhere surfaces through the lifetime stats only
   * and never bloats a packet. With no window open, the delivery surfaces
   * through the lifetime stats as well.
   */
  #foldDeliveryCount(
    field: 'duplicateEventCount' | 'rejectedEventCount',
    observedAt: string
  ): void {
    if (this.#open === undefined) return
    const delta = field === 'duplicateEventCount' ? { duplicateDelta: 1 } : { rejectedDelta: 1 }
    const open = this.#open
    const extendedSpan =
      open.firstEventAt !== '' && compareChronologicalTimestamps(observedAt, open.firstEventAt) < 0
        ? { firstEventAt: observedAt, lastEventAt: open.lastEventAt }
        : open.lastEventAt === '' ||
            compareChronologicalTimestamps(observedAt, open.lastEventAt) > 0
          ? { firstEventAt: open.firstEventAt, lastEventAt: observedAt }
          : {}
    if (this.#fitsInPacket({ ...delta, ...extendedSpan })) {
      this.#noteEventTime(observedAt)
      this.#applyDeliveryCount(field)
      return
    }
    // Seal under pressure; the fold lands in a fresh window whose span is
    // seeded with this delivery's timestamp, included in the projection.
    this.#sealToQueue()
    if (this.#fitsInPacket({ ...delta, firstEventAt: observedAt, lastEventAt: observedAt })) {
      this.#noteEventTime(observedAt)
      this.#applyDeliveryCount(field)
    }
  }

  #applyDeliveryCount(field: 'duplicateEventCount' | 'rejectedEventCount'): void {
    this.#withOpenWindow((window) => {
      if (field === 'duplicateEventCount') {
        window.duplicateEventCount += 1
      } else {
        window.rejectedEventCount += 1
      }
    })
  }

  #trackEventId(eventId: string, fingerprint: string): void {
    this.#seenEventIds.set(eventId, fingerprint)
    while (this.#seenEventIds.size > this.#maximumTrackedEventIds) {
      const oldest = this.#seenEventIds.keys().next()
      if (oldest.done) break
      this.#seenEventIds.delete(oldest.value)
    }
  }

  /**
   * Records the observation time of the accept in flight. The open window's
   * span is extended in place — but only while the extended packet stays
   * within the byte budget: a timestamp that cannot be reflected without
   * overflowing the window never bloats the packet a following pressure seal
   * would emit. When no window is open yet, the time is remembered and seeds
   * the next window created during this accept (see {@link #withOpenWindow}),
   * so a packet sealed under pressure never carries empty timestamps.
   */
  #noteEventTime(observedAt: string): void {
    this.#pendingEventTime = observedAt
    const open = this.#open
    if (!open) return
    const firstEventAt =
      open.firstEventAt === '' || compareChronologicalTimestamps(observedAt, open.firstEventAt) < 0
        ? observedAt
        : open.firstEventAt
    const lastEventAt =
      open.lastEventAt === '' || compareChronologicalTimestamps(observedAt, open.lastEventAt) > 0
        ? observedAt
        : open.lastEventAt
    if (firstEventAt === open.firstEventAt && lastEventAt === open.lastEventAt) return
    // The span extension is recorded only while the projected packet stays
    // within the byte budget; otherwise the window keeps its existing span
    // and the time surfaces through the next window's seed.
    if (!this.#fitsInPacket({ firstEventAt, lastEventAt })) return
    open.firstEventAt = firstEventAt
    open.lastEventAt = lastEventAt
  }

  /**
   * Merges the event into the per-child snapshot. Returns false when the
   * child would exceed the per-packet child budget (returning children
   * included) or the projected serialized packet would exceed the byte
   * budget; the caller seals and retries.
   */
  #mergeSnapshot(event: ChildProgressEvidenceEvent): boolean {
    const window = this.#windows.get(event.delegationId)
    if (window === undefined || event.generation > window.generation) {
      const snapshot: ChildProgressSnapshot = {
        delegationId: event.delegationId,
        childExecutionId: event.childExecutionId,
        ...(event.childAttemptId ? { childAttemptId: event.childAttemptId } : {}),
        generation: event.generation,
        phase: event.phase,
        lastObservedAt: event.observedAt,
        observedEventCount: 1,
        metrics: accumulateMetrics({}, event.metrics),
      }
      if (
        !this.#canPlaceSnapshot(event.delegationId, snapshot, event.phase === 'running' ? 1 : 0)
      ) {
        return false
      }
      this.#windows.set(event.delegationId, {
        generation: event.generation,
        terminal: isTerminalPhase(event.phase),
        attemptId: event.childAttemptId,
        snapshot,
      })
      this.#replaceSnapshotInOpenWindow(snapshot)
      if (event.phase === 'running') {
        this.#withOpenWindow((open) => {
          open.coalescedEventCount += 1
        })
      }
      return true
    }

    // Same generation: coalesce. Older observations never regress the
    // snapshot; metric totals accumulate with own-property-safe checked sums.
    // An unbound generation adopts the incoming attempt identity here, but the
    // binding commits with the snapshot placement below: a failed placement
    // (byte-pressure seal that cannot place it) leaves the identity free.
    const attemptId = window.attemptId ?? event.childAttemptId
    const supersedes =
      compareChronologicalTimestamps(event.observedAt, window.snapshot.lastObservedAt) >= 0
    const merged: ChildProgressSnapshot = {
      ...window.snapshot,
      // Surface the attempt bound to this generation once it is known.
      ...(attemptId !== undefined ? { childAttemptId: attemptId } : {}),
      ...(supersedes ? { phase: event.phase, lastObservedAt: event.observedAt } : {}),
      observedEventCount: window.snapshot.observedEventCount + 1,
      metrics: accumulateMetrics(window.snapshot.metrics, event.metrics),
    }
    if (!this.#canPlaceSnapshot(event.delegationId, merged, 1)) return false
    this.#windows.set(event.delegationId, {
      generation: window.generation,
      terminal: window.terminal || (supersedes && isTerminalPhase(event.phase)),
      attemptId,
      snapshot: merged,
    })
    this.#replaceSnapshotInOpenWindow(merged)
    this.#withOpenWindow((open) => {
      open.coalescedEventCount += 1
    })
    return true
  }

  #withOpenWindow(mutate: (open: OpenWindow) => void): void {
    if (!this.#open) {
      const open = emptyWindow()
      // Seed a window created mid-accept with the observation time already
      // recorded for this accept, so pressure-sealed packets always carry a
      // valid observation window.
      if (this.#pendingEventTime !== undefined) {
        open.firstEventAt = this.#pendingEventTime
        open.lastEventAt = this.#pendingEventTime
      }
      this.#open = open
    }
    mutate(this.#open)
  }

  /**
   * Child-capacity and byte-budget check for placing a candidate snapshot
   * into the open window. Applies to new children and returning children
   * alike, and the child budget counts the union of child identities across
   * snapshots AND retained entries: a child represented only by an entry
   * (its snapshot was sealed away by a byte split) occupies the budget just
   * as much as one represented by a snapshot. A child absent from the open
   * window counts against the budget even when an older window for the same
   * delegation exists.
   */
  #canPlaceSnapshot(
    delegationId: string,
    candidate: ChildProgressSnapshot,
    coalescedDelta: number
  ): boolean {
    const open = this.#open
    const represented =
      (open?.childSnapshots.some((entry) => entry.delegationId === delegationId) ?? false) ||
      (open?.entries.some((entry) => entry.delegationId === delegationId) ?? false)
    if (!represented) {
      const representedChildren = new Set<string>()
      for (const snapshot of open?.childSnapshots ?? []) {
        representedChildren.add(snapshot.delegationId)
      }
      for (const entry of open?.entries ?? []) {
        representedChildren.add(entry.delegationId)
      }
      if (representedChildren.size >= this.#maximumChildren) {
        return false
      }
    }
    return this.#fitsInPacket({ snapshot: candidate, coalescedDelta })
  }

  /**
   * Projects the exact packet that sealing would emit — headers, sequence,
   * entries, snapshots, delivery counters (candidate growth included), the
   * observation-window span (candidate span overrides included) and a digest
   * placeholder of the real digest's length — and reports whether it stays
   * within the serialized byte budget. Runs against the open window or, when
   * none is open yet (or `freshWindow` is set), against a fresh window seeded
   * with the observation time in flight, so the first observation of a window
   * is bounded too.
   */
  #fitsInPacket(
    candidate: {
      readonly snapshot?: ChildProgressSnapshot
      readonly entry?: ChildProgressEvidenceEntry
      readonly coalescedDelta?: number
      readonly duplicateDelta?: number
      readonly rejectedDelta?: number
      readonly firstEventAt?: string
      readonly lastEventAt?: string
    },
    projection: { readonly freshWindow?: boolean } = {}
  ): boolean {
    const open =
      projection.freshWindow || this.#open === undefined
        ? {
            ...freshProjectionWindow(),
            // The window actually created mid-accept is seeded with the
            // observation time in flight (see #withOpenWindow), so the
            // projection must size that span, not the placeholder.
            firstEventAt: this.#pendingEventTime ?? TIMESTAMP_PLACEHOLDER,
            lastEventAt: this.#pendingEventTime ?? TIMESTAMP_PLACEHOLDER,
          }
        : this.#open
    const entries =
      candidate.entry !== undefined ? [...open.entries, candidate.entry] : open.entries
    const snapshot = candidate.snapshot
    const childSnapshots =
      snapshot !== undefined
        ? [
            ...open.childSnapshots.filter(
              (present) => present.delegationId !== snapshot.delegationId
            ),
            snapshot,
          ].toSorted((left, right) => compareCodePointOrder(left.delegationId, right.delegationId))
        : open.childSnapshots
    const body = {
      schemaVersion: 2 as const,
      parentExecutionId: this.#parentExecutionId,
      sequence: this.#sequence + 1,
      firstEventAt: candidate.firstEventAt ?? open.firstEventAt,
      lastEventAt: candidate.lastEventAt ?? open.lastEventAt,
      entries,
      childSnapshots,
      coalescedEventCount: open.coalescedEventCount + (candidate.coalescedDelta ?? 0),
      duplicateEventCount: open.duplicateEventCount + (candidate.duplicateDelta ?? 0),
      rejectedEventCount: open.rejectedEventCount + (candidate.rejectedDelta ?? 0),
    }
    const projected = encoder.encode(
      canonicalJsonStringify({ ...body, contentDigest: DIGEST_PLACEHOLDER })
    ).byteLength
    return projected <= this.#maximumBytes
  }

  #replaceSnapshotInOpenWindow(snapshot: ChildProgressSnapshot): void {
    this.#withOpenWindow((open) => {
      const index = open.childSnapshots.findIndex(
        (candidate) => candidate.delegationId === snapshot.delegationId
      )
      if (index === -1) {
        open.childSnapshots.push(snapshot)
        open.childSnapshots.sort((left, right) =>
          compareCodePointOrder(left.delegationId, right.delegationId)
        )
      } else {
        open.childSnapshots[index] = snapshot
      }
    })
  }

  #appendEntry(entry: ChildProgressEvidenceEntry): boolean {
    if (!this.#fitsInPacket({ entry })) return false
    this.#withOpenWindow((open) => {
      open.entries.push(entry)
    })
    return true
  }

  /** Seals under packet pressure: the packet joins the ready queue. */
  #sealToQueue(): ChildProgressEvidencePacket | undefined {
    const packet = this.#seal()
    if (packet) this.#ready.push(packet)
    return packet
  }

  /** Closes the open window; returns undefined when there was nothing to seal. */
  #seal(): ChildProgressEvidencePacket | undefined {
    const open = this.#open
    this.#open = undefined
    if (!open || isEmptyWindow(open)) return undefined
    this.#sequence += 1
    const body = {
      schemaVersion: 2 as const,
      parentExecutionId: this.#parentExecutionId,
      sequence: this.#sequence,
      firstEventAt: open.firstEventAt,
      lastEventAt: open.lastEventAt,
      entries: open.entries,
      childSnapshots: open.childSnapshots,
      coalescedEventCount: open.coalescedEventCount,
      duplicateEventCount: open.duplicateEventCount,
      rejectedEventCount: open.rejectedEventCount,
    }
    return {
      ...body,
      contentDigest: childProgressEvidenceDigest(body),
    }
  }
}

function emptyWindow(): OpenWindow {
  return {
    firstEventAt: '',
    lastEventAt: '',
    entries: [],
    childSnapshots: [],
    coalescedEventCount: 0,
    duplicateEventCount: 0,
    rejectedEventCount: 0,
  }
}

function toEntry(event: ChildProgressEvidenceEvent): ChildProgressEvidenceEntry {
  return ChildProgressEvidenceEntrySchema.parse({
    kind: event.phase === 'awaiting_input' ? 'awaiting_input' : 'terminal',
    eventId: event.eventId,
    delegationId: event.delegationId,
    childExecutionId: event.childExecutionId,
    ...(event.childAttemptId ? { childAttemptId: event.childAttemptId } : {}),
    generation: event.generation,
    phase: event.phase,
    observedAt: event.observedAt,
    ...(event.terminalResultRef ? { terminalResultRef: event.terminalResultRef } : {}),
    ...(event.failure ? { failure: event.failure } : {}),
    ...(event.cancelReason ? { cancelReason: event.cancelReason } : {}),
    ...(event.interaction ? { interaction: event.interaction } : {}),
  })
}

/**
 * Deterministic content digest over a packet body: every field except the
 * digest itself, including the sequence (format v2).
 */
export function childProgressEvidenceDigest(
  body: Omit<ChildProgressEvidencePacket, 'contentDigest'>
): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(body)).digest('hex')}`
}

/**
 * Validates a packet as received by the workspace lead and re-derives its
 * content digest. Returns the parsed packet; throws on tampering (including
 * sequence edits) or structural violations so downstream code can trust the
 * identity fields.
 */
export function parseChildProgressEvidencePacket(packet: unknown): ChildProgressEvidencePacket {
  const parsed = ChildProgressEvidencePacketSchema.parse(packet)
  const { contentDigest, ...body } = parsed
  const expected = childProgressEvidenceDigest(body)
  if (expected !== contentDigest) {
    throw new ChildProgressEvidenceError(
      'DIGEST_MISMATCH',
      `Packet content digest mismatch: expected ${expected}, received ${contentDigest}`
    )
  }
  return parsed
}

/**
 * Human input addressed to the workspace lead while children run (a new
 * instruction, an approval resolution, a grant decision). The input carries
 * only opaque identity: the interaction it belongs to, its kind, and when the
 * lead received it. Payloads stay behind the interaction's own authorized
 * channel, exactly like packet references.
 */
export const LeadHumanInputSchema = z
  .object({
    interactionId: IdentifierSchemas.interactionId,
    kind: InteractionKindSchema,
    receivedAt: TimestampSchema,
  })
  .strict()

export type LeadHumanInput = z.output<typeof LeadHumanInputSchema>

/**
 * One ordered item the lead's turn loop consumes. Delivery order is the
 * outbox order; `sequence` is a per-dispatcher monotonic delivery identity.
 * Human input and critical child evidence are placed on the outbox in the
 * same scheduling step that accepted them — never behind routine progress
 * batching. Routine progress rides packets sealed at bounded coalescing
 * pressure or an explicit deadline (`trigger` records which).
 */
export type ChildProgressLeadDelivery =
  | {
      readonly kind: 'human_input'
      readonly sequence: number
      readonly input: LeadHumanInput
    }
  | {
      readonly kind: 'evidence'
      readonly sequence: number
      readonly packet: ChildProgressEvidencePacket
      readonly trigger: 'critical' | 'packet_pressure' | 'coalescing_pressure' | 'deadline'
    }

export interface ChildProgressLeadDispatcherOptions {
  readonly buffer: ChildProgressEvidenceBuffer
  /**
   * Routine events coalesced before the open packet is sealed for the lead.
   * Default 128; every value keeps delivery latency bounded because a child's
   * burst cannot postpone the next snapshot delivery past this many events.
   */
  readonly maximumCoalescedEventsPerDelivery?: number
}

/**
 * Delivery policy that keeps the lead responsive while at least two children
 * stream (M13.04.2, refs adea-ai/control-plane#1019). Composes the evidence
 * buffer with an explicit scheduling policy instead of timer callbacks, so
 * behavior is deterministic under test:
 *
 * - Human input addressed to the lead and critical child observations
 *   (`awaiting_input`, terminal outcomes) are appended to the outbox in the
 *   same step that accepts them — zero routine events, coalescing pressure or
 *   packet pressure may delay their delivery.
 * - Routine progress coalesces in the buffer and is delivered when the
 *   configured event pressure is reached, on an explicit owner deadline, or
 *   when the buffer seals under packet pressure. A burst from one child
 *   cannot starve another: every routine delivery carries the latest
 *   coalesced snapshot of every child observed in its window, and the
 *   pressure threshold bounds how many routine events can pass between
 *   deliveries.
 * - Delivery order is the outbox order (arrival order), with a per-dispatcher
 *   monotonic `sequence` so consumers can detect reordering.
 */
export class ChildProgressLeadDispatcher {
  readonly #buffer: ChildProgressEvidenceBuffer
  readonly #maximumCoalescedEventsPerDelivery: number
  readonly #outbox: ChildProgressLeadDelivery[] = []
  #routineEventsSinceDelivery = 0
  #sequence = 0
  #deliveredPackets = 0
  #deliveredHumanInputs = 0

  constructor(options: ChildProgressLeadDispatcherOptions) {
    this.#buffer = options.buffer
    this.#maximumCoalescedEventsPerDelivery =
      options.maximumCoalescedEventsPerDelivery ?? DEFAULTS.maximumCoalescedEventsPerDelivery
    if (this.#maximumCoalescedEventsPerDelivery < 1) {
      throw new ChildProgressEvidenceError(
        'CONFIGURATION',
        'maximumCoalescedEventsPerDelivery must be at least 1'
      )
    }
  }

  /**
   * Folds one child observation through the buffer and applies the delivery
   * policy. The receipt is the buffer's own; deliveries land on the outbox.
   * A critical observation is flushed for the lead immediately — the number
   * of routine events accepted after it but before its delivery is always 0.
   */
  acceptProgress(event: unknown): ChildProgressEvidenceReceipt {
    const receipt = this.#buffer.accept(event)
    // Packets the buffer sealed under packet pressure during this accept are
    // deliverable now; they precede anything sealed after them.
    for (const packet of this.#buffer.readyPackets()) {
      this.#enqueueEvidence(packet, 'packet_pressure')
    }
    if (receipt.outcome === 'retained') {
      const packet = this.#buffer.flush()
      if (packet) this.#enqueueEvidence(packet, 'critical')
      this.#routineEventsSinceDelivery = 0
      return receipt
    }
    if (receipt.outcome === 'coalesced') {
      this.#routineEventsSinceDelivery += 1
      if (this.#routineEventsSinceDelivery >= this.#maximumCoalescedEventsPerDelivery) {
        const packet = this.#buffer.flush()
        if (packet) this.#enqueueEvidence(packet, 'coalescing_pressure')
        this.#routineEventsSinceDelivery = 0
      }
    }
    return receipt
  }

  /**
   * Places human input addressed to the lead on the outbox immediately and
   * returns the delivery. No progress batching sits between the call and the
   * delivery being available to `takeDeliveries()`.
   */
  acceptHumanInput(input: unknown): ChildProgressLeadDelivery {
    const parsed = LeadHumanInputSchema.parse(input)
    this.#sequence += 1
    this.#deliveredHumanInputs += 1
    const delivery: ChildProgressLeadDelivery = {
      kind: 'human_input',
      sequence: this.#sequence,
      input: parsed,
    }
    this.#outbox.push(delivery)
    return delivery
  }

  /** Owner-driven batch deadline: seals the open packet for the lead now. */
  flushDeadline(): ChildProgressEvidencePacket | undefined {
    const packet = this.#buffer.flush()
    if (packet) this.#enqueueEvidence(packet, 'deadline')
    return packet
  }

  /**
   * Takes every delivery waiting for the lead, in arrival order. Mirrors the
   * buffer's `readyPackets()` drain semantics: each delivery is returned
   * exactly once.
   */
  takeDeliveries(): ChildProgressLeadDelivery[] {
    const deliveries = [...this.#outbox]
    this.#outbox.length = 0
    return deliveries
  }

  /** Delivery-side counters for telemetry and tests. */
  stats(): {
    readonly pendingDeliveries: number
    readonly routineEventsSinceDelivery: number
    readonly deliveredPacketCount: number
    readonly deliveredHumanInputCount: number
  } {
    return {
      pendingDeliveries: this.#outbox.length,
      routineEventsSinceDelivery: this.#routineEventsSinceDelivery,
      deliveredPacketCount: this.#deliveredPackets,
      deliveredHumanInputCount: this.#deliveredHumanInputs,
    }
  }

  #enqueueEvidence(
    packet: ChildProgressEvidencePacket,
    trigger: Extract<ChildProgressLeadDelivery, { kind: 'evidence' }>['trigger']
  ): void {
    this.#sequence += 1
    this.#deliveredPackets += 1
    this.#outbox.push({ kind: 'evidence', sequence: this.#sequence, packet, trigger })
  }
}

/**
 * A reference carried inside a packet, kept opaque in transit: the artifact
 * that would satisfy a completed child's `terminalResultRef`, or the
 * interaction behind an `awaiting_input` entry. The packet never carries the
 * referenced payload.
 */
export type ChildProgressEvidenceReference =
  | { readonly kind: 'terminal_result'; readonly artifactId: string }
  | { readonly kind: 'interaction'; readonly interactionId: string }

/**
 * The verdict an authority answers with at read time — for the CURRENT
 * authorization, never a capture-time snapshot. `forbidden` distinguishes an
 * explicitly revoked reference from one the caller was never authorized for;
 * `unavailable` means the reference cannot be resolved at all (missing or no
 * longer retained). Verdicts carry no payload, so a revoked reference cannot
 * leak the private content it once pointed at.
 */
export const ChildProgressReferenceVerdictSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('authorized') }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.literal('missing') }).strict(),
  z
    .object({
      status: z.literal('forbidden'),
      reason: z.enum(['revoked', 'not_authorized']),
    })
    .strict(),
])

export type ChildProgressReferenceVerdict = z.output<typeof ChildProgressReferenceVerdictSchema>

/**
 * The lazy, current-authorization reference authority. Implementations must
 * answer from live authorization state at call time; caching a verdict would
 * turn it into a capture-time snapshot and is expressly not done by callers
 * in this module.
 */
export interface ChildProgressReferenceAuthority {
  authorize(reference: ChildProgressEvidenceReference): Promise<ChildProgressReferenceVerdict>
}

export type ChildProgressReferenceResolution = ChildProgressEvidenceReference &
  ChildProgressReferenceVerdict

/**
 * Collects the distinct references a packet carries, in packet order
 * (entry order, deduplicated by kind and identifier).
 */
export function evidencePacketReferences(
  packet: ChildProgressEvidencePacket
): ChildProgressEvidenceReference[] {
  const references: ChildProgressEvidenceReference[] = []
  const seen = new Set<string>()
  const push = (reference: ChildProgressEvidenceReference): void => {
    const key =
      reference.kind === 'terminal_result'
        ? `terminal_result:${reference.artifactId}`
        : `interaction:${reference.interactionId}`
    if (seen.has(key)) return
    seen.add(key)
    references.push(reference)
  }
  for (const entry of packet.entries) {
    if (entry.terminalResultRef !== undefined) {
      push({ kind: 'terminal_result', artifactId: entry.terminalResultRef })
    }
    if (entry.interaction !== undefined) {
      push({ kind: 'interaction', interactionId: entry.interaction.interactionId })
    }
  }
  return references
}

/**
 * Resolves a packet's references at read time against the authority's
 * CURRENT authorization. The packet is re-validated first, every reference is
 * authorized by a fresh call (no caching between calls or across packets),
 * and the resolution carries only the reference identity and an explicit
 * verdict — `authorized`, `unavailable` (with `missing`), or `forbidden`
 * (with `revoked` or `not_authorized`). The referenced private payload is
 * never returned here; a caller that needs it fetches it behind its own
 * separately authorized channel, and a reference that has been revoked since
 * capture resolves to `forbidden` instead of ever surfacing its content.
 */
export async function resolveEvidenceReferences(
  packet: unknown,
  authority: ChildProgressReferenceAuthority
): Promise<readonly ChildProgressReferenceResolution[]> {
  const parsed = parseChildProgressEvidencePacket(packet)
  const resolutions: ChildProgressReferenceResolution[] = []
  for (const reference of evidencePacketReferences(parsed)) {
    const verdict = ChildProgressReferenceVerdictSchema.parse(await authority.authorize(reference))
    resolutions.push(referenceResolution(reference, verdict))
  }
  return resolutions
}

function referenceResolution(
  reference: ChildProgressEvidenceReference,
  verdict: ChildProgressReferenceVerdict
): ChildProgressReferenceResolution {
  if (verdict.status === 'authorized') return { ...reference, status: 'authorized' }
  if (verdict.status === 'unavailable') {
    return { ...reference, status: 'unavailable', reason: 'missing' }
  }
  return { ...reference, status: 'forbidden', reason: verdict.reason }
}

/**
 * Adapter for the child-job owner: converts a `DelegationEvent` already
 * flowing through the delegation pipeline into a buffer event. The owner
 * supplies the delivery identity (`eventId`) and the delegation's monotonic
 * `generation` (the delegation record revision is a suitable mark); both are
 * intentionally not inferred, because redelivery policy is the owner's.
 *
 * Cancellation reasons are passed through only when the producer actually
 * knows one (for example `parent_cancelled` from cascade cancellation);
 * ordinary child-originated cancellations carry no reason in the delegation
 * pipeline and the adapter preserves that uncertainty instead of inventing a
 * reason.
 */
export function delegationEventToEvidenceEvent(input: {
  readonly event: DelegationEvent
  readonly eventId: string
  readonly generation: number
  readonly childAttemptId?: string
  readonly interaction?: {
    readonly interactionId: string
    readonly kind: 'input' | 'approval' | 'grant' | 'runtime'
  }
  readonly metrics?: Record<string, number>
}): ChildProgressEvidenceEvent {
  const details = input.event.details
  const state = typeof details['state'] === 'string' ? details['state'] : undefined
  const phase =
    input.event.type === 'delegation.completed'
      ? ('completed' as const)
      : input.event.type === 'delegation.failed'
        ? ('failed' as const)
        : input.event.type === 'delegation.cancelled'
          ? ('cancelled' as const)
          : state === 'awaiting_input'
            ? ('awaiting_input' as const)
            : ('running' as const)
  const terminalResultRef =
    typeof details['terminalResultRef'] === 'string' ? details['terminalResultRef'] : undefined
  const failureCode =
    typeof details['failureCode'] === 'string' ? details['failureCode'] : undefined
  const parsedCancelReason = CancelReasonSchema.safeParse(
    input.event.type === 'delegation.cancelled' ? details['reason'] : undefined
  )
  const cancelReason = parsedCancelReason.success ? parsedCancelReason.data : undefined
  return ChildProgressEvidenceEventSchema.parse({
    eventId: input.eventId,
    parentExecutionId: input.event.parentExecutionId,
    delegationId: input.event.delegationId,
    childExecutionId: input.event.childExecutionId,
    ...(input.childAttemptId ? { childAttemptId: input.childAttemptId } : {}),
    generation: input.generation,
    phase,
    observedAt: input.event.occurredAt,
    ...(terminalResultRef ? { terminalResultRef } : {}),
    ...(failureCode ? { failure: { classification: 'unknown', code: failureCode } } : {}),
    ...(cancelReason !== undefined ? { cancelReason } : {}),
    ...(input.interaction ? { interaction: input.interaction } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
  })
}
