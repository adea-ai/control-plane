import { describe, expect, test } from 'bun:test'
import { ReconciliationScheduler } from './index.ts'

function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

async function waitFor(predicate, label) {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`LOCAL_SCHEDULER_TEST_TIMEOUT_${label}`)
}

function recordingService() {
  const calls = []
  let gate
  const service = {
    runBatch: async (input) => {
      calls.push(input)
      while (gate !== undefined) await gate.promise
      return { examined: 0, reconciled: 0, remediated: 0, manualIntervention: 0, waiting: 0 }
    },
    hold() {
      gate = deferred()
    },
    release() {
      gate?.resolve()
      gate = undefined
    },
    calls,
  }
  return service
}

describe('reconciliation scheduler', () => {
  test('fails closed on invalid scheduler bounds', () => {
    const service = { runBatch: async () => undefined }
    for (const intervalMs of [0, -1, 1.5, Number.NaN, 3_600_001]) {
      expect(() => new ReconciliationScheduler({ service, intervalMs, batchLimit: 10 })).toThrow(
        'Invalid reconciliation scheduler intervalMs'
      )
    }
    for (const batchLimit of [0, -1, 2.5, 1_001]) {
      expect(() => new ReconciliationScheduler({ service, intervalMs: 1_000, batchLimit })).toThrow(
        'Invalid reconciliation scheduler batchLimit'
      )
    }
  })

  test('never overlaps passes and reschedules only after a pass settles', async () => {
    const service = recordingService()
    const scheduler = new ReconciliationScheduler({
      service,
      intervalMs: 10,
      batchLimit: 7,
      onBatchError: () => undefined,
    })
    try {
      service.hold()
      scheduler.start()
      await waitFor(() => service.calls.length === 1, 'FIRST_PASS')
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(service.calls).toEqual([{ limit: 7 }])
      service.release()
      await waitFor(() => service.calls.length === 2, 'SECOND_PASS')
      expect(service.calls.every((call) => call.limit === 7)).toBe(true)
    } finally {
      await scheduler.close()
      service.release()
    }
  })

  test('drains the in-flight pass and refuses restart after close', async () => {
    const service = recordingService()
    const scheduler = new ReconciliationScheduler({
      service,
      intervalMs: 10,
      batchLimit: 5,
      onBatchError: () => undefined,
    })
    service.hold()
    scheduler.start()
    await waitFor(() => service.calls.length === 1, 'IN_FLIGHT_PASS')
    const draining = scheduler.close()
    await new Promise((resolve) => setTimeout(resolve, 25))
    let drained = false
    void draining.then(() => {
      drained = true
    })
    service.release()
    await draining
    expect(drained).toBe(true)
    expect(() => scheduler.start()).toThrow('RECONCILIATION_SCHEDULER_CLOSED')
    expect(service.calls).toEqual([{ limit: 5 }])
  })

  test('close before the first tick runs no pass', async () => {
    const service = recordingService()
    const scheduler = new ReconciliationScheduler({
      service,
      intervalMs: 5,
      batchLimit: 3,
      onBatchError: () => undefined,
    })
    scheduler.start()
    await scheduler.close()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(service.calls).toEqual([])
  })

  test('a failed pass reports a fixed diagnostic and later passes still run', async () => {
    const service = recordingService()
    const errors = []
    let failing = true
    const flaky = {
      runBatch: async (input) => {
        if (failing) throw new Error('raw persistence failure')
        return service.runBatch(input)
      },
    }
    const scheduler = new ReconciliationScheduler({
      service: flaky,
      intervalMs: 10,
      batchLimit: 4,
      onBatchError: () => errors.push('RECONCILIATION_BATCH_FAILED'),
    })
    try {
      scheduler.start()
      await waitFor(() => errors.length === 1, 'FIRST_FAILURE')
      failing = false
      await waitFor(() => service.calls.length === 1, 'RECOVERY_PASS')
    } finally {
      await scheduler.close()
    }
  })
})
