import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteExecutionEventRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import { DurableGraphEventPublisher } from './index.ts'

const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
const staleAttemptId = 'att_01JABCDEF0123456789ABCDEFH'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const graphReference = {
  graphDefinitionId: 'review-task',
  graphVersion: '1.0.0',
  contentDigest: `sha256:${'c'.repeat(64)}`,
}
const now = '2026-09-30T12:00:00.000Z'
const retentionMs = 30 * 24 * 60 * 60 * 1_000

async function createEnvironment({ graph = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'graph-event-publisher-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  await provider.migrate()
  const inputs = {
    ...createExecutionPlanTestFixtureInputs(),
    contextPackage: contextPackageSerializationFixtures.futurePi,
    ...(graph
      ? {
          graph: {
            reference: graphReference,
            input: { objective: 'Persist a graph execution' },
          },
        }
      : {}),
  }
  const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
  await new SqliteContextPackageRepository(provider).put(inputs.contextPackage)
  const plans = new SqliteExecutionPlanRepository(provider)
  await plans.put(plan)
  const commands = new SqliteCommandAcceptanceRepository(provider)
  const acceptance = new CommandInboxService({
    repository: commands,
    executionIdFactory: () => executionId,
    executionPlanValidator: { validate: async () => true, authorize: async () => true },
    now: () => now,
  })
  const accepted = await acceptance.acceptExecution({
    callerPrincipalId: 'svc_agent-hq',
    operation: 'execution.accept',
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    idempotencyKey: 'graph-events-acceptance-1',
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
    },
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    receivedAt: now,
    retentionExpiresAt: '2027-01-01T12:00:00.000Z',
  })
  const executions = new SqliteExecutionRepository(provider)
  const lifecycle = new ExecutionLifecycleService(executions)
  let execution = await lifecycle.transitionExecution({
    executionId,
    expectedVersion: accepted.execution.version,
    to: 'queued',
    transitionedAt: '2026-09-30T12:00:01.000Z',
  })
  const attempt = await lifecycle.createAttempt({
    executionId,
    attemptId,
    expectedExecutionVersion: execution.version,
    queuedAt: '2026-09-30T12:00:02.000Z',
  })
  execution = await lifecycle.getExecution(executionId)
  await lifecycle.transitionExecution({
    executionId,
    expectedVersion: execution.version,
    to: 'running',
    transitionedAt: '2026-09-30T12:00:03.000Z',
  })
  await lifecycle.transitionAttempt({
    attemptId,
    expectedVersion: attempt.version,
    to: 'running',
    transitionedAt: '2026-09-30T12:00:03.000Z',
  })

  const events = new SqliteExecutionEventRepository(provider)
  const publisher = (clock = () => now) =>
    new DurableGraphEventPublisher({
      commands,
      attempts: executions,
      plans,
      events,
      retentionMs,
      now: clock,
    })
  return {
    directory,
    path,
    get provider() {
      return provider
    },
    replaceProvider(next) {
      provider = next
    },
    commands,
    executions,
    plans,
    events,
    publisher,
    plan,
  }
}

function graphEvent(overrides = {}) {
  return {
    executionId,
    attemptId,
    workspaceId,
    workflowId: `wfl_${executionId.slice(4)}`,
    threadId: `graph:${executionId}`,
    sequence: 1,
    type: 'graph.node.started',
    node: 'prepare',
    occurredAt: '2026-09-30T12:00:04.000Z',
    details: { kind: 'runtime', operation: 'prepare' },
    ...overrides,
  }
}

test('publishes canonical graph events from trusted SQLite records and deduplicates after restart', async () => {
  const environment = await createEnvironment()
  let provider = environment.provider
  const secretCanary = 'graph-event-secret-canary-7f31'
  const event = graphEvent({ details: { kind: 'tool', operation: 'lookup', token: secretCanary } })
  try {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        environment.publisher().publish(event, 'graph:step:prepare:visit:1')
      )
    )
    const pending = await environment.events.queryPending(10)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      executionId,
      attemptId,
      workflowId: `wfl_${executionId.slice(4)}`,
      type: 'graph.node_started',
      schemaVersion: 1,
      sensitivity: 'internal',
      redaction: 'redacted',
      recordedAt: now,
      retentionExpiresAt: new Date(Date.parse(now) + retentionMs).toISOString(),
      publication: { status: 'pending', attempts: 0, version: 1 },
      correlation: {
        workspaceId,
        projectId: environment.plan.correlation.projectId,
        taskId: environment.plan.correlation.taskId,
        agentId: environment.plan.correlation.agentId,
        requestId: environment.plan.correlation.requestId,
        commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      },
      payload: {
        callerPrincipalId: 'svc_agent-hq',
        threadId: `graph:${executionId}`,
        graph: graphReference,
        node: 'prepare',
        details: { kind: 'tool', operation: 'lookup', token: '[REDACTED]' },
      },
    })
    expect(JSON.stringify(pending)).not.toContain(secretCanary)

    await provider.close()
    provider = new SqlitePersistenceProvider({ path: environment.path })
    environment.replaceProvider(provider)
    await provider.migrate()
    const restartedEvents = new SqliteExecutionEventRepository(provider)
    const replayPublisher = new DurableGraphEventPublisher({
      commands: new SqliteCommandAcceptanceRepository(provider),
      attempts: new SqliteExecutionRepository(provider),
      plans: new SqliteExecutionPlanRepository(provider),
      events: restartedEvents,
      retentionMs,
      now: () => '2026-09-30T12:01:00.000Z',
    })
    await replayPublisher.publish(
      { ...event, occurredAt: '2026-09-30T12:00:59.000Z' },
      'graph:step:prepare:visit:1'
    )
    const replayed = await restartedEvents.queryPending(10)
    expect(replayed).toHaveLength(1)
    expect(replayed[0].occurredAt).toBe(event.occurredAt)
    expect(replayed[0].recordedAt).toBe(now)
    expect(await restartedEvents.queryAfter(executionId, 0, 10)).toEqual(replayed)
  } finally {
    await provider.close()
    await rm(environment.directory, { recursive: true, force: true })
  }
})

