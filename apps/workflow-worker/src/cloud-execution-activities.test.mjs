import { describe, expect, test } from 'bun:test'
import { InMemoryExecutionRepository, ExecutionLifecycleService } from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  InMemoryExecutionPlanRepository,
} from '@control-plane/execution-plan'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'
import { DurableExecutionLifecycleActivities } from './cloud-execution-activities.ts'

const ids = {
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workflowId: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}

describe('durable Cloud execution activities', () => {
  test('freezes the selected remote runtime on the durable attempt before dispatch', async () => {
    const repository = new InMemoryExecutionRepository()
    const lifecycle = new ExecutionLifecycleService(repository)
    const plans = new InMemoryExecutionPlanRepository()
    const plan = executionPlan()
    await plans.put(plan)
    await lifecycle.createExecution({
      executionId: ids.executionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt: '2026-08-28T12:00:00.000Z',
    })
    const selected = {
      runtimeDefinitionId: 'rtd_01JABCDEF0123456789ABCDEFG',
      runtimeNodeRefId: 'rnr_01JABCDEF0123456789ABCDEFG',
      runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG',
      routingDecision: {
        routingVersion: 1,
        policy: {
          policyId: 'runtime-routing-v1',
          version: 1,
          digest: `sha256:${'a'.repeat(64)}`,
        },
        evaluatedAt: '2026-08-28T12:00:00.000Z',
        inputDigest: `sha256:${'b'.repeat(64)}`,
        decisionDigest: `sha256:${'c'.repeat(64)}`,
        selectedRank: 1,
        candidateCount: 1,
        reasonCodes: ['RUNTIME_SELECTED'],
      },
    }
    let resolutions = 0
    const activity = activities({
      lifecycle,
      plans,
      runtime: runtimePort(),
      runtimeRouter: {
        resolve: async (input) => {
          resolutions += 1
          expect(input.executionPlan).toEqual(plan)
          expect(input.execution.executionId).toBe(ids.executionId)
          return selected
        },
      },
    })

    await activity.persistStatus(status('queued'))
    await activity.ensureAttempt(attemptInput())
    await activity.ensureAttempt(attemptInput())
    expect(await repository.getAttempt(ids.attemptId)).toMatchObject({ runtime: selected })
    expect(resolutions).toBe(1)
  })

  test('converges lifecycle replay on one attempt and one terminal result across restart', async () => {
    const repository = new InMemoryExecutionRepository()
    const lifecycle = new ExecutionLifecycleService(repository)
    const plans = new InMemoryExecutionPlanRepository()
    const plan = executionPlan()
    await plans.put(plan)
    await lifecycle.createExecution({
      executionId: ids.executionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt: '2026-08-28T12:00:00.000Z',
      deadlineAt: '2026-08-28T13:00:00.000Z',
    })
    const runtime = runtimePort()
    const first = activities({ lifecycle, plans, runtime })

    await first.persistStatus(status('queued'))
    await expect(first.ensureAttempt(attemptInput())).resolves.toEqual({
      attemptId: ids.attemptId,
    })
    await first.persistStatus(status('starting', true))
    await first.persistStatus(status('running', true))
    await expect(first.dispatch(dispatchInput())).resolves.toEqual({
      outcome: 'completed',
      resultReference: ids.resultReference,
    })

    const restarted = activities({ lifecycle, plans, runtime })
    await expect(restarted.ensureAttempt(attemptInput())).resolves.toEqual({
      attemptId: ids.attemptId,
    })
    await restarted.persistStatus({
      ...status('completed', true),
      resultReference: ids.resultReference,
    })
    await restarted.persistStatus({
      ...status('completed', true),
      resultReference: ids.resultReference,
    })

    const execution = await lifecycle.getExecution(ids.executionId)
    const attempts = await repository.listAttempts(ids.executionId)
    expect(execution).toMatchObject({
      state: 'completed',
      attemptCount: 1,
      latestAttemptId: ids.attemptId,
      terminalResultRef: ids.resultReference,
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      attemptId: ids.attemptId,
      state: 'completed',
      terminalResultRef: ids.resultReference,
    })
    expect(runtime.dispatches).toHaveLength(1)
    expect(runtime.dispatches[0].executionPlan).toEqual(plan)
    expect(runtime.commandTransitions).toEqual([
      {
        executionId: ids.executionId,
        to: 'completed',
        transitionedAt: '2026-08-28T12:00:01.000Z',
        resultReference: ids.resultReference,
      },
      {
        executionId: ids.executionId,
        to: 'completed',
        transitionedAt: '2026-08-28T12:00:01.000Z',
        resultReference: ids.resultReference,
      },
    ])
  })

  test('persists normalized failures on both execution and attempt', async () => {
    const repository = new InMemoryExecutionRepository()
    const lifecycle = new ExecutionLifecycleService(repository)
    const plans = new InMemoryExecutionPlanRepository()
    const plan = executionPlan()
    await plans.put(plan)
    await lifecycle.createExecution({
      executionId: ids.executionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt: '2026-08-28T12:00:00.000Z',
    })
    const activity = activities({ lifecycle, plans, runtime: runtimePort() })
    await activity.persistStatus(status('queued'))
    await activity.ensureAttempt(attemptInput())
    await activity.persistStatus(status('starting', true))
    await activity.persistStatus({
      ...status('failed', true),
      failure: { classification: 'runtime_error', code: 'MANAGED_RUNTIME_FAILED' },
    })

    expect(await lifecycle.getExecution(ids.executionId)).toMatchObject({
      state: 'failed',
      failure: { classification: 'runtime_error', code: 'MANAGED_RUNTIME_FAILED' },
    })
    expect((await repository.listAttempts(ids.executionId))[0]).toMatchObject({
      state: 'failed',
      failure: { classification: 'runtime_error', code: 'MANAGED_RUNTIME_FAILED' },
    })
  })

  test('rejects Cloud completion without a durable result reference', async () => {
    const repository = new InMemoryExecutionRepository()
    const lifecycle = new ExecutionLifecycleService(repository)
    const plans = new InMemoryExecutionPlanRepository()
    const plan = executionPlan()
    await plans.put(plan)
    await lifecycle.createExecution({
      executionId: ids.executionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt: '2026-08-28T12:00:00.000Z',
    })
    const activity = activities({ lifecycle, plans, runtime: runtimePort() })

    await expect(activity.persistStatus(status('completed'))).rejects.toThrow(
      'WORKFLOW_COMPLETION_RESULT_MISSING'
    )
    expect((await lifecycle.getExecution(ids.executionId)).state).toBe('accepted')
  })

  test('denies dispatch and graph starts before effects, while cancellation and cleanup remain available', async () => {
    const fixture = await lifecycleFixture(graphExecutionPlan())
    const runtime = runtimePort()
    const graphCalls = []
    const budgetAdmission = {
      authorize: async () => {
        throw new Error('RUNTIME_BUDGET_ADMISSION_DENIED')
      },
    }
    const activity = activities({
      ...fixture,
      runtime,
      budgetAdmission,
      graph: graphPort(graphCalls),
    })
    await activity.persistStatus(status('queued'))
    await activity.ensureAttempt(attemptInput())

    await expect(activity.dispatch(dispatchInput(fixture.plan))).rejects.toThrow(
      'RUNTIME_BUDGET_ADMISSION_DENIED'
    )
    const graphInput = graphSegmentInput(fixture.plan)
    await expect(activity.runGraphSegment(graphInput)).rejects.toThrow(
      'RUNTIME_BUDGET_ADMISSION_DENIED'
    )
    await expect(
      activity.resumeGraphSegment({
        ...graphInput,
        checkpointId: 'checkpoint-1',
        response: { action: 'approve' },
      })
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
    await expect(
      activity.continueGraphSegment({ ...graphInput, checkpointId: 'checkpoint-1' })
    ).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
    expect(runtime.dispatches).toHaveLength(0)
    expect(graphCalls).toHaveLength(0)

    await activity.cancelActive({
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      workflowId: ids.workflowId,
      effectKey: 'cancel-effect',
      reason: 'user_request',
    })
    await activity.cancelActive({
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      workflowId: ids.workflowId,
      effectKey: 'graph-cancel-effect',
      reason: 'user_request',
      graph: {
        workspaceId: fixture.plan.correlation.workspaceId,
        reference: graphInput.graph,
        threadId: graphInput.threadId,
      },
    })
    await activity.cleanup({ executionId: ids.executionId, effectKey: 'cleanup-effect' })
    expect(runtime.cancellations).toHaveLength(1)
    expect(runtime.cleanups).toHaveLength(1)
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0]).toMatchObject({ idempotencyKey: 'graph-cancel-effect' })
  })

  test('authorizes dispatch, interaction, and graph effects with current identity and preserves graph input', async () => {
    const fixture = await lifecycleFixture(graphExecutionPlan())
    const runtime = runtimePort()
    const graphCalls = []
    const admissions = []
    const activity = activities({
      ...fixture,
      runtime,
      budgetAdmission: {
        authorize: async (input) => admissions.push(input),
      },
      graph: graphPort(graphCalls),
    })
    await activity.persistStatus(status('queued'))
    await activity.ensureAttempt(attemptInput())

    await activity.dispatch(dispatchInput(fixture.plan))
    await activity.applyInteraction({
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      responseId: 'rsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      action: 'approve',
      effectKey: 'interaction-effect',
    })
    const graphInput = graphSegmentInput(fixture.plan)
    await activity.runGraphSegment(graphInput)
    const resumeInput = {
      ...graphInput,
      checkpointId: 'checkpoint-1',
      response: { action: 'approve' },
    }
    await activity.resumeGraphSegment(resumeInput)
    const continueInput = { ...graphInput, checkpointId: 'checkpoint-1' }
    await activity.continueGraphSegment(continueInput)

    expect(admissions).toHaveLength(5)
    for (const input of admissions) {
      expect(input.execution.executionId).toBe(ids.executionId)
      expect(input.executionPlan).toEqual(fixture.plan)
      expect(input.attemptId).toBe(ids.attemptId)
    }
    expect(runtime.dispatches).toHaveLength(1)
    expect(runtime.interactions).toHaveLength(1)
    expect(graphCalls).toHaveLength(3)
    expect(graphCalls[0]).toBe(graphInput)
    expect(graphCalls[1]).toBe(resumeInput)
    expect(graphCalls[2]).toBe(continueInput)
  })

  test('rejects substituted graph authority before a node effect even without budget configuration', async () => {
    const fixture = await lifecycleFixture(graphExecutionPlan())
    const graphCalls = []
    const activity = activities({
      ...fixture,
      runtime: runtimePort(),
      graph: graphPort(graphCalls),
    })
    await activity.persistStatus(status('queued'))
    await activity.ensureAttempt(attemptInput())
    const valid = graphSegmentInput(fixture.plan)
    for (const substitute of [
      { workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG' },
      { workflowId: 'wfl_01JBBCDEF0123456789ABCDEFG' },
      { attemptId: 'att_01JBBCDEF0123456789ABCDEFG' },
      { threadId: 'graph:other-execution' },
      { graph: { ...valid.graph, graphVersion: '2.0.0' } },
      { graph: { ...valid.graph, contentDigest: `sha256:${'b'.repeat(64)}` } },
      { input: { objective: 'replace the accepted task' } },
    ]) {
      await expect(activity.runGraphSegment({ ...valid, ...substitute })).rejects.toThrow()
    }
    expect(graphCalls).toHaveLength(0)
    await activity.runGraphSegment(valid)
    expect(graphCalls).toEqual([valid])
  })

  test('rejects unpinned continuations and cancellation before graph effects', async () => {
    const fixture = await lifecycleFixture(graphExecutionPlan())
    const graphCalls = []
    const activity = activities({
      ...fixture,
      runtime: runtimePort(),
      graph: graphPort(graphCalls),
    })
    await activity.persistStatus(status('queued'))
    await activity.ensureAttempt(attemptInput())
    const valid = graphSegmentInput(fixture.plan)
    const substituted = { ...valid, graph: { ...valid.graph, graphVersion: '2.0.0' } }
    await expect(
      activity.resumeGraphSegment({
        ...substituted,
        checkpointId: 'checkpoint-1',
        response: 'approve',
      })
    ).rejects.toThrow()
    await expect(
      activity.continueGraphSegment({ ...substituted, checkpointId: 'checkpoint-1' })
    ).rejects.toThrow()
    await expect(
      activity.cancelActive({
        executionId: valid.executionId,
        attemptId: valid.attemptId,
        workflowId: valid.workflowId,
        effectKey: 'cancel-pinned-graph',
        reason: 'user_request',
        graph: {
          workspaceId: valid.workspaceId,
          reference: substituted.graph,
          threadId: valid.threadId,
        },
      })
    ).rejects.toThrow()
    expect(graphCalls).toHaveLength(0)
  })

  test('rejects a graph segment for an execution whose immutable plan has no graph', async () => {
    const fixture = await lifecycleFixture()
    const graphCalls = []
    const activity = activities({
      ...fixture,
      runtime: runtimePort(),
      graph: graphPort(graphCalls),
    })
    await activity.persistStatus(status('queued'))
    await activity.ensureAttempt(attemptInput())
    await expect(
      activity.runGraphSegment(graphSegmentInput(graphExecutionPlan()))
    ).rejects.toThrow()
    expect(graphCalls).toHaveLength(0)
  })

  test('rejects corrupt or substituted retained plans before graph effects', async () => {
    const fixture = await lifecycleFixture(graphExecutionPlan())
    const graphCalls = []
    const valid = graphSegmentInput(fixture.plan)
    const bootstrap = activities({ ...fixture, runtime: runtimePort() })
    await bootstrap.persistStatus(status('queued'))
    await bootstrap.ensureAttempt(attemptInput())
    for (const stored of [
      {
        ...fixture.plan,
        graph: { ...fixture.plan.graph, input: { objective: 'tampered persisted input' } },
      },
      { ...fixture.plan, contentDigest: `sha256:${'b'.repeat(64)}` },
      { ...fixture.plan, schemaVersion: 2 },
      undefined,
    ]) {
      const activity = activities({
        ...fixture,
        plans: { get: async () => stored },
        runtime: runtimePort(),
        graph: graphPort(graphCalls),
      })
      await expect(activity.runGraphSegment(valid)).rejects.toThrow()
    }
    expect(graphCalls).toHaveLength(0)
  })

  test('reloads the current execution identity before applying an interaction', async () => {
    const fixture = await lifecycleFixture()
    const runtime = runtimePort()
    let authorizations = 0
    const activity = activities({
      ...fixture,
      runtime,
      budgetAdmission: { authorize: async () => authorizations++ },
    })
    await activity.persistStatus(status('queued'))
    await activity.ensureAttempt(attemptInput())

    await expect(
      activity.applyInteraction({
        executionId: ids.executionId,
        attemptId: 'att_01JBBCDEF0123456789ABCDEFG',
        interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        responseId: 'rsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        action: 'approve',
        effectKey: 'interaction-effect',
      })
    ).rejects.toThrow('WORKFLOW_EXECUTION_IDENTITY_MISMATCH')
    expect(authorizations).toBe(0)
    expect(runtime.interactions).toHaveLength(0)
  })
})

