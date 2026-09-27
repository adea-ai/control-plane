import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { CommandInboxService } from '../packages/domain/src/index.ts'
import { contextPackageSerializationFixtures } from '../packages/context/src/index.ts'
import { createExecutionPlanTestFixture } from '../packages/execution-plan/src/testing.ts'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteDurableUsageStore,
  SqliteExecutionPlanRepository,
} from '../packages/sqlite-persistence/src/index.ts'
import { DurableUsageLedger } from '../packages/usage-ledger/src/index.ts'
import { LocalControlPlaneComposition } from '../apps/local-control-plane/src/composition.ts'
import {
  LangGraphSqliteCheckpointSaver,
  LangGraphOrchestrationAdapter,
  deterministicInterruptGraph,
} from '../packages/langgraph-adapter/src/index.ts'
import { OrchestrationGraphSegmentActivities } from '../packages/workflow-runtime/src/index.ts'

const acceptedAt = '2026-09-27T00:00:00.000Z'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const workflowId = 'wfl_01JABCDEF0123456789ABCDEFG'

async function acceptGraphExecution(composition) {
  const plan = createExecutionPlanTestFixture()
  await new SqliteContextPackageRepository(composition.persistence).put(
    contextPackageSerializationFixtures.futurePi
  )
  const planReference = await new SqliteExecutionPlanRepository(composition.persistence).put(plan)
  const executionPlan = { ...planReference, schemaVersion: plan.schemaVersion }
  const commands = new CommandInboxService({
    repository: new SqliteCommandAcceptanceRepository(composition.persistence, {
      budgetAdmission: true,
    }),
    executionIdFactory: () => executionId,
    executionPlanValidator: { validate: async () => true },
    now: () => acceptedAt,
  })
  const accepted = await commands.acceptExecution({
    callerPrincipalId: 'svc_m11-graph-test',
    operation: 'execution.accept',
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    idempotencyKey: 'm11-graph-composition-0001',
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
    },
    executionPlan,
    receivedAt: acceptedAt,
    retentionExpiresAt: '2026-10-27T00:00:00.000Z',
  })
  const attempt = await composition.executionLifecycleActivities.ensureAttempt({
    executionId: accepted.execution.executionId,
    workflowId,
    effectKey: 'm11-graph-composition-attempt',
  })
  return { accepted, attempt, plan }
}

async function closeUnstartedLocalComposition(composition) {
  await composition.close()
  composition.persistence.close({ checkpoint: true })
}

