import { describe, expect, test } from 'bun:test'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import {
  ExecutionLifecycleService,
  InMemoryExecutionRepository,
  executionConstraintFixtures,
} from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  InMemoryExecutionPlanRepository,
} from '@control-plane/execution-plan'
import {
  ChildProgressEvidenceBuffer,
  ChildProgressEvidenceError,
  ChildProgressLeadDispatcher,
  delegationEventToEvidenceEvent,
  evidencePacketReferences,
  parseChildProgressEvidencePacket,
  resolveEvidenceReferences,
} from './child-progress-evidence.ts'
import { DelegationService, InMemoryDelegationRepository } from './delegation.ts'

const digest = (character) => `sha256:${character.repeat(64)}`
const encoder = new TextEncoder()

const ids = {
  workspaceId: 'wsp_01JABCDEF0123456789ABCDEFG',
  projectId: 'prj_01JABCDEF0123456789ABCDEFG',
  taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
  agentId: 'agt_01JABCDEF0123456789ABCDEFG',
  requestId: 'req_01JABCDEF0123456789ABCDEFG',
  profileId: 'prf_01JABCDEF0123456789ABCDEFG',
  profileVersionId: 'pfv_01JABCDEF0123456789ABCDEFG',
  skillId: 'skl_01JABCDEF0123456789ABCDEFG',
  skillVersionId: 'skv_01JABCDEF0123456789ABCDEFG',
  parentExecutionId: 'exe_01JABCDEF0123456789ABCDEFG',
  foreignExecutionId: 'exe_01JDBCDEF0123456789ABCDEFG',
  childTaskIdA: 'tsk_01JBBCDEF0123456789ABCDEFG',
  childTaskIdB: 'tsk_01JCBCDEF0123456789ABCDEFG',
  childRequestIdA: 'req_01JBBCDEF0123456789ABCDEFG',
  childRequestIdB: 'req_01JCBCDEF0123456789ABCDEFG',
  childExecutionIdA: 'exe_01JBBCDEF0123456789ABCDEFG',
  childExecutionIdB: 'exe_01JCBCDEF0123456789ABCDEFG',
  childExecutionIdC: 'exe_01JFBCDEF0123456789ABCDEFG',
  delegationIdA: 'dlg_01JBBCDEF0123456789ABCDEFG',
  delegationIdB: 'dlg_01JCBCDEF0123456789ABCDEFG',
  delegationIdC: 'dlg_01JDBCDEF0123456789ABCDEFG',
  attemptIdA: 'att_01JBBCDEF0123456789ABCDEFG',
  attemptIdB: 'att_01JCBCDEF0123456789ABCDEFG',
  attemptIdC: 'att_01JDBCDEF0123456789ABCDEFG',
  runtimeConnectionId: 'rtc_01JBBCDEF0123456789ABCDEFG',
  interactionId: 'int_01JBBCDEF0123456789ABCDEFG',
  resultRefA: 'art_01JBBCDEF0123456789ABCDEFG',
  resultRefB: 'art_01JCBCDEF0123456789ABCDEFG',
}

const BASE_TIME = Date.parse('2026-08-25T18:05:00.000Z')
const at = (offsetMs) => new Date(BASE_TIME + offsetMs).toISOString()

let eventCounter = 0
const eventId = () => {
  eventCounter += 1
  return `evt_01J${'0'.repeat(15)}${String(eventCounter).padStart(8, '0')}`
}

const runningEvent = (overrides = {}) => ({
  eventId: eventId(),
  parentExecutionId: ids.parentExecutionId,
  delegationId: ids.delegationIdA,
  childExecutionId: ids.childExecutionIdA,
  generation: 1,
  phase: 'running',
  observedAt: at(0),
  ...overrides,
})

const serializedBytes = (packet) => encoder.encode(canonicalJsonStringify(packet)).byteLength

/**
 * Distinct child identities a packet represents: the union of snapshot
 * children and children that appear only through retained entries.
 */
const childIdentitiesOf = (packet) =>
  new Set([
    ...packet.childSnapshots.map((snapshot) => snapshot.delegationId),
    ...packet.entries.map((entry) => entry.delegationId),
  ])

/**
 * Wraps a buffer and enforces the emission invariants on every packet the
 * buffer produces in any test: each packet — whether delivered through a
 * receipt's `sealedPacket`, drained from `readyPackets()`, or returned by
 * `flush()` — must satisfy its own parser, respect the configured serialized
 * byte limit, and stay within the configured child-identity budget (children
 * represented only by retained entries count too). `emitted` records every
 * distinct packet exactly once (packet objects are compared by identity).
 */
function trackedBuffer(options) {
  const buffer = new ChildProgressEvidenceBuffer(options)
  const maximumBytes = options.maximumBytes ?? 16_384
  const maximumChildren = options.maximumChildren ?? 64
  const emitted = []
  const verify = (packet) => {
    expect(parseChildProgressEvidencePacket(packet)).toEqual(packet)
    expect(serializedBytes(packet)).toBeLessThanOrEqual(maximumBytes)
    expect(childIdentitiesOf(packet).size).toBeLessThanOrEqual(maximumChildren)
    if (!emitted.includes(packet)) emitted.push(packet)
  }
  return {
    emitted,
    accept(event) {
      const receipt = buffer.accept(event)
      if (receipt.sealedPacket) verify(receipt.sealedPacket)
      return receipt
    },
    flush() {
      const packet = buffer.flush()
      if (packet) verify(packet)
      return packet
    },
    readyPackets() {
      const packets = buffer.readyPackets()
      for (const packet of packets) verify(packet)
      return packets
    },
    stats() {
      return buffer.stats()
    },
  }
}

