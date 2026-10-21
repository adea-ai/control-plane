import { test, expect } from 'bun:test'
import {
  deferred,
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

test('a receipt revision and handle change during the final fenced authority read is refused before observation', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const composition = harness.composition
    harness.state.product = harness.fenceBody()
    const original = harness.receiptRecord(dispatchId)
    const realAssertFencedBinding = composition.admission.assertFencedBinding.bind(
      composition.admission
    )
    let authorityReads = 0
    composition.admission.assertFencedBinding = async (input) => {
      await realAssertFencedBinding(input)
      authorityReads += 1
      if (authorityReads === 2) {
        harness.writeReceiptRecord(dispatchId, {
          ...original,
          revision: original.revision + 1,
          handle: {
            ...original.handle,
            externalSessionId: 'ses_01JABCDEF0123456789ABCDEFX',
          },
        })
      }
    }
    let statusReads = 0
    const realStatus = composition.adapter.status.bind(composition.adapter)
    composition.adapter.status = async (handle) => {
      statusReads += 1
      return realStatus(handle)
    }

    await expectRefused(
      composition.service.status(harness.read('pi-durable.lead.status', { dispatchId }), principal),
      'PI_LEAD_AUTHORITY_CONFLICT'
    )
    expect(authorityReads).toBe(2)
    expect(statusReads).toBe(0)
    expect(harness.receiptRecord(dispatchId)).toMatchObject({
      revision: original.revision + 1,
      handle: { ...original.handle, externalSessionId: 'ses_01JABCDEF0123456789ABCDEFX' },
    })
    expect(composition.adapter.journal.list()[0].state).toBe('running')
  })
}, 60000)

test('a receipt revision change during cancellation withholds the response and retains the committed intent', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const composition = harness.composition
    harness.state.product = harness.fenceBody()
    const original = harness.receiptRecord(dispatchId)
    const adapter = composition.adapter
    const realCancelFenced = adapter.cancelFenced.bind(adapter)
    let cancelCalls = 0
    adapter.cancelFenced = async (...args) => {
      cancelCalls += 1
      const result = await realCancelFenced(...args)
      harness.writeReceiptRecord(dispatchId, { ...original, revision: original.revision + 1 })
      return result
    }

    try {
      await expectRefused(
        cancelled(harness, dispatchId, 'live-fence:receipt-revision-during-cancel'),
        'PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN'
      )
    } finally {
      adapter.cancelFenced = realCancelFenced
    }

    const retained = adapter.journal.get(original.handle.handleId)
    expect(cancelCalls).toBe(1)
    expect(retained.detail.cancellationIntent).toBeDefined()
    expect(['cancelling', 'unknown']).toContain(retained.state)
    expect(harness.receiptRecord(dispatchId).revision).toBe(original.revision + 1)
    await waitUntil(() => harness.state.streamsAborted === 1, 'receipt-race abort delivered')
    expect(harness.state.streamsAborted).toBe(1)
    expect(harness.state.starts).toBe(1)
    expect(harness.state.requests).toHaveLength(1)
  })
}, 60000)

test('a fenced lookup refuses an existing receipt before runtime-handle recovery or adapter effects', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const composition = harness.composition
    harness.state.product = harness.fenceBody()
    let handleLookups = 0
    let statusCalls = 0
    const oldFindHandle = composition.service.options.findRuntimeHandle
    const oldStatus = composition.adapter.status.bind(composition.adapter)
    composition.service.options.findRuntimeHandle = async (...args) => {
      handleLookups += 1
      return oldFindHandle(...args)
    }
    composition.adapter.status = async (...args) => {
      statusCalls += 1
      return oldStatus(...args)
    }
    const before = harness.leadTableCounts()
    const starts = harness.state.starts
    const inferences = harness.state.requests.length

    try {
      await expectRefused(
        composition.service.lookup(harness.read('pi-durable.lead.lookup', { intentId }), principal),
        'PI_LEAD_UNAVAILABLE'
      )
    } finally {
      composition.service.options.findRuntimeHandle = oldFindHandle
      composition.adapter.status = oldStatus
    }

    expect(handleLookups).toBe(0)
    expect(statusCalls).toBe(0)
    expect(harness.leadTableCounts()).toEqual(before)
    expect(harness.state.starts).toBe(starts)
    expect(harness.state.requests.length).toBe(inferences)
    expect(
      composition.adapter.journal.get(harness.receiptRecord(dispatchId).handle.handleId).state
    ).toBe('running')
  })
}, 60000)

