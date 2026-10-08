import { expect, test } from 'bun:test'
import {
  ContextPackageCompiler,
  contextPackageSerializationFixtures,
  bindProjectContextPackageToWorkspaceParent,
} from '@control-plane/context'
import { CommandInboxService, InMemoryCommandAcceptanceRepository } from '@control-plane/domain'
import { evaluateCapabilities } from '@control-plane/runtime-sdk'
import {
  ExecutionPlanCompiler,
  ExecutionPlanAcceptanceValidator,
  InMemoryExecutionPlanRepository,
  assertExecutionPlanIntegrity,
  deriveExecutionPlan,
  deriveExecutionPlanWithAuthority,
  assertExecutionPlanDerivedFrom,
  currentExecutionScopeAllows,
} from './index.ts'
import { createExecutionPlanTestFixture, createExecutionPlanTestFixtureInputs } from './testing.ts'

const at = '2026-08-24T10:00:00.000Z'
const expiry = '2026-09-23T10:00:00.000Z'
const workspaceScope = { schemaVersion: 1, kind: 'workspace' }
const id = (prefix, tail = 'G') => `${prefix}_01JABCDEF0123456789ABCDEF${tail}`
const compiler = new ExecutionPlanCompiler('1.0.0')
function fixture() {
  const legacy = contextPackageSerializationFixtures.futurePi
  const base = {
    workspaceId: id('wsp'),
    executionScope: workspaceScope,
    revision: 4,
    objective: 'Workspace lead',
    artifacts: [],
    constraints: legacy.constraints,
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  }
  const contextCompiler = new ContextPackageCompiler('1.0.0')
  const context = contextCompiler.compileWorkspace(base)
  const input = createExecutionPlanTestFixtureInputs({ contextPackage: context })
  const { projectId, ...correlation } = input.correlation
  const plan = compiler.compile({
    ...input,
    correlation: { ...correlation, executionScope: workspaceScope },
  })
  return { base, contextCompiler, context, input, plan, projectId }
}
function pin(plan) {
  return {
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
  }
}
function admission(plan) {
  return { ...plan.correlation, executionPlan: pin(plan), callerPrincipalId: 'svc_scope-test' }
}
function snapshot(input) {
  return {
    workspaceId: input.workspaceId,
    executionScope: input.executionScope,
    callerPrincipalId: input.callerPrincipalId,
    executionPlan: input.executionPlan,
    principalActive: true,
    grantActive: true,
    allowedPrincipalIds: [input.callerPrincipalId],
    expiresAt: expiry,
    ...(input.executionScope.kind === 'project' ? { projectWorkspaceId: input.workspaceId } : {}),
  }
}
function command(plan) {
  const { requestId, ...correlation } = plan.correlation
  return {
    callerPrincipalId: 'svc_scope-test',
    operation: 'execution.accept',
    commandId: id('cmd'),
    requestId,
    idempotencyKey: 'workspace-scope-0001',
    payloadHash: 'a'.repeat(64),
    correlation,
    executionPlan: pin(plan),
    receivedAt: at,
    retentionExpiresAt: expiry,
  }
}

test('legacy canonical plan bytes stay pinned; scope/version changes never rehash historical objects', () => {
  const legacy = createExecutionPlanTestFixture()
  expect(legacy.contentDigest).toBe(
    'sha256:dc03a107d310cf14591b6d34fba4ed6443faedfb8e972ac31f2a50957b3d86fe'
  )
  expect(assertExecutionPlanIntegrity(legacy)).toEqual(legacy)
  for (const changed of [
    { ...legacy, schemaVersion: 2 },
    { ...legacy, executionScope: workspaceScope },
    {
      ...legacy,
      correlation: {
        ...legacy.correlation,
        executionScope: {
          schemaVersion: 1,
          kind: 'project',
          projectId: legacy.correlation.projectId,
        },
      },
    },
  ]) {
    expect(() => assertExecutionPlanIntegrity(changed)).toThrow()
  }
  expect(legacy.schemaVersion).toBe(1)
  expect(legacy.correlation.executionScope).toBeUndefined()
})

test('workspace plan2 is content addressed, round trips and unsupported adapters are ineligible', async () => {
  const { plan, input } = fixture()
  expect(() => compiler.compile(input)).toThrow('CONTRADICTORY_REFERENCE:context-scope')
  expect(plan.schemaVersion).toBe(2)
  expect(plan.correlation.projectId).toBeUndefined()
  expect(plan.runtimeRequirements).toContainEqual({
    capability: 'execution.scope.workspace.v1',
    necessity: 'required',
    minimumSupport: 'supported',
  })
  const repository = new InMemoryExecutionPlanRepository()
  const reference = await repository.put(plan)
  expect(await repository.get(reference)).toEqual(plan)
  expect(evaluateCapabilities([], plan.runtimeRequirements).eligible).toBe(false)
  expect(() =>
    assertExecutionPlanIntegrity({
      ...plan,
      correlation: { ...plan.correlation, workspaceId: id('wsp', 'H') },
    })
  ).toThrow('EXECUTION_PLAN_INTEGRITY_ERROR')
})