describe('child progress evidence packets', () => {
  test('coalesces a burst of routine progress into bounded per-child snapshots', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    for (let index = 0; index < 250; index += 1) {
      const receipt = buffer.accept(
        runningEvent({ observedAt: at(index), metrics: { 'steps.completed': 1 } })
      )
      expect(receipt.outcome).toBe('coalesced')
    }
    const packet = buffer.flush()
    expect(packet.entries).toHaveLength(0)
    expect(packet.coalescedEventCount).toBe(250)
    expect(packet.childSnapshots).toHaveLength(1)
    expect(packet.childSnapshots[0]).toMatchObject({
      delegationId: ids.delegationIdA,
      childExecutionId: ids.childExecutionIdA,
      generation: 1,
      phase: 'running',
      lastObservedAt: at(249),
      observedEventCount: 250,
      metrics: { 'steps.completed': 250 },
    })
    expect(packet.firstEventAt).toBe(at(0))
    expect(packet.lastEventAt).toBe(at(249))
    expect(buffer.stats().readyPacketCount).toBe(0)
    expect(buffer.emitted).toHaveLength(1)
  })

  test('identical event streams produce identical packet digests', () => {
    const feed = (buffer) => {
      for (let index = 0; index < 10; index += 1) {
        buffer.accept(runningEvent({ observedAt: at(index), metrics: { 'steps.completed': 2 } }))
      }
      return buffer.flush()
    }
    const first = feed(trackedBuffer({ parentExecutionId: ids.parentExecutionId }))
    const second = feed(trackedBuffer({ parentExecutionId: ids.parentExecutionId }))
    expect(first.contentDigest).toBe(second.contentDigest)
    expect(parseChildProgressEvidencePacket(first)).toEqual(first)
  })

  test('never drops terminal outcomes, failures, cancellations, or approval requests', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    const events = [
      runningEvent({ observedAt: at(0) }),
      runningEvent({
        delegationId: ids.delegationIdB,
        childExecutionId: ids.childExecutionIdB,
        childAttemptId: ids.attemptIdB,
        phase: 'awaiting_input',
        observedAt: at(1_000),
        interaction: { interactionId: ids.interactionId, kind: 'approval' },
      }),
      runningEvent({
        phase: 'completed',
        observedAt: at(2_000),
        terminalResultRef: ids.resultRefA,
      }),
      runningEvent({
        delegationId: ids.delegationIdB,
        childExecutionId: ids.childExecutionIdB,
        childAttemptId: ids.attemptIdB,
        phase: 'failed',
        observedAt: at(3_000),
        failure: { classification: 'runtime_error', code: 'RUNTIME_LOST' },
      }),
      runningEvent({
        delegationId: ids.delegationIdC,
        childExecutionId: ids.childExecutionIdC,
        childAttemptId: ids.attemptIdC,
        phase: 'cancelled',
        observedAt: at(4_000),
        cancelReason: 'parent_cancelled',
      }),
    ]
    for (const [index, event] of events.entries()) {
      const receipt = buffer.accept(event)
      if (index === 0) {
        expect(receipt.outcome).toBe('coalesced')
      } else {
        expect(receipt).toMatchObject({ outcome: 'retained' })
      }
    }
    const packet = buffer.flush()
    expect(packet.entries.map((entry) => entry.phase)).toStrictEqual([
      'awaiting_input',
      'completed',
      'failed',
      'cancelled',
    ])
    expect(packet.entries[0].interaction).toStrictEqual({
      interactionId: ids.interactionId,
      kind: 'approval',
    })
    expect(packet.entries[1].terminalResultRef).toBe(ids.resultRefA)
    expect(packet.entries[2].failure).toStrictEqual({
      classification: 'runtime_error',
      code: 'RUNTIME_LOST',
    })
    expect(packet.entries[3].cancelReason).toBe('parent_cancelled')
    for (const entry of packet.entries) {
      expect(entry.eventId).toMatch(/^evt_/)
      expect(entry.delegationId).toMatch(/^dlg_/)
      expect(entry.childExecutionId).toMatch(/^exe_/)
      expect(entry.generation).toBe(1)
      expect(entry.observedAt).toMatch(/^2026-08-25T18:05:0/)
    }
  })

  test('keeps the lead responsive by surfacing approval requests immediately', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(runningEvent({ observedAt: at(0) }))
    const receipt = buffer.accept(
      runningEvent({
        phase: 'awaiting_input',
        observedAt: at(1_000),
        interaction: { interactionId: ids.interactionId, kind: 'input' },
      })
    )
    expect(receipt).toMatchObject({ outcome: 'retained', entryKind: 'awaiting_input' })
    const packet = buffer.flush()
    expect(packet.entries).toHaveLength(1)
    expect(packet.entries[0].phase).toBe('awaiting_input')
  })

  test('retains child-originated cancellations that carry no reason', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(runningEvent({ observedAt: at(0) }))
    const receipt = buffer.accept(runningEvent({ phase: 'cancelled', observedAt: at(1_000) }))
    expect(receipt).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    const packet = buffer.flush()
    expect(packet.entries).toHaveLength(1)
    expect(packet.entries[0].phase).toBe('cancelled')
    expect(packet.entries[0].cancelReason).toBeUndefined()
    expect(packet.childSnapshots[0].phase).toBe('cancelled')
  })

  test('deduplicates duplicate delivery by eventId without double counting', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    const first = runningEvent({ observedAt: at(0), metrics: { 'tool.calls': 1 } })
    expect(buffer.accept(first).outcome).toBe('coalesced')
    expect(buffer.accept(first).outcome).toBe('duplicate')
    const second = runningEvent({ observedAt: at(1_000), metrics: { 'tool.calls': 1 } })
    expect(buffer.accept(second).outcome).toBe('coalesced')
    expect(buffer.accept(second).outcome).toBe('duplicate')
    const packet = buffer.flush()
    expect(packet.coalescedEventCount).toBe(2)
    expect(packet.duplicateEventCount).toBe(2)
    expect(packet.childSnapshots[0].metrics['tool.calls']).toBe(2)
    expect(packet.childSnapshots[0].observedEventCount).toBe(2)
    expect(buffer.stats().lifetimeDuplicateCount).toBe(2)
  })

  test('rejects an eventId reused with changed content as conflicting', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    const original = runningEvent({ observedAt: at(0), metrics: { 'tool.calls': 1 } })
    expect(buffer.accept(original).outcome).toBe('coalesced')
    // Same eventId, different content for the same child.
    expect(
      buffer.accept({ ...original, observedAt: at(500), metrics: { 'tool.calls': 2 } })
    ).toMatchObject({ outcome: 'rejected', reason: 'conflicting_event' })
    // Same eventId reused for a different child's terminal event.
    const terminalForB = runningEvent({
      delegationId: ids.delegationIdB,
      childExecutionId: ids.childExecutionIdB,
      phase: 'cancelled',
      observedAt: at(1_000),
    })
    expect(buffer.accept({ ...terminalForB, eventId: original.eventId })).toMatchObject({
      outcome: 'rejected',
      reason: 'conflicting_event',
    })
    const packet = buffer.flush()
    // Neither conflicting delivery folded; the original stands alone.
    expect(packet.childSnapshots[0].observedEventCount).toBe(1)
    expect(packet.childSnapshots[0].metrics['tool.calls']).toBe(1)
    expect(packet.entries).toHaveLength(0)
    expect(packet.rejectedEventCount).toBe(2)
    expect(buffer.stats().lifetimeRejectionCount).toBe(2)
  })

  test('rejects changed child or attempt identity within a delegation generation', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    expect(
      buffer.accept(runningEvent({ childAttemptId: ids.attemptIdA, observedAt: at(0) })).outcome
    ).toBe('coalesced')
    // Another child's execution under the same delegation generation.
    expect(
      buffer.accept(
        runningEvent({
          childExecutionId: ids.childExecutionIdB,
          childAttemptId: ids.attemptIdB,
          observedAt: at(1_000),
        })
      )
    ).toMatchObject({ outcome: 'rejected', reason: 'conflicting_child_identity' })
    // A different attempt for the same generation.
    expect(
      buffer.accept(runningEvent({ childAttemptId: ids.attemptIdC, observedAt: at(2_000) }))
    ).toMatchObject({ outcome: 'rejected', reason: 'conflicting_child_identity' })
    const packet = buffer.flush()
    expect(packet.childSnapshots[0]).toMatchObject({
      childExecutionId: ids.childExecutionIdA,
      childAttemptId: ids.attemptIdA,
      observedEventCount: 1,
    })
    // A fresh generation may move to a new attempt, but never to another
    // child execution under the same delegation.
    expect(
      buffer.accept(
        runningEvent({ generation: 2, childAttemptId: ids.attemptIdB, observedAt: at(3_000) })
      ).outcome
    ).toBe('coalesced')
    expect(
      buffer.accept(
        runningEvent({
          generation: 3,
          childExecutionId: ids.childExecutionIdC,
          observedAt: at(4_000),
        })
      )
    ).toMatchObject({ outcome: 'rejected', reason: 'conflicting_child_identity' })
  })

  test('binds childAttemptId on first knowledge and rejects later attempts in the generation', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    // Early deliveries may not know the attempt yet.
    expect(buffer.accept(runningEvent({ observedAt: at(0) })).outcome).toBe('coalesced')
    expect(buffer.accept(runningEvent({ observedAt: at(1_000) })).outcome).toBe('coalesced')
    // The first delivery that names an attempt binds it to generation 1.
    expect(
      buffer.accept(runningEvent({ childAttemptId: ids.attemptIdA, observedAt: at(2_000) })).outcome
    ).toBe('coalesced')
    // A different attempt inside the same generation is a conflict.
    expect(
      buffer.accept(runningEvent({ childAttemptId: ids.attemptIdB, observedAt: at(3_000) }))
    ).toMatchObject({ outcome: 'rejected', reason: 'conflicting_child_identity' })
    const packet = buffer.flush()
    // The bound attempt is visible on the coalesced snapshot.
    expect(packet.childSnapshots[0].childAttemptId).toBe(ids.attemptIdA)
    expect(packet.childSnapshots[0].observedEventCount).toBe(3)
    // A fresh generation may move to a different attempt.
    expect(
      buffer.accept(
        runningEvent({ generation: 2, childAttemptId: ids.attemptIdB, observedAt: at(4_000) })
      ).outcome
    ).toBe('coalesced')
  })

  test('does not bind childAttemptId when the observation fails placement', () => {
    const oversizedMetrics = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `metrics.oversized.longKeyName.${String(index).padStart(2, '0')}`.padEnd(110, 'x'),
        7,
      ])
    )
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumBytes: 2048,
    })
    // The generation opens without a known attempt.
    expect(buffer.accept(runningEvent({ observedAt: at(0) })).outcome).toBe('coalesced')
    // An oversized delivery naming attempt X fails placement and must not
    // consume the attempt binding.
    let failure
    try {
      buffer.accept(
        runningEvent({
          childAttemptId: ids.attemptIdB,
          observedAt: at(1_000),
          metrics: oversizedMetrics,
        })
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ChildProgressEvidenceError)
    expect(failure.code).toBe('BOUNDS_EXCEEDED')
    // A small delivery naming attempt Y is therefore not a conflict: X was
    // never retained.
    expect(
      buffer.accept(runningEvent({ childAttemptId: ids.attemptIdC, observedAt: at(2_000) })).outcome
    ).toBe('coalesced')
    const packet = buffer.flush()
    expect(packet.childSnapshots[0]).toMatchObject({
      childExecutionId: ids.childExecutionIdA,
      childAttemptId: ids.attemptIdC,
      observedEventCount: 2,
    })
    // Attempt X never surfaced in any emitted packet.
    for (const emitted of buffer.emitted) {
      for (const snapshot of emitted.childSnapshots) {
        expect(snapshot.childAttemptId).not.toBe(ids.attemptIdB)
      }
    }
    // The binding committed with Y's successful placement: a later different
    // attempt inside the same generation is still a conflict.
    expect(
      buffer.accept(runningEvent({ childAttemptId: ids.attemptIdB, observedAt: at(3_000) }))
    ).toMatchObject({ outcome: 'rejected', reason: 'conflicting_child_identity' })
  })

  test('rejects stale generations and never regresses snapshots on out-of-order updates', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    expect(buffer.accept(runningEvent({ generation: 2, observedAt: at(0) })).outcome).toBe(
      'coalesced'
    )
    expect(buffer.accept(runningEvent({ generation: 1, observedAt: at(500) }))).toMatchObject({
      outcome: 'rejected',
      reason: 'stale_generation',
    })
    expect(
      buffer.accept(
        runningEvent({
          generation: 2,
          phase: 'awaiting_input',
          observedAt: at(10_000),
          interaction: { interactionId: ids.interactionId, kind: 'input' },
        })
      ).outcome
    ).toBe('retained')
    // Out-of-order: an older routine observation must not regress the snapshot.
    expect(buffer.accept(runningEvent({ generation: 2, observedAt: at(5_000) })).outcome).toBe(
      'coalesced'
    )
    // A newer routine observation is a legitimate resume after input.
    expect(buffer.accept(runningEvent({ generation: 2, observedAt: at(15_000) })).outcome).toBe(
      'coalesced'
    )
    expect(
      buffer.accept(
        runningEvent({
          generation: 2,
          phase: 'completed',
          observedAt: at(20_000),
          terminalResultRef: ids.resultRefA,
        })
      ).outcome
    ).toBe('retained')
    // A non-duplicate event after the generation went terminal is stale.
    expect(buffer.accept(runningEvent({ generation: 2, observedAt: at(30_000) }))).toMatchObject({
      outcome: 'rejected',
      reason: 'terminated_generation',
    })
    const packet = buffer.flush()
    expect(packet.rejectedEventCount).toBe(2)
    expect(packet.childSnapshots[0]).toMatchObject({
      phase: 'completed',
      lastObservedAt: at(20_000),
      observedEventCount: 5,
    })
    // A retry with a fresh generation is accepted again after termination.
    expect(
      buffer.accept(
        runningEvent({
          generation: 3,
          observedAt: at(40_000),
          childAttemptId: ids.attemptIdA,
        })
      ).outcome
    ).toBe('coalesced')
  })

  test('tracks concurrent children independently with sorted snapshots', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    const children = [
      { delegationId: ids.delegationIdA, childExecutionId: ids.childExecutionIdA },
      { delegationId: ids.delegationIdB, childExecutionId: ids.childExecutionIdB },
      { delegationId: ids.delegationIdC, childExecutionId: ids.childExecutionIdC },
    ]
    for (let round = 0; round < 3; round += 1) {
      for (const [index, child] of children.entries()) {
        buffer.accept(
          runningEvent({
            delegationId: child.delegationId,
            childExecutionId: child.childExecutionId,
            observedAt: at(round * 1_000 + index),
            metrics: { 'steps.completed': 1 },
          })
        )
      }
    }
    const packet = buffer.flush()
    expect(packet.childSnapshots.map((snapshot) => snapshot.delegationId)).toStrictEqual([
      ids.delegationIdA,
      ids.delegationIdB,
      ids.delegationIdC,
    ])
    for (const snapshot of packet.childSnapshots) {
      expect(snapshot.observedEventCount).toBe(3)
      expect(snapshot.metrics['steps.completed']).toBe(3)
      expect(snapshot.phase).toBe('running')
    }
  })

  test('survives cancellation during batching and accepts the retry generation', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(runningEvent({ observedAt: at(0) }))
    buffer.accept(
      runningEvent({
        delegationId: ids.delegationIdB,
        childExecutionId: ids.childExecutionIdB,
        observedAt: at(100),
      })
    )
    expect(
      buffer.accept(
        runningEvent({
          phase: 'cancelled',
          observedAt: at(1_000),
          cancelReason: 'parent_cancelled',
        })
      )
    ).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    expect(
      buffer.accept(
        runningEvent({
          delegationId: ids.delegationIdB,
          childExecutionId: ids.childExecutionIdB,
          phase: 'cancelled',
          observedAt: at(1_100),
          cancelReason: 'parent_cancelled',
        })
      )
    ).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    const packet = buffer.flush()
    expect(packet.entries.map((entry) => entry.cancelReason)).toStrictEqual([
      'parent_cancelled',
      'parent_cancelled',
    ])
    expect(packet.childSnapshots.map((snapshot) => snapshot.phase)).toStrictEqual([
      'cancelled',
      'cancelled',
    ])
    // A retried child (fresh generation) runs again after cancellation.
    expect(
      buffer.accept(
        runningEvent({ generation: 2, observedAt: at(2_000), childAttemptId: ids.attemptIdA })
      ).outcome
    ).toBe('coalesced')
  })

  test('seals a full packet instead of dropping terminal events under entry pressure', () => {
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumEntries: 2,
    })
    expect(
      buffer.accept(
        runningEvent({ phase: 'completed', observedAt: at(0), terminalResultRef: ids.resultRefA })
      ).outcome
    ).toBe('retained')
    expect(
      buffer.accept(
        runningEvent({
          delegationId: ids.delegationIdB,
          childExecutionId: ids.childExecutionIdB,
          phase: 'failed',
          observedAt: at(1_000),
          failure: { classification: 'timeout', code: 'CHILD_DEADLINE' },
        })
      ).outcome
    ).toBe('retained')
    const third = buffer.accept(
      runningEvent({
        delegationId: ids.delegationIdC,
        childExecutionId: ids.childExecutionIdC,
        phase: 'cancelled',
        observedAt: at(2_000),
        cancelReason: 'user_request',
      })
    )
    expect(third).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    expect(third.sealedPacket.entries.map((entry) => entry.phase)).toStrictEqual([
      'completed',
      'failed',
    ])
    expect(third.sealedPacket.sequence).toBe(1)
    const final = buffer.flush()
    expect(final.sequence).toBe(2)
    expect(final.entries.map((entry) => entry.phase)).toStrictEqual(['cancelled'])
    // The pressure-sealed packet is queued; the flushed packet was delivered
    // directly by flush() and is never queued behind it.
    expect(buffer.readyPackets()).toStrictEqual([third.sealedPacket])
    // Nothing was dropped: every terminal observation is in some packet.
    expect(
      buffer.emitted.flatMap((packet) => packet.entries).map((entry) => entry.phase)
    ).toStrictEqual(['completed', 'failed', 'cancelled'])
  })

  test('seals when distinct children exceed the per-packet child budget', () => {
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumChildren: 2,
    })
    buffer.accept(
      runningEvent({ delegationId: ids.delegationIdA, childExecutionId: ids.childExecutionIdA })
    )
    buffer.accept(
      runningEvent({ delegationId: ids.delegationIdB, childExecutionId: ids.childExecutionIdB })
    )
    const receipt = buffer.accept(
      runningEvent({ delegationId: ids.delegationIdC, childExecutionId: ids.childExecutionIdC })
    )
    expect(receipt.outcome).toBe('coalesced')
    expect(receipt.sealedPacket.childSnapshots).toHaveLength(2)
    const final = buffer.flush()
    expect(final.childSnapshots.map((snapshot) => snapshot.delegationId)).toStrictEqual([
      ids.delegationIdC,
    ])
  })

  test('enforces the child budget for returning children after a flush', () => {
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumChildren: 1,
    })
    const childA = { delegationId: ids.delegationIdA, childExecutionId: ids.childExecutionIdA }
    const childB = { delegationId: ids.delegationIdB, childExecutionId: ids.childExecutionIdB }
    buffer.accept(runningEvent({ ...childA, observedAt: at(0) }))
    const first = buffer.flush()
    expect(first.childSnapshots.map((snapshot) => snapshot.delegationId)).toStrictEqual([
      ids.delegationIdA,
    ])
    buffer.accept(runningEvent({ ...childB, observedAt: at(1_000) }))
    // Child A returns while child B occupies the single-child packet.
    const receipt = buffer.accept(runningEvent({ ...childA, observedAt: at(2_000) }))
    expect(receipt.outcome).toBe('coalesced')
    expect(receipt.sealedPacket).toBeDefined()
    expect(
      receipt.sealedPacket.childSnapshots.map((snapshot) => snapshot.delegationId)
    ).toStrictEqual([ids.delegationIdB])
    expect(buffer.readyPackets()).toStrictEqual([receipt.sealedPacket])
    const final = buffer.flush()
    expect(final.childSnapshots.map((snapshot) => snapshot.delegationId)).toStrictEqual([
      ids.delegationIdA,
    ])
    // No packet ever held two children.
    for (const packet of buffer.emitted) {
      expect(packet.childSnapshots.length).toBe(1)
    }
    expect(buffer.emitted.map((packet) => packet.sequence)).toStrictEqual([1, 2, 3])
  })

  test('rejects a single observation that cannot fit any packet within the byte budget', () => {
    const oversizedMetrics = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `metrics.oversized.longKeyName.${String(index).padStart(2, '0')}`.padEnd(110, 'x'),
        7,
      ])
    )
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumBytes: 2048,
    })
    expect(() =>
      buffer.accept(
        runningEvent({
          phase: 'failed',
          observedAt: at(0),
          failure: { classification: 'runtime_error', code: 'X'.repeat(256) },
          metrics: oversizedMetrics,
        })
      )
    ).toThrow(ChildProgressEvidenceError)
    // Nothing was emitted and nothing is left half-open.
    expect(buffer.flush()).toBeUndefined()
    expect(buffer.emitted).toHaveLength(0)
    expect(buffer.stats().openPacket).toBe(false)
  })

  test('does not commit the dedupe fingerprint of an event that failed placement', () => {
    const oversizedMetrics = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `metrics.oversized.longKeyName.${String(index).padStart(2, '0')}`.padEnd(110, 'x'),
        7,
      ])
    )
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumBytes: 2048,
    })
    const oversized = runningEvent({
      phase: 'failed',
      observedAt: at(0),
      failure: { classification: 'runtime_error', code: 'X'.repeat(256) },
      metrics: oversizedMetrics,
    })
    expect(() => buffer.accept(oversized)).toThrow(ChildProgressEvidenceError)
    // The retry re-attempts placement and hits the same bounds error; it must
    // never be misreported as a duplicate of an event nothing retained.
    let retry
    try {
      retry = buffer.accept(oversized)
    } catch (error) {
      retry = error
    }
    expect(retry).toBeInstanceOf(ChildProgressEvidenceError)
    expect(retry.code).toBe('BOUNDS_EXCEEDED')
    expect(buffer.stats().lifetimeDuplicateCount).toBe(0)
    expect(buffer.stats().openPacket).toBe(false)
    expect(buffer.flush()).toBeUndefined()
    expect(buffer.emitted).toHaveLength(0)
  })

  test('seals with valid timestamps when a large entry follows a fitting snapshot', () => {
    const largeMetrics = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `metrics.largeentry.longKeyName.${String(index).padStart(2, '0')}`.padEnd(90, 'y'),
        7,
      ])
    )
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumBytes: 2048,
    })
    const receipt = buffer.accept(
      runningEvent({
        phase: 'failed',
        observedAt: at(0),
        failure: { classification: 'runtime_error', code: 'X'.repeat(256) },
        metrics: largeMetrics,
      })
    )
    // The snapshot fits in a fresh packet; the entry does not fit beside it.
    expect(receipt).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    expect(receipt.sealedPacket).toBeDefined()
    const sealed = receipt.sealedPacket
    // The sealed packet is valid for its own parser (timestamps included)
    // even though the triggering event's entry moved to the next packet.
    expect(parseChildProgressEvidencePacket(sealed)).toEqual(sealed)
    expect(sealed.childSnapshots).toHaveLength(1)
    expect(sealed.entries).toHaveLength(0)
    expect(sealed.firstEventAt).toBe(at(0))
    const final = buffer.flush()
    expect(final.entries).toHaveLength(1)
    expect(final.entries[0].failure.code).toBe('X'.repeat(256))
    // The failure observation survived the split across both packets.
    expect(buffer.emitted).toHaveLength(2)
    expect(buffer.emitted.map((packet) => packet.sequence)).toStrictEqual([1, 2])
  })

  test('seals with valid timestamps when child-count pressure is followed by byte pressure', () => {
    const largeMetrics = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `metrics.largeentry.longKeyName.${String(index).padStart(2, '0')}`.padEnd(90, 'y'),
        7,
      ])
    )
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumChildren: 1,
      maximumBytes: 2048,
    })
    buffer.accept(runningEvent({ observedAt: at(0) }))
    const receipt = buffer.accept(
      runningEvent({
        delegationId: ids.delegationIdB,
        childExecutionId: ids.childExecutionIdB,
        phase: 'failed',
        observedAt: at(1_000),
        failure: { classification: 'runtime_error', code: 'X'.repeat(256) },
        metrics: largeMetrics,
      })
    )
    expect(receipt).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    expect(receipt.sealedPacket).toBeDefined()
    // First seal: the child budget (child A's open window). The fresh window
    // created for child B then seals under byte pressure when B's entry does
    // not fit beside B's snapshot — that second packet must still carry a
    // valid observation window, not empty timestamps.
    // Child C is small and running: after the byte split, B is represented in
    // the open window only by its retained entry, and the child-identity
    // budget must still count it — C may not join B's packet.
    const smallChild = buffer.accept(
      runningEvent({
        delegationId: ids.delegationIdC,
        childExecutionId: ids.childExecutionIdC,
        observedAt: at(2_000),
      })
    )
    expect(smallChild).toMatchObject({ outcome: 'coalesced' })
    expect(smallChild.sealedPacket).toBeDefined()
    const drained = buffer.readyPackets()
    const flushed = buffer.flush()
    const packets = [...drained, flushed].filter(Boolean)
    expect(packets).toHaveLength(4)
    expect(buffer.emitted).toHaveLength(4)
    for (const packet of packets) {
      expect(packet.firstEventAt).toMatch(/^2026-08-25T18:05:/)
      expect(packet.lastEventAt).toMatch(/^2026-08-25T18:05:/)
      // maximumChildren=1 holds for entry-only children as well.
      expect(childIdentitiesOf(packet).size).toBe(1)
    }
    // Nothing was dropped: A's snapshot, B's snapshot, B's failure entry, and
    // C's snapshot each landed in some packet.
    expect(
      packets.flatMap((packet) => packet.childSnapshots).map((snapshot) => snapshot.delegationId)
    ).toStrictEqual([ids.delegationIdA, ids.delegationIdB, ids.delegationIdC])
    const entries = packets.flatMap((packet) => packet.entries)
    expect(entries).toHaveLength(1)
    expect(entries[0].failure.code).toBe('X'.repeat(256))
    // B's entry-only packet never absorbed child C.
    const entryPacket = packets.find((packet) => packet.entries.length > 0)
    expect(entryPacket.entries.map((entry) => entry.delegationId)).toStrictEqual([
      ids.delegationIdB,
    ])
    expect(entryPacket.childSnapshots).toHaveLength(0)
    expect(packets.at(-1).childSnapshots.map((snapshot) => snapshot.delegationId)).toStrictEqual([
      ids.delegationIdC,
    ])
  })

  test('seals on the serialized byte budget when snapshots grow', () => {
    const longMetrics = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [
        `metrics.pressure.longKeyForBudgetTesting.${String(index).padStart(2, '0')}.x`.padEnd(
          60,
          'k'
        ),
        1_000_000,
      ])
    )
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumBytes: 2048,
    })
    const children = [
      { delegationId: ids.delegationIdA, childExecutionId: ids.childExecutionIdA },
      { delegationId: ids.delegationIdB, childExecutionId: ids.childExecutionIdB },
      { delegationId: ids.delegationIdC, childExecutionId: ids.childExecutionIdC },
    ]
    const receipts = children.map((child) =>
      buffer.accept(
        runningEvent({
          delegationId: child.delegationId,
          childExecutionId: child.childExecutionId,
          metrics: longMetrics,
        })
      )
    )
    // One child fits within the full serialized budget; a second does not.
    expect(receipts[0].sealedPacket).toBeUndefined()
    expect(receipts[1].sealedPacket).toBeDefined()
    const final = buffer.flush()
    expect(final.childSnapshots.map((snapshot) => snapshot.delegationId)).toStrictEqual([
      ids.delegationIdC,
    ])
    // Snapshots are conserved across the seal boundary and no packet exceeds
    // its budget (verified by the tracked-buffer invariant on every emission).
    const snapshots = buffer.emitted.flatMap((packet) => packet.childSnapshots)
    expect(snapshots.map((snapshot) => snapshot.delegationId)).toStrictEqual([
      ids.delegationIdA,
      ids.delegationIdB,
      ids.delegationIdC,
    ])
  })

  test('keeps duplicate-counter growth inside the serialized byte budget', () => {
    const maximumBytes = 2048
    // Deterministic calibration: pad child A's metrics so a window holding
    // A's snapshot with duplicateEventCount 9 serializes to exactly
    // budget - 2 bytes. The 9→10, 99→100 and 999→1000 counter digit
    // crossings each add one serialized byte, so an unguarded duplicate
    // counter pushes the window one byte past the limit.
    const padKey = (length) => `metrics.dupcounter.pad.${'p'.repeat(length)}`
    const fillerKey = (index) =>
      `metrics.dupcounter.filler.${String(index).padStart(2, '0')}`.padEnd(96, 'f')
    const projectedWindowBytes = (metrics, duplicateCount) => {
      const body = {
        schemaVersion: 2,
        parentExecutionId: ids.parentExecutionId,
        sequence: 1,
        firstEventAt: at(0),
        lastEventAt: at(0),
        entries: [],
        childSnapshots: [
          {
            delegationId: ids.delegationIdA,
            childExecutionId: ids.childExecutionIdA,
            generation: 1,
            phase: 'running',
            lastObservedAt: at(0),
            observedEventCount: 1,
            metrics,
          },
        ],
        coalescedEventCount: 1,
        duplicateEventCount: duplicateCount,
        rejectedEventCount: 0,
      }
      return encoder.encode(canonicalJsonStringify({ ...body, contentDigest: digest('0') }))
        .byteLength
    }
    let calibrated
    for (let fillers = 0; fillers <= 14 && calibrated === undefined; fillers += 1) {
      for (let pad = 1; pad <= 200; pad += 1) {
        const metrics = {}
        for (let index = 0; index < fillers; index += 1) metrics[fillerKey(index)] = 1
        metrics[padKey(pad)] = 1
        if (projectedWindowBytes(metrics, 9) === maximumBytes - 2) {
          calibrated = metrics
          break
        }
      }
    }
    expect(calibrated).toBeDefined()

    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId, maximumBytes })
    const progress = runningEvent({ observedAt: at(0), metrics: calibrated })
    expect(buffer.accept(progress).outcome).toBe('coalesced')
    for (let index = 0; index < 1_000; index += 1) {
      expect(buffer.accept(progress).outcome).toBe('duplicate')
    }
    const drained = buffer.readyPackets()
    const flushed = buffer.flush()
    const packets = [...drained, flushed].filter(Boolean)
    expect(packets.length).toBeGreaterThanOrEqual(2)
    for (const packet of packets) {
      expect(serializedBytes(packet)).toBeLessThanOrEqual(maximumBytes)
    }
    // Every duplicate is accounted for across the packet windows.
    expect(packets.reduce((sum, packet) => sum + packet.duplicateEventCount, 0)).toBe(1_000)
    expect(buffer.stats().lifetimeDuplicateCount).toBe(1_000)
    expect(buffer.emitted.map((packet) => packet.sequence)).toStrictEqual([1, 2])
  })

  test('bounds an oversized event timestamp before any state mutates', () => {
    const buffer = trackedBuffer({
      parentExecutionId: ids.parentExecutionId,
      maximumBytes: 2048,
    })
    expect(buffer.accept(runningEvent({ observedAt: at(0) })).outcome).toBe('coalesced')
    // Syntactically valid ISO instant whose 4,000 fractional digits cannot
    // coexist with any evidence inside even the largest packet budget.
    const fatTimestamp = `2026-08-25T18:05:00.${'4'.repeat(4000)}Z`
    let failure
    try {
      buffer.accept(
        runningEvent({ parentExecutionId: ids.foreignExecutionId, observedAt: fatTimestamp })
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ChildProgressEvidenceError)
    expect(failure.code).toBe('BOUNDS_EXCEEDED')
    // The delivery was never recorded — not as a rejection counter, not as a
    // window timestamp — so the open packet keeps its original bounds.
    const packet = buffer.flush()
    expect(packet.rejectedEventCount).toBe(0)
    expect(packet.firstEventAt).toBe(at(0))
    expect(packet.lastEventAt).toBe(at(0))
    expect(buffer.stats().lifetimeRejectionCount).toBe(0)
    expect(buffer.emitted).toHaveLength(1)
  })

  test('seals when a rejection would push the observation window past the byte budget', () => {
    const maximumBytes = 2048
    // Deterministic calibration: pad child A's metrics so a window holding
    // A's snapshot serializes to exactly budget - 2 bytes. The rejection
    // below carries a longer (but valid) timestamp whose span extension adds
    // 37 serialized bytes — an unguarded span change pushes the packet past
    // the limit even though the rejection counter itself fits.
    const fillerKey = (index) =>
      `metrics.rejectspan.filler.${String(index).padStart(2, '0')}`.padEnd(96, 'f')
    const padKey = (length) => `metrics.rejectspan.pad.${'p'.repeat(length)}`
    const projectedWindowBytes = (metrics) => {
      const body = {
        schemaVersion: 2,
        parentExecutionId: ids.parentExecutionId,
        sequence: 1,
        firstEventAt: at(0),
        lastEventAt: at(0),
        entries: [],
        childSnapshots: [
          {
            delegationId: ids.delegationIdA,
            childExecutionId: ids.childExecutionIdA,
            generation: 1,
            phase: 'running',
            lastObservedAt: at(0),
            observedEventCount: 1,
            metrics,
          },
        ],
        coalescedEventCount: 1,
        duplicateEventCount: 0,
        rejectedEventCount: 0,
      }
      return encoder.encode(canonicalJsonStringify({ ...body, contentDigest: digest('0') }))
        .byteLength
    }
    let calibrated
    for (let fillers = 0; fillers <= 14 && calibrated === undefined; fillers += 1) {
      for (let pad = 1; pad <= 200; pad += 1) {
        const metrics = {}
        for (let index = 0; index < fillers; index += 1) metrics[fillerKey(index)] = 1
        metrics[padKey(pad)] = 1
        if (projectedWindowBytes(metrics) === maximumBytes - 2) {
          calibrated = metrics
          break
        }
      }
    }
    expect(calibrated).toBeDefined()

    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId, maximumBytes })
    expect(buffer.accept(runningEvent({ observedAt: at(0), metrics: calibrated })).outcome).toBe(
      'coalesced'
    )
    // Later than at(0) and 61 characters long: recording it extends the open
    // window's lastEventAt by 37 bytes.
    const longObservedAt = `2026-08-25T18:05:00.${'9'.repeat(40)}Z`
    expect(longObservedAt.length).toBe(61)
    expect(
      buffer.accept(
        runningEvent({ parentExecutionId: ids.foreignExecutionId, observedAt: longObservedAt })
      )
    ).toMatchObject({ outcome: 'rejected', reason: 'foreign_parent' })
    // The rejection lands in a fresh window whose span is seeded with the
    // long timestamp — both packets stay within the serialized budget.
    const drained = buffer.readyPackets()
    const flushed = buffer.flush()
    const packets = [...drained, flushed].filter(Boolean)
    expect(packets).toHaveLength(2)
    expect(packets[0].rejectedEventCount).toBe(0)
    expect(packets[1].rejectedEventCount).toBe(1)
    expect(packets[1].firstEventAt).toBe(longObservedAt)
    expect(packets[1].lastEventAt).toBe(longObservedAt)
    for (const packet of packets) {
      expect(serializedBytes(packet)).toBeLessThanOrEqual(maximumBytes)
    }
    expect(buffer.emitted.map((packet) => packet.sequence)).toStrictEqual([1, 2])
  })

  test('metric accumulation ignores inherited keys and saturates at safe integers', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(runningEvent({ observedAt: at(0), metrics: { toString: 2 } }))
    buffer.accept(runningEvent({ observedAt: at(1_000), metrics: { toString: 3 } }))
    buffer.accept(runningEvent({ observedAt: at(2_000), metrics: { hasOwnProperty: 4 } }))
    buffer.accept(
      runningEvent({ observedAt: at(3_000), metrics: { huge: Number.MAX_SAFE_INTEGER } })
    )
    const overflow = buffer.accept(runningEvent({ observedAt: at(4_000), metrics: { huge: 7 } }))
    expect(overflow.outcome).toBe('coalesced')
    const packet = buffer.flush()
    const metrics = packet.childSnapshots[0].metrics
    expect(typeof metrics['toString']).toBe('number')
    expect(metrics['toString']).toBe(5)
    expect(metrics['hasOwnProperty']).toBe(4)
    expect(metrics['huge']).toBe(Number.MAX_SAFE_INTEGER)
    // The packet survives its own parser with the inherited-key metrics.
    expect(parseChildProgressEvidencePacket(packet)).toEqual(packet)
  })

  test('rejects events for a foreign parent execution without opening a packet', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    expect(
      buffer.accept(runningEvent({ parentExecutionId: ids.foreignExecutionId }))
    ).toMatchObject({ outcome: 'rejected', reason: 'foreign_parent' })
    expect(buffer.flush()).toBeUndefined()
    expect(buffer.stats().lifetimeRejectionCount).toBe(1)
  })

  test('rejects invalid configuration and malformed events', () => {
    expect(
      () =>
        new ChildProgressEvidenceBuffer({
          parentExecutionId: ids.parentExecutionId,
          maximumEntries: 0,
        })
    ).toThrow(ChildProgressEvidenceError)
    expect(
      () =>
        new ChildProgressEvidenceBuffer({
          parentExecutionId: ids.parentExecutionId,
          maximumBytes: 1024,
        })
    ).toThrow(ChildProgressEvidenceError)
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
    expect(() => buffer.accept(runningEvent({ phase: 'queued' }))).toThrow()
    expect(() => buffer.accept(runningEvent({ terminalResultRef: ids.resultRefA }))).toThrow()
    expect(() => buffer.accept(runningEvent({ phase: 'completed' }))).toThrow()
    expect(buffer.stats().openPacket).toBe(false)
  })

  test('rejects sequence tampering: the digest covers the ordering identity', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(runningEvent({ observedAt: at(0) }))
    const packet = buffer.flush()
    expect(parseChildProgressEvidencePacket(packet)).toEqual(packet)
    const resequenced = { ...packet, sequence: packet.sequence + 1 }
    expect(() => parseChildProgressEvidencePacket(resequenced)).toThrow(ChildProgressEvidenceError)
    try {
      parseChildProgressEvidencePacket(resequenced)
    } catch (error) {
      expect(error.code).toBe('DIGEST_MISMATCH')
    }
  })
})

