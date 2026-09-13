import { describe, expect, test } from 'bun:test'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  InMemoryCommandAcceptanceRepository,
  InMemoryExecutionRepository,
  RuntimeCommandRecordSchema,
} from '@control-plane/domain'
import {
  PostgresReconciliationEffects,
  PostgresReconciliationSource,
  observeRuntime,
} from './reconciliation-projection.ts'

const now = '2026-09-01T12:00:00.000Z'
const later = '2026-09-01T12:05:00.000Z'
const correlation = {
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}
const requestId = 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const executionPlan = {
  executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  contentDigest: `sha256:${'7'.repeat(64)}`,
  schemaVersion: 1,
}
const attemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const connectionId = 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const resultReference = 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'

describe('reconciliation projection runtime mapping', () => {
  const running = { state: 'running', updatedAt: now }
  const attempt = { state: 'running', updatedAt: now }

  test('a recorded runtime result converges without retrying the runtime', () => {
    const record = runtimeCommand({ status: 'succeeded', resultStatus: 'succeeded' })
    expect(observeRuntime(record, attempt, running, undefined)).toEqual({
      status: 'completed',
      observedAt: record.resultRecordedAt,
      resultReference,
    })
    expect(
      observeRuntime(
        runtimeCommand({ status: 'failed', resultStatus: 'failed' }),
        attempt,
        running,
        undefined
      )
    ).toMatchObject({
      status: 'failed',
    })
    expect(
      observeRuntime(
        runtimeCommand({ status: 'cancelled', resultStatus: 'cancelled' }),
        attempt,
        running,
        undefined
      )
    ).toMatchObject({
      status: 'cancelled',
    })
  })

  test('a success without a recorded result reference parks as unknown', () => {
    const record = runtimeCommand({ status: 'succeeded', resultStatus: 'succeeded' })
    delete record.resultReference
    expect(observeRuntime(record, attempt, running, undefined)).toMatchObject({ status: 'unknown' })
  })

  test('an outcome the lifecycle cannot legally accept parks as unknown', () => {
    expect(
      observeRuntime(
        runtimeCommand({ status: 'succeeded', resultStatus: 'succeeded' }),
        { state: 'queued', updatedAt: now },
        { state: 'accepted', updatedAt: now },
        undefined
      )
    ).toMatchObject({ status: 'unknown' })
    expect(
      observeRuntime(
        runtimeCommand({ status: 'succeeded', resultStatus: 'succeeded' }),
        { state: 'cancelled', updatedAt: now },
        running,
        undefined
      )
    ).toMatchObject({ status: 'unknown' })
  })

  test('a lost ACK parks instead of claiming a terminal state', () => {
    for (const status of ['queued', 'expired']) {
      expect(observeRuntime(runtimeCommand({ status }), attempt, running, undefined)).toMatchObject(
        {
          status: 'unknown',
        }
      )
    }
    expect(
      observeRuntime(runtimeCommand({ status: 'dispatched' }), attempt, running, undefined)
    ).toMatchObject({ status: 'running' })
    expect(
      observeRuntime(runtimeCommand({ status: 'acknowledged' }), attempt, running, undefined)
    ).toMatchObject({ status: 'running' })
  })

  test('a disconnected runtime connection reports disconnected before in-flight states', () => {
    const connection = { status: 'disconnected', updatedAt: now }
    expect(
      observeRuntime(runtimeCommand({ status: 'dispatched' }), attempt, running, connection)
    ).toMatchObject({ status: 'disconnected' })
  })

  test('a missing runtime command for a started attempt reports not_found', () => {
    expect(observeRuntime(undefined, attempt, running, undefined)).toMatchObject({
      status: 'not_found',
    })
    expect(
      observeRuntime(undefined, undefined, { state: 'accepted', updatedAt: now }, undefined)
    ).toMatchObject({
      status: 'unknown',
    })
  })
})

