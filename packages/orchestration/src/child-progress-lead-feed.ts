import { canonicalJsonStringify } from '@control-plane/contracts'
import { createHash } from 'node:crypto'
import {
  DelegationEventSchema,
  type DelegationEvent,
  type DelegationEventPublisher,
} from './delegation.js'
import {
  ChildProgressLeadDispatcher,
  delegationEventToEvidenceEvent,
  type LeadHumanInput,
} from './child-progress-evidence.js'

/**
 * The durable outlet capability this feed requires: canonical idempotent
 * publish plus the ordered `list()` that restart replay rebuilds from.
 * `SqliteDelegationEventPublisher` implements it.
 */
export interface ChildProgressEventOutlet extends DelegationEventPublisher {
  list(): Promise<readonly DelegationEvent[]>
}

export interface ChildProgressLeadFeedOptions {
  /**
   * The canonical durable delegation-event outlet (for example
   * `SqliteDelegationEventPublisher`). It is the authority: every publish
   * validates scope and idempotency THERE before anything reaches the lead
   * projection, and `list()` is the restart source.
   */
  readonly publications: ChildProgressEventOutlet
  readonly dispatcher: ChildProgressLeadDispatcher
  /**
   * Owner-supplied monotonic generation per delegation — never inferred.
   * It must answer the generation each folded event belongs to; owners that
   * keep a monotonic per-delegation mark in durable state get exact
   * restart replay, while a constant mark is correct for delegations whose
   * generation never advances.
   */
  readonly generationOf: (event: DelegationEvent) => number
}

export interface ChildProgressLeadFeedStats {
  readonly foldedEventCount: number
  readonly duplicateEventCount: number
  readonly rejectedEventCount: number
}

/**
 * Live child-progress lead feed over the canonical durable delegation-event
 * path (M13.04.2, refs adea-ai/control-plane#1019).
 *
 * This is the wiring that keeps the evidence buffer, lead dispatcher and
 * reference resolver off the library shelf: the feed IS the owner's
 * `DelegationEventPublisher`, so every canonical durable publication folds
 * through `delegationEventToEvidenceEvent` into the dispatcher in the same
 * step, and the lead's outbox is fed by the real pipeline rather than by
 * tests. Ordering guarantees:
 *
 * - Durable first: the canonical publisher accepts (or idempotently
 *   replays, or conflicts) the event before the projection sees it; a
 *   failed durable publish never reaches the lead.
 * - Restart: `replay()` re-folds everything the durable outlet retains. The
 *   evidence event id is derived deterministically from the event content,
 *   so the same event carries the same id live and after restart, and the
 *   buffer's eventId dedup answers `duplicate` instead of re-delivering.
 * - Content-addressed identity means a reused identity with changed content
 *   is rejected as `conflicting_event` instead of masquerading as a
 *   duplicate, and redelivery policy stays where it belongs — with the
 *   canonical publisher's idempotency contract.
 *
 * Human input never rides the event fold: the owner places it on the
 * dispatcher with `acceptHumanInput` in the same scheduling step that
 * accepted it, so no routine progress batching can delay it.
 */
export class ChildProgressLeadFeed implements DelegationEventPublisher {
  #foldedEventCount = 0
  #duplicateEventCount = 0
  #rejectedEventCount = 0

  constructor(readonly options: ChildProgressLeadFeedOptions) {}

  async publish(eventInput: DelegationEvent, idempotencyKey: string): Promise<void> {
    const event = DelegationEventSchema.parse(eventInput)
    await this.options.publications.publish(event, idempotencyKey)
    this.#fold(event)
  }

  list(): Promise<readonly DelegationEvent[]> {
    return this.options.publications.list()
  }

  /**
   * Rebuilds the lead projection from the canonical durable publications
   * after a restart. Replay is idempotent through the content-derived event
   * identity: already-folded events answer duplicate and produce no second
   * delivery.
   */
  async replay(): Promise<ChildProgressLeadFeedStats> {
    const before = this.#snapshotStats()
    for (const event of await this.options.publications.list()) {
      this.#fold(DelegationEventSchema.parse(event))
    }
    const after = this.#snapshotStats()
    return {
      foldedEventCount: after.foldedEventCount - before.foldedEventCount,
      duplicateEventCount: after.duplicateEventCount - before.duplicateEventCount,
      rejectedEventCount: after.rejectedEventCount - before.rejectedEventCount,
    }
  }

  /** Human input for the lead, placed on the outbox in this scheduling step. */
  acceptHumanInput(input: unknown): ReturnType<ChildProgressLeadDispatcher['acceptHumanInput']> {
    return this.options.dispatcher.acceptHumanInput(input)
  }

  /** Deliveries waiting for the lead, in outbox order, each returned once. */
  takeDeliveries(): ReturnType<ChildProgressLeadDispatcher['takeDeliveries']> {
    return this.options.dispatcher.takeDeliveries()
  }

  stats(): ChildProgressLeadFeedStats & ReturnType<ChildProgressLeadDispatcher['stats']> {
    return { ...this.#snapshotStats(), ...this.options.dispatcher.stats() }
  }

  #fold(event: DelegationEvent): void {
    const childAttemptId = event.details['childAttemptId']
    const receipt = this.options.dispatcher.acceptProgress(
      delegationEventToEvidenceEvent({
        event,
        eventId: childProgressEvidenceEventId(event),
        generation: this.options.generationOf(event),
        ...(typeof childAttemptId === 'string' && childAttemptId.length > 0
          ? { childAttemptId }
          : {}),
      })
    )
    if (receipt.outcome === 'duplicate') this.#duplicateEventCount += 1
    else if (receipt.outcome === 'rejected') this.#rejectedEventCount += 1
    else this.#foldedEventCount += 1
  }

  #snapshotStats(): ChildProgressLeadFeedStats {
    return {
      foldedEventCount: this.#foldedEventCount,
      duplicateEventCount: this.#duplicateEventCount,
      rejectedEventCount: this.#rejectedEventCount,
    }
  }

  /** Exposed for tests and owner telemetry: the deterministic fold identity. */
  static evidenceEventId(event: DelegationEvent): string {
    return childProgressEvidenceEventId(event)
  }
}

const CROCKFORD_HEAD = '0123456789ABCDEFGH'

/**
 * Content-derived evidence identity: the same durable event folds under the
 * same `evt_…` id live and after restart, a redelivery of identical content
 * deduplicates, and changed content under the same canonical identity cannot
 * pass as a duplicate. The first 26 hex nibbles (104 bits) of the canonical
 * event digest map into the Crockford alphabet the identifier contract uses.
 */
function childProgressEvidenceEventId(event: DelegationEvent): string {
  const digest = createHash('sha256').update(canonicalJsonStringify(event)).digest('hex')
  const suffix = digest
    .slice(0, 26)
    .split('')
    .map((character) => CROCKFORD_HEAD[Number.parseInt(character, 16)])
    .join('')
  return `evt_${suffix}`
}

export type { LeadHumanInput }
