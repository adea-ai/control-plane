import { createHash } from 'node:crypto'
import {
  canonicalJsonStringify,
  compareCodePointOrder,
  IdentifierSchemas,
} from '@control-plane/contracts'
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
 * bounds shrink packet size, never the retained evidence set.
 *
 * Every observation carries the full job/attempt identity (`delegationId`,
 * `childExecutionId`, `childAttemptId`, owner-owned `generation`) and
 * provenance (`eventId`, `observedAt`). Duplicate deliveries are deduplicated
 * by `eventId`; events from a superseded generation or arriving after a
 * generation went terminal are rejected with an explicit receipt rather than
 * folded silently. All payload-shaped fields are opaque identifiers, digests,
 * enums, timestamps or bounded integers: evidence travels as authorized
 * references (artifact, interaction, result), never as copied secrets or
 * unrelated private context.
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

/**
 * A single child progress observation as delivered by the child-job owner.
 * `generation` is the owner-owned monotonic attempt/revision mark for the
 * delegation (for example the delegation record revision or the attempt
 * sequence); events below the high-water mark are stale by definition.
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
      field: 'terminalResultRef' | 'failure' | 'cancelReason' | 'interaction',
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
    if (event.phase === 'cancelled') {
      requireFor(
        'cancelReason',
        event.cancelReason !== undefined,
        'Cancelled child progress requires a cancellation reason'
      )
    } else {
      requireAbsent('cancelReason', event.cancelReason !== undefined)
    }
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
    if (entry.phase === 'cancelled' && entry.cancelReason === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Cancelled entries require a cancellation reason',
      })
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

export const ChildProgressEvidencePacketSchema = z
  .object({
    schemaVersion: z.literal(1),
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
      readonly reason: 'stale_generation' | 'terminated_generation' | 'foreign_parent'
      readonly eventId: string
      readonly delegationId?: string
    }

export interface ChildProgressEvidenceBufferOptions {
  readonly parentExecutionId: string
  /** Critical entries per packet before the packet seals. Default 32. */
  readonly maximumEntries?: number
  /** Distinct children per packet before the packet seals. Default 64. */
  readonly maximumChildren?: number
  /** Canonical-JSON byte budget per packet. Default 16384; 2048..1048576. */
  readonly maximumBytes?: number
  /** Bounded memory for duplicate detection. Default 8192; oldest evicted. */
  readonly maximumTrackedEventIds?: number
}

interface DelegationWindow {
  generation: number
  terminal: boolean
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
} as const

const encoder = new TextEncoder()

/** Only these phases close a generation; awaiting_input keeps it open for resume. */
const TERMINAL_PHASES = new Set(['completed', 'failed', 'cancelled'])