test('current scoped admission binds principal, grant, audience, expiry, exact plan and real project membership', async () => {
  const { plan } = fixture()
  const input = admission(plan)
  expect(
    await currentExecutionScopeAllows({ readCurrent: async () => snapshot(input) }, input, at)
  ).toBe(true)
  for (const override of [
    { workspaceId: id('wsp', 'H') },
    { principalActive: false },
    { grantActive: false },
    { allowedPrincipalIds: [] },
    { callerPrincipalId: 'svc_another' },
    { expiresAt: at },
    { executionPlan: { ...input.executionPlan, contentDigest: `sha256:${'b'.repeat(64)}` } },
    { executionScope: { schemaVersion: 1, kind: 'project', projectId: id('prj') } },
  ]) {
    expect(
      await currentExecutionScopeAllows(
        { readCurrent: async () => ({ ...snapshot(input), ...override }) },
        input,
        at
      )
    ).toBe(false)
  }
})

test('CommandInbox requires explicit current authority, converges concurrent admissions and denies revoked replay', async () => {
  const { plan } = fixture()
  const plans = new InMemoryExecutionPlanRepository()
  await plans.put(plan)
  let allowed = true
  const authority = { readCurrent: async (input) => ({ ...snapshot(input), grantActive: allowed }) }
  const repository = new InMemoryCommandAcceptanceRepository()
  const validator = new ExecutionPlanAcceptanceValidator(plans)
  expect(await validator.validate(admission(plan))).toBe(false)
  const legacyValidatorInbox = new CommandInboxService({
    repository: new InMemoryCommandAcceptanceRepository(),
    executionIdFactory: () => id('exe'),
    now: () => at,
    executionPlanValidator: { validate: async () => true, authorize: async () => true },
  })
  await expect(legacyValidatorInbox.acceptExecution(command(plan))).rejects.toThrow(
    'INVALID_EXECUTION_PLAN_REFERENCE'
  )
  const scoped = new CommandInboxService({
    repository,
    executionIdFactory: () => id('exe'),
    now: () => at,
    executionPlanValidator: {
      authorizeScope: (input) => currentExecutionScopeAllows(authority, input, at),
      validate: async () => true,
      authorize: async () => true,
    },
  })
  const results = await Promise.all(
    Array.from({ length: 8 }, () => scoped.acceptExecution(command(plan)))
  )
  expect(results.filter((x) => !x.replayed)).toHaveLength(1)
  expect(repository.executionCount).toBe(1)
  const terminal = await scoped.transitionExecutionCommand({
    executionId: id('exe'),
    to: 'completed',
    transitionedAt: at,
    resultReference: id('art'),
  })
  expect(terminal.status).toBe('completed')
  expect(terminal.executionScope).toEqual(workspaceScope)
  allowed = false
  await expect(scoped.acceptExecution(command(plan))).rejects.toThrow(
    'INVALID_EXECUTION_PLAN_REFERENCE'
  )
  expect(
    await new ExecutionPlanAcceptanceValidator(
      { get: async () => undefined },
      { catalog: { profiles: {}, skills: {} }, scopeAuthority: authority, now: () => at }
    ).authorize(admission(plan))
  ).toBe(false)
})

test.each([false, true])(
  'explicit project replay checks the retained legacy pin and current scope even after a race: %s',
  async (race) => {
    const legacy = createExecutionPlanTestFixture()
    const input = createExecutionPlanTestFixtureInputs()
    const explicit = compiler.compile({
      ...input,
      correlation: {
        ...input.correlation,
        executionScope: {
          schemaVersion: 1,
          kind: 'project',
          projectId: input.correlation.projectId,
        },
      },
    })
    const repository = new InMemoryCommandAcceptanceRepository()
    const legacyValidator = { validate: async () => true, authorize: async () => true }
    const makeInbox = (validator, store = repository) =>
      new CommandInboxService({
        repository: store,
        executionIdFactory: () => id('exe', 'H'),
        now: () => at,
        executionPlanValidator: validator,
      })
    const admitted = await makeInbox(legacyValidator).acceptExecution(command(legacy))
    const targetStore = race
      ? {
          get: async () => undefined,
          getByExecutionId: (value) => repository.getByExecutionId(value),
          getExecution: (value) => repository.getExecution(value),
          compareAndSet: (version, value) => repository.compareAndSet(version, value),
          accept: (value, execution) => repository.accept(value, execution),
        }
      : repository
    await expect(
      makeInbox(legacyValidator, targetStore).acceptExecution(command(explicit))
    ).rejects.toThrow('INVALID_EXECUTION_PLAN_REFERENCE')
    const observed = []
    const authority = {
      ...legacyValidator,
      authorizeScope: async (value) => {
        observed.push(value)
        // The input plan is allowed; the retained legacy winner is revoked.
        return value.executionPlan.schemaVersion === 2
      },
    }
    await expect(
      makeInbox(authority, targetStore).acceptExecution(command(explicit))
    ).rejects.toThrow('INVALID_EXECUTION_PLAN_REFERENCE')
    expect(observed.at(-1).executionPlan).toEqual(pin(legacy))
    expect(observed.at(-1).executionScope).toEqual(explicit.correlation.executionScope)
    const allowed = {
      ...legacyValidator,
      authorizeScope: async (value) =>
        currentExecutionScopeAllows({ readCurrent: async () => snapshot(value) }, value, at),
    }
    const replay = await makeInbox(allowed, targetStore).acceptExecution(command(explicit))
    expect(replay.replayed).toBe(true)
    expect(replay.command).toEqual(admitted.command)
    expect(replay.execution).toEqual(admitted.execution)
    expect(replay.command.executionScope).toBeUndefined()
    expect(repository.executionCount).toBe(1)
    // An unchanged legacy request still has its historical validator behavior.
    expect((await makeInbox(legacyValidator).acceptExecution(command(legacy))).replayed).toBe(true)
  }
)