test('fenced cancellation forwards the transport idempotency key and issue time unchanged', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    harness.state.product = harness.fenceBody()
    const adapter = harness.composition.adapter
    const realCancelFenced = adapter.cancelFenced.bind(adapter)
    const forwarded = []
    adapter.cancelFenced = async (handle, input, authorize) => {
      forwarded.push(structuredClone(input))
      return realCancelFenced(handle, input, authorize)
    }

    try {
      await cancelled(harness, dispatchId, 'live-fence:exact-cancel-command')
    } finally {
      adapter.cancelFenced = realCancelFenced
    }

    expect(forwarded).toEqual([
      {
        idempotencyKey: 'live-fence:exact-cancel-command',
        requestedAt: '2026-10-08T09:00:00.000Z',
      },
    ])
    await waitUntil(() => harness.state.streamsAborted === 1, 'exact-command abort delivered')
    expect(harness.state.streamsAborted).toBe(1)
  })
}, 60000)

test('a fenced adapter response with a different handle is rejected', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    harness.state.product = harness.fenceBody()
    const adapter = harness.composition.adapter
    const realStatus = adapter.status.bind(adapter)
    let statusCalls = 0
    adapter.status = async (handle) => {
      statusCalls += 1
      const status = await realStatus(handle)
      return {
        ...status,
        handle: { ...status.handle, externalSessionId: 'ses_01JABCDEF0123456789ABCDEFX' },
      }
    }

    try {
      await expectRefused(
        harness.composition.service.status(
          harness.read('pi-durable.lead.status', { dispatchId }),
          principal
        ),
        'PI_LEAD_AUTHORITY_CONFLICT'
      )
    } finally {
      adapter.status = realStatus
    }

    expect(statusCalls).toBe(1)
    expect(adapter.journal.list()[0].state).toBe('running')
  })
}, 60000)

test('a fenced receipt with a different execution or attempt is refused before observation', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const composition = harness.composition
    harness.state.product = harness.fenceBody()
    const original = harness.receiptRecord(dispatchId)
    const realStatus = composition.adapter.status.bind(composition.adapter)
    let statusCalls = 0
    composition.adapter.status = async (...args) => {
      statusCalls += 1
      return realStatus(...args)
    }

    try {
      for (const change of [
        { executionId: 'exe_01JABCDEF0123456789ABCDEFH' },
        { attemptId: 'att_01JABCDEF0123456789ABCDEFH' },
      ]) {
        harness.writeReceiptRecord(dispatchId, { ...original, ...change })
        await expectRefused(
          composition.service.status(
            harness.read('pi-durable.lead.status', { dispatchId }),
            principal
          ),
          'PI_LEAD_AUTHORITY_CONFLICT'
        )
      }
    } finally {
      composition.adapter.status = realStatus
      harness.writeReceiptRecord(dispatchId, original)
    }

    expect(statusCalls).toBe(0)
    expect(composition.adapter.journal.list()[0].state).toBe('running')
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
    const cancelReachedResponseCheck = deferred()
    const releaseResponseCheck = deferred()
    let journalAtResponseCheck
    adapter.cancelFenced = async (handle, input, authorize) => {
      const result = await realCancelFenced(handle, input, authorize)
      journalAtResponseCheck = adapter.journal.get(handle.handleId)
      cancelReachedResponseCheck.resolve()
      await releaseResponseCheck.promise
      return result
    }
    const cancelPromise = cancelled(harness, dispatchId, 'live-fence:recheck')
    try {
      await cancelReachedResponseCheck.promise
      expect(harness.state.requests).toHaveLength(1)
      expect(['cancelling', 'unknown']).toContain(journalAtResponseCheck.state)
      expect(journalAtResponseCheck.detail.cancellationIntent).toBeDefined()

      // The adapter has committed the intent and delivered the abort request, but the lead
      // service is still parked before its response authorization check.
      harness.state.product = harness.fenceBody({ authorityRevision: 9 })
      releaseResponseCheck.resolve()

      await expectRefused(cancelPromise, 'PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN')
      const retained = adapter.journal.get(journalAtResponseCheck.handleId)
      expect(retained.detail.cancellationIntent).toEqual(
        journalAtResponseCheck.detail.cancellationIntent
      )
      expect(['cancelling', 'unknown']).toContain(retained.state)
      expect(harness.state.requests).toHaveLength(1)
      expect(harness.state.starts).toBe(1)
      expect(harness.state.reconcileCalls).toBe(0)
    } finally {
      releaseResponseCheck.resolve()
      adapter.cancelFenced = realCancelFenced
    }
  })
}, 60000)

