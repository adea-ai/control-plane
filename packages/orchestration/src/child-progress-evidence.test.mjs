import { describe, expect, test } from 'bun:test'
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
  delegationEventToEvidenceEvent,
  parseChildProgressEvidencePacket,
} from './child-progress-evidence.ts'
import { DelegationService, InMemoryDelegationRepository } from './delegation.ts'

const digest = (character) => `sha256:${character.repeat(64)}`

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

describe('child progress evidence packets', () => {
  test('coalesces a burst of routine progress into bounded per-child snapshots', () => {
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
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
  })

  test('identical event streams produce identical packet digests', () => {
    const feed = (buffer) => {
      for (let index = 0; index < 10; index += 1) {
        buffer.accept(runningEvent({ observedAt: at(index), metrics: { 'steps.completed': 2 } }))
      }
      return buffer.flush()
    }
    const first = feed(
      new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
    )
    const second = feed(
      new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
    )
    expect(first.contentDigest).toBe(second.contentDigest)
    expect(parseChildProgressEvidencePacket(first)).toEqual(first)
  })

  test('never drops terminal outcomes, failures, cancellations, or approval requests', () => {
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
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
    expect(parseChildProgressEvidencePacket(packet)).toEqual(packet)
  })

  test('keeps the lead responsive by surfacing approval requests immediately', () => {
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
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

  test('deduplicates duplicate delivery by eventId without double counting', () => {
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
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

  test('rejects stale generations and never regresses snapshots on out-of-order updates', () => {
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
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
        runningEvent({ generation: 3, observedAt: at(40_000), childAttemptId: ids.attemptIdA })
      ).outcome
    ).toBe('coalesced')
  })

  test('tracks concurrent children independently with sorted snapshots', () => {
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
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
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
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
    const buffer = new ChildProgressEvidenceBuffer({
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
          childAttemptId: ids.attemptIdB,
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
        childAttemptId: ids.attemptIdC,
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
    for (const packet of [third.sealedPacket, final]) {
      expect(parseChildProgressEvidencePacket(packet)).toEqual(packet)
    }
  })

  test('seals when distinct children exceed the per-packet child budget', () => {
    const buffer = new ChildProgressEvidenceBuffer({
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

  test('seals on the byte budget when snapshots grow', () => {
    const longMetrics = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `metrics.pressure.longKeyForBudgetTesting.${String(index).padStart(2, '0')}.x`.padEnd(
          60,
          'k'
        ),
        1_000_000,
      ])
    )
    const buffer = new ChildProgressEvidenceBuffer({
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
    expect(receipts[0].sealedPacket).toBeUndefined()
    expect(receipts[1].sealedPacket).toBeUndefined()
    expect(receipts[2].sealedPacket).toBeDefined()
    expect(receipts[2].sealedPacket.childSnapshots).toHaveLength(2)
    const final = buffer.flush()
    expect(final.childSnapshots).toHaveLength(1)
    for (const packet of [receipts[2].sealedPacket, final]) {
      expect(parseChildProgressEvidencePacket(packet)).toEqual(packet)
    }
  })

  test('rejects events for a foreign parent execution without opening a packet', () => {
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
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

  test('coalesces progress from the delegation persistence fixtures into packets', async () => {
    const fixture = await createDelegationFixture()
    await delegateChild(fixture, 'A')
    await delegateChild(fixture, 'B')
    const buffer = new ChildProgressEvidenceBuffer({ parentExecutionId: ids.parentExecutionId })
    const lane = new Map([
      [ids.delegationIdA, 1_000],
      [ids.delegationIdB, 60_000],
    ])
    const lastEventId = new Map()

    const deliver = async (delegationId, input, adapter = {}) => {
      const outcome = await fixture.service.recordChildProgress({
        delegationId,
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
      {
        interaction: { interactionId: ids.interactionId, kind: 'approval' },
      }
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
    expect(parseChildProgressEvidencePacket(packet)).toEqual(packet)

    // Duplicate redelivery of a terminal event is absorbed by eventId.
    const redeliveredEvent = fixture.events.at(-1)
    const redelivered = await fixture.service.recordChildProgress({
      delegationId: ids.delegationIdB,
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
