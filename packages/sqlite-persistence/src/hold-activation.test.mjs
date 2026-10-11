import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { CommandInboxService, ExecutionSchema } from '@control-plane/domain'
import { EvaluationService } from '@control-plane/production-readiness'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteEvaluationRepository,
  SqliteExecutionEventRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
  SqliteReceiptRetention,
  SqliteRetentionHoldRepository,
  SqliteRuntimeCommandRepository,
  countSqliteMatchingActiveRetentionHolds,
} from './index.ts'
import { getReferenceRetentionWindow } from './retention-reference-metadata.js'
import {
  acceptancePlan,
  acceptancePlanReference,
  seedAcceptancePlan,
} from './execution-plan-fixtures.mjs'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherWorkspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherProjectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const acceptedAt = '2026-05-01T10:00:00.000Z'
const expiredAt = '2026-08-01T10:00:00.000Z'
const commandAcceptedAt = '2026-08-24T10:00:00.000Z'
const commandExpiredAt = '2026-09-23T10:00:00.000Z'
const now = new Date('2026-09-24T12:00:00.000Z')
const provenance = {
  actorPrincipalRef: 'operator:sqlite-hold-test',
  authorityRef: 'authority:sqlite-test',
}
const digest = (character) => `sha256:${character.repeat(64)}`
const storedId = (value) => `r-${createHash('sha256').update(value).digest('hex')}`

function policyFor(classId) {
  return {
    [classId]: {
      owner: 'retention-owner',
      scopes: classId === 'evaluation-runs' ? ['class'] : ['class', 'workspace', 'project'],
      reasonCodes: ['legal-case'],
    },
  }
}

async function addHold(provider, classId, scope) {
  const policy = policyFor(classId)
  const hold = {
    holdId: randomUUID(),
    classId,
    scope,
    owner: 'retention-owner',
    reasonCode: 'legal-case',
    createdAt: '2026-09-01T12:00:00.000Z',
    createdBy: provenance,
    revision: 0,
  }
  await new SqliteRetentionHoldRepository(provider, policy).create(hold)
  return { policy, hold }
}

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-hold-activation-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    await run({ directory, provider })
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function waitForWorkerMessage(worker, expectedType) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      cleanup()
      callback(value)
    }
    const onMessage = (message) => {
      if (message?.type === 'error') {
        finish(reject, new Error(message.error))
      } else if (message?.type === expectedType) {
        finish(resolve, message)
      }
    }
    const onError = (error) => {
      finish(reject, error)
    }
    const onExit = (code) => {
      finish(reject, new Error(`worker exited ${code} before ${expectedType}`))
    }
    const cleanup = () => {
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
  })
}