test('workspace to real project child requires narrowed current authority and retained structural proof', async () => {
  const { base, contextCompiler, context, plan, projectId } = fixture()
  const projectContext = contextCompiler.compile({
    objective: base.objective,
    projectState: {
      schemaVersion: 1,
      workspaceId: base.workspaceId,
      projectId,
      revision: 4,
      items: [],
      createdAt: base.compiledAt,
      updatedAt: base.compiledAt,
    },
    expectedProjectStateRevision: 4,
    candidates: [],
    artifacts: [],
    constraints: base.constraints,
    permissions: [],
    successCriteria: base.successCriteria,
    returnContract: base.returnContract,
    budgets: base.budgets,
    compiledAt: base.compiledAt,
  })
  const childContext = bindProjectContextPackageToWorkspaceParent(context, projectContext)
  const childInput = {
    correlation: {
      ...plan.correlation,
      projectId,
      executionScope: { schemaVersion: 1, kind: 'project', projectId },
    },
    contextPackage: childContext,
    constraints: plan.constraints,
    runtimeRequirements: plan.runtimeRequirements.filter(
      (x) => x.capability !== 'execution.scope.workspace.v1'
    ),
    outputContract: plan.outputContract,
    compiledAt: plan.compiledAt,
  }
  await expect(
    deriveExecutionPlanWithAuthority(
      plan,
      { ...childInput, contextPackage: context },
      {
        callerPrincipalId: 'svc_scope-test',
        authority: { readCurrent: async (input) => snapshot(input) },
        now: at,
      }
    )
  ).rejects.toThrow('CHILD_AUTHORITY_EXPANSION:context-scope')
  expect(() => deriveExecutionPlan(plan, childInput)).toThrow('CHILD_AUTHORITY_EXPANSION')
  const authority = { readCurrent: async (input) => snapshot(input) }
  const child = await deriveExecutionPlanWithAuthority(plan, childInput, {
    callerPrincipalId: 'svc_scope-test',
    authority,
    now: at,
  })
  expect(child.schemaVersion).toBe(2)
  expect(assertExecutionPlanDerivedFrom(plan, child, context, childContext)).toEqual(child)
  for (const override of [
    { projectWorkspaceId: id('wsp', 'H') },
    { grantActive: false },
    { allowedPrincipalIds: [] },
  ]) {
    await expect(
      deriveExecutionPlanWithAuthority(plan, childInput, {
        callerPrincipalId: 'svc_scope-test',
        now: at,
        authority: {
          readCurrent: async (input) =>
            input.executionScope.kind === 'project'
              ? { ...snapshot(input), ...override }
              : snapshot(input),
        },
      })
    ).rejects.toThrow('CHILD_AUTHORITY_EXPANSION')
  }
})

test('a raced duplicate rechecks the stored winner rather than the losing input plan grant', async () => {
  const { plan, input } = fixture()
  const repository = new InMemoryCommandAcceptanceRepository()
  const initial = new CommandInboxService({
    repository,
    executionIdFactory: () => id('exe'),
    now: () => at,
    executionPlanValidator: {
      authorizeScope: async () => true,
      validate: async () => true,
      authorize: async () => true,
    },
  })
  const original = await initial.acceptExecution(command(plan))
  const other = compiler.compile({
    ...input,
    correlation: plan.correlation,
    compiledAt: '2026-08-24T11:00:00.000Z',
  })
  const calls = []
  const raced = new CommandInboxService({
    executionIdFactory: () => id('exe', 'H'),
    now: () => at,
    repository: {
      get: async () => undefined,
      accept: async () => ({
        outcome: 'duplicate',
        command: original.command,
        execution: original.execution,
      }),
    },
    executionPlanValidator: {
      validate: async () => true,
      authorize: async () => true,
      authorizeScope: async (value) => {
        calls.push(value.executionPlan.contentDigest)
        return value.executionPlan.contentDigest === other.contentDigest
      },
    },
  })
  await expect(raced.acceptExecution(command(other))).rejects.toThrow(
    'INVALID_EXECUTION_PLAN_REFERENCE'
  )
  expect(calls).toEqual([other.contentDigest, plan.contentDigest])
  expect(repository.executionCount).toBe(1)
})
