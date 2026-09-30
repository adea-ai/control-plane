import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import {
  AdmissionRolloutError,
  CommandInboxService,
  InMemoryCommandAcceptanceRepository,
} from '@control-plane/domain'
import { DurableExecutionAcceptanceService } from './execution-acceptance.service.ts'
import { DurableUsageError } from '@control-plane/usage-ledger/durable-contract'
import {
  ExecutionPlanCompiler,
  InMemoryExecutionPlanRepository,
} from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'

test('dispatches graph selection exclusively from the stored immutable plan', async () => {
  const graph = {
    reference: {
      graphDefinitionId: 'review-task',
      graphVersion: '1.0.0',
      contentDigest: `sha256:${'c'.repeat(64)}`,
    },
    input: { objective: 'Persisted task' },
  }
  const plan = new ExecutionPlanCompiler('1.0.0').compile({
    ...createExecutionPlanTestFixtureInputs(),
    graph,
  })
  const plans = new InMemoryExecutionPlanRepository()
  await plans.put(plan)
  const fixture = ControlApiFixtures.executionAcceptance.request
  const request = {
    ...fixture,
    workspaceId: plan.correlation.workspaceId,
    projectId: plan.correlation.projectId,
    payload: {
      ...fixture.payload,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      graph: { ...graph, input: { objective: 'Caller substitution' } },
    },
  }
  const submissions = []
  const service = new DurableExecutionAcceptanceService({
    plans,
    commands: new CommandInboxService({
      repository: new InMemoryCommandAcceptanceRepository(),
      executionIdFactory: () => 'exe_01JABCDEF0123456789ABCDEFG',
      executionPlanValidator: { validate: async () => true, authorize: async () => true },
      now: () => request.issuedAt,
    }),
    dispatcher: { submit: async (input) => submissions.push(input) },
    now: () => request.issuedAt,
  })
  await service.accept(request, request.caller.servicePrincipalId)
  expect(submissions).toHaveLength(1)
  expect(submissions[0].graph).toEqual({
    workspaceId: plan.correlation.workspaceId,
    reference: graph.reference,
    input: graph.input,
    threadId: 'graph:exe_01JABCDEF0123456789ABCDEFG',
  })
})

test.each(['missing', 'digest', 'scope'])(
  'refuses dispatch when the trusted plan reader returns %s',
  async (reason) => {
    const fixture = ControlApiFixtures.executionAcceptance.request
    const request = {
      ...fixture,
      payload: {
        ...fixture.payload,
        retentionExpiresAt: new Date(Date.parse(fixture.issuedAt) + 30 * 86_400_000).toISOString(),
      },
    }
    const persisted = {
      ...request.payload.executionPlan,
      correlation: {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        taskId: request.payload.taskId,
        agentId: request.payload.agentId,
      },
    }
    if (reason === 'digest') persisted.contentDigest = `sha256:${'f'.repeat(64)}`
    if (reason === 'scope') persisted.correlation.workspaceId = 'wsp_01JABCDEF0123456789ABCDEFH'
    let dispatched = 0
    const service = new DurableExecutionAcceptanceService({
      plans: { get: async () => (reason === 'missing' ? undefined : persisted) },
      commands: new CommandInboxService({
        repository: new InMemoryCommandAcceptanceRepository(),
        executionIdFactory: () => 'exe_01JABCDEF0123456789ABCDEFG',
        executionPlanValidator: { validate: async () => true },
        now: () => request.issuedAt,
      }),
      dispatcher: {
        submit: async () => {
          dispatched++
        },
      },
      now: () => request.issuedAt,
    })
    await expect(service.accept(request, request.caller.servicePrincipalId)).rejects.toMatchObject({
      status: 503,
    })
    expect(dispatched).toBe(0)
  }
)

test.each([
  'ADMISSION_ROLLOUT_PAUSED',
  'ADMISSION_ROLLOUT_GATE_UNAVAILABLE',
  'ADMISSION_ROLLOUT_STATE_INVALID',
  'ADMISSION_ROLLOUT_AUTHORITY_DENIED',
])('intake gate %s is a sanitized 503 before dispatch', async (code) => {
  const fixture = ControlApiFixtures.executionAcceptance.request
  const request = {
    ...fixture,
    payload: {
      ...fixture.payload,
      retentionExpiresAt: new Date(Date.parse(fixture.issuedAt) + 30 * 86_400_000).toISOString(),
    },
  }
  const cause = new AdmissionRolloutError(code)
  let dispatched = 0
  const service = new DurableExecutionAcceptanceService({
    commands: {
      acceptExecution: async () => {
        throw cause
      },
    },
    dispatcher: {
      submit: async () => {
        dispatched++
      },
    },
    now: () => request.issuedAt,
  })
  let rejection
  try {
    await service.accept(request, 'svc_admission-test')
  } catch (error) {
    rejection = error
  }
  expect(rejection?.getStatus?.()).toBe(503)
  expect(rejection?.getResponse?.()).toEqual({
    code: 'EXECUTION_INTAKE_UNAVAILABLE',
    message: 'Execution intake is temporarily unavailable',
  })
  expect(rejection?.cause).toBe(cause)
  expect(dispatched).toBe(0)
})

