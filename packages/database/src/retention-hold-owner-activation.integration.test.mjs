import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { eq, sql } from 'drizzle-orm'
import { loadDatabaseCredentials } from '@control-plane/config'
import { ControlApiFixtures } from '@control-plane/contracts'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { RuntimeConnectionRegistry } from '@control-plane/runtime-sdk'
import { PostgresCommandAcceptanceRepository } from './command-inbox-repository.ts'
import { PostgresExecutionEventRepository } from './execution-event-repository.ts'
import { PostgresExecutionCancellationRepository } from './execution-cancellation-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { PostgresInteractionCommandRepository } from './interaction-command-repository.ts'
import { PostgresInteractionRepository } from './interaction-repository.ts'
import { PostgresReceiptRetention } from './receipt-retention.ts'
import { PostgresRetentionHoldRepository } from './retention-hold-repository.ts'
import { PostgresRuntimeCommandRepository } from './runtime-command-repository.ts'
import { PostgresRuntimeConnectionRepository } from './runtime-connection-repository.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import { executionCancellations } from './schema/execution-cancellations.ts'
import { executionAttempts } from './schema/executions.ts'
import { runtimeEventReceipts } from './schema/runtime-event-receipts.ts'
import { retiredCommandKeys } from './schema/retired-command-keys.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const assessedAt = new Date('2026-09-24T12:00:00.000Z')
const postReleaseAssessedAt = new Date('2026-09-24T14:00:00.000Z')
const terminalAt = '2026-08-24T11:05:00.000Z'
const retentionMs = 30 * 24 * 60 * 60 * 1_000
const acceptancePlan = createExecutionPlanTestFixture()
const acceptancePlanReference = {
  executionPlanId: acceptancePlan.executionPlanId,
  contentDigest: acceptancePlan.contentDigest,
  schemaVersion: acceptancePlan.schemaVersion,
}
const provenance = {
  actorPrincipalRef: 'operator:os-user:postgres-test',
  authorityRef: 'authority:postgres:test-database',
}
const holdPolicy = {
  'execution-events': {
    owner: 'platform-operator',
    scopes: ['class', 'project'],
    reasonCodes: ['legal-case'],
  },
  'command-inbox': {
    owner: 'platform-operator',
    scopes: ['class', 'project'],
    reasonCodes: ['legal-case'],
  },
  'runtime-ledgers': {
    owner: 'runtime-owner',
    scopes: ['class', 'workspace'],
    reasonCodes: ['legal-case'],
  },
  executions: {
    owner: 'platform-operator',
    scopes: ['class', 'project'],
    reasonCodes: ['legal-case'],
  },
  'interaction-receipts': {
    owner: 'platform-operator',
    scopes: ['class', 'project'],
    reasonCodes: ['legal-case'],
  },
}

function makeHold(classId, owner, scope) {
  return {
    holdId: randomUUID(),
    classId,
    scope,
    owner,
    reasonCode: 'legal-case',
    createdAt: '2026-09-24T11:00:00.000Z',
    createdBy: provenance,
    revision: 0,
  }
}

function projectScope(execution) {
  return {
    kind: 'project',
    workspaceId: execution.correlation.workspaceId,
    projectId: execution.correlation.projectId,
  }
}

function executionInput(suffix) {
  return {
    callerPrincipalId: 'svc_retention-owner-activation',
    operation: 'execution.accept',
    commandId: `cmd_${suffix}`,
    requestId: `req_${suffix}`,
    idempotencyKey: `retention-owner-activation-${suffix}`,
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: `wsp_${suffix}`,
      projectId: `prj_${suffix}`,
      taskId: `tsk_${suffix}`,
      agentId: `agt_${suffix}`,
    },
    executionPlan: acceptancePlanReference,
    receivedAt: '2026-07-31T11:00:00.000Z',
    retentionExpiresAt: '2026-09-01T11:00:00.000Z',
  }
}

async function seedPlan(database) {
  await new PostgresContextPackageRepository(database).put(
    contextPackageSerializationFixtures.futurePi
  )
  await new PostgresExecutionPlanRepository(database).put(acceptancePlan)
}

async function acceptExecution(database, suffix) {
  const input = executionInput(suffix)
  const repository = new PostgresCommandAcceptanceRepository(database)
  const accepted = await new CommandInboxService({
    repository,
    executionIdFactory: () => `exe_${suffix}`,
    executionPlanValidator: { validate: async () => true },
    now: () => input.receivedAt,
  }).acceptExecution(input)
  return { input, accepted, repository }
}