describe('delegation event adapter', () => {
  const delegationEvent = (overrides = {}) => ({
    type: 'delegation.progress',
    delegationId: ids.delegationIdA,
    parentExecutionId: ids.parentExecutionId,
    childExecutionId: ids.childExecutionIdA,
    occurredAt: at(0),
    details: {},
    ...overrides,
  })

  test('maps delegation event types onto evidence phases and references', () => {
    expect(
      delegationEventToEvidenceEvent({
        event: delegationEvent(),
        eventId: eventId(),
        generation: 1,
      })
    ).toMatchObject({ phase: 'running' })
    expect(
      delegationEventToEvidenceEvent({
        event: delegationEvent({ details: { state: 'awaiting_input' } }),
        eventId: eventId(),
        generation: 1,
        childAttemptId: ids.attemptIdA,
        interaction: { interactionId: ids.interactionId, kind: 'approval' },
      })
    ).toMatchObject({ phase: 'awaiting_input', childAttemptId: ids.attemptIdA })
    expect(
      delegationEventToEvidenceEvent({
        event: delegationEvent({
          type: 'delegation.completed',
          details: { state: 'completed', terminalResultRef: ids.resultRefA },
        }),
        eventId: eventId(),
        generation: 1,
      })
    ).toMatchObject({ phase: 'completed', terminalResultRef: ids.resultRefA })
    expect(
      delegationEventToEvidenceEvent({
        event: delegationEvent({
          type: 'delegation.failed',
          details: { state: 'failed', failureCode: 'RUNTIME_LOST' },
        }),
        eventId: eventId(),
        generation: 1,
      })
    ).toMatchObject({
      phase: 'failed',
      failure: { classification: 'unknown', code: 'RUNTIME_LOST' },
    })
    expect(
      delegationEventToEvidenceEvent({
        event: delegationEvent({
          type: 'delegation.cancelled',
          details: { reason: 'parent_cancelled' },
        }),
        eventId: eventId(),
        generation: 1,
      })
    ).toMatchObject({ phase: 'cancelled', cancelReason: 'parent_cancelled' })
  })

  test('preserves uncertainty when a child-originated cancellation has no reason', () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    // Ordinary child cancellation: the delegation pipeline publishes no reason.
    const withoutReason = delegationEventToEvidenceEvent({
      event: delegationEvent({ type: 'delegation.cancelled', details: {} }),
      eventId: eventId(),
      generation: 1,
    })
    expect(withoutReason.phase).toBe('cancelled')
    expect(withoutReason.cancelReason).toBeUndefined()
    // A reason the contract does not know is dropped, not invented into an enum.
    const unknownReason = delegationEventToEvidenceEvent({
      event: delegationEvent({
        type: 'delegation.cancelled',
        details: { reason: 'sorter_malfunction' },
      }),
      eventId: eventId(),
      generation: 1,
    })
    expect(unknownReason.cancelReason).toBeUndefined()
    // Both adapt cleanly into retained cancellation evidence.
    expect(buffer.accept(withoutReason).outcome).toBe('retained')
    const second = delegationEventToEvidenceEvent({
      event: delegationEvent({
        type: 'delegation.cancelled',
        details: { reason: 'sorter_malfunction' },
        delegationId: ids.delegationIdB,
        childExecutionId: ids.childExecutionIdB,
      }),
      eventId: eventId(),
      generation: 1,
    })
    expect(buffer.accept(second).outcome).toBe('retained')
    const packet = buffer.flush()
    const cancellations = packet.entries.filter((entry) => entry.phase === 'cancelled')
    expect(cancellations).toHaveLength(2)
    for (const entry of cancellations) {
      expect(entry.cancelReason).toBeUndefined()
    }
  })

  test('coalesces progress from the delegation persistence fixtures into packets', async () => {
    const fixture = await createDelegationFixture()
    await delegateChild(fixture, 'A')
    await delegateChild(fixture, 'B')
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    const lane = new Map([
      [ids.delegationIdA, 1_000],
      [ids.delegationIdB, 60_000],
    ])
    const lastEventId = new Map()

    const deliver = async (delegationId, input, adapter = {}) => {
      // recordChildProgress requires the caller to assert the attempt identity.
      const childAttemptId = delegationId === ids.delegationIdA ? ids.attemptIdA : ids.attemptIdB
      const outcome = await fixture.service.recordChildProgress({
        delegationId,
        childAttemptId,
        ...input,
        observedAt: at(lane.get(delegationId)),
      })
      lane.set(delegationId, lane.get(delegationId) + 1_000)
      const event = fixture.events.at(-1)
      const id = eventId()
      lastEventId.set(delegationId, id)
      const receipt = buffer.accept(
        delegationEventToEvidenceEvent({
          event,
          eventId: id,
          generation: outcome.record.revision,
          childAttemptId: outcome.record.childAttemptId,
          ...adapter,
        })
      )
      return { outcome, receipt, eventId: id }
    }

    // Two children run concurrently; routine progress coalesces per child.
    for (let step = 0; step < 3; step += 1) {
      for (const delegationId of [ids.delegationIdA, ids.delegationIdB]) {
        const { receipt } = await deliver(delegationId, { state: 'running' })
        expect(receipt.outcome).toBe('coalesced')
      }
    }
    // Child B asks for approval: retained verbatim, packet flushed for the lead.
    const approval = await deliver(
      ids.delegationIdB,
      { state: 'awaiting_input' },
      { interaction: { interactionId: ids.interactionId, kind: 'approval' } }
    )
    expect(approval.receipt).toMatchObject({ outcome: 'retained', entryKind: 'awaiting_input' })
    const approvalPacket = buffer.flush()
    expect(approvalPacket.entries).toHaveLength(1)
    expect(approvalPacket.entries[0].phase).toBe('awaiting_input')
    expect(approvalPacket.entries[0].delegationId).toBe(ids.delegationIdB)

    // Both children finish while batching continues; terminal outcomes survive.
    const completedA = await deliver(ids.delegationIdA, {
      state: 'completed',
      terminalResultRef: ids.resultRefA,
    })
    const completedB = await deliver(ids.delegationIdB, {
      state: 'completed',
      terminalResultRef: ids.resultRefB,
    })
    expect(completedA.receipt).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    expect(completedB.receipt).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    const packet = buffer.flush()
    expect(packet.entries.map((entry) => entry.phase)).toStrictEqual(['completed', 'completed'])
    expect(packet.entries[0].terminalResultRef).toBe(ids.resultRefA)
    expect(packet.entries[1].terminalResultRef).toBe(ids.resultRefB)
    expect(packet.childSnapshots.map((snapshot) => snapshot.phase)).toStrictEqual([
      'completed',
      'completed',
    ])

    // Duplicate redelivery of a terminal event is absorbed by eventId.
    const redeliveredEvent = fixture.events.at(-1)
    const redelivered = await fixture.service.recordChildProgress({
      delegationId: ids.delegationIdB,
      childAttemptId: ids.attemptIdB,
      state: 'completed',
      terminalResultRef: ids.resultRefB,
      observedAt: at(lane.get(ids.delegationIdB)),
    })
    expect(redelivered.record.state).toBe('completed')
    expect(
      buffer.accept(
        delegationEventToEvidenceEvent({
          event: redeliveredEvent,
          eventId: lastEventId.get(ids.delegationIdB),
          generation: redelivered.record.revision,
          childAttemptId: redelivered.record.childAttemptId,
        })
      )
    ).toMatchObject({ outcome: 'duplicate' })
    expect(buffer.stats().lifetimeDuplicateCount).toBe(1)
  })
})

