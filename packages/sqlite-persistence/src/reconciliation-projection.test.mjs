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
  SqliteExecutionCancellationRepository,
  SqliteExecutionEventRepository,
  SqliteExecutionRepository,
  SqliteCommandAcceptanceRepository,
  SqlitePersistenceProvider,
  SqliteReconciliationCheckpointRepository,
  SqliteReconciliationEffects,
  SqliteReconciliationSource,
  SqliteRuntimeCommandRepository,
} from './index.ts'

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
const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const attemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const runtimeCommandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const connectionId = 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const resultReference = 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'

let directories = []
let providers = []

afterAll(async () => {
  for (const provider of providers) {
    await provider.close({ checkpoint: true })
  }
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function provisioned() {
  const directory = await mkdtemp(join(tmpdir(), 'reconciliation-projection-'))
  const provider = new SqlitePersistenceProvider({
    path: join(directory, 'control-plane.sqlite'),
  })
  await provider.migrate()
  directories.push(directory)
  providers.push(provider)
  return provider
}

async function seeded({ runtimeStatus = 'succeeded' } = {}) {
  const persistence = await provisioned()
  const executions = new SqliteExecutionRepository(persistence)
  const commands = new SqliteCommandAcceptanceRepository(persistence)
  const runtimeCommands = new SqliteRuntimeCommandRepository(persistence)
  const events = new SqliteExecutionEventRepository(persistence)
  const runtimeDiscovery = {
    getRuntimeConnection: async () => ({
      status: 'available',
      connection: { status: 'connected', health: 'healthy', availability: 'healthy' },
      observedAt: now,
    }),
  }
  const inbox = new CommandInboxService({
    repository: commands,
    executionIdFactory: () => executionId,
    executionPlanValidator: { validate: async () => true },
    now: () => now,
  })
  const { execution } = await inbox.acceptExecution({
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId,
    requestId,
    idempotencyKey: 'reconciliation-projection:sqlite:1',
    payloadHash: '8'.repeat(64),
    correlation,
    executionPlan,
    receivedAt: now,
    retentionExpiresAt: '2026-10-01T12:00:00.000Z',
  })
  await executions.insertExecution(execution)
  const lifecycle = new ExecutionLifecycleService(executions)
  await lifecycle.createAttempt({
    executionId,
    attemptId,
    expectedExecutionVersion: execution.version,
    queuedAt: now,
    runtime: { runtimeConnectionId: connectionId },
  })
  await lifecycle.transitionExecution({
    executionId,
    expectedVersion: execution.version + 1,
    to: 'queued',
    transitionedAt: now,
  })
  await lifecycle.transitionExecution({
    executionId,
    expectedVersion: execution.version + 2,
    to: 'running',
    transitionedAt: now,
  })
  await lifecycle.transitionAttempt({
    attemptId,
    expectedVersion: 1,
    to: 'running',
    transitionedAt: now,
  })
  await runtimeCommands.create(runtimeCommandRecord(runtimeStatus))
  const submissions = []
  const source = new SqliteReconciliationSource({
    executions,
    commands,
    runtimeCommands,
    runtimeConnections: runtimeDiscovery,
    events,
    now: () => later,
  })
  const effects = new SqliteReconciliationEffects({
    executions,
    commands,
    events,
    workflowSubmitter: { submit: async (input) => submissions.push(input) },
    now: () => later,
  })
  return {
    persistence,
    executions,
    commands,
    runtimeCommands,
    events,
    source,
    effects,
    submissions,
  }
}

function runtimeCommandRecord(status) {
  const terminal = ['succeeded', 'failed', 'cancelled'].includes(status)
  const inFlight = status !== 'queued'
  return {
    commandId: runtimeCommandId,
    executionId,
    attemptId,
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runtimeConnectionId: connectionId,
    workspaceId: correlation.workspaceId,
    idempotencyKey: 'reconciliation-projection:sqlite:rt:1',
    payloadHash: `sha256:${'a'.repeat(64)}`,
    commandEnvelope: { operation: 'runtime.start' },
    issuedAt: now,
    expiresAt: '2026-09-01T13:00:00.000Z',
    status,
    version: 2,
    deliveryAttempts: inFlight ? 1 : 0,
    ...(inFlight
      ? { lastChannelGeneration: 1, lastSequence: 1, firstDispatchedAt: now, lastDispatchedAt: now }
      : {}),
    ...(terminal ? { resultReference, resultStatus: status, resultRecordedAt: now } : {}),
    createdAt: now,
    updatedAt: now,
  }
}

describe('SQLite reconciliation projection', () => {
  test('source candidates are bounded by the staleness cutoff', async () => {
    const environment = await seeded()
    expect(await environment.source.listCandidates({ limit: 10 })).toEqual([executionId])
    for (const limit of [0, -1, 1.5, 1_001]) {
      await expect(environment.source.listCandidates({ limit })).rejects.toThrow(
        'INVALID_RECONCILIATION_CANDIDATE_LIMIT'
      )
    }
  })

  test('observation reflects the runtime terminal record and delivery debt', async () => {
    const environment = await seeded()
    const observation = await environment.source.load(executionId)
    expect(observation).toMatchObject({
      executionId,
      attempt: { attemptId, state: 'running', runtimeCommandId },
      workflow: { status: 'missing' },
      runtime: { status: 'completed', resultReference },
      delivery: { pendingCount: 0 },
    })
  })

  test('a full pass converges a runtime-terminal execution idempotently', async () => {
    const environment = await seeded()
    const checkpoints = new SqliteReconciliationCheckpointRepository(environment.persistence)
    const service = new ExecutionReconciliationService({
      repository: checkpoints,
      source: environment.source,
      effects: environment.effects,
      policy: { staleAfterMs: 1_000 },
      clock: () => Date.parse(later),
    })
    const first = await service.runBatch({ limit: 10 })
    expect(first.examined).toBe(1)
    expect(first.remediated).toBe(1)
    const execution = await environment.executions.getExecution(executionId)
    expect(execution.state).toBe('completed')
    expect(execution.terminalResultRef).toBe(resultReference)
    expect((await environment.executions.getAttempt(attemptId)).state).toBe('completed')
    const checkpointsAfterFirstPass = await countCheckpoints(environment.persistence)
    expect(checkpointsAfterFirstPass).toBe(1)
    const [stored] = await listCheckpoints(environment.persistence)
    expect(stored.state).toBe('remediated')
    expect(stored.action).toBe('apply_runtime_terminal')

    // Repeated passes never duplicate checkpoints nor re-run billable work.
    expect(await service.runBatch({ limit: 10 })).toMatchObject({ examined: 0 })
    expect(await countCheckpoints(environment.persistence)).toBe(checkpointsAfterFirstPass)
    expect(environment.submissions).toEqual([])
  })

  test('a lost-ACK runtime command parks the checkpoint without terminal claims', async () => {
    const environment = await seeded({ runtimeStatus: 'dispatched' })
    const checkpoints = new SqliteReconciliationCheckpointRepository(environment.persistence)
    const service = new ExecutionReconciliationService({
      repository: checkpoints,
      source: environment.source,
      effects: environment.effects,
      policy: { staleAfterMs: 1_000 },
      clock: () => Date.parse(later),
    })
    const result = await service.runBatch({ limit: 10 })
    expect(result.waiting).toBe(1)
    expect(result.remediated).toBe(0)
    // Parked on the reconciliation_required states — never a fabricated terminal.
    expect((await environment.executions.getExecution(executionId)).state).toBe(
      'reconciliation_required'
    )
    expect((await environment.executions.getAttempt(attemptId)).state).toBe(
      'reconciliation_required'
    )
    expect((await environment.commands.getByExecutionId(executionId)).status).toBe(
      'reconciliation_required'
    )
    expect(environment.submissions).toEqual([])
  })

  test('replayEvents re-arms undelivered publication schedules only', async () => {
    const environment = await seeded()
    await environment.events.append({
      eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      executionId,
      type: 'execution.accepted',
      schemaVersion: 1,
      correlation: {
        ...correlation,
        commandId,
        traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        requestId,
      },
      payload: { state: 'accepted' },
      occurredAt: now,
      recordedAt: now,
      retentionExpiresAt: '2026-10-01T12:00:00.000Z',
    })
    expect(await environment.events.summarizePendingDelivery(executionId, 100)).toMatchObject({
      pendingCount: 1,
    })
    expect(await environment.events.rearmPendingDelivery(executionId, later, 100)).toBe(1)
    expect(await environment.events.summarizePendingDelivery(executionId, 100)).toMatchObject({
      pendingCount: 1,
    })
  })

  test('resumeWorkflow stands down against a recorded cancellation', async () => {
    const environment = await seeded()
    const cancellations = new SqliteExecutionCancellationRepository(environment.persistence)
    await cancellations.reserve({
      request: {
        workspaceId: correlation.workspaceId,
        projectId: correlation.projectId,
        caller: { servicePrincipalId: 'svc_agent-hq' },
        contractVersion: { major: 1, minor: 0 },
        requestId,
        correlation: { traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAC',
        idempotencyKey: 'reconciliation-projection:cancel:1',
        payloadHash: 'c'.repeat(64),
        operation: 'execution.cancel',
        issuedAt: now,
        payload: { executionId },
      },
    })
    const submissions = []
    const effects = new SqliteReconciliationEffects({
      executions: environment.executions,
      commands: environment.commands,
      events: environment.events,
      workflowSubmitter: { submit: async (input) => submissions.push(input) },
      cancellations,
      now: () => later,
    })
    await effects.resumeWorkflow({ executionId, checkpointId: 'rcp_' + 'a'.repeat(32) })
    expect(submissions).toEqual([])
    expect((await environment.commands.getByExecutionId(executionId)).status).toBe('accepted')
  })
})

async function countCheckpoints(persistence) {
  return (await listCheckpoints(persistence)).length
}

async function listCheckpoints(persistence) {
  return persistence.transaction((transaction) =>
    transaction
      .list('reconciliation-checkpoints')
      .then((records) =>
        records
          .map((record) => record.value)
          .toSorted((left, right) => left.observationHash.localeCompare(right.observationHash))
      )
  )
}
