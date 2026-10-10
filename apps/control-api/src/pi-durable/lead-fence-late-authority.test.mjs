import { test, expect } from 'bun:test'
import { afterExpiry, principal, waitUntil, withLiveHarness } from './lead-fence-live-harness.mjs'

// Late-authority reproduction. Each case changes the fence, the retained deadline, or the superseded
// attempt while one awaited read or effect of a fenced observation or cancel is in flight, and records
// what happened before the refusal. These tests report current behavior; they do not change it.

const EARLIER_DEADLINE = '2026-10-08T08:30:00.000Z'
const LATER_ATTEMPT = 'att_01JABCDEF0123456789ABCDEFH'

function counted(composition) {
  const calls = { status: 0, progress: 0, cancel: 0 }
  const adapter = composition.adapter
  const realStatus = adapter.status.bind(adapter)
  const realProgress = adapter.progress.bind(adapter)
  const realCancelFenced = adapter.cancelFenced.bind(adapter)
  adapter.status = async (handle) => {
    calls.status += 1
    return realStatus(handle)
  }
  adapter.progress = (handle, options) => {
    calls.progress += 1
    return realProgress(handle, options)
  }
  adapter.cancelFenced = async (handle, input, authorize) => {
    calls.cancel += 1
    return realCancelFenced(handle, input, authorize)
  }
  return calls
}

async function expectRefused(promise, code) {
  await expect(promise).rejects.toThrow(code)
}

const statusOf = (harness, dispatchId, actor = principal) =>
  harness.composition.service.status(
    harness.read('pi-durable.lead.status', { dispatchId }, actor),
    actor
  )

const cancelOf = (harness, dispatchId, key) =>
  harness.composition.service.cancel(
    harness.envelope('pi-durable.lead.cancel', { dispatchId }, key),
    principal
  )

test('status: a fence change during the awaited binding read is caught before the adapter observes', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const calls = counted(harness.composition)
    harness.state.product = harness.fenceBody()
    // Read 1 is the lookup's binding; the change lands after read 1, so the pre-effect recheck
    // (read 2) sees the new revision.
    harness.armExecutionRead(1, async () => {
      harness.state.product = harness.fenceBody({ authorityRevision: 9 })
    })
    await expectRefused(statusOf(harness, dispatchId), 'PI_LEAD_AUTHORITY_CONFLICT')
    expect(calls.status).toBe(0)
    expect(harness.composition.adapter.journal.list()[0].state).toBe('running')
  })
}, 60000)

test('status: a fence change during the pre-effect recheck read is caught only after the adapter read', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const calls = counted(harness.composition)
    harness.state.product = harness.fenceBody()
    // Read 2 is the pre-effect recheck; the change lands after its pins were checked.
    harness.armExecutionRead(2, async () => {
      harness.state.product = harness.fenceBody({ authorityRevision: 9 })
    })
    await expectRefused(statusOf(harness, dispatchId), 'PI_LEAD_AUTHORITY_CONFLICT')
    // Observation only: the adapter read ran, but no record changed and nothing was aborted.
    expect(calls.status).toBe(1)
    expect(harness.composition.adapter.journal.list()[0].state).toBe('running')
    expect(harness.state.streamsAborted).toBe(0)
  })
}, 60000)

test('cancel: a fence change before the authorize read is caught before any effect', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const calls = counted(harness.composition)
    harness.state.product = harness.fenceBody()
    // Read 1 is the lookup's binding; the authorize recheck (read 2) then sees the new revision.
    harness.armExecutionRead(1, async () => {
      harness.state.product = harness.fenceBody({ authorityRevision: 9 })
    })
    await expectRefused(
      cancelOf(harness, dispatchId, 'late:cancel-before-authorize'),
      'PI_LEAD_AUTHORITY_CONFLICT'
    )
    // The adapter was reached, and the refusal came from the authorize recheck before any state change.
    expect(calls.cancel).toBe(1)
    expect(harness.composition.adapter.journal.list()[0].state).toBe('running')
    expect(harness.state.streamsAborted).toBe(0)
  })
}, 60000)