async function lifecycleFixture(plan = executionPlan()) {
  const repository = new InMemoryExecutionRepository()
  const lifecycle = new ExecutionLifecycleService(repository)
  const plans = new InMemoryExecutionPlanRepository()
  await plans.put(plan)
  await lifecycle.createExecution({
    executionId: ids.executionId,
    correlation: plan.correlation,
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    acceptedAt: '2026-08-28T12:00:00.000Z',
  })
  return { lifecycle, plans, plan }
}

function activities({ lifecycle, plans, runtime, runtimeRouter, budgetAdmission, graph }) {
  return new DurableExecutionLifecycleActivities({
    lifecycle,
    plans,
    runtime,
    graph: graph ?? {
      runGraphSegment: async () => ({
        outcome: 'failed',
        failureCode: 'GRAPH_DISABLED',
        retryable: false,
      }),
      resumeGraphSegment: async () => ({
        outcome: 'failed',
        failureCode: 'GRAPH_DISABLED',
        retryable: false,
      }),
      continueGraphSegment: async () => ({
        outcome: 'failed',
        failureCode: 'GRAPH_DISABLED',
        retryable: false,
      }),
      cancelGraphSegment: async () => {},
    },
    commands: {
      transitionExecutionCommand: async (input) => runtime.commandTransitions.push(input),
    },
    ...(runtimeRouter === undefined ? {} : { runtimeRouter }),
    ...(budgetAdmission === undefined ? {} : { budgetAdmission }),
    now: () => '2026-08-28T12:00:01.000Z',
  })
}