describe('responsive lead delivery with two running children', () => {
  const childA = { delegationId: ids.delegationIdA, childExecutionId: ids.childExecutionIdA }
  const childB = {
    delegationId: ids.delegationIdB,
    childExecutionId: ids.childExecutionIdB,
    childAttemptId: ids.attemptIdB,
  }
  const childEvent = (child, overrides = {}) =>
    runningEvent({
      delegationId: child.delegationId,
      childExecutionId: child.childExecutionId,
      ...(child.childAttemptId ? { childAttemptId: child.childAttemptId } : {}),
      ...overrides,
    })
  const evidenceDeliveries = (deliveries) => deliveries.filter(({ kind }) => kind === 'evidence')

  test('places human input and critical child evidence on the outbox in the accepting step', () => {
    const dispatcher = new ChildProgressLeadDispatcher({
      buffer: trackedBuffer({ parentExecutionId: ids.parentExecutionId }),
      maximumCoalescedEventsPerDelivery: 128,
    })
    // Both children stream below the coalescing pressure threshold.
    for (let index = 0; index < 40; index += 1) {
      expect(dispatcher.acceptProgress(childEvent(childA, { observedAt: at(index) })).outcome).toBe(
        'coalesced'
      )
      expect(dispatcher.acceptProgress(childEvent(childB, { observedAt: at(index) })).outcome).toBe(
        'coalesced'
      )
    }
    expect(dispatcher.takeDeliveries()).toStrictEqual([])

    // Human input addressed to the lead is delivered in the same scheduling
    // step — zero further events are accepted before it is available.
    const input = dispatcher.acceptHumanInput({
      interactionId: ids.interactionId,
      kind: 'input',
      receivedAt: at(1_000),
    })
    const afterInput = dispatcher.takeDeliveries()
    expect(afterInput).toStrictEqual([
      {
        kind: 'human_input',
        sequence: input.sequence,
        input: { interactionId: ids.interactionId, kind: 'input', receivedAt: at(1_000) },
      },
    ])

    // Child B's approval request arrives amid child A's routine burst: it is
    // delivered immediately, never queued behind progress batching.
    for (let index = 40; index < 60; index += 1) {
      dispatcher.acceptProgress(childEvent(childA, { observedAt: at(index) }))
    }
    const approval = dispatcher.acceptProgress(
      childEvent(childB, {
        phase: 'awaiting_input',
        observedAt: at(2_000),
        interaction: { interactionId: ids.interactionId, kind: 'approval' },
      })
    )
    expect(approval).toMatchObject({ outcome: 'retained', entryKind: 'awaiting_input' })
    const afterApproval = dispatcher.takeDeliveries()
    expect(afterApproval).toHaveLength(1)
    expect(afterApproval[0].kind).toBe('evidence')
    expect(afterApproval[0].trigger).toBe('critical')
    expect(afterApproval[0].packet.entries.map((entry) => entry.phase)).toStrictEqual([
      'awaiting_input',
    ])
    expect(afterApproval[0].packet.entries[0].delegationId).toBe(ids.delegationIdB)
    // The flushed packet also carries the coalesced snapshots of both
    // children, so the lead wakes up with fresh state for each of them.
    expect(
      afterApproval[0].packet.childSnapshots.map((snapshot) => snapshot.delegationId)
    ).toStrictEqual([ids.delegationIdA, ids.delegationIdB])
    // Delivery identities are strictly monotonic across the session.
    expect(input.sequence).toBeLessThan(afterApproval[0].sequence)
    expect(dispatcher.stats().deliveredHumanInputCount).toBe(1)
    expect(dispatcher.stats().deliveredPacketCount).toBe(1)
  })

  test('a burst from one child never starves the other child through the delivery stream', () => {
    const dispatcher = new ChildProgressLeadDispatcher({
      buffer: trackedBuffer({ parentExecutionId: ids.parentExecutionId }),
      maximumCoalescedEventsPerDelivery: 50,
    })
    // Child A bursts 240 routine events; child B interleaves one event every
    // 60 A-events and then goes quiet.
    for (let index = 0; index < 240; index += 1) {
      dispatcher.acceptProgress(childEvent(childA, { observedAt: at(index) }))
      if (index % 60 === 0) {
        dispatcher.acceptProgress(childEvent(childB, { observedAt: at(index) }))
      }
    }
    const deliveries = evidenceDeliveries(dispatcher.takeDeliveries())
    // 244 routine events at pressure 50 seal exactly four routine packets.
    expect(deliveries).toHaveLength(4)
    for (const delivery of deliveries) {
      expect(delivery.trigger).toBe('coalescing_pressure')
      // Every routine delivery carries BOTH children's latest snapshots:
      // A's burst cannot push B out of the delivery stream.
      expect(delivery.packet.childSnapshots.map((snapshot) => snapshot.delegationId)).toStrictEqual(
        [ids.delegationIdA, ids.delegationIdB]
      )
    }
    // B's interleaved events advanced its snapshot in each successive packet;
    // counts are cumulative per generation.
    expect(
      deliveries.map(
        (delivery) =>
          delivery.packet.childSnapshots.find(
            (snapshot) => snapshot.delegationId === ids.delegationIdB
          ).observedEventCount
      )
    ).toStrictEqual([1, 2, 3, 4])
    expect(
      deliveries.map(
        (delivery) =>
          delivery.packet.childSnapshots.find(
            (snapshot) => snapshot.delegationId === ids.delegationIdA
          ).observedEventCount
      )
    ).toStrictEqual([49, 98, 147, 196])
    // The owner-driven deadline delivers the remaining open window.
    const deadlinePacket = dispatcher.flushDeadline()
    expect(deadlinePacket.childSnapshots.map((snapshot) => snapshot.delegationId)).toStrictEqual([
      ids.delegationIdA,
    ])
    expect(deadlinePacket.childSnapshots[0].observedEventCount).toBe(240)
    // Delivery sequences are strictly increasing across the whole session.
    const deadlineDeliveries = dispatcher.takeDeliveries()
    expect(deadlineDeliveries).toHaveLength(1)
    expect(deadlineDeliveries[0].trigger).toBe('deadline')
    expect(deadlineDeliveries[0].sequence).toBeGreaterThan(deliveries.at(-1).sequence)
  })

  test('duplicate deliveries neither trigger nor postpone coalescing pressure', () => {
    const dispatcher = new ChildProgressLeadDispatcher({
      buffer: trackedBuffer({ parentExecutionId: ids.parentExecutionId }),
      maximumCoalescedEventsPerDelivery: 10,
    })
    const first = childEvent(childA, { observedAt: at(0) })
    for (let index = 0; index < 9; index += 1) {
      dispatcher.acceptProgress(index === 0 ? first : childEvent(childA, { observedAt: at(index) }))
    }
    // A redelivered event is not fresh progress: it must not consume the
    // pressure budget nor trigger a delivery.
    expect(dispatcher.acceptProgress(first).outcome).toBe('duplicate')
    expect(dispatcher.takeDeliveries()).toStrictEqual([])
    expect(dispatcher.stats().routineEventsSinceDelivery).toBe(9)
    // The tenth distinct event crosses the threshold and delivers.
    dispatcher.acceptProgress(childEvent(childA, { observedAt: at(10_000) }))
    const deliveries = dispatcher.takeDeliveries()
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].trigger).toBe('coalescing_pressure')
    expect(deliveries[0].packet.childSnapshots[0].observedEventCount).toBe(10)
  })

  test('terminates cleanly when a terminal transition arrives for each running child', () => {
    const dispatcher = new ChildProgressLeadDispatcher({
      buffer: trackedBuffer({ parentExecutionId: ids.parentExecutionId }),
      maximumCoalescedEventsPerDelivery: 128,
    })
    for (let index = 0; index < 5; index += 1) {
      dispatcher.acceptProgress(childEvent(childA, { observedAt: at(index) }))
      dispatcher.acceptProgress(childEvent(childB, { observedAt: at(index) }))
    }
    const completedA = dispatcher.acceptProgress(
      childEvent(childA, {
        phase: 'completed',
        observedAt: at(1_000),
        terminalResultRef: ids.resultRefA,
      })
    )
    const completedB = dispatcher.acceptProgress(
      childEvent(childB, {
        phase: 'completed',
        observedAt: at(1_100),
        terminalResultRef: ids.resultRefB,
      })
    )
    expect(completedA).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    expect(completedB).toMatchObject({ outcome: 'retained', entryKind: 'terminal' })
    const deliveries = dispatcher.takeDeliveries()
    expect(deliveries).toHaveLength(2)
    expect(deliveries.map((delivery) => delivery.trigger)).toStrictEqual(['critical', 'critical'])
    expect(deliveries[0].packet.entries[0].terminalResultRef).toBe(ids.resultRefA)
    expect(deliveries[1].packet.entries[0].terminalResultRef).toBe(ids.resultRefB)
    // A's critical delivery carries the open window's snapshots for both
    // children; B's follows after the seal with its own snapshot (A's state
    // was already delivered and stays terminal).
    expect(
      deliveries[0].packet.childSnapshots.map((snapshot) => snapshot.delegationId)
    ).toStrictEqual([ids.delegationIdA, ids.delegationIdB])
    expect(
      deliveries[1].packet.childSnapshots.map((snapshot) => snapshot.delegationId)
    ).toStrictEqual([ids.delegationIdB])
    expect(dispatcher.flushDeadline()).toBeUndefined()
  })

  test('validates dispatcher configuration and human input', () => {
    expect(
      () =>
        new ChildProgressLeadDispatcher({
          buffer: new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId }),
          maximumCoalescedEventsPerDelivery: 0,
        })
    ).toThrow(ChildProgressEvidenceError)
    const dispatcher = new ChildProgressLeadDispatcher({
      buffer: new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId }),
    })
    expect(() => dispatcher.acceptHumanInput({ kind: 'input', receivedAt: at(0) })).toThrow()
    expect(dispatcher.takeDeliveries()).toStrictEqual([])
  })
})