test.each([
  ['BUDGET_EXHAUSTED', 422, 'BUDGET_EXHAUSTED'],
  ['BUDGET_SETTLED', 409, 'BUDGET_SETTLED'],
  ['BUDGET_NOT_FOUND', 503, 'BUDGET_ADMISSION_UNAVAILABLE'],
  ['STORE_STATE_INVALID', 503, 'BUDGET_ADMISSION_UNAVAILABLE'],
  ['USAGE_LEDGER_SCOPE_MISMATCH', 503, 'BUDGET_ADMISSION_UNAVAILABLE'],
])('budget admission %s rejects safely before dispatch', async (code, status, publicCode) => {
  const fixture = ControlApiFixtures.executionAcceptance.request
  const request = {
    ...fixture,
    payload: {
      ...fixture.payload,
      retentionExpiresAt: new Date(Date.parse(fixture.issuedAt) + 30 * 86_400_000).toISOString(),
    },
  }
  let dispatched = 0
  const service = new DurableExecutionAcceptanceService({
    commands: {
      acceptExecution: async () => {
        throw new DurableUsageError(code)
      },
    },
    dispatcher: {
      submit: async () => {
        dispatched += 1
      },
    },
    now: () => request.issuedAt,
  })
  let rejection
  try {
    await service.accept(request, 'svc_admission-test')
  } catch (error) {
    rejection = error
  }
  expect(rejection?.getStatus()).toBe(status)
  expect(rejection?.getResponse().code).toBe(publicCode)
  expect(dispatched).toBe(0)
  if (status === 503) {
    expect(JSON.stringify(rejection.getResponse())).not.toContain(code)
    expect(rejection.cause).toBeInstanceOf(DurableUsageError)
    expect(rejection.cause.code).toBe(code)
  }
})

test.each(['optimistic replay', 'acceptance race'])(
  'admission denial prevents workflow submission on %s',
  async (path) => {
    const fixture = ControlApiFixtures.executionAcceptance.request
    const request = {
      ...fixture,
      payload: {
        ...fixture.payload,
        retentionExpiresAt: new Date(Date.parse(fixture.issuedAt) + 30 * 86_400_000).toISOString(),
      },
    }
    const repository = new InMemoryCommandAcceptanceRepository()
    const commands = new CommandInboxService({
      repository,
      executionIdFactory: () => 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      executionPlanValidator: { authorize: async () => true, validate: async () => true },
      now: () => request.issuedAt,
    })
    const accepted = await commands.acceptExecution({
      callerPrincipalId: 'svc_admission-test',
      operation: request.operation,
      commandId: request.commandId,
      requestId: request.requestId,
      idempotencyKey: request.idempotencyKey,
      payloadHash: request.payloadHash,
      correlation: {
        workspaceId: request.workspaceId,
        projectId: request.projectId,
        taskId: request.payload.taskId,
        agentId: request.payload.agentId,
      },
      executionPlan: request.payload.executionPlan,
      receivedAt: request.issuedAt,
      retentionExpiresAt: request.payload.retentionExpiresAt,
    })
    let verified = 0
    repository.verifyAdmission = async () => {
      verified += 1
      throw new Error('BUDGET_NOT_FOUND')
    }
    if (path === 'acceptance race') repository.get = async () => undefined
    let dispatched = 0
    const service = new DurableExecutionAcceptanceService({
      commands,
      dispatcher: {
        submit: async () => {
          dispatched += 1
        },
      },
      now: () => request.issuedAt,
    })

    await expect(service.accept(request, 'svc_admission-test')).rejects.toThrow('BUDGET_NOT_FOUND')
    expect(verified).toBe(1)
    expect(dispatched).toBe(0)
    expect(await repository.getByExecutionId(accepted.execution.executionId)).toMatchObject({
      status: 'accepted',
      version: 1,
    })
    expect(repository.executionCount).toBe(1)
  }
)
