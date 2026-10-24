import { test, expect } from 'bun:test'
import { afterExpiry, principal, waitUntil, withLiveHarness } from './lead-fence-live-harness.mjs'

const EARLIER_DEADLINE = '2026-10-08T08:30:00.000Z'

const cancelOf = (harness, dispatchId, key) =>
  harness.composition.service.cancel(
    harness.envelope('pi-durable.lead.cancel', { dispatchId }, key),
    principal
  )

const expectRefused = (promise, code) => expect(promise).rejects.toThrow(code)

test('a fence change after the first cancel authorization blocks the final journal claim', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const handle = harness.receiptRecord(dispatchId).handle
    harness.state.product = harness.fenceBody()
    harness.armAfterCancelAuthorization(async () => {
      harness.state.product = harness.fenceBody({ authorityRevision: 9 })
    })

    await expectRefused(
      cancelOf(harness, dispatchId, 'cross-store:post-auth-fence'),
      'PI_LEAD_AUTHORITY_CONFLICT'
    )
    const journal = harness.composition.adapter.journal.get(handle.handleId)
    expect(journal.state).toBe('running')
    expect(journal.detail.cancellationIntent).toBeUndefined()
    expect(harness.state.product.authorityRevision).toBe(9)
    expect(harness.state.streamsAborted).toBe(0)
    expect(harness.state.requests).toHaveLength(1)
    expect(harness.state.starts).toBe(1)
    expect(harness.state.reconcileCalls).toBe(0)
  })
}, 60000)

test('an execution deadline update after the first final CP sample blocks the journal claim', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const handle = harness.receiptRecord(dispatchId).handle
    harness.state.product = harness.fenceBody()
    harness.armBindingSnapshot('pre-effect', 'final', () =>
      harness.setExecutionDeadline(EARLIER_DEADLINE)
    )

    await expectRefused(
      cancelOf(harness, dispatchId, 'cross-store:post-final-cp-sample'),
      'PI_LEAD_AUTHORITY_CONFLICT'
    )
    const journal = harness.composition.adapter.journal.get(handle.handleId)
    expect(journal.state).toBe('running')
    expect(journal.detail.cancellationIntent).toBeUndefined()
    expect(harness.state.streamsAborted).toBe(0)
    expect(harness.state.requests).toHaveLength(1)
    expect(harness.state.starts).toBe(1)
    expect(harness.state.reconcileCalls).toBe(0)
  })
}, 60000)

test('expiry after the authorize callback returns blocks the journal claim and cancellation', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const handle = harness.receiptRecord(dispatchId).handle
    harness.state.product = harness.fenceBody()
    harness.armAfterCancelAuthorization(async () => {
      harness.state.clock = afterExpiry
    })

    await expectRefused(
      cancelOf(harness, dispatchId, 'cross-store:post-auth-expiry'),
      'PI_AUTHORITY_EXPIRED'
    )

    const journal = harness.composition.adapter.journal.get(handle.handleId)
    expect(journal.state).toBe('running')
    expect(journal.detail.cancellationIntent).toBeUndefined()
    expect(harness.state.streamsAborted).toBe(0)
    expect(harness.state.requests).toHaveLength(1)
    expect(harness.state.starts).toBe(1)
    expect(harness.state.reconcileCalls).toBe(0)
  })
}, 60000)

// The former missing-port policy is superseded. These executed zero-effect requirements
// remain failing qualification gates until a reviewed native/all-writer effect fence exists.
// An OUTCOME_UNKNOWN response after effect is not an atomic authorization guarantee.
test('qualified cancellation must reject revocation after its final asynchronous authorization with zero effect', async () => {
  await withLiveHarness(
    async (harness) => {
      const { dispatchId } = await harness.admitInFlightRun()
      const handle = harness.receiptRecord(dispatchId).handle
      harness.state.product = harness.fenceBody()
      let finalAuthorizationEntered = false
      harness.armAfterCancelAuthorization(async () => {
        finalAuthorizationEntered = true
        harness.state.product = harness.fenceBody({ authorityRevision: 9 })
      }, 'final')

      await expectRefused(
        cancelOf(harness, dispatchId, 'qualification:final-fence-revocation'),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
      const journal = harness.composition.adapter.journal.get(handle.handleId)
      expect(finalAuthorizationEntered).toBe(true)
      expect({
        state: journal.state,
        hasCancellationIntent: journal.detail.cancellationIntent !== undefined,
        streamsAborted: harness.state.streamsAborted,
      }).toEqual({ state: 'running', hasCancellationIntent: false, streamsAborted: 0 })
    },
    { cancellationAuthority: false }
  )
}, 60000)

test('qualified cancellation must reject deadline change after its final asynchronous authorization with zero effect', async () => {
  await withLiveHarness(
    async (harness) => {
      const { dispatchId } = await harness.admitInFlightRun()
      const handle = harness.receiptRecord(dispatchId).handle
      harness.state.product = harness.fenceBody()
      let finalAuthorizationEntered = false
      harness.armAfterCancelAuthorization(async () => {
        finalAuthorizationEntered = true
        await harness.setExecutionDeadline(EARLIER_DEADLINE)
      }, 'final')

      await expectRefused(
        cancelOf(harness, dispatchId, 'qualification:final-deadline-change'),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
      const journal = harness.composition.adapter.journal.get(handle.handleId)
      expect(finalAuthorizationEntered).toBe(true)
      expect({
        state: journal.state,
        hasCancellationIntent: journal.detail.cancellationIntent !== undefined,
        streamsAborted: harness.state.streamsAborted,
      }).toEqual({ state: 'running', hasCancellationIntent: false, streamsAborted: 0 })
    },
    { cancellationAuthority: false }
  )
}, 60000)

test('repeated recovery under a fence preserves cancellation truth without probing or redispatching', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const handle = harness.receiptRecord(dispatchId).handle
    harness.state.product = harness.fenceBody()
    await cancelOf(harness, dispatchId, 'cross-store:cancel-before-recovery')
    await waitUntil(() => harness.state.streamsAborted === 1, 'cancelled turn aborted')
    harness.state.reconcileDecision = 'safe_to_resume'
    const retainedCancellationIntent = harness.composition.adapter.journal.get(handle.handleId)
      .detail.cancellationIntent

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(harness.composition.adapter.reconcile(handle)).rejects.toThrow(
        'PI_AUTHORITY_REJECTED'
      )
      const journal = harness.composition.adapter.journal.get(handle.handleId)
      expect(journal.state).toBe('cancelling')
      expect(journal.detail.cancellationIntent).toEqual(retainedCancellationIntent)
      expect(journal.detail.inferencePending).toBe(true)
      expect(harness.state.reconcileCalls).toBe(0)
      expect(harness.state.requests).toHaveLength(1)
      expect(harness.state.starts).toBe(1)
    }
  })
}, 60000)
