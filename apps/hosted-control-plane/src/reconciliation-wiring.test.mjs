import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { RetentionSweep } from '@control-plane/deployment'
import { HostedServerControlPlaneComposition } from './index.ts'

function fakeConnection() {
  return {
    database: {},
    check: async () => undefined,
    close: async () => undefined,
  }
}

const identityPublicKey = 'publickeyv1_w7YHemBctH5Ck2nQRQ47iBBqhNHy4FV7t2Usbye2A6f'
const dataDirectory = '/unused-hosted-reconciliation-test'

describe('hosted composition reconciliation wiring', () => {
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

  test('starts retention independently of reconciliation configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-hosted-retention-'))
    const starts = []
    const closes = []
    const originalStart = RetentionSweep.prototype.start
    const originalClose = RetentionSweep.prototype.close
    RetentionSweep.prototype.start = function () {
      starts.push(this)
      return originalStart.call(this)
    }
    RetentionSweep.prototype.close = function () {
      closes.push(this)
      return originalClose.call(this)
    }
    try {
      for (const reconciliation of [undefined, reconciliationOptions()]) {
        const composition = new HostedServerControlPlaneComposition({
          dataDirectory: directory,
          databaseUrl: 'postgresql://app:secret@postgres/control_plane',
          requestIdentityPublicKey: identityPublicKey,
          connection: fakeConnection(),
          workflowRuntime: {
            start: async () => undefined,
            stop: async () => undefined,
            health: async () => ({ ready: true, component: 'workflow', version: 'test' }),
          },
          endpointFactory: {
            create: async () => ({ run: async () => undefined, shutdown: async () => undefined }),
          },
          ...(reconciliation === undefined ? {} : { reconciliation }),
        })
        await composition.start()
        await composition.close()
      }
      expect(starts).toHaveLength(2)
      expect(closes).toHaveLength(2)
    } finally {
      RetentionSweep.prototype.start = originalStart
      RetentionSweep.prototype.close = originalClose
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('validates retention cadence without reconciliation configuration', () => {
    expect(
      () =>
        new HostedServerControlPlaneComposition({
          dataDirectory,
          databaseUrl: 'postgresql://app:secret@postgres/control_plane',
          requestIdentityPublicKey: identityPublicKey,
          connection: fakeConnection(),
          retentionSweepIntervalMs: 0,
        })
    ).toThrow('RETENTION_SWEEP_INVALID_INTERVAL')
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
