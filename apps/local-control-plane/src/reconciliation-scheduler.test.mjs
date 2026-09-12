import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { LocalControlPlaneComposition } from './composition.ts'
import { ReconciliationScheduler } from './reconciliation-scheduler.ts'

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

describe('local composition reconciliation wiring', () => {
  const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAA'
  const checkedAt = '2026-08-24T15:00:00.000Z'

  function reconciliationOptions() {
    return {
      source: {
        load: async (id) => ({
          executionId: id,
          checkedAt,
          command: { status: 'accepted', commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
          execution: { state: 'accepted', updatedAt: '2026-08-24T14:00:00.000Z' },
          attempt: undefined,
          workflow: { status: 'missing' },
          runtime: { status: 'unknown', observedAt: checkedAt },
          delivery: { pendingCount: 0 },
        }),
        listCandidates: async () => [executionId],
      },
      effects: {
        markReconciliationRequired: async () => undefined,
        resumeWorkflow: async () => undefined,
        applyRuntimeTerminal: async () => undefined,
        replayEvents: async () => undefined,
      },
      intervalMs: 1_000,
      batchLimit: 10,
    }
  }

  function fakeLifecycle() {
    return {
      runtimeTransport: {
        transportKind: 'direct-local',
        open: async () => undefined,
        close: async () => undefined,
      },
      workflowRuntime: {
        profile: 'local',
        start: async () => undefined,
        stop: async () => undefined,
      },
      endpointFactory: {
        create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
      },
    }
  }

  test('schedules reconciliation only from explicit configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-reconciliation-'))
    try {
      const unconfigured = new LocalControlPlaneComposition({ dataDirectory: directory })
      expect(unconfigured.reconciliationService).toBeUndefined()
      await unconfigured.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }

    const configuredDirectory = await mkdtemp(join(tmpdir(), 'local-reconciliation-'))
    try {
      const configured = new LocalControlPlaneComposition({
        dataDirectory: configuredDirectory,
        reconciliation: reconciliationOptions(),
      })
      expect(configured.reconciliationService).toBeDefined()
      await configured.close()
    } finally {
      await rm(configuredDirectory, { recursive: true, force: true })
    }
  })

  test('fails closed on invalid reconciliation schedule bounds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-reconciliation-invalid-'))
    try {
      expect(
        () =>
          new LocalControlPlaneComposition({
            dataDirectory: directory,
            reconciliation: { ...reconciliationOptions(), intervalMs: 0 },
          })
      ).toThrow('Invalid reconciliation scheduler intervalMs')
      expect(
        () =>
          new LocalControlPlaneComposition({
            dataDirectory: directory,
            reconciliation: { ...reconciliationOptions(), batchLimit: 1_001 },
          })
      ).toThrow('Invalid reconciliation scheduler batchLimit')
      expect(
        () =>
          new LocalControlPlaneComposition({
            dataDirectory: directory,
            reconciliation: {
              ...reconciliationOptions(),
              rateLimit: { windowMs: 0, maximumPerWindow: 5 },
            },
          })
      ).toThrow('INVALID_RECONCILIATION_RATE_LIMIT')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('starts and drains the scheduler around the composition lifecycle and emits metrics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-reconciliation-lifecycle-'))
    const added = []
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      metricAdapter: {
        add: (name, value, attributes) => added.push({ name, value, attributes }),
        record: () => undefined,
      },
      reconciliation: { ...reconciliationOptions(), intervalMs: 10 },
      ...fakeLifecycle(),
    })
    try {
      const batchCalls = []
      const originalRunBatch = composition.reconciliationService.runBatch.bind(
        composition.reconciliationService
      )
      composition.reconciliationService.runBatch = async (input) => {
        batchCalls.push(input)
        return originalRunBatch(input)
      }

      await composition.start()
      await waitFor(async () => batchCalls.length === 1 || undefined, 'SCHEDULED_PASS')
      await composition.close()
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(batchCalls.length).toBe(1)

      // Metrics flow through the consistency emitter with cataloged names and bounded labels.
      expect(added.filter(({ name }) => name === 'execution.reconciliation.count')).toHaveLength(1)
      expect(added.at(-1)).toEqual({
        name: 'execution.reconciliation.count',
        value: 1,
        attributes: {
          'service.name': 'local-control-plane',
          reason: 'accepted_unstarted',
          outcome: 'created',
        },
      })
    } finally {
      await composition.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