async function terminalizeAccepted(database, accepted, input, at = terminalAt) {
  await database.execute(sql`
    update executions set state = 'completed', terminal_at = ${at}::timestamptz,
      updated_at = ${at}::timestamptz where execution_id = ${accepted.execution.executionId}
  `)
  await database.execute(sql`
    update command_inbox set status = 'completed', terminal_at = ${at}::timestamptz,
      result_reference = 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'
    where command_id = ${input.commandId}
  `)
}

async function createTerminalOwner(database, suffix) {
  const lifecycle = new ExecutionLifecycleService(new PostgresExecutionRepository(database))
  const execution = await lifecycle.createExecution({
    executionId: `exe_${suffix}`,
    correlation: {
      workspaceId: `wsp_${suffix}`,
      projectId: `prj_${suffix}`,
      taskId: `tsk_${suffix}`,
      agentId: `agt_${suffix}`,
      requestId: `req_${suffix}`,
    },
    executionPlan: acceptancePlanReference,
    acceptedAt: '2026-01-01T10:00:00.000Z',
  })
  const attempt = await lifecycle.createAttempt({
    executionId: execution.executionId,
    attemptId: `att_${suffix}`,
    expectedExecutionVersion: execution.version,
    queuedAt: '2026-01-02T10:00:00.000Z',
  })
  await lifecycle.transitionAttempt({
    attemptId: attempt.attemptId,
    expectedVersion: attempt.version,
    to: 'failed',
    transitionedAt: '2026-01-03T10:00:00.000Z',
    failure: { classification: 'runtime_error', code: 'RETENTION_OWNER_FIXTURE_TERMINAL' },
  })
  const current = await lifecycle.getExecution(execution.executionId)
  const terminal = await lifecycle.transitionExecution({
    executionId: execution.executionId,
    expectedVersion: current.version,
    to: 'failed',
    transitionedAt: '2026-01-04T10:00:00.000Z',
    failure: { classification: 'runtime_error', code: 'RETENTION_OWNER_FIXTURE_TERMINAL' },
  })
  return { execution: terminal, attemptId: attempt.attemptId, lifecycle }
}