test('maps only the canonical graph lifecycle vocabulary to public event names', async () => {
  const environment = await createEnvironment()
  try {
    const publisher = environment.publisher()
    const events = [
      graphEvent({ type: 'graph.started', sequence: 1, node: undefined }),
      graphEvent({ type: 'graph.node.started', sequence: 2 }),
      graphEvent({ type: 'graph.node.completed', sequence: 3 }),
      graphEvent({ type: 'graph.completed', sequence: 4, node: undefined }),
    ]
    for (const [index, event] of events.entries()) {
      await publisher.publish(event, `graph:lifecycle:${index + 1}`)
    }

    expect(
      (await environment.events.queryAfter(executionId, 0, 10)).map(({ type }) => type)
    ).toEqual(['graph.started', 'graph.node_started', 'graph.node_completed', 'graph.completed'])
  } finally {
    await environment.provider.close()
    await rm(environment.directory, { recursive: true, force: true })
  }
})

test('rejects forged scope, thread, stale attempt and plans without a pinned graph', async () => {
  const environment = await createEnvironment()
  try {
    const publisher = environment.publisher()
    const lifecycle = new ExecutionLifecycleService(environment.executions)
    const currentExecution = await environment.commands.getExecution(executionId)
    const nextAttempt = await lifecycle.createAttempt({
      executionId,
      attemptId: staleAttemptId,
      expectedExecutionVersion: currentExecution.version,
      queuedAt: '2026-09-30T12:00:04.000Z',
    })
    await lifecycle.transitionAttempt({
      attemptId: staleAttemptId,
      expectedVersion: nextAttempt.version,
      to: 'running',
      transitionedAt: '2026-09-30T12:00:05.000Z',
    })
    const invalidEvents = [
      graphEvent({ workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' }),
      graphEvent({ workflowId: 'wfl_01JABCDEF0123456789ABCDEFH' }),
      graphEvent({ threadId: 'graph:exe_01JABCDEF0123456789ABCDEFH' }),
      graphEvent({ attemptId }),
      graphEvent({ attemptId: 'att_01JABCDEF0123456789ABCDEFJ' }),
    ]
    for (const [index, event] of invalidEvents.entries()) {
      await expect(publisher.publish(event, `graph:forged:${index}:1`)).rejects.toMatchObject({
        name: 'GraphEventPublicationError',
      })
    }
    expect(await environment.events.queryPending(10)).toEqual([])
  } finally {
    await environment.provider.close()
    await rm(environment.directory, { recursive: true, force: true })
  }

  const unpinned = await createEnvironment({ graph: false })
  try {
    await expect(
      unpinned.publisher().publish(graphEvent(), 'graph:unapproved:1')
    ).rejects.toMatchObject({ code: 'GRAPH_PLAN_REQUIRED' })
    expect(await unpinned.events.queryPending(10)).toEqual([])
  } finally {
    await unpinned.provider.close()
    await rm(unpinned.directory, { recursive: true, force: true })
  }
})

test('rejects oversized redacted detail payloads before persisting an event', async () => {
  const environment = await createEnvironment()
  try {
    await expect(
      environment
        .publisher()
        .publish(
          graphEvent({ details: { context: 'x'.repeat(20_000) } }),
          'graph:step:prepare:oversized:1'
        )
    ).rejects.toMatchObject({ code: 'EVENT_PAYLOAD_TOO_LARGE' })
    expect(await environment.events.queryPending(10)).toEqual([])
  } finally {
    await environment.provider.close()
    await rm(environment.directory, { recursive: true, force: true })
  }
})

test('conflicts when the same scoped event identity is replayed with different semantics', async () => {
  const environment = await createEnvironment()
  try {
    const publisher = environment.publisher()
    const key = 'graph:step:prepare:visit:1'
    await publisher.publish(graphEvent(), key)
    await expect(
      publisher.publish(graphEvent({ type: 'graph.node.completed' }), key)
    ).rejects.toMatchObject({ code: 'GRAPH_EVENT_IDEMPOTENCY_CONFLICT' })
    expect(await environment.events.queryPending(10)).toHaveLength(1)
  } finally {
    await environment.provider.close()
    await rm(environment.directory, { recursive: true, force: true })
  }
})