async function waitForSharedValue(state, index, expectedValues, description) {
  const deadline = Date.now() + 4500
  while (true) {
    const value = Atomics.load(state, index)
    if (expectedValues.includes(value)) return value
    if (Atomics.load(state, 4) !== 0) throw new Error(`worker failed before ${description}`)
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${description}; state=${value}`)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function seedTerminalExecution(provider, input = {}) {
  const scope = input.scope ?? { workspaceId, projectId }
  const id = input.executionId ?? executionId
  const execution = ExecutionSchema.parse({
    executionId: id,
    state: 'completed',
    version: 2,
    correlation: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    executionPlan: acceptancePlanReference,
    attemptCount: 0,
    acceptedAt,
    terminalAt: expiredAt,
    createdAt: acceptedAt,
    updatedAt: expiredAt,
  })
  await provider.transaction((transaction) =>
    transaction.put({ namespace: 'executions', id: storedId(id), value: execution })
  )
  return execution
}

function eventDraft(id = eventId, scope = { workspaceId, projectId }) {
  return {
    eventId: id,
    executionId,
    type: 'execution.progress',
    schemaVersion: 1,
    correlation: {
      ...scope,
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    payload: { operation: 'hold-activation-fixture' },
    occurredAt: acceptedAt,
    recordedAt: acceptedAt,
    retentionExpiresAt: expiredAt,
  }
}

async function publishEvent(provider, id = eventId) {
  await provider.transaction(async (transaction) => {
    const record = await transaction.get('execution-events', storedId(id))
    if (record === undefined) throw new Error('HOLD_ACTIVATION_EVENT_MISSING')
    await transaction.put({
      namespace: 'execution-events',
      id: record.id,
      expectedRevision: record.revision,
      value: {
        ...record.value,
        publication: { status: 'published', attempts: 1, version: 1, publishedAt: expiredAt },
      },
    })
  })
}

async function seedTerminalCommand(provider, project = acceptancePlan.correlation.projectId) {
  await seedAcceptancePlan(provider)
  const commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV'
  const idempotencyKey = 'hold-activation-command-0001'
  const scope = {
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    workspaceId: acceptancePlan.correlation.workspaceId,
    projectId: project,
    idempotencyKey,
  }
  const commands = new SqliteCommandAcceptanceRepository(provider)
  const result = await new CommandInboxService({
    repository: commands,
    executionIdFactory: () => executionId,
    executionPlanValidator: { validate: async () => true },
    now: () => commandAcceptedAt,
  }).acceptExecution({
    callerPrincipalId: scope.callerPrincipalId,
    operation: scope.operation,
    commandId,
    requestId: acceptancePlan.correlation.requestId,
    idempotencyKey,
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      taskId: acceptancePlan.correlation.taskId,
      agentId: acceptancePlan.correlation.agentId,
    },
    executionPlan: acceptancePlanReference,
    receivedAt: commandAcceptedAt,
    retentionExpiresAt: commandExpiredAt,
  })
  await provider.transaction(async (transaction) => {
    const execution = await transaction.get('executions', storedId(executionId))
    const command = await transaction.get('command-inbox', storedId(scopeKey(scope)))
    if (execution === undefined || command === undefined)
      throw new Error('HOLD_ACTIVATION_COMMAND_MISSING')
    await transaction.put({
      namespace: 'executions',
      id: execution.id,
      expectedRevision: execution.revision,
      value: {
        ...execution.value,
        state: 'completed',
        version: 2,
        terminalAt: commandExpiredAt,
        updatedAt: commandExpiredAt,
      },
    })
    await transaction.put({
      namespace: 'command-inbox',
      id: command.id,
      expectedRevision: command.revision,
      value: {
        ...command.value,
        status: 'completed',
        terminalAt: commandExpiredAt,
        resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
    })
  })
  await commands.retireExpiredCommand(scope, now.toISOString())
  return { commands, scope, result }
}

function scopeKey(scope) {
  return [
    scope.callerPrincipalId,
    scope.operation,
    scope.workspaceId,
    scope.projectId,
    scope.idempotencyKey,
  ].join('\u001f')
}

async function seedRuntimeCommand(provider) {
  await seedTerminalExecution(provider)
  const commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW'
  await provider.transaction((transaction) =>
    transaction.put({
      namespace: 'runtime-commands',
      id: storedId(commandId),
      value: {
        commandId,
        executionId,
        attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        workspaceId,
        idempotencyKey: 'runtime-hold-activation-0001',
        payloadHash: digest('a'),
        commandEnvelope: { operation: 'runtime.cancel' },
        issuedAt: acceptedAt,
        expiresAt: '2026-05-03T10:00:00.000Z',
        status: 'succeeded',
        version: 1,
        deliveryAttempts: 1,
        lastChannelGeneration: 1,
        lastSequence: 1,
        firstDispatchedAt: expiredAt,
        lastDispatchedAt: expiredAt,
        acknowledgementReference: 'ack-runtime-hold-activation-0001',
        acknowledgementDisposition: 'accepted',
        acknowledgedAt: expiredAt,
        resultStatus: 'succeeded',
        resultRecordedAt: expiredAt,
        createdAt: acceptedAt,
        updatedAt: expiredAt,
      },
    })
  )
}

test('active scoped holds gate every SQLite retention class before deletion', async () => {
  await withProvider(async ({ provider }) => {
    await seedTerminalExecution(provider)
    const events = new SqliteExecutionEventRepository(provider)
    await events.append(eventDraft())
    await publishEvent(provider)
    const { policy: eventPolicy } = await addHold(provider, 'execution-events', {
      kind: 'project',
      workspaceId,
      projectId,
    })
    const eventResult = await events.deleteEligibleEvents(now, {
      policyRetainMs: 0,
      dryRun: false,
      retentionHoldPolicy: eventPolicy,
    })
    expect(eventResult.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(eventResult.deleted).toBe(0)
  })

  await withProvider(async ({ provider }) => {
    const { commands, scope } = await seedTerminalCommand(provider)
    const { policy } = await addHold(provider, 'command-inbox', {
      kind: 'project',
      workspaceId: acceptancePlan.correlation.workspaceId,
      projectId: acceptancePlan.correlation.projectId,
    })
    const assessment = await commands.assessExpiredInbox(now, {
      policyRetainMs: 0,
      retentionHoldPolicy: policy,
    })
    expect(assessment.retainedByReason).toEqual({ hold_recorded: 1 })
    const deletion = await commands.deleteEligibleInbox(now, {
      policyRetainMs: 0,
      dryRun: false,
      retentionHoldPolicy: policy,
    })
    expect(deletion.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(
      await provider.transaction((transaction) =>
        transaction.get('command-inbox', storedId(scopeKey(scope)))
      )
    ).toBeDefined()
  })

  await withProvider(async ({ provider }) => {
    await seedTerminalExecution(provider)
    const { policy } = await addHold(provider, 'executions', {
      kind: 'project',
      workspaceId,
      projectId,
    })
    const result = await new SqliteExecutionRepository(provider).deleteEligibleExecutions(now, {
      policyRetainMs: 0,
      dryRun: false,
      retentionHoldPolicy: policy,
    })
    expect(result.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(result.deleted).toBe(0)
  })

  await withProvider(async ({ provider }) => {
    const { plan } = await seedAcceptancePlan(provider)
    const plans = new SqliteExecutionPlanRepository(provider)
    const firstObservation = new Date('2026-09-01T00:00:00.000Z')
    await plans.deleteEligibleExecutionPlans(firstObservation, {
      policyRetainMs: 1,
      dryRun: false,
    })
    const { policy } = await addHold(provider, 'execution-plans', {
      kind: 'project',
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
    })
    const result = await plans.deleteEligibleExecutionPlans(
      new Date(firstObservation.getTime() + 2),
      {
        policyRetainMs: 1,
        dryRun: false,
        retentionHoldPolicy: policy,
      }
    )
    expect(result.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(result.deleted).toBe(0)
  })

  await withProvider(async ({ provider }) => {
    const package_ = contextPackageSerializationFixtures.futurePi
    const packages = new SqliteContextPackageRepository(provider)
    await packages.put(package_)
    const firstObservation = new Date('2026-09-01T00:00:00.000Z')
    await packages.deleteEligibleContextPackages(firstObservation, {
      policyRetainMs: 1,
      dryRun: false,
    })
    const { policy } = await addHold(provider, 'context-packages', {
      kind: 'project',
      workspaceId: package_.projectState.workspaceId,
      projectId: package_.projectState.projectId,
    })
    const result = await packages.deleteEligibleContextPackages(
      new Date(firstObservation.getTime() + 2),
      {
        policyRetainMs: 1,
        dryRun: false,
        retentionHoldPolicy: policy,
      }
    )
    expect(result.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(result.deleted).toBe(0)
  })

  await withProvider(async ({ provider }) => {
    await seedRuntimeCommand(provider)
    const { policy } = await addHold(provider, 'runtime-ledgers', {
      kind: 'project',
      workspaceId,
      projectId,
    })
    const result = await new SqliteRuntimeCommandRepository(provider).deleteEligibleRuntimeCommands(
      now,
      { policyRetainMs: 0, dryRun: false, retentionHoldPolicy: policy }
    )
    expect(result.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(result.deleted).toBe(0)
  })

  await withProvider(async ({ provider }) => {
    const cancellation = ControlApiFixtures.executionCancellation.request
    const ownerId = cancellation.payload.executionId
    await seedTerminalExecution(provider, {
      executionId: ownerId,
      scope: { workspaceId: cancellation.workspaceId, projectId: cancellation.projectId },
    })
    await provider.transaction((transaction) =>
      transaction.put({
        namespace: 'execution-cancellation-receipts',
        id: 'r-hold-activation-cancellation',
        value: {
          request: {
            ...cancellation,
            idempotencyKey: 'cancel-hold-activation-fixture-01',
            payload: { executionId: ownerId },
          },
          acceptedAt,
        },
      })
    )
    const { policy } = await addHold(provider, 'interaction-receipts', {
      kind: 'project',
      workspaceId: cancellation.workspaceId,
      projectId: cancellation.projectId,
    })
    const result = await new SqliteReceiptRetention(provider).sweepEligibleInteractionReceipts(
      now,
      {
        policyRetainMs: 0,
        dryRun: false,
        retentionHoldPolicy: policy,
      }
    )
    expect(result.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(result.deleted).toBe(0)
  })

  await withProvider(async ({ provider }) => {
    const configuration = {
      executionPlanDigest: digest('1'),
      profile: { id: 'profile-release', version: '1.0.0', digest: digest('2') },
      skills: [],
      graph: { id: 'graph-release', version: '1.0.0', digest: digest('3') },
      runtime: { id: 'runtime-release', version: '1.0.0', digest: digest('4') },
      model: { id: 'model-release', version: '1.0.0', digest: digest('5') },
      tools: [],
      policy: { id: 'policy-release', version: '1.0.0', digest: digest('6') },
    }
    const suite = {
      evalSuiteId: 'hold-activation-suite',
      version: '1.0.0',
      digest: digest('7'),
      dataset: { id: 'hold-activation-dataset', version: '1.0.0', digest: digest('8') },
      mode: 'offline',
      cases: [
        {
          evalCaseId: 'hold-activation-case',
          inputDigest: digest('9'),
          scorers: [
            { metric: 'functional_correctness', direction: 'min', threshold: 0.5, required: true },
          ],
        },
      ],
    }
    const run = await new EvaluationService({
      repository: new SqliteEvaluationRepository(provider),
      now: () => expiredAt,
    }).run({
      evalRunId: 'hold-activation-run',
      suite,
      configuration,
      execute: async () => ({ functional_correctness: 1 }),
    })
    expect(run.status).toBe('passed')
    const { policy } = await addHold(provider, 'evaluation-runs', { kind: 'class' })
    const result = await new SqliteEvaluationRepository(provider).deleteEligibleEvaluationRuns(
      now,
      {
        policyRetainMs: 0,
        dryRun: false,
        retentionHoldPolicy: policy,
      }
    )
    expect(result.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(result.deleted).toBe(0)
  })
}, 60_000)

test('missing policy is backward-compatible only for an empty namespace and otherwise fails closed', async () => {
  await withProvider(async ({ provider }) => {
    expect(
      await provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(transaction, { classId: 'context-packages' })
      )
    ).toBe(0)
    await expect(
      provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(transaction, { classId: 'context-packages' }, {})
      )
    ).rejects.toThrow('RETENTION_HOLD_POLICY_INVALID')

    const { hold } = await addHold(provider, 'context-packages', { kind: 'class' })
    await expect(
      provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(transaction, { classId: 'context-packages' })
      )
    ).rejects.toThrow('RETENTION_HOLD_POLICY_INVALID')
    const repository = new SqliteRetentionHoldRepository(provider, policyFor('context-packages'))
    await repository.release({
      holdId: hold.holdId,
      expectedRevision: 0,
      release: {
        requestId: randomUUID(),
        releasedAt: '2026-09-02T12:00:00.000Z',
        releasedBy: provenance,
      },
    })
    await expect(
      provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(transaction, { classId: 'context-packages' })
      )
    ).rejects.toThrow('RETENTION_HOLD_POLICY_INVALID')
  })

  await withProvider(async ({ provider }) => {
    await provider.transaction((transaction) =>
      transaction.put({
        namespace: 'retention-holds',
        id: 'malformed',
        value: { classId: 'unknown' },
      })
    )
    await expect(
      provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(
          transaction,
          { classId: 'context-packages' },
          policyFor('context-packages')
        )
      )
    ).rejects.toThrow('RETENTION_HOLD_STORED_RECORD_INVALID')
    await expect(
      provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(transaction, { classId: 'context-packages' })
      )
    ).rejects.toThrow('RETENTION_HOLD_POLICY_INVALID')
  })
})

test('an explicit policy validates the complete stored hold set, not just the requested class', async () => {
  await withProvider(async ({ provider }) => {
    const fullPolicy = {
      ...policyFor('context-packages'),
      ...policyFor('runtime-ledgers'),
    }
    const repository = new SqliteRetentionHoldRepository(provider, fullPolicy)
    const contextHold = {
      holdId: randomUUID(),
      classId: 'context-packages',
      scope: { kind: 'project', workspaceId, projectId },
      owner: 'retention-owner',
      reasonCode: 'legal-case',
      createdAt: '2026-09-01T12:00:00.000Z',
      createdBy: provenance,
      revision: 0,
    }
    const runtimeHold = {
      ...contextHold,
      holdId: randomUUID(),
      classId: 'runtime-ledgers',
      scope: { kind: 'workspace', workspaceId },
    }
    await repository.create(contextHold)
    await repository.create(runtimeHold)

    expect(
      await provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(
          transaction,
          { classId: 'context-packages', scope: contextHold.scope },
          fullPolicy
        )
      )
    ).toBe(1)
    await expect(
      provider.transaction((transaction) =>
        countSqliteMatchingActiveRetentionHolds(
          transaction,
          { classId: 'context-packages', scope: contextHold.scope },
          policyFor('context-packages')
        )
      )
    ).rejects.toThrow('RETENTION_HOLD_STORED_RECORD_INVALID')
  })
})

test('project holds do not cross tenant boundaries; unavailable execution scope fails closed', async () => {
  await withProvider(async ({ provider }) => {
    await seedTerminalExecution(provider, {
      scope: { workspaceId: otherWorkspaceId, projectId: otherProjectId },
    })
    const events = new SqliteExecutionEventRepository(provider)
    await events.append(
      eventDraft('evt_01ARZ3NDEKTSV4RRFFQ69G5FAW', {
        workspaceId: otherWorkspaceId,
        projectId: otherProjectId,
      })
    )
    await publishEvent(provider, 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW')
    const { policy } = await addHold(provider, 'execution-events', {
      kind: 'project',
      workspaceId,
      projectId,
    })
    const result = await events.deleteEligibleEvents(now, {
      policyRetainMs: 0,
      dryRun: false,
      retentionHoldPolicy: policy,
    })
    expect(result.deleted).toBe(1)
    expect(result.retainedByReason).toEqual({})
  })

  await withProvider(async ({ provider }) => {
    const events = new SqliteExecutionEventRepository(provider)
    await events.append(eventDraft())
    await publishEvent(provider)
    const { policy } = await addHold(provider, 'execution-events', {
      kind: 'project',
      workspaceId,
      projectId,
    })
    const journal = []
    await expect(
      events.deleteEligibleEvents(now, {
        policyRetainMs: 0,
        dryRun: false,
        retentionHoldPolicy: policy,
        journal: async (operations) => journal.push(...operations),
      })
    ).rejects.toThrow('RETENTION_HOLD_TARGET_SCOPE_MISSING')
    expect(journal).toEqual([])
    expect(await events.get(eventId)).toBeDefined()
  })
})

test('a held candidate is admitted within the bound without journaling or deleting', async () => {
  await withProvider(async ({ provider }) => {
    await seedTerminalExecution(provider)
    const events = new SqliteExecutionEventRepository(provider)
    await events.append(eventDraft())
    await publishEvent(provider)
    const { policy } = await addHold(provider, 'execution-events', {
      kind: 'project',
      workspaceId,
      projectId,
    })
    const journal = []
    const result = await events.deleteEligibleEvents(now, {
      policyRetainMs: 0,
      bound: 1,
      dryRun: false,
      retentionHoldPolicy: policy,
      journal: async (operations) => journal.push(...operations),
    })
    expect(result.scanned).toBe(1)
    expect(result.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(result.deleted).toBe(0)
    expect(journal).toEqual([])
    expect(await events.get(eventId)).toBeDefined()
  })
})

test('a concurrent hold writer serializes ahead of a claim on a second SQLite provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-hold-two-provider-'))
  const path = join(directory, 'state.sqlite')
  const provider = new SqlitePersistenceProvider({ path })
  const workerState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5))
  let holdWriter
  let claimWorker
  try {
    await provider.migrate()
    await seedTerminalExecution(provider)
    const events = new SqliteExecutionEventRepository(provider)
    await events.append(eventDraft())
    await publishEvent(provider)
    provider.close()

    const policy = policyFor('execution-events')
    const hold = {
      holdId: randomUUID(),
      classId: 'execution-events',
      scope: { kind: 'project', workspaceId, projectId },
      owner: 'retention-owner',
      reasonCode: 'legal-case',
      createdAt: '2026-09-01T12:00:00.000Z',
      createdBy: provenance,
      revision: 0,
    }
    const moduleUrl = new URL('./index.ts', import.meta.url).href
    holdWriter = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads')
        ;(async () => {
          const { SqlitePersistenceProvider } = await import(workerData.moduleUrl)
          const state = new Int32Array(workerData.workerState)
          const provider = new SqlitePersistenceProvider({ path: workerData.path })
          await provider.migrate()
          const acquire = new Promise((resolve) => parentPort.once('message', resolve))
          Atomics.store(state, 0, 1)
          Atomics.notify(state, 0)
          await acquire
          await provider.transaction(async (transaction) => {
            const commit = new Promise((resolve) => parentPort.once('message', resolve))
            Atomics.store(state, 2, 1)
            Atomics.notify(state, 2)
            await commit
            await transaction.put({
              namespace: 'retention-holds',
              id: workerData.hold.holdId,
              value: workerData.hold,
            })
          })
          provider.close()
          parentPort.postMessage({ type: 'hold-committed' })
        })().catch((error) => {
          const state = new Int32Array(workerData.workerState)
          Atomics.store(state, 4, 1)
          Atomics.notify(state, 4)
          parentPort.postMessage({ type: 'error', error: error?.stack ?? String(error) })
        })
      `,
      { eval: true, workerData: { path, moduleUrl, hold, workerState: workerState.buffer } }
    )
    claimWorker = new Worker(
      `
        const { parentPort, workerData } = require('node:worker_threads')
        ;(async () => {
          const { DatabaseSync } = require('node:sqlite')
          const { SqliteExecutionEventRepository, SqlitePersistenceProvider } =
            await import(workerData.moduleUrl)
          const state = new Int32Array(workerData.workerState)
          const provider = new SqlitePersistenceProvider({ path: workerData.path })
          await provider.migrate()
          const start = new Promise((resolve) => parentPort.once('message', resolve))
          Atomics.store(state, 1, 1)
          Atomics.notify(state, 1)
          await start
          const originalExec = DatabaseSync.prototype.exec
          let observeBegin = true
          DatabaseSync.prototype.exec = function (sql, ...parameters) {
            if (observeBegin && sql === 'BEGIN IMMEDIATE') {
              observeBegin = false
              // Force a short SQLite busy response so lock contention is
              // observed directly instead of inferred from message timing.
              originalExec.call(this, 'PRAGMA busy_timeout = 25')
              try {
                const result = originalExec.call(this, sql, ...parameters)
                Atomics.store(state, 3, 2)
                Atomics.notify(state, 3)
                return result
              } catch (error) {
                if (!/locked|busy/i.test(String(error?.message))) {
                  Atomics.store(state, 3, 3)
                  Atomics.notify(state, 3)
                  throw error
                }
                Atomics.store(state, 3, 1)
                Atomics.notify(state, 3)
                Atomics.wait(state, 3, 1)
                return originalExec.call(this, sql, ...parameters)
              }
            }
            return originalExec.call(this, sql, ...parameters)
          }
          const sweep = new SqliteExecutionEventRepository(provider).deleteEligibleEvents(
            new Date(workerData.now),
            {
              policyRetainMs: 0,
              dryRun: false,
              retentionHoldPolicy: workerData.policy,
            }
          )
          const result = await sweep
          provider.close()
          parentPort.postMessage({ type: 'sweep-complete', result })
        })().catch((error) => {
          const state = new Int32Array(workerData.workerState)
          Atomics.store(state, 4, 1)
          Atomics.notify(state, 4)
          parentPort.postMessage({ type: 'error', error: error?.stack ?? String(error) })
        })
      `,
      {
        eval: true,
        workerData: {
          path,
          moduleUrl,
          now: now.toISOString(),
          policy,
          workerState: workerState.buffer,
        },
      }
    )

    await Promise.all([
      waitForSharedValue(workerState, 0, [1], 'holder migration'),
      waitForSharedValue(workerState, 1, [1], 'sweeper migration'),
    ])
    const holdLocked = waitForSharedValue(workerState, 2, [1], 'holder transaction lock')
    holdWriter.postMessage('acquire-hold', [])
    await holdLocked
    const beginBlocked = waitForSharedValue(workerState, 3, [1, 2, 3], 'claim BEGIN result')
    claimWorker.postMessage('start-sweep', [])
    const beginResult = await beginBlocked
    if (beginResult !== 1) throw new Error('claim BEGIN did not contend with the active holder')
    const writerCommitted = waitForWorkerMessage(holdWriter, 'hold-committed')
    const sweepComplete = waitForWorkerMessage(claimWorker, 'sweep-complete')
    holdWriter.postMessage('commit-hold', [])
    await writerCommitted
    Atomics.store(workerState, 3, 2)
    Atomics.notify(workerState, 3)
    const { result } = await sweepComplete
    expect(result.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(result.deleted).toBe(0)

    // Tear down both native connection owners before reopening for verification.
    // A close acknowledgement alone does not settle the worker's native resources.
    await Promise.all([holdWriter.terminate(), claimWorker.terminate()])
    holdWriter = undefined
    claimWorker = undefined
    const verificationProvider = new SqlitePersistenceProvider({ path })
    try {
      await verificationProvider.migrate()
      expect(
        await new SqliteExecutionEventRepository(verificationProvider).get(eventId)
      ).toBeDefined()
    } finally {
      verificationProvider.close()
    }
  } finally {
    Atomics.store(workerState, 3, 2)
    Atomics.notify(workerState, 3)
    await holdWriter?.terminate()
    await claimWorker?.terminate()
    if (provider) {
      try {
        provider.close()
      } catch {
        // It may already be closed after the fixture was seeded.
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('holds never pause or reset either reference retention clock', async () => {
  await withProvider(async ({ provider }) => {
    const { plan } = await seedAcceptancePlan(provider)
    const plans = new SqliteExecutionPlanRepository(provider)
    const firstObservation = new Date('2026-09-01T00:00:00.000Z')
    await plans.deleteEligibleExecutionPlans(firstObservation, { policyRetainMs: 1, dryRun: false })
    const planWindowBefore = await provider.transaction((transaction) =>
      getReferenceRetentionWindow(transaction, 'executionPlans', storedId(plan.executionPlanId))
    )
    expect(planWindowBefore).toBe(firstObservation.toISOString())
    const { policy: planPolicy } = await addHold(provider, 'execution-plans', {
      kind: 'project',
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
    })
    const planResult = await plans.deleteEligibleExecutionPlans(
      new Date(firstObservation.getTime() + 2),
      {
        policyRetainMs: 1,
        dryRun: false,
        retentionHoldPolicy: planPolicy,
      }
    )
    const planWindowAfter = await provider.transaction((transaction) =>
      getReferenceRetentionWindow(transaction, 'executionPlans', storedId(plan.executionPlanId))
    )
    expect(planResult.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(planWindowAfter).toBe(planWindowBefore)
  })

  await withProvider(async ({ provider }) => {
    const package_ = contextPackageSerializationFixtures.futurePi
    const packages = new SqliteContextPackageRepository(provider)
    await packages.put(package_)
    const firstObservation = new Date('2026-09-01T00:00:00.000Z')
    await packages.deleteEligibleContextPackages(firstObservation, {
      policyRetainMs: 1,
      dryRun: false,
    })
    const packageWindowBefore = await provider.transaction((transaction) =>
      getReferenceRetentionWindow(
        transaction,
        'contextPackages',
        storedId(package_.contextPackageId)
      )
    )
    expect(packageWindowBefore).toBe(firstObservation.toISOString())
    const { policy } = await addHold(provider, 'context-packages', {
      kind: 'project',
      workspaceId: package_.projectState.workspaceId,
      projectId: package_.projectState.projectId,
    })
    const result = await packages.deleteEligibleContextPackages(
      new Date(firstObservation.getTime() + 2),
      {
        policyRetainMs: 1,
        dryRun: false,
        retentionHoldPolicy: policy,
      }
    )
    const packageWindowAfter = await provider.transaction((transaction) =>
      getReferenceRetentionWindow(
        transaction,
        'contextPackages',
        storedId(package_.contextPackageId)
      )
    )
    expect(result.retainedByReason).toEqual({ hold_recorded: 1 })
    expect(packageWindowAfter).toBe(packageWindowBefore)
  })
})