test('Local and Hosted Simple forward graph lifecycle operations after SQLite admission', async () => {
  for (const profile of ['local', 'hosted-simple']) {
    const directory = await mkdtemp(join(tmpdir(), 'm11-graph-composition-'))
    const calls = []
    const graphActivities = Object.fromEntries(
      ['runGraphSegment', 'resumeGraphSegment', 'continueGraphSegment', 'cancelGraphSegment'].map(
        (operation) => [
          operation,
          async (input) => {
            calls.push({ operation, input })
            return { outcome: 'continue', checkpointId: 'checkpoint-one' }
          },
        ]
      )
    )
    const composition = new LocalControlPlaneComposition({
      dataDirectory: directory,
      profile,
      runtimeTransport: { transportKind: 'direct-local' },
      graphActivities,
    })
    try {
      await composition.persistence.migrate()
      const owner = await acceptGraphExecution(composition)
      const activities = composition.executionLifecycleActivities
      const input = {
        executionId: owner.accepted.execution.executionId,
        attemptId: owner.attempt.attemptId,
        workspaceId: owner.plan.correlation.workspaceId,
        workflowId,
        graph: {
          graphDefinitionId: 'graph-one',
          graphVersion: '1.0.0',
          contentDigest: `sha256:${'a'.repeat(64)}`,
        },
        threadId: 'thread-one',
        input: { objective: 'forward graph operations' },
        idempotencyKey: 'effect-one',
      }
      const expectedGraphInputs = []
      for (const operation of ['runGraphSegment', 'resumeGraphSegment', 'continueGraphSegment']) {
        const operationInput =
          operation === 'runGraphSegment'
            ? input
            : {
                executionId: input.executionId,
                attemptId: input.attemptId,
                workspaceId: input.workspaceId,
                workflowId: input.workflowId,
                graph: input.graph,
                threadId: input.threadId,
                checkpointId: 'checkpoint-one',
                ...(operation === 'resumeGraphSegment' ? { response: { action: 'approve' } } : {}),
                idempotencyKey: `effect-${operation}`,
              }
        expectedGraphInputs.push(operationInput)
        expect(await activities[operation](operationInput)).toEqual({
          outcome: 'continue',
          checkpointId: 'checkpoint-one',
        })
      }
      expect(calls.map(({ input: graphInput }) => graphInput)).toEqual(expectedGraphInputs)
      await new DurableUsageLedger({
        store: new SqliteDurableUsageStore(composition.persistence),
      }).finalizeBudget({
        workspaceId: owner.plan.correlation.workspaceId,
        executionId: input.executionId,
        source: {
          sourceId: 'fixture:graph-test-finalize',
          idempotencyKey: 'fixture:graph-test-finalize',
        },
      })
      const callbacksBeforeDeniedGraphOperations = calls.length
      for (const operation of ['runGraphSegment', 'resumeGraphSegment', 'continueGraphSegment']) {
        const operationInput =
          operation === 'runGraphSegment'
            ? input
            : {
                executionId: input.executionId,
                attemptId: input.attemptId,
                workspaceId: input.workspaceId,
                workflowId: input.workflowId,
                graph: input.graph,
                threadId: input.threadId,
                checkpointId: 'checkpoint-one',
                ...(operation === 'resumeGraphSegment' ? { response: { action: 'approve' } } : {}),
                idempotencyKey: `effect-denied-${operation}`,
              }
        await expect(activities[operation](operationInput)).rejects.toThrow(
          'RUNTIME_BUDGET_ADMISSION_DENIED'
        )
        expect(calls).toHaveLength(callbacksBeforeDeniedGraphOperations)
      }
      await activities.cancelActive({
        executionId: input.executionId,
        attemptId: input.attemptId,
        workflowId: input.workflowId,
        effectKey: input.idempotencyKey,
        reason: 'deadline',
        graph: { workspaceId: input.workspaceId, reference: input.graph, threadId: input.threadId },
      })
      expect(calls.map(({ operation }) => operation)).toEqual([
        'runGraphSegment',
        'resumeGraphSegment',
        'continueGraphSegment',
        'cancelGraphSegment',
      ])
      expect(calls[3].input).toEqual({
        executionId: input.executionId,
        attemptId: input.attemptId,
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        graph: input.graph,
        threadId: input.threadId,
        reason: 'deadline',
        idempotencyKey: input.idempotencyKey,
      })
    } finally {
      await closeUnstartedLocalComposition(composition)
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('Local refuses graph options that would silently be ignored', () => {
  expect(
    () =>
      new LocalControlPlaneComposition({
        dataDirectory: '/unused',
        graphActivities: {},
        activities: {},
      })
  ).toThrow('LOCAL_GRAPH_ACTIVITIES_CONFIGURATION_CONFLICT')
  expect(
    () => new LocalControlPlaneComposition({ dataDirectory: '/unused', graphActivities: {} })
  ).toThrow('LOCAL_GRAPH_RUNTIME_REQUIRED')
})

test('Local and Hosted Simple resume graph approval from their own SQLite database after reconstruction', async () => {
  for (const profile of ['local', 'hosted-simple']) {
    const directory = await mkdtemp(join(tmpdir(), 'm11-graph-local-recovery-'))
    const graph = {
      graphDefinitionId: 'local-recovery',
      graphVersion: '1.0.0',
      contentDigest: `sha256:${'a'.repeat(64)}`,
    }
    const workspaceId = createExecutionPlanTestFixture().correlation.workspaceId
    const calls = []
    const createComposition = () =>
      new LocalControlPlaneComposition({
        dataDirectory: directory,
        profile,
        runtimeTransport: { transportKind: 'direct-local' },
        workflowRuntime: {
          start: async () => {},
          stop: async () => {},
          health: async () => ({ ready: true, component: 'restate', version: '1.7.9' }),
        },
        endpointFactory: {
          create: async () => ({ run: async () => {}, shutdown: async () => {} }),
        },
        graphActivitiesFactory: ({ persistence }) =>
          new OrchestrationGraphSegmentActivities(
            new LangGraphOrchestrationAdapter({
              checkpointer: new LangGraphSqliteCheckpointSaver(persistence, workspaceId),
              graphs: [deterministicInterruptGraph(graph)],
              operations: {
                invoke: async ({ name }) => {
                  calls.push(name)
                  return { value: name }
                },
                cancel: async () => true,
              },
              events: { publish: async () => {} },
            })
          ),
      })
    let composition = createComposition()
    try {
      await composition.persistence.migrate()
      const owner = await acceptGraphExecution(composition)
      const request = {
        executionId: owner.accepted.execution.executionId,
        attemptId: owner.attempt.attemptId,
        workspaceId: owner.plan.correlation.workspaceId,
        workflowId,
        graph,
        threadId: 'local-thread',
        input: { objective: 'recover approval' },
        idempotencyKey: 'local:graph:run',
      }
      await composition.start()
      const paused = await composition.executionLifecycleActivities.runGraphSegment(request)
      expect(paused).toMatchObject({ outcome: 'awaiting_input', interactionId: 'approval-1' })
      await composition.close()
      composition = createComposition()
      await composition.start()
      const { input: _input, ...resume } = request
      const completed = await composition.executionLifecycleActivities.resumeGraphSegment({
        ...resume,
        checkpointId: paused.checkpointId,
        response: { action: 'approve' },
        idempotencyKey: 'local:graph:resume',
      })
      expect(completed.outcome).toBe('completed')
      expect(calls).toEqual(['prepare', 'finalize'])
    } finally {
      await composition.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('Local rejects conflicting graph factories before invoking them', () => {
  let called = false
  const graphActivitiesFactory = () => {
    called = true
    return {}
  }
  for (const extra of [{ graphActivities: {} }, { activities: {} }, {}]) {
    expect(
      () =>
        new LocalControlPlaneComposition({
          dataDirectory: '/unused',
          graphActivitiesFactory,
          ...extra,
        })
    ).toThrow()
  }
  expect(called).toBe(false)
})