test('cancel: a fence change during the authorize read takes effect before the refusal', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const calls = counted(harness.composition)
    harness.state.product = harness.fenceBody()
    // Read 2 is the authorize recheck. Its pins were checked before the change lands, so the adapter
    // proceeds to its state transition and to abort the held model turn.
    harness.armExecutionRead(2, async () => {
      harness.state.product = harness.fenceBody({ authorityRevision: 9 })
    })
    await expectRefused(
      cancelOf(harness, dispatchId, 'late:cancel-during-authorize'),
      'PI_LEAD_AUTHORITY_CONFLICT'
    )
    expect(calls.cancel).toBe(1)
    // The effect happened: the run was driven into cancellation and its model turn was aborted.
    expect(harness.composition.adapter.journal.list()[0].state).toBe('cancelling')
    await waitUntil(
      () => harness.state.streamsAborted >= 1,
      'model turn aborted after refused cancel'
    )
    expect(harness.state.streamsAborted).toBe(1)
  })
}, 60000)

test('cancel: an execution deadline change during the authorize read takes effect before the refusal', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const calls = counted(harness.composition)
    harness.state.product = harness.fenceBody()
    harness.armExecutionRead(2, () => harness.setExecutionDeadline(EARLIER_DEADLINE))
    await expectRefused(
      cancelOf(harness, dispatchId, 'late:deadline-during-authorize'),
      'PI_LEAD_AUTHORITY_CONFLICT'
    )
    expect(calls.cancel).toBe(1)
    expect(harness.composition.adapter.journal.list()[0].state).toBe('cancelling')
    await waitUntil(
      () => harness.state.streamsAborted >= 1,
      'model turn aborted after refused cancel'
    )
  })
}, 60000)

test('cancel: a retained expiry that lands during the authorize read is still cancelled, because no time check follows the awaited reads', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    harness.state.product = harness.fenceBody()
    harness.armExecutionRead(2, async () => {
      harness.state.clock = afterExpiry
    })
    const response = await cancelOf(harness, dispatchId, 'late:expiry-during-authorize')
    // Gap: the retained admission expired (clock past expiresAt) before the effect, yet the cancel
    // is accepted and the held turn is aborted.
    expect(response.data.state).toBe('cancelling')
    expect(harness.state.clock).toBe(afterExpiry)
    await waitUntil(
      () => harness.state.streamsAborted >= 1,
      'model turn aborted after accepted cancel'
    )
  })
}, 60000)

test('status: a retained expiry that lands during the pre-effect read is still served', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    harness.state.product = harness.fenceBody()
    harness.armExecutionRead(2, async () => {
      harness.state.clock = afterExpiry
    })
    const response = await statusOf(harness, dispatchId)
    // Gap: observation of a run whose retained admission expired is served.
    expect(response.data.state).toBe('running')
  })
}, 60000)

