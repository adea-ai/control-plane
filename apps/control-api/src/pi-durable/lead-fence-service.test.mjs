import { test, expect } from 'bun:test'
import {
  intentId,
  outsiderPrincipal,
  principal,
  secondAllowedPrincipal,
  waitUntil,
  withLiveHarness,
} from './lead-fence-live-harness.mjs'

async function expectRefused(promise, code) {
  await expect(promise).rejects.toThrow(code)
}

// M18.01.3 live service path. A run is admitted through the production lead composition and its
// model turn is genuinely held open. Adea then publishes a v2 fence, and every observation and
// cancellation goes through DurablePiDurableLeadService against that in-flight run.

const cancelled = (harness, dispatchId, key) =>
  harness.composition.service.cancel(
    harness.envelope('pi-durable.lead.cancel', { dispatchId }, key),
    principal
  )

test('a fence set on an in-flight model turn serves status and progress and cancels as the original actor, aborting that turn with no second start, inference, or reservation', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId, record } = await harness.admitInFlightRun()
    const composition = harness.composition
    expect(record.state).toBe('running')
    expect(harness.state.streamsAborted).toBe(0)
    const before = {
      starts: harness.state.starts,
      inferences: harness.state.requests.length,
      reservations: harness.state.budgetReserves,
    }
    harness.state.product = harness.fenceBody()

    const status = await composition.service.status(
      harness.read('pi-durable.lead.status', { dispatchId }),
      principal
    )
    expect(status.data).toMatchObject({ dispatchId, state: 'running' })

    const progress = await composition.service.progress(
      harness.read('pi-durable.lead.progress', { dispatchId }),
      principal
    )
    expect(progress.data).toMatchObject({ dispatchId, events: expect.any(Array) })

    const response = await cancelled(harness, dispatchId, 'live-fence:cancel-in-flight')
    expect(['cancelling', 'cancelled']).toContain(response.data.state)
    // The cancellation reached the held model turn: the client aborted that response stream.
    await waitUntil(() => harness.state.streamsAborted >= 1, 'in-flight turn aborted')
    expect(harness.state.streamsAborted).toBe(1)

    expect(harness.state.starts).toBe(before.starts)
    expect(harness.state.requests.length).toBe(before.inferences)
    expect(harness.state.budgetReserves).toBe(before.reservations)
    expect(harness.state.productReads).toBeGreaterThan(0)
  })
}, 60000)

test('under a fence, changed pins refuse observation and cancellation before any effect on the in-flight turn', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const composition = harness.composition
    const starts = harness.state.starts
    const changes = [
      ['authority revision', { authorityRevision: 8 }],
      ['scope', { scopeRef: `adea-product:sha256:${'e'.repeat(64)}` }],
      ['allowed principals', { allowedPrincipalIds: ['svc_adea'] }],
      [
        'canonical actor',
        {
          canonicalActorPrincipalId: `user:${'9'.repeat(8)}-${'9'.repeat(4)}-4${'9'.repeat(3)}-8${'9'.repeat(3)}-${'9'.repeat(12)}`,
        },
      ],
    ]
    for (const [label, change] of changes) {
      harness.state.product = harness.fenceBody(change)
      await expectRefused(
        composition.service.status(
          harness.read('pi-durable.lead.status', { dispatchId }),
          principal
        ),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
      await expectRefused(
        cancelled(harness, dispatchId, `live-fence:cancel:${label.replaceAll(' ', '-')}`),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
    }
    expect(harness.state.starts).toBe(starts)
    expect(harness.state.streamsAborted).toBe(0)
    const [record] = composition.adapter.journal.list()
    expect(record.state).toBe('running')
    harness.state.product = harness.fenceBody()
    const restored = await composition.service.status(
      harness.read('pi-durable.lead.status', { dispatchId }),
      principal
    )
    expect(restored.data.state).toBe('running')
  })
}, 60000)

test('under a fence, a principal outside the allowlist is refused, and a second allowed principal observes but cannot cancel', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const composition = harness.composition
    harness.state.product = harness.fenceBody()

    await expectRefused(
      composition.service.status(
        harness.read('pi-durable.lead.status', { dispatchId }, outsiderPrincipal),
        outsiderPrincipal
      ),
      'PI_LEAD_SCOPE_REJECTED'
    )
    await expectRefused(
      composition.service.cancel(
        harness.envelope(
          'pi-durable.lead.cancel',
          { dispatchId },
          'live-fence:outsider',
          outsiderPrincipal
        ),
        outsiderPrincipal
      ),
      'PI_LEAD_SCOPE_REJECTED'
    )

    const observed = await composition.service.status(
      harness.read('pi-durable.lead.status', { dispatchId }, secondAllowedPrincipal),
      secondAllowedPrincipal
    )
    expect(observed.data.state).toBe('running')
    await expectRefused(
      composition.service.cancel(
        harness.envelope(
          'pi-durable.lead.cancel',
          { dispatchId },
          'live-fence:second',
          secondAllowedPrincipal
        ),
        secondAllowedPrincipal
      ),
      'PI_LEAD_SCOPE_REJECTED'
    )
    expect(harness.state.streamsAborted).toBe(0)
    expect(composition.adapter.journal.list()[0].state).toBe('running')
  })
}, 60000)