describe('lazy reference resolution under current authorization', () => {
  const authorizationAuthority = ({ revoked, notAuthorized, missing, calls }) => ({
    async authorize(reference) {
      calls.push(reference)
      const id =
        reference.kind === 'terminal_result' ? reference.artifactId : reference.interactionId
      if (revoked.has(id)) return { status: 'forbidden', reason: 'revoked' }
      if (notAuthorized.has(id)) return { status: 'forbidden', reason: 'not_authorized' }
      if (missing.has(id)) return { status: 'unavailable', reason: 'missing' }
      return { status: 'authorized' }
    },
  })

  test('resolves references at read time against current authorization without caching', async () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(
      runningEvent({ phase: 'completed', observedAt: at(0), terminalResultRef: ids.resultRefA })
    )
    buffer.accept(
      runningEvent({
        delegationId: ids.delegationIdB,
        childExecutionId: ids.childExecutionIdB,
        childAttemptId: ids.attemptIdB,
        phase: 'awaiting_input',
        observedAt: at(1_000),
        interaction: { interactionId: ids.interactionId, kind: 'approval' },
      })
    )
    const packet = buffer.flush()
    const revoked = new Set()
    const calls = []
    const authority = authorizationAuthority({
      revoked,
      notAuthorized: new Set(),
      missing: new Set(),
      calls,
    })

    const first = await resolveEvidenceReferences(packet, authority)
    expect(first).toStrictEqual([
      { kind: 'terminal_result', artifactId: ids.resultRefA, status: 'authorized' },
      { kind: 'interaction', interactionId: ids.interactionId, status: 'authorized' },
    ])

    // Revocation after an authorized resolution changes the next read: the
    // authority is consulted fresh on every resolution — verdicts are never
    // snapshotted at capture time.
    revoked.add(ids.resultRefA)
    const second = await resolveEvidenceReferences(packet, authority)
    expect(second[0]).toStrictEqual({
      kind: 'terminal_result',
      artifactId: ids.resultRefA,
      status: 'forbidden',
      reason: 'revoked',
    })
    expect(second[1]).toMatchObject({ status: 'authorized' })
    // Four fresh authorize calls for two references resolved twice.
    expect(calls).toHaveLength(4)
  })

  test('distinguishes authorized, revoked, not-authorized, and unavailable states', async () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(
      runningEvent({
        phase: 'completed',
        observedAt: at(0),
        terminalResultRef: ids.resultRefA,
      })
    )
    buffer.accept(
      runningEvent({
        delegationId: ids.delegationIdB,
        childExecutionId: ids.childExecutionIdB,
        childAttemptId: ids.attemptIdB,
        phase: 'completed',
        observedAt: at(1_000),
        terminalResultRef: ids.resultRefB,
      })
    )
    const packet = buffer.flush()
    const resolutions = await resolveEvidenceReferences(
      packet,
      authorizationAuthority({
        revoked: new Set([ids.resultRefA]),
        notAuthorized: new Set([ids.resultRefB]),
        missing: new Set([ids.interactionId]),
        calls: [],
      })
    )
    // resultRefA was explicitly revoked for the reader and resultRefB was
    // never authorized; both resolve to forbidden with distinct reasons.
    expect(resolutions).toStrictEqual([
      {
        kind: 'terminal_result',
        artifactId: ids.resultRefA,
        status: 'forbidden',
        reason: 'revoked',
      },
      {
        kind: 'terminal_result',
        artifactId: ids.resultRefB,
        status: 'forbidden',
        reason: 'not_authorized',
      },
    ])
    // The resolution carries only identity and explicit state — never any
    // referenced payload.
    for (const resolution of resolutions) {
      expect(Object.keys(resolution).toSorted()).toStrictEqual([
        'artifactId',
        'kind',
        'reason',
        'status',
      ])
    }
  })

  test('resolves an unavailable interaction as missing, not forbidden', async () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(
      runningEvent({
        phase: 'awaiting_input',
        observedAt: at(0),
        interaction: { interactionId: ids.interactionId, kind: 'input' },
      })
    )
    const packet = buffer.flush()
    const resolutions = await resolveEvidenceReferences(
      packet,
      authorizationAuthority({
        revoked: new Set(),
        notAuthorized: new Set(),
        missing: new Set([ids.interactionId]),
        calls: [],
      })
    )
    expect(resolutions).toStrictEqual([
      {
        kind: 'interaction',
        interactionId: ids.interactionId,
        status: 'unavailable',
        reason: 'missing',
      },
    ])
  })

  test('deduplicates the same reference repeated across entries', async () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(
      runningEvent({
        phase: 'completed',
        observedAt: at(0),
        terminalResultRef: ids.resultRefA,
      })
    )
    buffer.accept(
      runningEvent({
        delegationId: ids.delegationIdB,
        childExecutionId: ids.childExecutionIdB,
        childAttemptId: ids.attemptIdB,
        phase: 'completed',
        observedAt: at(1_000),
        terminalResultRef: ids.resultRefA,
      })
    )
    const packet = buffer.flush()
    expect(evidencePacketReferences(packet)).toStrictEqual([
      { kind: 'terminal_result', artifactId: ids.resultRefA },
    ])
    const resolutions = await resolveEvidenceReferences(
      packet,
      authorizationAuthority({
        revoked: new Set(),
        notAuthorized: new Set(),
        missing: new Set(),
        calls: [],
      })
    )
    expect(resolutions).toStrictEqual([
      { kind: 'terminal_result', artifactId: ids.resultRefA, status: 'authorized' },
    ])
    expect(evidencePacketReferences({ ...packet, entries: [] })).toStrictEqual([])
  })

  test('fails loudly on a tampered packet or a misbehaving authority', async () => {
    const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
    buffer.accept(
      runningEvent({ phase: 'completed', observedAt: at(0), terminalResultRef: ids.resultRefA })
    )
    const packet = buffer.flush()
    await expect(
      resolveEvidenceReferences(
        { ...packet, sequence: packet.sequence + 1 },
        authorizationAuthority({
          revoked: new Set(),
          notAuthorized: new Set(),
          missing: new Set(),
          calls: [],
        })
      )
    ).rejects.toThrow(ChildProgressEvidenceError)
    await expect(
      resolveEvidenceReferences(packet, {
        async authorize() {
          return { status: 'granted' }
        },
      })
    ).rejects.toThrow()
  })
})

