import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { fixture } from './adapter.fixture.mjs'

const at = '2026-10-08T00:00:00.000Z'

/**
 * Issue-level prep for control-plane#935 (M13.02): durable cancel intent,
 * generation-bound retry, exact approval-before-effect, retained effect
 * receipt and reconciliation after ambiguous success. Each test pins one
 * 935 acceptance behavior against the existing primitives (1031's
 * cancel-intent schema, generation fencing, and publication boundary).
 * RED here specifies the integration gap; GREEN locks the baseline the
 * integration must preserve. Target-bound execution observation
 * (session+task+generation+intent/attempt verified together) is specified
 * where receipt shapes must grow; no new scheduler, session registry,
 * durability engine, or credentials are introduced.
 */
test('935: cancel intent persists across restart and still reports pending', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-935-cancel-intent-'))
  const { options, request } = fixture(directory)
  const first = new PiDurableRuntimeAdapter(options)
  try {
    const handle = await first.start(request)
    const cancelled = await first.cancel(handle, {
      idempotencyKey: 'cancel:935-persist',
      requestedAt: at,
    })
    expect(cancelled.state).toBe('cancelling')
    const retained = first.journal.get(handle.handleId).detail.cancellationIntent
    expect(retained).toMatchObject({ schemaVersion: 'pi-cancellation-intent/v1' })

    // Separate lifetime on the same directory, like a restarted worker.
    const second = new PiDurableRuntimeAdapter(options)
    try {
      const recovered = second.journal.get(handle.handleId)
      expect(recovered.state).toBe('cancelling')
      expect(recovered.detail.cancellationIntent).toEqual(retained)
      const status = await second.status(handle)
      expect(status.state).toBe('cancelling')
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
    rmSync(directory, { force: true, recursive: true })
  }
})

test('935: cancelling one attempt never disturbs a sibling attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-935-attempt-fence-'))
  const siblingAttemptId = 'att_01JABCDEF0123456789ABCDEFH'
  const { options, request } = fixture(directory)
  const adapter = new PiDurableRuntimeAdapter(options)
  try {
    const first = await adapter.start(request)
    const second = await adapter.start({
      ...request,
      attemptId: siblingAttemptId,
      idempotencyKey: 'message:two',
      attemptBudget: {
        ...request.attemptBudget,
        attemptId: siblingAttemptId,
        reservationKey: `runtime-attempt:${siblingAttemptId}`,
      },
    })
    await adapter.cancel(first, { idempotencyKey: 'cancel:935-first', requestedAt: at })
    expect(adapter.journal.get(first.handleId).state).toBe('cancelling')
    expect(adapter.journal.get(second.handleId).state).not.toBe('cancelling')
    expect(adapter.journal.get(second.handleId).detail.cancellationIntent).toBeUndefined()
  } finally {
    await adapter.close()
    rmSync(directory, { force: true, recursive: true })
  }
})

test('935: status receipt carries execution identity; target binding is specified, not present', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-935-receipt-'))
  const { options, request } = fixture(directory)
  const adapter = new PiDurableRuntimeAdapter(options)
  try {
    const handle = await adapter.start(request)
    const status = await adapter.status(handle)
    expect(status.handle.attemptId).toBe(request.attemptId)
    expect(status.state).toBe('starting')
    // 935 target-bound observation (session+task+observedGeneration+owning
    // intent/attempt, verified together) has no field yet: the receipt
    // intentionally carries no target today, and nothing here may read
    // execution location as target authority. This documents the exact
    // gap the integration closes.
    expect(status).not.toHaveProperty('target')
    expect(status).not.toHaveProperty('handoffTarget')
  } finally {
    await adapter.close()
    rmSync(directory, { force: true, recursive: true })
  }
})