test('scoped cancel: a fence change during the adapter execution-scope read takes effect before the refusal', async () => {
  await withLiveHarness(
    async (harness) => {
      const { dispatchId } = await harness.admitInFlightRun()
      const calls = counted(harness.composition)
      harness.state.product = harness.fenceBody()
      expect(harness.plan.schemaVersion).toBe(2)
      harness.armScopeRead(async () => {
        harness.state.product = harness.fenceBody({ authorityRevision: 9 })
      })
      await expectRefused(
        cancelOf(harness, dispatchId, 'late:scope-revision'),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
      expect(calls.cancel).toBe(1)
      expect(harness.composition.adapter.journal.list()[0].state).toBe('cancelling')
      await waitUntil(
        () => harness.state.streamsAborted >= 1,
        'scoped turn aborted after refused cancel'
      )
    },
    { scoped: true }
  )
}, 60000)

test('scoped cancel: a retained expiry during the adapter execution-scope read is still cancelled', async () => {
  await withLiveHarness(
    async (harness) => {
      const { dispatchId } = await harness.admitInFlightRun()
      harness.state.product = harness.fenceBody()
      harness.armScopeRead(async () => {
        harness.state.clock = afterExpiry
      })
      const response = await cancelOf(harness, dispatchId, 'late:scope-expiry')
      // Gap: the scope grant and the admission are both past expiry at the effect, yet cancel succeeds.
      expect(response.data.state).toBe('cancelling')
      await waitUntil(
        () => harness.state.streamsAborted >= 1,
        'scoped turn aborted after accepted cancel'
      )
    },
    { scoped: true }
  )
}, 60000)

test('superseded attempt, precondition: while the turn is in flight, a later attempt is refused and the latest pointer cannot move outside the lifecycle', async () => {
  await withLiveHarness(async (harness) => {
    await harness.admitInFlightRun()
    const retained = harness.ids.attemptId
    await expect(harness.supersedeAttempt(LATER_ATTEMPT)).rejects.toThrow('SETTLEMENT_INCOMPLETE')
    expect(await harness.latestAttemptId()).toBe(retained)
    expect(await harness.moveLatestAttemptBypassingLifecycle(LATER_ATTEMPT)).toBe(false)
    expect(await harness.latestAttemptId()).toBe(retained)
    expect(harness.composition.adapter.journal.list()[0].state).toBe('running')
  })
}, 60000)

test('superseded attempt, precondition: after an unfenced completion the runtime reservation stays open, so the lifecycle refuses supersession', async () => {
  await withLiveHarness(async (harness) => {
    await harness.admitInFlightRun()
    const retained = harness.ids.attemptId
    harness.state.gate.resolve()
    await waitUntil(
      () => harness.composition.adapter.journal.list()[0].state === 'completed',
      'run completed'
    )
    await expect(harness.supersedeAttempt(LATER_ATTEMPT)).rejects.toThrow('SETTLEMENT_INCOMPLETE')
    expect(await harness.latestAttemptId()).toBe(retained)
  })
}, 60000)

test('superseded attempt, qualification: the unfenced path refuses a receipt whose attempt is no longer latest; the fenced retained handle serves and cancels it', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const calls = counted(harness.composition)
    const retained = harness.ids.attemptId
    harness.state.gate.resolve()
    await waitUntil(
      () => harness.composition.adapter.journal.list()[0].state === 'completed',
      'run completed'
    )
    // Control: the unfenced receipt is served while its attempt is still the latest.
    expect((await statusOf(harness, dispatchId)).data.state).toBe('completed')
    // PRECONDITION (reproduction only, see the harness): settle the reservation, then supersede through the lifecycle.
    await harness.settleRuntimeAttemptForReproduction(retained)
    expect((await statusOf(harness, dispatchId)).data.state).toBe('completed')
    await harness.supersedeAttempt(LATER_ATTEMPT)
    expect(await harness.latestAttemptId()).toBe(LATER_ATTEMPT)

    // Unfenced: refused once superseded. The admission branch compares the latest attempt on every
    // resolve, but node-admission #safe masks unexpected throws as PI_LEAD_UNAVAILABLE, so the exact
    // cause of this refusal is not isolated by this test.
    await expectRefused(statusOf(harness, dispatchId), 'PI_LEAD_UNAVAILABLE')

    // Fenced: the retained handle is served, and nothing compares its attempt with the latest one.
    harness.state.product = harness.fenceBody()
    const observed = await statusOf(harness, dispatchId)
    expect(observed.data.state).toBe('completed')
    expect(observed.data.status.handle.attemptId).toBe(retained)
    // The fenced cancel reaches the adapter, which refuses a terminal attempt; nothing is aborted.
    await expect(cancelOf(harness, dispatchId, 'late:superseded-fenced-cancel')).rejects.toThrow(
      'PI_EXECUTION_TERMINAL'
    )
    expect(calls.cancel).toBe(1)
    expect(harness.state.streamsAborted).toBe(0)
    expect(harness.state.starts).toBe(1)
    expect(harness.composition.adapter.journal.list()[0].state).toBe('completed')
    expect(await harness.latestAttemptId()).toBe(LATER_ATTEMPT)
  })
}, 60000)

test('under the fence, a cancelled turn cannot be reconciled and stays cancelling', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    harness.state.product = harness.fenceBody()
    await cancelOf(harness, dispatchId, 'late:cancel-then-reconcile')
    await waitUntil(() => harness.state.streamsAborted >= 1, 'cancelled turn aborted')
    harness.state.reconcileDecision = 'safe_to_resume'
    // The production reconciliation path re-derives the canonical admission, which needs the withheld
    // prompt, so the fence refuses it and the attempt does not settle.
    await expect(
      harness.composition.adapter.reconcile(harness.receiptRecord(dispatchId).handle)
    ).rejects.toThrow('PI_AUTHORITY_REJECTED')
    expect(harness.composition.adapter.journal.list()[0].state).toBe('cancelling')
  })
}, 60000)

test('under the fence, a turn that completes while fenced is persisted as unknown rather than completed', async () => {
  await withLiveHarness(async (harness) => {
    await harness.admitInFlightRun()
    harness.state.product = harness.fenceBody()
    harness.state.gate.resolve()
    await waitUntil(
      () => harness.composition.adapter.journal.list()[0].state !== 'running',
      'turn settled'
    )
    const record = harness.composition.adapter.journal.list()[0]
    expect(record.state).toBe('unknown')
    expect(record.detail.reasonCode).toBe('PI_INFERENCE_RECONCILIATION_REQUIRED')
  })
}, 60000)
