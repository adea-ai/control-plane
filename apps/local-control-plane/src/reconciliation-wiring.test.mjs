import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { LocalControlPlaneComposition } from './index.ts'

async function waitFor(predicate, label) {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`WIRING_TEST_TIMEOUT_${label}`)
}

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
