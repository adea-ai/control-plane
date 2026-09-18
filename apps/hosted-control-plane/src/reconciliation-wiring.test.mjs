import { describe, expect, test } from 'bun:test'
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