describe('reconciliation source candidate bounds', () => {
  test('bounds the batch and derives the staleness cutoff from the clock', async () => {
    const scans = []
    const source = new PostgresReconciliationSource({
      executions: {
        getExecution: async () => undefined,
        getAttempt: async () => undefined,
        listReconciliationCandidates: async (input) => {
          scans.push(input)
          return ['exe_01ARZ3NDEKTSV4RRFFQ69G5FAV']
        },
      },
      commands: { getByExecutionId: async () => undefined },
      runtimeCommands: { latestForAttempt: async () => undefined },
      runtimeConnections: { get: async () => undefined },
      events: { summarizePendingDelivery: async () => ({ pendingCount: 0 }) },
      candidateStaleAfterMs: 30_000,
      now: () => now,
    })
    expect(await source.listCandidates({ limit: 25 })).toEqual(['exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'])
    expect(scans).toEqual([{ staleBefore: '2026-09-01T11:59:30.000Z', limit: 25 }])
    for (const limit of [0, -1, 1.5, 1_001]) {
      await expect(source.listCandidates({ limit })).rejects.toThrow(
        'INVALID_RECONCILIATION_CANDIDATE_LIMIT'
      )
    }
    expect(
      () => new PostgresReconciliationSource(minimalSourceOptions({ candidateStaleAfterMs: 0 }))
    ).toThrow('INVALID_RECONCILIATION_CANDIDATE_STALENESS')
  })

  test('load assembles the observation from execution, inbox, attempt and delivery facts', async () => {
    const execution = {
      executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      state: 'running',
      updatedAt: now,
      latestAttemptId: attemptId,
    }
    const command = { commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV', status: 'processing' }
    const attempts = new Map([
      [attemptId, { attemptId, sequence: 1, state: 'running', updatedAt: now }],
    ])
    let deliveryScans = 0
    const source = new PostgresReconciliationSource({
      executions: {
        getExecution: async (id) => (id === execution.executionId ? execution : undefined),
        getAttempt: async (id) => attempts.get(id),
        listReconciliationCandidates: async () => [],
      },
      commands: { getByExecutionId: async () => command },
      runtimeCommands: {
        latestForAttempt: async () => runtimeCommand({ status: 'acknowledged' }),
      },
      runtimeConnections: { get: async () => ({ status: 'connected', updatedAt: now }) },
      events: {
        summarizePendingDelivery: async (_executionId, limit) => {
          deliveryScans += 1
          expect(limit).toBe(100)
          return { pendingCount: 2, oldestPendingAt: later }
        },
      },
      now: () => later,
    })
    const observation = await source.load(execution.executionId)
    expect(observation).toMatchObject({
      executionId: execution.executionId,
      checkedAt: later,
      command,
      execution: { state: 'running', updatedAt: now },
      attempt: {
        attemptId,
        sequence: 1,
        state: 'running',
        runtimeCommandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
      workflow: { status: 'missing' },
      runtime: { status: 'running' },
      delivery: { pendingCount: 2, oldestPendingAt: later },
    })
    expect(deliveryScans).toBe(1)
    await expect(source.load('exe_00000000000000000000000000')).rejects.toThrow(
      'RECONCILIATION_EXECUTION_MISSING'
    )
  })
})

describe('reconciliation effects over in-memory lifecycle stores', () => {
  async function seeded({ withAttempt = false } = {}) {
    const executions = new InMemoryExecutionRepository()
    const commands = new InMemoryCommandAcceptanceRepository()
    const inbox = new CommandInboxService({
      repository: commands,
      executionIdFactory: () => 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      executionPlanValidator: { validate: async () => true },
      now: () => now,
    })
    const { execution } = await inbox.acceptExecution({
      callerPrincipalId: 'svc_agent-hq',
      operation: 'execution.accept',
      commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId,
      idempotencyKey: 'reconciliation-projection:unit:1',
      payloadHash: '8'.repeat(64),
      correlation,
      executionPlan,
      receivedAt: now,
      retentionExpiresAt: '2026-10-01T12:00:00.000Z',
    })
    await executions.insertExecution(execution)
    const lifecycle = new ExecutionLifecycleService(executions)
    if (withAttempt) {
      await lifecycle.createAttempt({
        executionId: execution.executionId,
        attemptId,
        expectedExecutionVersion: execution.version,
        queuedAt: now,
        runtime: { runtimeConnectionId: connectionId },
      })
    }
    const submissions = []
    const effects = new PostgresReconciliationEffects({
      executions,
      commands,
      events: {
        rearmPendingDelivery: async (executionId, dueAt, limit) => {
          submissions.push({ kind: 'rearm', executionId, dueAt, limit })
          return 0
        },
      },
      workflowSubmitter: {
        submit: async (input) => submissions.push({ kind: 'submit', ...input }),
      },
      now: () => later,
    })
    return {
      executions,
      commands,
      lifecycle,
      inbox,
      effects,
      submissions,
      executionId: execution.executionId,
    }
  }

  test('markReconciliationRequired parks command, execution and attempt exactly once', async () => {
    const environment = await seeded({ withAttempt: true })
    const input = {
      executionId: environment.executionId,
      attemptId,
      reason: 'stale_heartbeat',
      checkpointId: 'rcp_' + 'a'.repeat(32),
      observedAt: later,
    }
    await environment.effects.markReconciliationRequired(input)
    const command = await environment.commands.getByExecutionId(environment.executionId)
    expect(command.status).toBe('reconciliation_required')
    expect(command.errorReference).toBe(`reconciliation://checkpoint/${input.checkpointId}`)
    const execution = await environment.executions.getExecution(environment.executionId)
    expect(execution.state).toBe('reconciliation_required')
    const attemptRecord = await environment.executions.getAttempt(attemptId)
    expect(attemptRecord.state).toBe('reconciliation_required')

    // A repeated pass over the same parking decision is a no-op.
    const versionBefore = execution.version
    await environment.effects.markReconciliationRequired(input)
    expect((await environment.executions.getExecution(environment.executionId)).version).toBe(
      versionBefore
    )
  })

  test('applyRuntimeTerminal lands the recorded runtime outcome and converges', async () => {
    const environment = await seeded({ withAttempt: true })
    const lifecycle = new ExecutionLifecycleService(environment.executions)
    const executionBefore = await environment.executions.getExecution(environment.executionId)
    await lifecycle.transitionExecution({
      executionId: environment.executionId,
      expectedVersion: executionBefore.version,
      to: 'queued',
      transitionedAt: now,
    })
    await lifecycle.transitionExecution({
      executionId: environment.executionId,
      expectedVersion: executionBefore.version + 1,
      to: 'running',
      transitionedAt: now,
    })
    await lifecycle.transitionAttempt({
      attemptId,
      expectedVersion: (await environment.executions.getAttempt(attemptId)).version,
      to: 'running',
      transitionedAt: now,
    })
    await environment.effects.applyRuntimeTerminal({
      executionId: environment.executionId,
      attemptId,
      checkpointId: 'rcp_' + 'a'.repeat(32),
      outcome: 'completed',
      resultReference,
      observedAt: later,
    })
    const attemptRecord = await environment.executions.getAttempt(attemptId)
    expect(attemptRecord.state).toBe('completed')
    expect(attemptRecord.terminalResultRef).toBe(resultReference)
    const execution = await environment.executions.getExecution(environment.executionId)
    expect(execution.state).toBe('completed')
    expect(execution.terminalResultRef).toBe(resultReference)
  })

  test('applyRuntimeTerminal refuses to rewrite a conflicting terminal state', async () => {
    const environment = await seeded({ withAttempt: true })
    const lifecycle = new ExecutionLifecycleService(environment.executions)
    await lifecycle.transitionAttempt({
      attemptId,
      expectedVersion: (await environment.executions.getAttempt(attemptId)).version,
      to: 'cancelled',
      transitionedAt: now,
    })
    await expect(
      environment.effects.applyRuntimeTerminal({
        executionId: environment.executionId,
        attemptId,
        checkpointId: 'rcp_' + 'a'.repeat(32),
        outcome: 'completed',
        resultReference,
        observedAt: later,
      })
    ).rejects.toThrow('RECONCILIATION_TERMINAL_CONFLICT')
  })

  test('resumeWorkflow re-submits only a genuinely unstarted accepted execution', async () => {
    const environment = await seeded()
    const checkpointId = 'rcp_' + 'b'.repeat(32)
    await environment.effects.resumeWorkflow({ executionId: environment.executionId, checkpointId })
    expect(environment.submissions).toEqual([
      {
        kind: 'submit',
        executionId: environment.executionId,
        workflowId: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        executionPlan,
        deadlineAt: '2026-10-01T12:00:00.000Z',
      },
    ])
    expect((await environment.commands.getByExecutionId(environment.executionId)).status).toBe(
      'processing'
    )

    // Already-processing commands are never resubmitted.
    await environment.effects.resumeWorkflow({ executionId: environment.executionId, checkpointId })
    expect(environment.submissions).toHaveLength(1)
  })

  test('resumeWorkflow stands down against a recorded cancellation', async () => {
    const environment = await seeded()
    const effects = new PostgresReconciliationEffects({
      executions: environment.executions,
      commands: environment.commands,
      events: { rearmPendingDelivery: async () => 0 },
      workflowSubmitter: {
        submit: async () => {
          throw new Error('SUBMIT_MUST_NOT_BE_CALLED')
        },
      },
      cancellations: {
        listByExecution: async () => [
          { request: { payload: { executionId: environment.executionId } }, acceptedAt: now },
        ],
      },
      now: () => later,
    })
    await effects.resumeWorkflow({
      executionId: environment.executionId,
      checkpointId: 'rcp_' + 'c'.repeat(32),
    })
    expect(environment.submissions).toEqual([])
    expect((await environment.commands.getByExecutionId(environment.executionId)).status).toBe(
      'accepted'
    )
  })

  test('replayEvents only re-arms the outbound event schedule', async () => {
    const environment = await seeded()
    await environment.effects.replayEvents({
      executionId: environment.executionId,
      checkpointId: 'rcp_' + 'd'.repeat(32),
    })
    expect(environment.submissions).toEqual([
      { kind: 'rearm', executionId: environment.executionId, dueAt: later, limit: 100 },
    ])
  })
})

function minimalSourceOptions(overrides = {}) {
  return {
    executions: {
      getExecution: async () => undefined,
      getAttempt: async () => undefined,
      listReconciliationCandidates: async () => [],
    },
    commands: { getByExecutionId: async () => undefined },
    runtimeCommands: { latestForAttempt: async () => undefined },
    runtimeConnections: { get: async () => undefined },
    events: { summarizePendingDelivery: async () => ({ pendingCount: 0 }) },
    now: () => now,
    ...overrides,
  }
}

function runtimeCommand({ status, resultStatus }) {
  const inFlight = status !== 'queued'
  const acknowledged = status === 'acknowledged'
  return RuntimeCommandRecordSchema.parse({
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    attemptId,
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runtimeConnectionId: connectionId,
    workspaceId: correlation.workspaceId,
    idempotencyKey: 'reconciliation-projection:runtime:1',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: { operation: 'runtime.start' },
    issuedAt: now,
    expiresAt: '2026-09-01T13:00:00.000Z',
    status,
    version: 3,
    deliveryAttempts: inFlight ? 1 : 0,
    ...(inFlight
      ? {
          lastChannelGeneration: 1,
          lastSequence: 1,
          firstDispatchedAt: now,
          lastDispatchedAt: now,
        }
      : {}),
    ...(acknowledged
      ? {
          acknowledgementReference: 'ack:1:1',
          acknowledgementDisposition: 'accepted',
          acknowledgedAt: now,
        }
      : {}),
    ...(resultStatus === undefined
      ? {}
      : {
          resultReference,
          resultStatus,
          resultRecordedAt: later,
        }),
    createdAt: now,
    updatedAt: later,
  })
}
