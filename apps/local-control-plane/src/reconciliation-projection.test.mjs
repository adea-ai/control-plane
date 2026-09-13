import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  ExecutionReconciliationService,
} from '@control-plane/domain'
import {
  SqliteReconciliationEffects,
  SqliteReconciliationSource,
} from '@control-plane/sqlite-persistence'
import { LocalControlPlaneComposition } from './composition.ts'

const correlation = {
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}
const executionPlan = {
  executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  contentDigest: `sha256:${'7'.repeat(64)}`,
  schemaVersion: 1,
}
const now = '2026-09-01T12:00:00.000Z'
const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'

const fakeWorkflowRuntime = {
  start: async () => undefined,
  stop: async () => undefined,
  health: async () => ({ ready: true, component: 'test', version: '1' }),
}

const providers = []
const directories = []

afterAll(async () => {
  for (const provider of providers) provider.close({ checkpoint: true })
  for (const directory of directories) await rm(directory, { recursive: true, force: true })
})

async function composed(reconciliation) {
  const directory = await mkdtemp(join(tmpdir(), 'local-reconciliation-'))
  directories.push(directory)
  const composition = new LocalControlPlaneComposition({
    dataDirectory: directory,
    workflowRuntime: fakeWorkflowRuntime,
    reconciliation,
  })
  // start() would migrate; these tests drive the stores without starting servers.
  await composition.persistence.migrate()
  providers.push(composition.persistence)
  return composition
}

async function seeded(composition, { runtimeStatus = 'succeeded' } = {}) {
  const inbox = new CommandInboxService({
    repository: composition.commandRepository,
    executionIdFactory: () => executionId,
    executionPlanValidator: { validate: async () => true },
    now: () => now,
  })
  const { execution } = await inbox.acceptExecution({
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    idempotencyKey: 'local-reconciliation:1',
    payloadHash: '8'.repeat(64),
    correlation,
    executionPlan,
    receivedAt: now,
    retentionExpiresAt: '2026-10-01T12:00:00.000Z',
  })
  await composition.executions.insertExecution(execution)
  const lifecycle = new ExecutionLifecycleService(composition.executions)
  await lifecycle.createAttempt({
    executionId: execution.executionId,
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    expectedExecutionVersion: execution.version,
    queuedAt: now,
    runtime: { runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
  })
  await lifecycle.transitionExecution({
    executionId: execution.executionId,
    expectedVersion: execution.version + 1,
    to: 'queued',
    transitionedAt: now,
  })
  await lifecycle.transitionExecution({
    executionId: execution.executionId,
    expectedVersion: execution.version + 2,
    to: 'running',
    transitionedAt: now,
  })
  await lifecycle.transitionAttempt({
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    expectedVersion: 1,
    to: 'running',
    transitionedAt: now,
  })
  await composition.runtimeCommands.create({
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    executionId: execution.executionId,
    attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId: correlation.workspaceId,
    idempotencyKey: 'local-reconciliation:runtime:1',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: { operation: 'runtime.start' },
    issuedAt: now,
    expiresAt: '2026-09-01T13:00:00.000Z',
    status: runtimeStatus,
    version: 2,
    deliveryAttempts: 1,
    lastChannelGeneration: 1,
    lastSequence: 1,
    firstDispatchedAt: now,
    lastDispatchedAt: now,
    ...(runtimeStatus === 'succeeded'
      ? {
          resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          resultStatus: 'succeeded',
          resultRecordedAt: now,
        }
      : {}),
    createdAt: now,
    updatedAt: now,
  })
  return execution.executionId
}

describe('local reconciliation projection composition', () => {
  test('absent configuration enables nothing; conflicting configuration fails closed', async () => {
    const silent = await composed(undefined)
    expect(silent.reconciliationService).toBeUndefined()
    expect(silent.reconciliationSource).toBeUndefined()
    expect(silent.reconciliationEffects).toBeUndefined()
    await expect(
      composed({
        projection: 'observation',
        source: { load: async () => undefined, listCandidates: async () => [] },
        intervalMs: 1_000,
        batchLimit: 5,
      })
    ).rejects.toThrow('LOCAL_RECONCILIATION_CONFIGURATION_CONFLICT')
    await expect(composed({ intervalMs: 1_000, batchLimit: 5 })).rejects.toThrow(
      'LOCAL_RECONCILIATION_CONFIGURATION_INVALID'
    )
  })

  test('projection wiring composes the production SQLite source and effects', async () => {
    const composition = await composed({
      projection: 'observation',
      intervalMs: 1_000,
      batchLimit: 10,
    })
    expect(composition.reconciliationService).toBeInstanceOf(ExecutionReconciliationService)
    expect(composition.reconciliationSource).toBeInstanceOf(SqliteReconciliationSource)
    expect(composition.reconciliationEffects).toBeInstanceOf(SqliteReconciliationEffects)
  })

  test('the composed projection converges a runtime-terminal execution over real rows', async () => {
    const composition = await composed({
      projection: 'observation',
      intervalMs: 1_000,
      batchLimit: 10,
    })
    const executionId = await seeded(composition)
    const result = await composition.reconciliationService.runBatch({ limit: 10 })
    expect(result.examined).toBe(1)
    expect(result.remediated).toBe(1)
    const execution = await composition.executions.getExecution(executionId)
    expect(execution.state).toBe('completed')
    expect(execution.terminalResultRef).toBe('art_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect((await composition.executions.getAttempt('att_01ARZ3NDEKTSV4RRFFQ69G5FAV')).state).toBe(
      'completed'
    )
    // A repeated pass neither re-examines the converged row nor duplicates checkpoints.
    await expect(composition.reconciliationService.runBatch({ limit: 10 })).resolves.toMatchObject({
      examined: 0,
    })
  })
})