function runtimePort() {
  const dispatches = []
  const interactions = []
  const cancellations = []
  const cleanups = []
  const commandTransitions = []
  return {
    dispatches,
    interactions,
    cancellations,
    cleanups,
    commandTransitions,
    async dispatch(input) {
      dispatches.push(globalThis.structuredClone(input))
      return { outcome: 'completed', resultReference: ids.resultReference }
    },
    async applyInteraction(input) {
      interactions.push(globalThis.structuredClone(input))
      return { outcome: 'failed', failureCode: 'INTERACTION_UNEXPECTED', retryable: false }
    },
    async cancel(input) {
      cancellations.push(globalThis.structuredClone(input))
    },
    async cleanup(input) {
      cleanups.push(globalThis.structuredClone(input))
    },
  }
}

function graphPort(calls) {
  return {
    async runGraphSegment(input) {
      calls.push(input)
      return { outcome: 'completed' }
    },
    async resumeGraphSegment(input) {
      calls.push(input)
      return { outcome: 'completed' }
    },
    async continueGraphSegment(input) {
      calls.push(input)
      return { outcome: 'completed' }
    },
    async cancelGraphSegment(input) {
      calls.push(input)
    },
  }
}

function graphSegmentInput(plan) {
  return {
    executionId: ids.executionId,
    attemptId: ids.attemptId,
    workspaceId: plan.correlation.workspaceId,
    workflowId: ids.workflowId,
    graph: plan.graph.reference,
    threadId: `graph:${ids.executionId}`,
    input: plan.graph.input,
    idempotencyKey: 'workflow:segment:1',
  }
}

function attemptInput() {
  return {
    executionId: ids.executionId,
    workflowId: ids.workflowId,
    effectKey: `${ids.workflowId}:execution-lifecycle-v1:attempt`,
  }
}

function dispatchInput(plan = executionPlan()) {
  return {
    executionId: ids.executionId,
    attemptId: ids.attemptId,
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    effectKey: `${ids.workflowId}:execution-lifecycle-v1:dispatch`,
  }
}

function status(state, attempt = false) {
  return {
    executionId: ids.executionId,
    ...(attempt ? { attemptId: ids.attemptId } : {}),
    state,
    effectKey: `${ids.workflowId}:execution-lifecycle-v1:${state}`,
  }
}

function executionPlan() {
  return createExecutionPlanTestFixture()
}

function graphExecutionPlan() {
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...createExecutionPlanTestFixtureInputs(),
    graph: {
      reference: {
        graphDefinitionId: 'manager-graph',
        graphVersion: '1.0.0',
        contentDigest: `sha256:${'a'.repeat(64)}`,
      },
      input: { objective: 'admit before starting' },
    },
  })
}