async function createDelegationFixture() {
  const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(parentPlanInput())
  const executions = new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(executions)
  const plans = new InMemoryExecutionPlanRepository()
  await plans.put(parentPlan)
  await lifecycle.createExecution({
    executionId: ids.parentExecutionId,
    correlation: parentPlan.correlation,
    executionPlan: {
      executionPlanId: parentPlan.executionPlanId,
      contentDigest: parentPlan.contentDigest,
      schemaVersion: parentPlan.schemaVersion,
    },
    acceptedAt: '2026-08-25T18:00:00.000Z',
    deadlineAt: '2026-08-25T19:00:00.000Z',
  })
  const events = []
  const service = new DelegationService({
    delegations: new InMemoryDelegationRepository(),
    lifecycle,
    plans,
    events: {
      async publish(event) {
        events.push(event)
      },
    },
  })
  return { parentPlan, events, service }
}

const CHILD_INPUTS = {
  A: {
    delegationId: ids.delegationIdA,
    childExecutionId: ids.childExecutionIdA,
    childTaskId: ids.childTaskIdA,
    childRequestId: ids.childRequestIdA,
    attemptId: ids.attemptIdA,
    objective: 'Child A objective',
  },
  B: {
    delegationId: ids.delegationIdB,
    childExecutionId: ids.childExecutionIdB,
    childTaskId: ids.childTaskIdB,
    childRequestId: ids.childRequestIdB,
    attemptId: ids.attemptIdB,
    objective: 'Child B objective',
  },
}

