import { test, expect } from 'bun:test'
import { principal, withLiveHarness } from './lead-fence-live-harness.mjs'

const cancelOf = (harness, dispatchId, key) =>
  harness.composition.service.cancel(
    harness.envelope('pi-durable.lead.cancel', { dispatchId }, key),
    principal
  )

const expectNoCancellationEffect = (harness, handleId) => {
  const journal = harness.composition.adapter.journal.get(handleId)
  expect(journal.state).toBe('running')
  expect(journal.detail.cancellationIntent).toBeUndefined()
  expect(harness.state.streamsAborted).toBe(0)
  expect(harness.state.requests).toHaveLength(1)
  expect(harness.state.starts).toBe(1)
}

test('native cancellation refuses a preparation deadline crossed after final authorization before product expiry', async () => {
  await withLiveHarness(
    async (harness) => {
      const { dispatchId, record } = await harness.admitInFlightRun()
      const receipt = harness.receiptRecord(dispatchId)
      const deadline = Date.parse(receipt.deadlineAt)
      const productExpiry = Date.parse(record.admission.admission.authority.expiresAt)
      expect(deadline).toBeLessThan(productExpiry)
      const afterDeadline = deadline + 1
      expect(afterDeadline).toBeLessThan(productExpiry)
      harness.state.product = harness.fenceBody()
      let finalAuthorizationEntered = false
      harness.armAfterCancelAuthorization(async () => {
        finalAuthorizationEntered = true
        // Natural expiry alone changes: the canonical records and fence remain untouched.
        harness.state.clock = new Date(afterDeadline).toISOString()
      }, 'final')

      await expect(
        cancelOf(harness, dispatchId, 'native-guard:earlier-preparation-deadline')
      ).rejects.toThrow('PI_AUTHORITY_EXPIRED')
      expect(finalAuthorizationEntered).toBe(true)
      expectNoCancellationEffect(harness, receipt.handle.handleId)
    },
    { preparation: true }
  )
}, 60000)

test('native cancellation refuses an input queued after final authorization and retains that input', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const receipt = harness.receiptRecord(dispatchId)
    harness.state.product = harness.fenceBody()
    let queuedInputId
    harness.armAfterCancelAuthorization(async () => {
      queuedInputId = await harness.queueNativeInputForQualification({
        requestId: 'native-guard:queued-after-final-authorization',
        content: 'Retain this follow-up when the earlier cancellation snapshot is refused.',
      })
    }, 'final')

    await expect(
      cancelOf(harness, dispatchId, 'native-guard:queued-input-snapshot-changed')
    ).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
    expect(queuedInputId).toBeNumber()
    expect(await harness.nativeQueuedInputIdsForQualification()).toContain(queuedInputId)
    expectNoCancellationEffect(harness, receipt.handle.handleId)
  })
}, 60000)