function isTerminalPhase(phase: ChildProgressEvidenceEvent['phase']): boolean {
  return TERMINAL_PHASES.has(phase)
}

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
  readonly #seenEventIds = new Map<string, true>()
  readonly #windows = new Map<string, DelegationWindow>()
  readonly #ready: ChildProgressEvidencePacket[] = []
  #open: OpenWindow | undefined
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
   * exception control flow for at-least-once delivery.
   */
  accept(event: unknown): ChildProgressEvidenceReceipt {
    const parsed = ChildProgressEvidenceEventSchema.parse(event)
    if (parsed.parentExecutionId !== this.#parentExecutionId) {
      this.#lifetimeRejections += 1
      return {
        outcome: 'rejected',
        reason: 'foreign_parent',
        eventId: parsed.eventId,
        delegationId: parsed.delegationId,
      }
    }
    if (this.#seenEventIds.has(parsed.eventId)) {
      this.#lifetimeDuplicates += 1
      if (this.#open) this.#open.duplicateEventCount += 1
      return { outcome: 'duplicate', eventId: parsed.eventId }
    }
    this.#trackEventId(parsed.eventId)

    const window = this.#windows.get(parsed.delegationId)
    if (window) {
      if (parsed.generation < window.generation) {
        return this.#reject('stale_generation', parsed.eventId, parsed.delegationId)
      }
      if (parsed.generation === window.generation && window.terminal) {
        return this.#reject('terminated_generation', parsed.eventId, parsed.delegationId)
      }
    }

    const critical = parsed.phase !== 'running'
    const entry: ChildProgressEvidenceEntry | undefined = critical ? toEntry(parsed) : undefined

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
      if (!this.#appendEntry(entry)) {
        throw new ChildProgressEvidenceError(
          'BOUNDS_EXCEEDED',
          `A single evidence entry exceeds the configured maximumBytes budget (${this.#maximumBytes})`
        )
      }
    }
    this.#noteEventTime(parsed.observedAt)

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
    reason: 'stale_generation' | 'terminated_generation',
    eventId: string,
    delegationId: string
  ): ChildProgressEvidenceReceipt {
    this.#lifetimeRejections += 1
    if (this.#open) this.#open.rejectedEventCount += 1
    return { outcome: 'rejected', reason, eventId, delegationId }
  }

  #trackEventId(eventId: string): void {
    this.#seenEventIds.set(eventId, true)
    while (this.#seenEventIds.size > this.#maximumTrackedEventIds) {
      const oldest = this.#seenEventIds.keys().next()
      if (oldest.done) break
      this.#seenEventIds.delete(oldest.value)
    }
  }

  #noteEventTime(observedAt: string): void {
    if (!this.#open) return
    if (this.#open.firstEventAt === '' || observedAt < this.#open.firstEventAt) {
      this.#open.firstEventAt = observedAt
    }
    if (this.#open.lastEventAt === '' || observedAt > this.#open.lastEventAt) {
      this.#open.lastEventAt = observedAt
    }
  }

  /**
   * Merges the event into the per-child snapshot. Returns false when the
   * child is new and the packet is at child capacity, or when the projected
   * packet would exceed the byte budget; the caller seals and retries.
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
        metrics: event.metrics ?? {},
      }
      if (this.#exceedsFreshPacketBudget(event.delegationId, snapshot)) return false
      this.#windows.set(event.delegationId, {
        generation: event.generation,
        terminal: isTerminalPhase(event.phase),
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
    // snapshot; metric totals always accumulate.
    const supersedes = event.observedAt >= window.snapshot.lastObservedAt
    const metrics = { ...window.snapshot.metrics }
    for (const [key, value] of Object.entries(event.metrics ?? {})) {
      metrics[key] = (metrics[key] ?? 0) + value
    }
    const merged: ChildProgressSnapshot = {
      ...window.snapshot,
      ...(supersedes
        ? {
            phase: event.phase,
            lastObservedAt: event.observedAt,
            ...(event.childAttemptId ? { childAttemptId: event.childAttemptId } : {}),
          }
        : {}),
      observedEventCount: window.snapshot.observedEventCount + 1,
      metrics,
    }
    if (this.#exceedsGrownPacketBudget(window.snapshot, merged)) return false
    this.#windows.set(event.delegationId, {
      generation: window.generation,
      terminal: window.terminal || (supersedes && isTerminalPhase(event.phase)),
      snapshot: merged,
    })
    this.#replaceSnapshotInOpenWindow(merged)
    this.#withOpenWindow((open) => {
      open.coalescedEventCount += 1
    })
    return true
  }

  #withOpenWindow(mutate: (open: OpenWindow) => void): void {
    if (!this.#open) this.#open = emptyWindow()
    mutate(this.#open)
  }

  #variableBodySize(variable: {
    readonly entries: readonly ChildProgressEvidenceEntry[]
    readonly childSnapshots: readonly ChildProgressSnapshot[]
  }): number {
    return encoder.encode(
      canonicalJsonStringify({ entries: variable.entries, childSnapshots: variable.childSnapshots })
    ).byteLength
  }

  #projectedSize(overrides?: {
    readonly snapshot?: ChildProgressSnapshot
    readonly entry?: ChildProgressEvidenceEntry
  }): number {
    if (!this.#open) return 0
    const entries =
      overrides?.entry !== undefined ? [...this.#open.entries, overrides.entry] : this.#open.entries
    const snapshot = overrides?.snapshot
    const childSnapshots =
      snapshot !== undefined
        ? [
            ...this.#open.childSnapshots.filter(
              (candidate) => candidate.delegationId !== snapshot.delegationId
            ),
            snapshot,
          ].toSorted((left, right) => compareCodePointOrder(left.delegationId, right.delegationId))
        : this.#open.childSnapshots
    return this.#variableBodySize({ entries, childSnapshots })
  }

  #exceedsFreshPacketBudget(delegationId: string, snapshot: ChildProgressSnapshot): boolean {
    const knownChild = this.#open?.childSnapshots.some(
      (candidate) => candidate.delegationId === delegationId
    )
    if (!knownChild && (this.#open?.childSnapshots.length ?? 0) >= this.#maximumChildren) {
      return true
    }
    return this.#projectedSize({ snapshot }) > this.#maximumBytes
  }

  #exceedsGrownPacketBudget(
    current: ChildProgressSnapshot,
    merged: ChildProgressSnapshot
  ): boolean {
    if (!this.#open) return false
    const grown = this.#projectedSize({ snapshot: merged })
    const currentSize = this.#projectedSize({ snapshot: current })
    return grown > currentSize && grown > this.#maximumBytes
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
    if (this.#projectedSize({ entry }) > this.#maximumBytes) return false
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
      schemaVersion: 1 as const,
      parentExecutionId: this.#parentExecutionId,
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
      sequence: this.#sequence,
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

/** Deterministic content digest over a packet body (every field but the digest itself). */
export function childProgressEvidenceDigest(
  body: Omit<ChildProgressEvidencePacket, 'contentDigest' | 'sequence'>
): string {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(body)).digest('hex')}`
}

/**
 * Validates a packet as received by the workspace lead and re-derives its
 * content digest. Returns the parsed packet; throws on tampering or
 * structural violations so downstream code can trust the identity fields.
 */
export function parseChildProgressEvidencePacket(packet: unknown): ChildProgressEvidencePacket {
  const parsed = ChildProgressEvidencePacketSchema.parse(packet)
  const { contentDigest, sequence: _sequence, ...body } = parsed
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
 * Adapter for the child-job owner: converts a `DelegationEvent` already
 * flowing through the delegation pipeline into a buffer event. The owner
 * supplies the delivery identity (`eventId`) and the delegation's monotonic
 * `generation` (the delegation record revision is a suitable mark); both are
 * intentionally not inferred, because redelivery policy is the owner's.
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
  const cancelReason =
    input.event.type === 'delegation.cancelled' && typeof details['reason'] === 'string'
      ? details['reason']
      : undefined
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
    ...(cancelReason ? { cancelReason } : {}),
    ...(input.interaction ? { interaction: input.interaction } : {}),
    ...(input.metrics ? { metrics: input.metrics } : {}),
  })
}