async function delegateChild(fixture, suffix) {
  const child = CHILD_INPUTS[suffix]
  const constraints = globalThis.structuredClone(fixture.parentPlan.constraints)
  constraints.tools.grants[0].operations = ['read']
  constraints.limits.budget.maximumMicrounits = 1_000_000
  constraints.limits.tokens.maximumTotal = 10_000
  constraints.limits.duration.maximumMs = 600_000
  const contextPackage = deriveContextPackage(contextPackageSerializationFixtures.futurePi, {
    objective: child.objective,
    allowedStateItemIds: [],
    allowedArtifactIds: [],
    budgets: { maximumBytes: 512, maximumTokens: 128 },
    successCriteria: ['Return evidence'],
    returnContract: { contractRef: 'contract://adapter-result/v1' },
    compiledAt: '2026-08-25T18:01:00.000Z',
  })
  await fixture.service.delegate({
    delegationId: child.delegationId,
    parentExecutionId: ids.parentExecutionId,
    childExecutionId: child.childExecutionId,
    role: 'researcher',
    profileVersionId: ids.profileVersionId,
    objective: child.objective,
    parentPlan: fixture.parentPlan,
    childPlan: {
      correlation: {
        ...fixture.parentPlan.correlation,
        taskId: child.childTaskId,
        requestId: child.childRequestId,
      },
      contextPackage,
      constraints,
      runtimeRequirements: fixture.parentPlan.runtimeRequirements,
      outputContract: fixture.parentPlan.outputContract,
      compiledAt: '2026-08-25T18:01:00.000Z',
    },
    policy: {
      cancellation: 'cascade',
      deadline: 'bounded_by_parent',
      failure: 'retry',
      maximumRetries: 2,
    },
    acceptedAt: '2026-08-25T18:01:00.000Z',
    deadlineAt: '2026-08-25T18:10:00.000Z',
  })
  await fixture.service.dispatchChild({
    delegationId: child.delegationId,
    childAttemptId: child.attemptId,
    runtime: { runtimeConnectionId: ids.runtimeConnectionId },
    dispatchedAt: '2026-08-25T18:02:00.000Z',
  })
}

