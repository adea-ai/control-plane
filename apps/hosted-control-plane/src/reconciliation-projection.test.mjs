import { describe, expect, test } from 'bun:test'
import { ExecutionReconciliationService } from '@control-plane/domain'
import {
  PostgresReconciliationEffects,
  PostgresReconciliationSource,
} from '@control-plane/database'
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

function composition(options = {}) {
  return new HostedServerControlPlaneComposition({
    dataDirectory: 'unused',
    databaseUrl:
      'postgresql://control_plane_app:local-application-only@127.0.0.1:54329/control_plane',
    connection: fakeConnection(),
    requestIdentityPublicKey: identityPublicKey,
    workflowRuntime: {
      start: async () => undefined,
      stop: async () => undefined,
      health: async () => ({ ready: true, component: 'test', version: '1' }),
    },
    ...options,
  })
}

describe('hosted reconciliation projection composition', () => {
  test('projection configuration composes the production source and effects', () => {
    const hosted = composition({
      reconciliation: { projection: 'observation', intervalMs: 1_000, batchLimit: 10 },
    })
    expect(hosted.reconciliationService).toBeInstanceOf(ExecutionReconciliationService)
    expect(hosted.reconciliationSource).toBeInstanceOf(PostgresReconciliationSource)
    expect(hosted.reconciliationEffects).toBeInstanceOf(PostgresReconciliationEffects)
  })

  test('explicit source and effects injection still wins the explicit path', () => {
    const source = { load: async () => undefined, listCandidates: async () => [] }
    const effects = {
      markReconciliationRequired: async () => undefined,
      resumeWorkflow: async () => undefined,
      applyRuntimeTerminal: async () => undefined,
      replayEvents: async () => undefined,
    }
    const hosted = composition({
      reconciliation: { source, effects, intervalMs: 1_000, batchLimit: 10 },
    })
    expect(hosted.reconciliationService).toBeInstanceOf(ExecutionReconciliationService)
    expect(hosted.reconciliationSource).toBe(source)
    expect(hosted.reconciliationEffects).toBe(effects)
  })

  test('the projection and explicit adapters are mutually exclusive', () => {
    expect(() =>
      composition({
        reconciliation: {
          projection: 'observation',
          source: { load: async () => undefined, listCandidates: async () => [] },
          intervalMs: 1_000,
          batchLimit: 10,
        },
      })
    ).toThrow('HOSTED_RECONCILIATION_CONFIGURATION_CONFLICT')
  })

  test('an incomplete configuration fails closed', () => {
    expect(() => composition({ reconciliation: { intervalMs: 1_000, batchLimit: 10 } })).toThrow(
      'HOSTED_RECONCILIATION_CONFIGURATION_INVALID'
    )
    expect(() =>
      composition({
        reconciliation: {
          source: { load: async () => undefined, listCandidates: async () => [] },
          intervalMs: 1_000,
          batchLimit: 10,
        },
      })
    ).toThrow('HOSTED_RECONCILIATION_CONFIGURATION_INVALID')
  })

  test('absent reconciliation configuration enables nothing', () => {
    expect(composition().reconciliationService).toBeUndefined()
  })

  test('scheduler construction bounds remain validated before start', () => {
    expect(
      () =>
        new ReconciliationScheduler({
          service: { runBatch: async () => undefined },
          intervalMs: 0,
          batchLimit: 10,
        })
    ).toThrow('Invalid reconciliation scheduler intervalMs')
  })
})
