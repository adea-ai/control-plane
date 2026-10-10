import { describe, expect, test } from 'bun:test'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import {
  ChildProgressEvidenceBuffer,
  ChildProgressLeadDispatcher,
} from './child-progress-evidence.ts'
import { ChildProgressLeadFeed } from './child-progress-lead-feed.ts'

const PARENT = 'exe_01JABCDEF0123456789ABCDEFG'
const CHILD_A = 'exe_01JBBCDEF0123456789ABCDEFG'
const CHILD_B = 'exe_01JCBCDEF0123456789ABCDEFG'
const DLG_A = 'dlg_01JBBCDEF0123456789ABCDEFG'
const DLG_B = 'dlg_01JCBCDEF0123456789ABCDEFG'
const ATT_A = 'att_01JBBCDEF0123456789ABCDEFG'
const ATT_B = 'att_01JCBCDEF0123456789ABCDEFG'
const ART_A = 'art_01JBBCDEF0123456789ABCDEFG'
const ART_B = 'art_01JCBCDEF0123456789ABCDEFG'

const event = (overrides) => ({
  type: 'delegation.progress',
  delegationId: DLG_A,
  parentExecutionId: PARENT,
  childExecutionId: CHILD_A,
  occurredAt: '2026-08-25T18:05:00.000Z',
  details: { state: 'running', childAttemptId: ATT_A },
  ...overrides,
})

/** Canonical durable outlet double with the real publisher's contract. */
function durablePublications() {
  const byKey = new Map()
  const order = []
  return {
    async publish(input, idempotencyKey) {
      const canonical = canonicalJsonStringify(input)
      const seen = byKey.get(idempotencyKey)
      if (seen !== undefined) {
        if (seen !== canonical) throw new Error('DELEGATION_PUBLICATION_CONFLICT')
        return
      }
      byKey.set(idempotencyKey, canonical)
      order.push(input)
    },
    async list() {
      return [...order]
    },
    get size() {
      return order.length
    },
  }
}

function createFeed(publications, generationOf = () => 1) {
  const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: PARENT })
  const dispatcher = new ChildProgressLeadDispatcher({ buffer })
  return {
    dispatcher,
    feed: new ChildProgressLeadFeed({ publications, dispatcher, generationOf }),
  }
}