function parentPlanInput() {
  const skill = {
    skillVersionId: ids.skillVersionId,
    skillId: ids.skillId,
    revision: 1,
    lifecycle: 'published',
    manifest: {
      schemaVersion: 1,
      semanticVersion: '1.0.0',
      contentDigest: digest('b'),
      requiredCapabilities: ['filesystem.read'],
      requiredTools: [{ toolId: 'project-files', versionRange: '^1.0.0' }],
      compatibleProfileSchemaVersions: [1],
      compatibleContractMajorVersions: [1],
    },
    content: { instructions: 'Inspect project files.', artifactRefs: [] },
    createdAt: '2026-08-25T17:00:00.000Z',
    lifecycleMetadata: { publishedAt: '2026-08-25T17:00:00.000Z' },
  }
  return {
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
      requestId: ids.requestId,
    },
    profile: {
      profileVersionId: ids.profileVersionId,
      profileId: ids.profileId,
      version: 1,
      revision: 1,
      lifecycle: 'published',
      contentDigest: digest('a'),
      definition: {
        schemaVersion: 1,
        roleInstructions: 'Coordinate safely.',
        skills: [
          { skillId: ids.skillId, skillVersionId: ids.skillVersionId, contentDigest: digest('b') },
        ],
        capabilityRequirements: ['filesystem.read'],
        executionConstraints: globalThis.structuredClone(executionConstraintFixtures.write),
        outputContractRefs: ['contract://execution-result/v1'],
      },
      createdAt: '2026-08-25T17:00:00.000Z',
      lifecycleMetadata: { publishedAt: '2026-08-25T17:00:00.000Z' },
    },
    skills: [skill],
    contextPackage: globalThis.structuredClone(contextPackageSerializationFixtures.futurePi),
    constraints: globalThis.structuredClone(executionConstraintFixtures.write),
    requestConstraints: [],
    runtimeRequirements: [
      { capability: 'stream.output', necessity: 'required', minimumSupport: 'supported' },
    ],
    outputContract: { contractRef: 'contract://execution-result/v1' },
    compiledAt: '2026-08-25T17:00:00.000Z',
  }
}

// Mixed fractional-second precision: lexical order is not chronological, so
// these regressions pin the chronological comparison at every evidence
// boundary. `…18:05:00Z` (zero fraction) sorts AFTER `…18:05:00.100Z`
// lexically even though it is earlier in time.
const zeroFractionSecond = '2026-08-25T18:05:00Z'
const threeDigitSecond = '2026-08-25T18:05:00.100Z'
const nextSecondZeroFraction = '2026-08-25T18:05:01Z'

test('a coarser-fraction terminal observation supersedes an earlier running snapshot chronologically', () => {
  const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
  buffer.accept(runningEvent({ observedAt: zeroFractionSecond }))
  buffer.accept(
    runningEvent({
      phase: 'completed',
      observedAt: threeDigitSecond,
      terminalResultRef: ids.resultRefA,
    })
  )
  const packet = buffer.flush()
  // Chronologically the terminal (.100) is later, so it must supersede the
  // running snapshot even though it sorts before the zero-fraction lexically.
  expect(packet.childSnapshots[0]).toMatchObject({
    phase: 'completed',
    lastObservedAt: threeDigitSecond,
  })
})

test('the observation window span stays chronological across mixed fractional precision', () => {
  const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
  buffer.accept(runningEvent({ observedAt: zeroFractionSecond }))
  buffer.accept(runningEvent({ observedAt: threeDigitSecond }))
  const packet = buffer.flush()
  // The zero-fraction instant is the chronological minimum and the three-digit
  // one the maximum, so the span must not be swapped by lexical ordering.
  expect(packet.firstEventAt).toBe(zeroFractionSecond)
  expect(packet.lastEventAt).toBe(threeDigitSecond)
})

test('a coarser-fraction terminal observation closes the generation against later events', () => {
  const buffer = trackedBuffer({ parentExecutionId: ids.parentExecutionId })
  buffer.accept(runningEvent({ observedAt: zeroFractionSecond }))
  buffer.accept(
    runningEvent({
      phase: 'completed',
      observedAt: threeDigitSecond,
      terminalResultRef: ids.resultRefA,
    })
  )
  // Because the terminal observation actually superseded, the generation is
  // terminal and a later event must be rejected, not silently accepted.
  expect(buffer.accept(runningEvent({ observedAt: nextSecondZeroFraction }))).toMatchObject({
    outcome: 'rejected',
    reason: 'terminated_generation',
  })
})
