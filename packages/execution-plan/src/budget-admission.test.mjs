import { expect, test } from 'bun:test'
import { CommandInboxService, InMemoryCommandAcceptanceRepository } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from './testing.ts'
import { executionBudgetAdmissionSource, executionPlanBudgetAllowance } from './index.ts'

const plan = createExecutionPlanTestFixture()
const at = '2026-08-24T10:00:00.000Z'

async function accepted() {
  return new CommandInboxService({
    repository: new InMemoryCommandAcceptanceRepository(),
    executionIdFactory: () => 'exe_01JABCDEF0123456789ABCDEFG',
    executionPlanValidator: { validate: async () => true },
    now: () => at,
  }).acceptExecution({
    callerPrincipalId: 'svc_budget-admission',
    operation: 'execution.accept',
    commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
    requestId: plan.correlation.requestId,
    idempotencyKey: 'budget-admission-fixture-0001',
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
      schemaVersion: 1,
    },
    receivedAt: at,
    retentionExpiresAt: '2026-09-23T10:00:00.000Z',
  })
}

test('allocates only immutable persisted plan ceilings, not extra request amounts', async () => {
  const { command, execution } = await accepted()
  const allowance = executionPlanBudgetAllowance(
    {
      ...command,
      maximumMicrounits: Number.MAX_SAFE_INTEGER,
      maximumTokens: Number.MAX_SAFE_INTEGER,
    },
    execution,
    plan
  )
  expect(allowance.maximumMicrounits).toBe(plan.constraints.limits.budget.maximumMicrounits)
  expect(allowance.maximumTokens).toBe(plan.constraints.limits.tokens.maximumTotal)
  expect(allowance.source).toEqual(executionBudgetAdmissionSource(command, execution))
  expect(Object.isFrozen(allowance)).toBe(true)
  expect(Object.isFrozen(allowance.source)).toBe(true)
})

test('binds the allocation source to the accepted actor, payload and immutable owner', async () => {
  const { command, execution } = await accepted()
  const source = executionBudgetAdmissionSource(command, execution)
  expect(
    executionBudgetAdmissionSource({ ...command, callerPrincipalId: 'svc_another' }, execution)
  ).not.toEqual(source)
  expect(
    executionBudgetAdmissionSource({ ...command, payloadHash: 'b'.repeat(64) }, execution)
  ).not.toEqual(source)
  expect(source.sourceId).toMatch(/^allocation:sha256:[a-f0-9]{64}$/)
  expect(source.idempotencyKey).toBe(`execution-budget-open:${execution.executionId}`)
})

test('keeps historical replay identity independent of current lifecycle status and timestamps', async () => {
  const { command, execution } = await accepted()
  expect(
    executionBudgetAdmissionSource(
      { ...command, version: 2, status: 'processing', processingAt: at },
      { ...execution, version: 2, updatedAt: '2026-08-24T10:00:01.000Z' }
    )
  ).toEqual(executionBudgetAdmissionSource(command, execution))
})

test.each(['workspaceId', 'projectId', 'taskId', 'agentId'])(
  'rejects mismatched command/owner %s',
  async (field) => {
    const { command, execution } = await accepted()
    const bad = { ...command, [field]: `${command[field].slice(0, -1)}H` }
    expect(() => executionBudgetAdmissionSource(bad, execution)).toThrow(
      'INVALID_EXECUTION_PLAN_REFERENCE'
    )
  }
)

test('rejects plan mutation and a pin that does not match the stored plan', async () => {
  const { command, execution } = await accepted()
  const damaged = structuredClone(plan)
  damaged.constraints.limits.budget.maximumMicrounits += 1
  expect(() => executionPlanBudgetAllowance(command, execution, damaged)).toThrow()
  const badPin = { ...command.executionPlan, contentDigest: `sha256:${'c'.repeat(64)}` }
  expect(() =>
    executionPlanBudgetAllowance(
      { ...command, executionPlan: badPin },
      { ...execution, executionPlan: badPin },
      plan
    )
  ).toThrow('INVALID_EXECUTION_PLAN_REFERENCE')
})