describe('child progress lead feed over the canonical durable outlet', () => {
  test('folds durable publications for two children into ordered lead deliveries', async () => {
    const publications = durablePublications()
    const { feed } = createFeed(publications)

    await feed.publish(event(), 'delegation:dlg_a:progress:1')
    await feed.publish(
      event({
        delegationId: DLG_B,
        childExecutionId: CHILD_B,
        details: { state: 'running', childAttemptId: ATT_B },
      }),
      'delegation:dlg_b:progress:1'
    )
    // Routine progress coalesces: nothing is pushed at the lead yet.
    expect(feed.takeDeliveries()).toEqual([])

    await feed.publish(
      event({
        type: 'delegation.completed',
        details: { childAttemptId: ATT_A, terminalResultRef: ART_A },
      }),
      'delegation:dlg_a:completed:1'
    )
    const first = feed.takeDeliveries()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ kind: 'evidence', trigger: 'critical' })
    const delegations = new Set([
      ...first[0].packet.entries.map((entry) => entry.delegationId),
      ...first[0].packet.childSnapshots.map((snapshot) => snapshot.delegationId),
    ])
    expect([...delegations].toSorted()).toStrictEqual([DLG_A, DLG_B])

    await feed.publish(
      event({
        type: 'delegation.completed',
        delegationId: DLG_B,
        childExecutionId: CHILD_B,
        details: { childAttemptId: ATT_B, terminalResultRef: ART_B },
      }),
      'delegation:dlg_b:completed:1'
    )
    const second = feed.takeDeliveries()
    expect(second).toHaveLength(1)
    expect(second[0].sequence).toBeGreaterThan(first[0].sequence)
    expect(feed.stats()).toMatchObject({ foldedEventCount: 4, pendingDeliveries: 0 })
    expect(publications.size).toBe(4)
  })

  test('identical redelivery deduplicates and divergent idempotency conflicts at the outlet', async () => {
    const publications = durablePublications()
    const { feed } = createFeed(publications)

    await feed.publish(event(), 'delegation:dlg_a:progress:1')
    // Same idempotency key, same content: the durable outlet replays it
    // without a second publication; the projection dedups by content identity.
    await feed.publish(event(), 'delegation:dlg_a:progress:1')
    expect(feed.stats().duplicateEventCount).toBe(1)
    expect(publications.size).toBe(1)

    // Same idempotency key, changed content: the canonical outlet conflicts
    // before the projection ever sees it.
    await expect(
      feed.publish(event({ occurredAt: '2026-08-25T18:06:00.000Z' }), 'delegation:dlg_a:progress:1')
    ).rejects.toThrow('DELEGATION_PUBLICATION_CONFLICT')

    // Same content under a different key publishes durably but still folds
    // exactly once through the content-derived evidence identity.
    await feed.publish(event(), 'delegation:dlg_a:progress:retry')
    expect(publications.size).toBe(2)
    expect(feed.stats().foldedEventCount).toBe(1)
    expect(feed.stats().duplicateEventCount).toBe(2)
  })

  test('restart replay rebuilds the projection once and re-fold answers duplicate', async () => {
    const publications = durablePublications()
    const first = createFeed(publications)
    await first.feed.publish(event(), 'delegation:dlg_a:progress:1')
    await first.feed.publish(
      event({
        type: 'delegation.completed',
        details: { childAttemptId: ATT_A, terminalResultRef: ART_A },
      }),
      'delegation:dlg_a:completed:1'
    )
    expect(first.feed.takeDeliveries()).toHaveLength(1)

    // Restart: the durable outlet survives, the projection starts empty and
    // rebuilds from it — same events, same derived identities, one packet.
    const second = createFeed(publications)
    const replayed = await second.feed.replay()
    expect(replayed.foldedEventCount).toBe(2)
    const rebuilt = second.feed.takeDeliveries()
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0].packet.entries.map((entry) => entry.delegationId)).toContain(DLG_A)

    // Replaying again over the same projection is idempotent: everything
    // answers duplicate and no second delivery appears.
    const again = await second.feed.replay()
    expect(again).toEqual({ foldedEventCount: 0, duplicateEventCount: 2, rejectedEventCount: 0 })
    expect(second.feed.takeDeliveries()).toEqual([])
    expect(second.feed.stats().duplicateEventCount).toBe(2)
  })

  test('human input reaches the outbox ahead of any routine batching', async () => {
    const publications = durablePublications()
    const { feed } = createFeed(publications)
    await feed.publish(event(), 'delegation:dlg_a:progress:1')
    feed.acceptHumanInput({
      interactionId: 'int_01JBBCDEF0123456789ABCDEFG',
      kind: 'input',
      receivedAt: '2026-08-25T18:05:01.000Z',
    })
    const deliveries = feed.takeDeliveries()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      kind: 'human_input',
      sequence: 1,
      input: { kind: 'input' },
    })
    expect(IdentifierSchemas.interactionId.parse(deliveries[0].input.interactionId)).toBeTruthy()
    expect(feed.stats().deliveredHumanInputCount).toBe(1)
  })

  test('generation fencing rejects superseded-generation events explicitly', async () => {
    const publications = durablePublications()
    const { feed } = createFeed(publications, (folded) =>
      folded.occurredAt === '2026-08-25T18:05:00.000Z' ? 2 : 1
    )
    await feed.publish(event(), 'delegation:dlg_a:progress:1')
    expect(feed.stats().rejectedEventCount).toBe(0)
    // An older-generation observation after the owner moved on is rejected,
    // counted, and never delivered.
    await feed.publish(
      event({ occurredAt: '2026-08-25T18:04:00.000Z' }),
      'delegation:dlg_a:progress:stale'
    )
    expect(feed.stats().rejectedEventCount).toBe(1)
    expect(feed.takeDeliveries()).toEqual([])
  })

  test('derived evidence identity is deterministic and content-bound', () => {
    const one = ChildProgressLeadFeed.evidenceEventId(event())
    expect(one).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(ChildProgressLeadFeed.evidenceEventId(event())).toBe(one)
    expect(
      ChildProgressLeadFeed.evidenceEventId(event({ occurredAt: '2026-08-25T18:06:00.000Z' }))
    ).not.toBe(one)
  })
})