test('ordinary cancellation reports an unknown outcome when authority changes after its abort returns', async () => {
  await withLiveHarness(async (harness) => {
    const { dispatchId } = await harness.admitInFlightRun()
    const adapter = harness.composition.adapter
    const realCancel = adapter.cancel.bind(adapter)
    const cancelReachedResponseCheck = deferred()
    const releaseResponseCheck = deferred()
    let journalAtResponseCheck
    adapter.cancel = async (handle, command) => {
      const result = await realCancel(handle, command)
      journalAtResponseCheck = adapter.journal.get(handle.handleId)
      cancelReachedResponseCheck.resolve()
      await releaseResponseCheck.promise
      return result
    }

    const cancelPromise = cancelled(harness, dispatchId, 'live-fence:ordinary-cancel-recheck')
    let cancelResult
    const responseOutcome = cancelPromise.then(
      (value) => ({ kind: 'resolved', value }),
      (error) => {
        cancelResult = error
        return { kind: 'rejected', error }
      }
    )
    try {
      const adapterReturned = await Promise.race([
        cancelReachedResponseCheck.promise.then(() => true),
        responseOutcome.then(() => false),
      ])
      if (!adapterReturned)
        throw new Error(`ORDINARY_CANCEL_FAILED_BEFORE_ADAPTER_RETURN:${cancelResult?.code}`)
      await waitUntil(() => harness.state.streamsAborted === 1, 'ordinary abort delivered')
      expect(harness.state.streamsAborted).toBe(1)
      expect(journalAtResponseCheck.detail.cancellationIntent).toBeDefined()
      expect(['cancelling', 'unknown']).toContain(journalAtResponseCheck.state)

      // The ordinary adapter has committed its intent and delivered one abort. Revoke the
      // product binding before the service's final response authorization check.
      harness.state.product = harness.fenceBody({ authorityRevision: 9 })
      releaseResponseCheck.resolve()

      const result = await responseOutcome
      expect(result.kind).toBe('rejected')
      expect(cancelResult.code).toBe('PI_LEAD_CANCELLATION_OUTCOME_UNKNOWN')
      const retained = adapter.journal.get(journalAtResponseCheck.handleId)
      expect(retained.detail.cancellationIntent).toEqual(
        journalAtResponseCheck.detail.cancellationIntent
      )
      expect(['cancelling', 'unknown']).toContain(retained.state)
      expect(harness.state.streamsAborted).toBe(1)
      expect(harness.state.starts).toBe(1)
      expect(harness.state.requests).toHaveLength(1)
      expect(harness.state.reconcileCalls).toBe(0)
      harness.state.gate.resolve()
      await adapter.drain()
    } finally {
      releaseResponseCheck.resolve()
      harness.state.gate.resolve()
      await adapter.drain()
      adapter.cancel = realCancel
    }
  })
}, 60000)