describe.skipIf(!enabled)('PostgreSQL owner-scoped retention-hold activation', () => {
  const isolatedDatabases = []

  async function createDatabase() {
    const isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    isolatedDatabases.push(isolated)
    await isolated.migrate()
    await seedPlan(isolated.application)
    return isolated
  }

  afterEach(async () => {
    const created = isolatedDatabases.splice(0)
    const results = await Promise.allSettled(created.map((isolated) => isolated.dispose()))
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length > 0)
      throw new AggregateError(errors, 'ISOLATED_TEST_DATABASE_DISPOSAL_FAILED')
  })

  test('event and command holds preserve tenant scope, journals and replay fences', async () => {
    const database = (await createDatabase()).application
    const owner = await acceptExecution(database, '01CRZ3NDEKTSV4RRFFQ69G5FFB')
    const foreignOwner = await acceptExecution(database, '01CRZ3NDEKTSV4RRFFQ69G5FFA')
    await terminalizeAccepted(database, owner.accepted, owner.input)
    await terminalizeAccepted(database, foreignOwner.accepted, foreignOwner.input)

    const events = new PostgresExecutionEventRepository(database)
    const eventDraft = (eventId, execution) => ({
      eventId,
      executionId: execution.executionId,
      type: 'execution.progress',
      schemaVersion: 1,
      correlation: {
        workspaceId: execution.correlation.workspaceId,
        projectId: execution.correlation.projectId,
        taskId: execution.correlation.taskId,
        agentId: execution.correlation.agentId,
        requestId: execution.correlation.requestId,
        traceId: 'trc_01CRZ3NDEKTSV4RRFFQ69G5FFB',
      },
      payload: { step: 'owner-retention' },
      occurredAt: '2026-08-24T11:00:00.000Z',
      recordedAt: '2026-08-24T11:00:00.000Z',
      retentionExpiresAt: '2026-08-24T11:06:00.000Z',
    })
    const eventId = `evt_01CRZ3NDEKTSV4RRFFQ69G5FFB`
    const foreignEventId = `evt_01CRZ3NDEKTSV4RRFFQ69G5FFA`
    for (const [id, execution] of [
      [eventId, owner.accepted.execution],
      [foreignEventId, foreignOwner.accepted.execution],
    ]) {
      await events.append(eventDraft(id, execution))
      const event = await events.get(id)
      expect(
        await events.compareAndSetPublication(event.publication.version, {
          ...event,
          publication: {
            status: 'published',
            attempts: 1,
            version: event.publication.version + 1,
            publishedAt: '2026-08-24T11:01:00.000Z',
          },
        })
      ).toBe(true)
    }

    const holds = new PostgresRetentionHoldRepository(database, holdPolicy)
    const eventHold = makeHold(
      'execution-events',
      'platform-operator',
      projectScope(owner.accepted.execution)
    )
    const commandHold = makeHold(
      'command-inbox',
      'platform-operator',
      projectScope(owner.accepted.execution)
    )
    await holds.create(eventHold)
    await holds.create(commandHold)
    const eventJournal = []
    const options = {
      policyRetainMs: retentionMs,
      bound: 64,
      dryRun: false,
      retentionHoldPolicy: holdPolicy,
      journal: async (entries) => eventJournal.push(...entries),
    }
    const eventRetention = new PostgresExecutionEventRepository(database)
    const heldEvents = await eventRetention.deleteEligibleEvents(assessedAt, options)
    expect(heldEvents).toMatchObject({ deleted: 1, retainedByReason: { hold_recorded: 1 } })
    expect(
      eventJournal.map((entry) => entry.eventId ?? entry.operations?.[0]?.eventId)
    ).not.toContain(eventId)
    expect(await eventRetention.get(eventId)).toBeDefined()
    expect(await eventRetention.get(foreignEventId)).toBeUndefined()

    const releaseTime = '2026-09-24T13:00:00.000Z'
    await holds.release({
      holdId: eventHold.holdId,
      expectedRevision: 0,
      release: { requestId: randomUUID(), releasedAt: releaseTime, releasedBy: provenance },
    })
    const releasedEvents = await eventRetention.deleteEligibleEvents(postReleaseAssessedAt, options)
    expect(releasedEvents.deleted).toBe(1)
    expect(await eventRetention.get(eventId)).toBeUndefined()
    expect(
      await eventRetention.append(eventDraft(eventId, owner.accepted.execution))
    ).toBeUndefined()

    const commandScope = {
      callerPrincipalId: owner.input.callerPrincipalId,
      operation: owner.input.operation,
      workspaceId: owner.input.correlation.workspaceId,
      projectId: owner.input.correlation.projectId,
      idempotencyKey: owner.input.idempotencyKey,
    }
    expect(
      await owner.repository.retireExpiredCommand(commandScope, assessedAt.toISOString())
    ).toBe(true)
    const commandJournal = []
    const commandOptions = {
      ...options,
      journal: async (entries) => commandJournal.push(...entries),
    }
    const heldCommands = await owner.repository.deleteEligibleInbox(assessedAt, commandOptions)
    expect(heldCommands).toMatchObject({ deleted: 0, retainedByReason: { hold_recorded: 1 } })
    expect(commandJournal).toEqual([])
    expect(
      await owner.repository.getByExecutionId(owner.accepted.execution.executionId)
    ).toBeDefined()
    await holds.release({
      holdId: commandHold.holdId,
      expectedRevision: 0,
      release: { requestId: randomUUID(), releasedAt: releaseTime, releasedBy: provenance },
    })
    const releasedCommands = await owner.repository.deleteEligibleInbox(
      postReleaseAssessedAt,
      commandOptions
    )
    expect(releasedCommands.deleted).toBe(1)
    expect(commandJournal.map((entry) => entry.kind)).toEqual([
      'postgres.retireCommandKey',
      'postgres.deleteCommand',
    ])
    await expect(owner.repository.get(commandScope)).rejects.toMatchObject({
      code: 'COMMAND_RETENTION_EXPIRED',
    })
    const [retired] = await database
      .select()
      .from(retiredCommandKeys)
      .where(eq(retiredCommandKeys.commandId, owner.input.commandId))
    expect(retired).toBeDefined()
  }, 60_000)

  test('execution and runtime-ledger holds preserve complete attempt and receipt evidence', async () => {
    const database = (await createDatabase()).application
    const executionOwner = await createTerminalOwner(database, '01CRZ3NDEKTSV4RRFFQ69G5FFG')
    const runtimeOwner = await createTerminalOwner(database, '01CRZ3NDEKTSV4RRFFQ69G5FFH')
    const runtimeConnectionId = 'rtc_01CRZ3NDEKTSV4RRFFQ69G5FFH'
    const nodeId = 'rnr_01CRZ3NDEKTSV4RRFFQ69G5FFH'
    const workspaceId = runtimeOwner.execution.correlation.workspaceId
    await new RuntimeConnectionRegistry(new PostgresRuntimeConnectionRepository(database)).register(
      {
        runtimeConnectionId,
        identityDigest: `sha256:${'9'.repeat(64)}`,
        connectionType: 'managed_local',
        runtimeNodeRefId: nodeId,
        runtimeDefinitionId: 'rtd_01CRZ3NDEKTSV4RRFFQ69G5FFH',
        location: 'local_device',
        adapterVersion: '1.0.0',
        driverVersion: '1.0.0',
        harnessVersion: '1.0.0',
        status: 'connected',
        health: 'healthy',
        capabilities: [],
        compatibilityState: 'compatible',
        limitations: [],
        lastDiscoveredAt: '2026-08-24T23:00:00.000Z',
        lastHeartbeatAt: '2026-08-24T23:00:00.000Z',
        lastHealthCheckAt: '2026-08-24T23:00:00.000Z',
      }
    )
    const runtimeRepository = new PostgresRuntimeCommandRepository(database)
    const base = {
      executionId: runtimeOwner.execution.executionId,
      attemptId: runtimeOwner.attemptId,
      nodeId,
      runtimeConnectionId,
      workspaceId,
      idempotencyKey: 'runtime-command:retention-owner-activation',
      payloadHash: `sha256:${'4'.repeat(64)}`,
      commandEnvelope: { operation: 'runtime.cancel' },
      issuedAt: '2026-08-24T23:00:02.000Z',
      expiresAt: '2026-08-24T23:10:02.000Z',
      version: 1,
      deliveryAttempts: 0,
      createdAt: '2026-08-24T23:00:02.000Z',
      updatedAt: '2026-08-24T23:00:02.000Z',
    }
    const runtimeCommandId = 'cmd_01CRZ3NDEKTSV4RRFFQ69G5FFH'
    expect(
      (await runtimeRepository.create({ ...base, commandId: runtimeCommandId, status: 'queued' }))
        .outcome
    ).toBe('created')
    const runtimeSettledAt = '2026-08-24T23:05:00.000Z'
    expect(
      await runtimeRepository.compareAndSet(1, {
        ...base,
        commandId: runtimeCommandId,
        status: 'succeeded',
        version: 2,
        deliveryAttempts: 1,
        lastChannelGeneration: 1,
        lastSequence: 1,
        firstDispatchedAt: runtimeSettledAt,
        lastDispatchedAt: runtimeSettledAt,
        acknowledgementReference: 'ack-runtime-retention-owner-0001',
        acknowledgementDisposition: 'accepted',
        acknowledgedAt: runtimeSettledAt,
        resultStatus: 'succeeded',
        resultRecordedAt: runtimeSettledAt,
        updatedAt: runtimeSettledAt,
      })
    ).toBe(true)
    await database.execute(sql`
      insert into runtime_event_receipts (command_id, message_kind, message_sequence, frame_hash, outcome, recorded_at)
      values (${runtimeCommandId}, 'progress', 1, ${`s2:${'a'.repeat(64)}`}, 'applied', ${runtimeSettledAt}::timestamptz)
    `)

    const holds = new PostgresRetentionHoldRepository(database, holdPolicy)
    const executionHold = makeHold(
      'executions',
      'platform-operator',
      projectScope(executionOwner.execution)
    )
    const runtimeHold = makeHold('runtime-ledgers', 'runtime-owner', {
      kind: 'workspace',
      workspaceId,
    })
    await holds.create(executionHold)
    await holds.create(runtimeHold)
    const journal = []
    const options = {
      policyRetainMs: retentionMs,
      bound: 64,
      dryRun: false,
      retentionHoldPolicy: holdPolicy,
      journal: async (entries) => journal.push(...entries),
    }

    const executionRetention = new PostgresExecutionRepository(database)
    const heldExecution = await executionRetention.deleteEligibleExecutions(assessedAt, options)
    expect(heldExecution).toMatchObject({
      deleted: 0,
      retainedByReason: { hold_recorded: 1, reference_pending: 1 },
    })
    expect(journal).toEqual([])
    expect(
      await executionRetention.getExecution(executionOwner.execution.executionId)
    ).toBeDefined()
    expect(
      await database
        .select()
        .from(executionAttempts)
        .where(eq(executionAttempts.attemptId, executionOwner.attemptId))
    ).toHaveLength(1)

    const runtimeRetention = new PostgresRuntimeCommandRepository(database)
    const heldRuntime = await runtimeRetention.deleteEligibleRuntimeCommands(assessedAt, options)
    expect(heldRuntime).toMatchObject({ deleted: 0, retainedByReason: { hold_recorded: 1 } })
    expect(await runtimeRetention.get(runtimeCommandId)).toBeDefined()
    expect(
      await database
        .select()
        .from(runtimeEventReceipts)
        .where(eq(runtimeEventReceipts.commandId, runtimeCommandId))
    ).toHaveLength(1)
    expect(journal).toEqual([])

    const release = {
      requestId: randomUUID(),
      releasedAt: '2026-09-24T13:00:00.000Z',
      releasedBy: provenance,
    }
    await holds.release({ holdId: runtimeHold.holdId, expectedRevision: 0, release })
    const removedRuntime = await runtimeRetention.deleteEligibleRuntimeCommands(
      postReleaseAssessedAt,
      options
    )
    expect(removedRuntime.deleted).toBe(1)
    expect(journal).toEqual([
      { kind: 'postgres.deleteRuntimeCommand', commandId: runtimeCommandId },
    ])
    expect(await runtimeRetention.get(runtimeCommandId)).toBeUndefined()
    expect(
      await database
        .select()
        .from(runtimeEventReceipts)
        .where(eq(runtimeEventReceipts.commandId, runtimeCommandId))
    ).toHaveLength(0)

    await holds.release({ holdId: executionHold.holdId, expectedRevision: 0, release })
    journal.length = 0
    const removedExecution = await executionRetention.deleteEligibleExecutions(
      postReleaseAssessedAt,
      options
    )
    expect(removedExecution.deleted).toBe(2)
    expect(journal).toContainEqual({
      kind: 'postgres.deleteExecution',
      executionId: executionOwner.execution.executionId,
    })
    expect(
      await executionRetention.getExecution(executionOwner.execution.executionId)
    ).toBeUndefined()
  }, 60_000)

  test('interaction and cancellation receipts stay owner-bound until release', async () => {
    const database = (await createDatabase()).application
    const owner = await createTerminalOwner(database, '01CRZ3NDEKTSV4RRFFQ69G5FFJ')
    const executionId = owner.execution.executionId
    const workspaceId = owner.execution.correlation.workspaceId
    const projectId = owner.execution.correlation.projectId
    const acceptedAt = '2026-01-06T10:00:00.000Z'
    const interactionId = 'int_01CRZ3NDEKTSV4RRFFQ69G5FFJ'
    const interactionAttemptId = owner.attemptId
    const responseId = 'cmd_01CRZ3NDEKTSV4RRFFQ69G5FFJ'
    await new PostgresInteractionRepository(database).insert({
      interactionId,
      executionId,
      attemptId: interactionAttemptId,
      kind: 'approval',
      prompt: { title: 'Approve the operation' },
      allowedActions: ['approve', 'deny'],
      allowedPrincipalIds: ['svc_agent-hq'],
      state: 'responded',
      version: 2,
      requestedAt: '2026-01-05T10:00:00.000Z',
      expiresAt: '2026-01-05T11:00:00.000Z',
      response: {
        responseId,
        action: 'approve',
        respondingPrincipalId: 'svc_agent-hq',
        respondedAt: acceptedAt,
      },
    })

    const interactionRequest = {
      ...ControlApiFixtures.interactionResponse.request,
      workspaceId,
      projectId,
      idempotencyKey: 'retention-owner-interaction-1',
      payload: {
        ...ControlApiFixtures.interactionResponse.request.payload,
        executionId,
        attemptId: interactionAttemptId,
        interactionId,
      },
    }
    const interactionRepository = new PostgresInteractionCommandRepository(database)
    await interactionRepository.reserve({ request: interactionRequest })
    await interactionRepository.markAccepted(interactionRequest, acceptedAt)

    const cancellationRequest = {
      ...ControlApiFixtures.executionCancellation.request,
      workspaceId,
      projectId,
      idempotencyKey: 'retention-owner-cancellation-1',
      payload: { executionId },
    }
    const cancellationRepository = new PostgresExecutionCancellationRepository(database)
    await cancellationRepository.reserve({ request: cancellationRequest })
    await cancellationRepository.markAccepted(cancellationRequest, acceptedAt)
    // Reserve uses the database's wall clock. Model the historical creation
    // instant as well as acceptance; otherwise these rows are not candidates.
    await database.execute(sql`
      update interaction_commands set created_at = ${acceptedAt}::timestamptz
    `)
    await database.execute(sql`
      update execution_cancellations set created_at = ${acceptedAt}::timestamptz
    `)

    const holds = new PostgresRetentionHoldRepository(database, holdPolicy)
    const hold = makeHold(
      'interaction-receipts',
      'platform-operator',
      projectScope(owner.execution)
    )
    await holds.create(hold)
    const journal = []
    const retention = new PostgresReceiptRetention(database)
    const options = {
      policyRetainMs: retentionMs,
      bound: 64,
      dryRun: false,
      retentionHoldPolicy: holdPolicy,
      journal: async (entries) => journal.push(...entries),
    }
    const held = await retention.sweepEligibleInteractionReceipts(assessedAt, options)
    expect(held).toMatchObject({ deleted: 0, retainedByReason: { hold_recorded: 2 } })
    expect(journal).toEqual([])
    expect(await interactionRepository.get(interactionRequest)).toBeDefined()
    expect(await cancellationRepository.get(cancellationRequest)).toBeDefined()

    const release = {
      requestId: randomUUID(),
      releasedAt: '2026-09-24T13:00:00.000Z',
      releasedBy: provenance,
    }
    await holds.release({ holdId: hold.holdId, expectedRevision: 0, release })

    // These well-formed receipts lack valid canonical owner proof: one points
    // to no execution and the other disagrees with the existing owner's scope.
    const orphanRequest = {
      ...ControlApiFixtures.executionCancellation.request,
      workspaceId,
      projectId,
      idempotencyKey: 'retention-owner-missing-owner-1',
      payload: { executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    }
    const mismatchedRequest = {
      ...ControlApiFixtures.executionCancellation.request,
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW',
      idempotencyKey: 'retention-owner-scope-mismatch-1',
      payload: { executionId },
    }
    const orphanReceipt = { request: orphanRequest, acceptedAt }
    const mismatchedReceipt = { request: mismatchedRequest, acceptedAt }
    const orphanKey = '0'.repeat(64)
    const mismatchKey = 'f'.repeat(64)
    await database.execute(sql`
      insert into execution_cancellations (command_key, workspace_id, project_id, receipt, created_at)
      values (${orphanKey}, ${workspaceId}, ${projectId}, ${JSON.stringify(orphanReceipt)}::jsonb, ${'2026-01-06T10:00:00.000Z'}::timestamptz)
    `)
    await database.execute(sql`
      insert into execution_cancellations (command_key, workspace_id, project_id, receipt, created_at)
      values (${mismatchKey}, ${mismatchedRequest.workspaceId}, ${mismatchedRequest.projectId}, ${JSON.stringify(mismatchedReceipt)}::jsonb, ${'2026-01-06T10:00:00.000Z'}::timestamptz)
    `)
    journal.length = 0
    const released = await retention.sweepEligibleInteractionReceipts(
      postReleaseAssessedAt,
      options
    )
    expect(released.deleted).toBe(2)
    expect(journal).toHaveLength(2)
    expect(await interactionRepository.get(interactionRequest)).toBeUndefined()
    expect(await cancellationRepository.get(cancellationRequest)).toBeUndefined()
    const unsafe = await database
      .select({ commandKey: executionCancellations.commandKey })
      .from(executionCancellations)
      .where(sql`${executionCancellations.commandKey} in (${orphanKey}, ${mismatchKey})`)
    expect(unsafe.map((row) => row.commandKey).toSorted()).toEqual([orphanKey, mismatchKey])
  }, 60_000)
})
