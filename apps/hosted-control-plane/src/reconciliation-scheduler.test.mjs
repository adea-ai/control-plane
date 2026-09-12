import { describe, expect, test } from 'bun:test'
import { HostedServerControlPlaneComposition } from './composition.ts'
import { ReconciliationScheduler } from './reconciliation-scheduler.ts'

const identityPublicKey = 'publickeyv1_w7YHemBctH5Ck2nQRQ47iBBqhNHy4FV7t2Usbye2A6f'

function fakeConnection() {
  return {
    database: {},
    check: async () => undefined,
    close: async () => undefined,
  }
}

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
  throw new Error(`HOSTED_SCHEDULER_TEST_TIMEOUT_${label}`)
}

describe('hosted reconciliation scheduler', () => {
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

  test('never overlaps passes and drains the in-flight pass on close', async () => {
    const calls = []
    let gate
    const service = {
      runBatch: async (input) => {
        calls.push(input)
        while (gate !== undefined) await gate.promise
        return { examined: 0, reconciled: 0, remediated: 0, manualIntervention: 0, waiting: 0 }
      },
    }
    const scheduler = new ReconciliationScheduler({
      service,
      intervalMs: 10,
      batchLimit: 6,
      onBatchError: () => undefined,
    })
    gate = deferred()
    scheduler.start()
    await waitFor(() => calls.length === 1, 'FIRST_PASS')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls).toEqual([{ limit: 6 }])
    const draining = scheduler.close()
    gate.resolve()
    gate = undefined
    await draining
    expect(() => scheduler.start()).toThrow('RECONCILIATION_SCHEDULER_CLOSED')
    expect(calls).toEqual([{ limit: 6 }])
  })

  test('a failed pass reports a fixed diagnostic and later passes still run', async () => {
    const errors = []
    let calls = 0
    let failing = true
    const scheduler = new ReconciliationScheduler({
      service: {
        runBatch: async () => {
          calls += 1
          if (failing) throw new Error('raw persistence failure')
          return { examined: 0, reconciled: 0, remediated: 0, manualIntervention: 0, waiting: 0 }
        },
      },
      intervalMs: 10,
      batchLimit: 4,
      onBatchError: () => errors.push('RECONCILIATION_BATCH_FAILED'),
    })
    try {
      scheduler.start()
      await waitFor(() => errors.length === 1, 'FIRST_FAILURE')
      failing = false
      await waitFor(() => calls === 2, 'RECOVERY_PASS')
    } finally {
      await scheduler.close()
    }
  })
})

describe('hosted composition reconciliation wiring', () => {
  const dataDirectory = '/unused-hosted-reconciliation-test'

  function reconciliationOptions() {
    return {
      source: {
        load: async () => {
          throw new Error('unused')
        },
        listCandidates: async () => [],
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

  test('schedules reconciliation only from explicit configuration', () => {
    const unconfigured = new HostedServerControlPlaneComposition({
      dataDirectory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
    })
    expect(unconfigured.reconciliationService).toBeUndefined()

    const configured = new HostedServerControlPlaneComposition({
      dataDirectory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
      reconciliation: reconciliationOptions(),
    })
    expect(configured.reconciliationService).toBeDefined()
  })

  test('fails closed on invalid reconciliation schedule bounds', () => {
    const base = {
      dataDirectory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
    }
    expect(
      () =>
        new HostedServerControlPlaneComposition({
          ...base,
          reconciliation: { ...reconciliationOptions(), intervalMs: 3_600_001 },
        })
    ).toThrow('Invalid reconciliation scheduler intervalMs')
    expect(
      () =>
        new HostedServerControlPlaneComposition({
          ...base,
          reconciliation: { ...reconciliationOptions(), batchLimit: 0 },
        })
    ).toThrow('Invalid reconciliation scheduler batchLimit')
    expect(
      () =>
        new HostedServerControlPlaneComposition({
          ...base,
          reconciliation: {
            ...reconciliationOptions(),
            rateLimit: { windowMs: 1_000, maximumPerWindow: 10_001 },
          },
        })
    ).toThrow('INVALID_RECONCILIATION_RATE_LIMIT')
  })

  test('injects the metric adapter into the composed command inbox', () => {
    const added = []
    const composition = new HostedServerControlPlaneComposition({
      dataDirectory,
      databaseUrl: 'postgresql://app:secret@postgres/control_plane',
      requestIdentityPublicKey: identityPublicKey,
      connection: fakeConnection(),
      metricAdapter: {
        add: (name, value, attributes) => added.push({ name, value, attributes }),
        record: () => undefined,
      },
      reconciliation: reconciliationOptions(),
    })
    expect(composition.executionAcceptanceService).toBeDefined()
    expect(composition.reconciliationService).toBeDefined()
    expect(added).toEqual([])
  })
})