test('under a fence, prepare on a fresh intent is refused by the authority before any funding read or marker', async () => {
  await withLiveHarness(
    async (harness) => {
      // The preparation port is configured, so the refusal below is the fence's, not an absent port.
      harness.state.product = harness.fenceBody()
      await harness.open()
      const composition = harness.composition
      const before = harness.leadTableCounts()
      await expectRefused(
        composition.service.prepare(
          harness.envelope('pi-durable.lead.prepare', { intentId }, 'live-fence:fresh-prepare'),
          principal
        ),
        'PI_LEAD_UNAVAILABLE'
      )
      expect(harness.state.fundingReads).toBe(0)
      expect(harness.state.budgetReserves).toBe(0)
      const after = harness.leadTableCounts()
      // No marker, receipt, or intent is written; only the command's idempotency binding is.
      expect(after.intents).toBe(before.intents)
      expect(after.receipts).toBe(before.receipts)
      expect(after.commands - before.commands).toBe(1)
    },
    { preparation: true }
  )
}, 60000)

test('the configured preparation path funds one run, and under a fence prepare and dispatch are refused with no funding read or second start', async () => {
  await withLiveHarness(
    async (harness) => {
      // admitInFlightRun prepares through the configured port (unfenced), then dispatches that
      // preparation; the model turn it starts is held open.
      const { dispatchId, preparationRef } = await harness.admitInFlightRun()
      const composition = harness.composition
      // Funding is read by the configured path while the unfenced run is admitted.
      const reads = harness.state.fundingReads
      expect(reads).toBeGreaterThanOrEqual(1)
      const starts = harness.state.starts
      const inferences = harness.state.requests.length
      harness.state.product = harness.fenceBody()
      await expectRefused(
        composition.service.prepare(
          harness.envelope('pi-durable.lead.prepare', { intentId }, 'live-fence:fenced-prepare'),
          principal
        ),
        'PI_LEAD_UNAVAILABLE'
      )
      expect(harness.state.fundingReads).toBe(reads)
      // Without a preparation the configured dispatch refuses before the authority, starting nothing.
      await expectRefused(
        composition.service.dispatch(
          harness.envelope(
            'pi-durable.lead.dispatch',
            { intentId },
            'live-fence:unprepared-dispatch'
          ),
          principal
        ),
        'PI_LEAD_PREPARATION_REQUIRED'
      )
      // With the prepared reference, the fence refuses the dispatch in the authority.
      await expectRefused(
        composition.service.dispatch(
          harness.envelope(
            'pi-durable.lead.dispatch',
            { intentId, preparationRef },
            'live-fence:fenced-dispatch'
          ),
          principal
        ),
        'PI_LEAD_UNAVAILABLE'
      )
      expect(harness.state.starts).toBe(starts)
      expect(harness.state.requests.length).toBe(inferences)
      expect(harness.state.streamsAborted).toBe(0)
      expect(composition.adapter.journal.list()[0].state).toBe('running')
      expect(dispatchId).toMatch(/^dispatch_[a-f0-9]{32}$/)
    },
    { preparation: true }
  )
}, 60000)

test('a retained receipt that no longer matches its admission, request, or handle is refused before any effect', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const composition = harness.composition
    harness.state.product = harness.fenceBody()
    const original = harness.receiptRecord(dispatchId)
    const other = `sha256:${'d'.repeat(64)}`
    const tampers = [
      { admissionDigest: other },
      { startDigest: other },
      { deadlineAt: '2026-10-08T09:30:00.000Z' },
      { allowedPrincipalIds: ['svc_adea'] },
      { handle: { ...original.handle, externalSessionId: 'ses_01JABCDEF0123456789ABCDEFX' } },
    ]
    const starts = harness.state.starts
    for (const change of tampers) {
      harness.writeReceiptRecord(dispatchId, { ...original, ...change })
      await expectRefused(
        composition.service.status(
          harness.read('pi-durable.lead.status', { dispatchId }),
          principal
        ),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
    }
    expect(harness.state.starts).toBe(starts)
    harness.writeReceiptRecord(dispatchId, original)
    const restored = await composition.service.status(
      harness.read('pi-durable.lead.status', { dispatchId }),
      principal
    )
    expect(restored.data.state).toBe('running')
  })
}, 60000)

test('the fence is rechecked after each awaited effect, and a changed fence withholds the response', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const composition = harness.composition
    harness.state.product = harness.fenceBody()
    const adapter = composition.adapter
    const realStatus = adapter.status.bind(adapter)
    adapter.status = async (handle) => {
      const result = await realStatus(handle)
      // The fence changes while the status effect was awaited.
      harness.state.product = harness.fenceBody({ authorityRevision: 9 })
      return result
    }
    try {
      await expectRefused(
        composition.service.status(
          harness.read('pi-durable.lead.status', { dispatchId }),
          principal
        ),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
    } finally {
      adapter.status = realStatus
    }

    harness.state.product = harness.fenceBody()
    const realCancelFenced = adapter.cancelFenced.bind(adapter)
    adapter.cancelFenced = async (handle, input, authorize) => {
      const result = await realCancelFenced(handle, input, authorize)
      harness.state.product = harness.fenceBody({
        scopeRef: `adea-product:sha256:${'f'.repeat(64)}`,
      })
      return result
    }
    try {
      await expectRefused(
        cancelled(harness, dispatchId, 'live-fence:recheck'),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
    } finally {
      adapter.cancelFenced = realCancelFenced
    }
  })
}, 60000)
