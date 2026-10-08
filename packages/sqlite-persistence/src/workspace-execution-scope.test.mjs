import { expect, test } from 'bun:test'
import { ControlApiFixtures } from '@control-plane/contracts'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CommandInboxService,
  ExecutionLifecycleService,
  commandInboxScopeKey,
  retiredCommandKeyCandidates,
} from '@control-plane/domain'
import {
  ContextPackageCompiler,
  contextPackageSerializationFixtures,
  bindProjectContextPackageToWorkspaceParent,
  deriveContextPackage,
} from '@control-plane/context'
import {
  ExecutionPlanCompiler,
  ExecutionPlanAcceptanceValidator,
  deriveExecutionPlanWithAuthority,
  deriveExecutionPlan,
} from '@control-plane/execution-plan'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteExecutionCancellationRepository,
  SqliteExecutionEventRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
  SqlitePersistenceProvider,
  SqliteRetentionHoldRepository,
} from './index.ts'

const scope = { schemaVersion: 1, kind: 'workspace' }
const at = '2026-08-24T10:00:00.000Z'
const expiry = '2026-09-23T10:00:00.000Z'
const id = (prefix, tail = 'G') => `${prefix}_01JABCDEF0123456789ABCDEF${tail}`
const storedId = (value) => `r-${createHash('sha256').update(value).digest('hex')}`
function workspaceFixture() {
  const legacy = contextPackageSerializationFixtures.futurePi
  const context = new ContextPackageCompiler('1.0.0').compileWorkspace({
    workspaceId: id('wsp'),
    executionScope: scope,
    revision: 4,
    objective: 'Run the workspace lead',
    artifacts: [],
    constraints: legacy.constraints,
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  })
  const input = createExecutionPlanTestFixtureInputs({ contextPackage: context })
  const { projectId: _, ...correlation } = input.correlation
  return {
    context,
    plan: new ExecutionPlanCompiler('1.0.0').compile({
      ...input,
      correlation: { ...correlation, executionScope: scope },
    }),
  }
}
function projectFixture(workspaceId = id('wsp')) {
  const legacy = contextPackageSerializationFixtures.futurePi
  const context = new ContextPackageCompiler('1.0.0').compile({
    objective: legacy.objective,
    projectState: {
      schemaVersion: 1,
      workspaceId,
      projectId: id('prj'),
      revision: 4,
      items: [],
      createdAt: at,
      updatedAt: at,
    },
    expectedProjectStateRevision: 4,
    candidates: [],
    artifacts: [],
    constraints: legacy.constraints,
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  })
  const input = createExecutionPlanTestFixtureInputs({ contextPackage: context })
  return {
    context,
    plan: new ExecutionPlanCompiler('1.0.0').compile({
      ...input,
      correlation: { ...input.correlation, workspaceId },
    }),
  }
}
function commandInput(plan) {
  const { requestId, ...correlation } = plan.correlation
  return {
    callerPrincipalId: 'svc_scope-test',
    operation: 'execution.accept',
    commandId: id('cmd'),
    requestId,
    idempotencyKey: 'workspace-scope-0001',
    payloadHash: 'a'.repeat(64),
    correlation,
    executionPlan: {
      executionPlanId: plan.executionPlanId,
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
    },
    receivedAt: at,
    retentionExpiresAt: expiry,
  }
}
function service(provider, tail = 'G', budgetAdmission = true) {
  return new CommandInboxService({
    repository: new SqliteCommandAcceptanceRepository(provider, { budgetAdmission }),
    executionIdFactory: () => id('exe', tail),
    executionPlanValidator: {
      validate: async () => true,
      authorize: async () => true,
      authorizeScope: async () => true,
    },
    now: () => at,
  })
}
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-workspace-execution-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    await run({
      provider,
      path,
      reopen: async () => {
        await provider.close()
        provider = new SqlitePersistenceProvider({ path })
        await provider.migrate()
        return provider
      },
    })
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}
async function seed(provider, context, plan) {
  await new SqliteContextPackageRepository(provider).put(context)
  await new SqliteExecutionPlanRepository(provider).put(plan)
}

test('workspace concurrent budget admission, cancellation, events and restart retain explicit scope', async () => {
  await fixture(async ({ provider, reopen }) => {
    const { context, plan } = workspaceFixture()
    await seed(provider, context, plan)
    const request = commandInput(plan)
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        service(provider, index === 0 ? 'G' : 'H').acceptExecution(request)
      )
    )
    expect(results.filter((result) => !result.replayed)).toHaveLength(1)
    for (const result of results) expect(result.execution).toEqual(results[0].execution)
    const accepted = results[0]
    expect(accepted.command.executionScope).toEqual(scope)
    expect(accepted.command.projectId).toBeUndefined()
    expect(Object.hasOwn(JSON.parse(JSON.stringify(accepted.command)), 'projectId')).toBe(false)
    expect(accepted.execution.correlation).toEqual(plan.correlation)
    await new ExecutionLifecycleService(new SqliteExecutionRepository(provider)).createAttempt({
      executionId: accepted.execution.executionId,
      attemptId: id('att'),
      expectedExecutionVersion: 1,
      queuedAt: at,
    })
    const { projectId: _project, ...legacyEnvelope } =
      ControlApiFixtures.executionAcceptance.request
    const cancellation = {
      ...legacyEnvelope,
      workspaceId: id('wsp'),
      executionScope: scope,
      caller: { servicePrincipalId: 'svc_scope-test' },
      operation: 'execution.cancel',
      commandId: id('cmd', 'H'),
      requestId: id('req', 'H'),
      idempotencyKey: 'workspace-cancel-0001',
      payload: { executionId: accepted.execution.executionId },
    }
    const cancellations = new SqliteExecutionCancellationRepository(provider)
    const reserves = await Promise.all(
      Array.from({ length: 4 }, () => cancellations.reserve({ request: cancellation }))
    )
    expect(reserves.filter((result) => result.inserted)).toHaveLength(1)
    await cancellations.markAccepted(cancellation, at)
    await expect(
      cancellations.reserve({
        request: {
          ...cancellation,
          workspaceId: id('wsp', 'H'),
          idempotencyKey: 'different-cancel-0001',
        },
      })
    ).rejects.toThrow('SQLITE_EXECUTION_CANCELLATION_SCOPE_MISMATCH')
    const events = new SqliteExecutionEventRepository(provider)
    const draft = {
      eventId: id('evt'),
      executionId: accepted.execution.executionId,
      type: 'execution.progressed',
      schemaVersion: 1,
      correlation: {
        ...plan.correlation,
        commandId: accepted.command.commandId,
        traceId: id('trc'),
      },
      payload: { progress: 25 },
      occurredAt: at,
      recordedAt: at,
      retentionExpiresAt: expiry,
    }
    const event = await events.append(draft)
    expect(event.correlation.executionScope).toEqual(scope)
    await expect(
      events.append({
        ...draft,
        eventId: id('evt', 'H'),
        correlation: { ...draft.correlation, workspaceId: id('wsp', 'H') },
      })
    ).rejects.toThrow('SQLITE_EXECUTION_EVENT_SCOPE_MISMATCH')
    provider = await reopen()
    expect(
      await new SqliteExecutionPlanRepository(provider).get({
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
      })
    ).toEqual(plan)
    expect((await service(provider).acceptExecution(request)).replayed).toBe(true)
    expect(await new SqliteExecutionCancellationRepository(provider).get(cancellation)).toEqual({
      request: cancellation,
      acceptedAt: at,
    })
    expect(await new SqliteExecutionEventRepository(provider).get(event.eventId)).toEqual(event)
    expect(
      (
        await new SqliteExecutionRepository(provider).listAttempts(accepted.execution.executionId)
      )[0].attemptId
    ).toBe(id('att'))
  })
})

test('legacy project bytes and replay identities survive reopen and explicit project normalization', async () => {
  await fixture(async ({ provider, reopen }) => {
    const context = contextPackageSerializationFixtures.futurePi
    const plan = createExecutionPlanTestFixture()
    expect(plan.contentDigest).toBe(
      'sha256:dc03a107d310cf14591b6d34fba4ed6443faedfb8e972ac31f2a50957b3d86fe'
    )
    const plans = new SqliteExecutionPlanRepository(provider)
    for (const historicalMutation of [
      { ...plan, schemaVersion: 2 },
      {
        ...plan,
        correlation: {
          ...plan.correlation,
          executionScope: {
            schemaVersion: 1,
            kind: 'project',
            projectId: plan.correlation.projectId,
          },
        },
      },
    ])
      expect(() => plans.put(historicalMutation)).toThrow()
    await seed(provider, context, plan)
    const request = commandInput(plan)
    const accepted = await service(provider).acceptExecution(request)
    const historical = [
      accepted.command.callerPrincipalId,
      accepted.command.operation,
      accepted.command.workspaceId,
      accepted.command.projectId,
      accepted.command.idempotencyKey,
    ].join('\u001f')
    expect(commandInboxScopeKey(accepted.command)).toBe(historical)
    const explicit = {
      ...accepted.command,
      executionScope: { schemaVersion: 1, kind: 'project', projectId: accepted.command.projectId },
    }
    expect(commandInboxScopeKey(explicit)).toBe(historical)
    expect(retiredCommandKeyCandidates(explicit)).toEqual(
      retiredCommandKeyCandidates(accepted.command)
    )
    const before = await provider.transaction((tx) =>
      tx.get('execution-plans', storedId(plan.executionPlanId))
    )
    provider = await reopen()
    expect(
      await provider.transaction((tx) => tx.get('execution-plans', storedId(plan.executionPlanId)))
    ).toEqual(before)
    expect((await service(provider).acceptExecution(request)).execution).toEqual(accepted.execution)
    expect(Object.hasOwn(plan.correlation, 'executionScope')).toBe(false)
  })
})

test('workspace admission rejects a foreign workspace without owner or budget side effects', async () => {
  await fixture(async ({ provider }) => {
    const { context, plan } = workspaceFixture()
    await seed(provider, context, plan)
    const request = commandInput(plan)
    await expect(
      service(provider).acceptExecution({
        ...request,
        correlation: { ...request.correlation, workspaceId: id('wsp', 'H') },
      })
    ).rejects.toThrow('INVALID_EXECUTION_PLAN_REFERENCE')
    for (const namespace of ['executions', 'command-inbox', 'command-by-execution'])
      expect(await provider.transaction((tx) => tx.list(namespace))).toEqual([])
  })
})

test('workspace execution retention uses its workspace owner and keeps project holds narrow', async () => {
  await fixture(async ({ provider }) => {
    const execution = {
      executionId: id('exe'),
      state: 'completed',
      version: 2,
      correlation: {
        workspaceId: id('wsp'),
        executionScope: scope,
        taskId: id('tsk'),
        agentId: id('agt'),
        requestId: id('req'),
      },
      executionPlan: {
        executionPlanId: id('pln'),
        contentDigest: `sha256:${'a'.repeat(64)}`,
        schemaVersion: 2,
      },
      attemptCount: 0,
      acceptedAt: at,
      terminalAt: at,
      createdAt: at,
      updatedAt: at,
    }
    await provider.transaction((tx) =>
      tx.put({ namespace: 'executions', id: storedId(execution.executionId), value: execution })
    )
    const policy = {
      executions: {
        owner: 'workspace-owner',
        scopes: ['class', 'workspace', 'project'],
        reasonCodes: ['legal-case'],
      },
    }
    const holds = new SqliteRetentionHoldRepository(provider, policy)
    const makeHold = (holdId, holdScope) => ({
      holdId,
      classId: 'executions',
      scope: holdScope,
      owner: 'workspace-owner',
      reasonCode: 'legal-case',
      createdAt: at,
      createdBy: { actorPrincipalRef: 'operator:fixture', authorityRef: 'authority:fixture' },
      revision: 0,
    })
    await holds.create(
      makeHold('10000000-0000-4000-8000-000000000001', {
        kind: 'project',
        workspaceId: id('wsp'),
        projectId: id('prj'),
      })
    )
    const owner = new SqliteExecutionRepository(provider)
    const assess = () =>
      owner.deleteEligibleExecutions(new Date('2026-10-08T00:00:00.000Z'), {
        policyRetainMs: 1,
        dryRun: true,
        retentionHoldPolicy: policy,
      })
    expect((await assess()).eligible).toBe(1)
    await holds.create(
      makeHold('10000000-0000-4000-8000-000000000002', {
        kind: 'workspace',
        workspaceId: id('wsp'),
      })
    )
    expect((await assess()).retainedByReason.hold_recorded).toBe(1)
  })
})

test('actual kernel admission rereads current workspace principal, grant and audience on new acceptance and replay', async () => {
  await fixture(async ({ provider }) => {
    const { context, plan } = workspaceFixture()
    await seed(provider, context, plan)
    const inputs = createExecutionPlanTestFixtureInputs({ contextPackage: context })
    let current = {
      principalActive: true,
      grantActive: true,
      allowedPrincipalIds: ['svc_scope-test'],
      expiresAt: '2026-08-25T00:00:00.000Z',
    }
    let reads = 0
    const validator = new ExecutionPlanAcceptanceValidator(
      new SqliteExecutionPlanRepository(provider),
      {
        catalog: {
          profiles: {
            getAgentProfile: async () => ({
              profileId: inputs.profile.profileId,
              ownership: { scope: 'workspace', workspaceId: id('wsp') },
            }),
            getAgentProfileVersion: async () => inputs.profile,
          },
          skills: {
            getSkill: async () => ({
              skillId: inputs.skills[0].skillId,
              ownership: { scope: 'workspace', workspaceId: id('wsp') },
            }),
            getSkillVersion: async () => inputs.skills[0],
          },
        },
        scopeAuthority: {
          readCurrent: async (input) => {
            reads++
            return {
              ...current,
              workspaceId: input.workspaceId,
              executionScope: scope,
              callerPrincipalId: input.callerPrincipalId,
              executionPlan: input.executionPlan,
            }
          },
        },
        now: () => at,
      }
    )
    const commandService = new CommandInboxService({
      repository: new SqliteCommandAcceptanceRepository(provider, { budgetAdmission: true }),
      executionIdFactory: () => id('exe'),
      executionPlanValidator: validator,
      now: () => at,
    })
    const request = commandInput(plan)
    const original = current
    for (const denied of [
      { ...original, principalActive: false },
      { ...original, grantActive: false },
      { ...original, allowedPrincipalIds: [] },
      { ...original, expiresAt: at },
    ]) {
      current = denied
      await expect(commandService.acceptExecution(request)).rejects.toThrow(
        'INVALID_EXECUTION_PLAN_REFERENCE'
      )
      expect(await provider.transaction((tx) => tx.list('executions'))).toEqual([])
    }
    current = original
    expect((await commandService.acceptExecution(request)).replayed).toBe(false)
    const before = await provider.transaction(async (tx) => ({
      commands: await tx.list('command-inbox'),
      executions: await tx.list('executions'),
      budgets: await tx.list('usage-budgets'),
    }))
    current = { ...original, allowedPrincipalIds: [] }
    await expect(commandService.acceptExecution(request)).rejects.toThrow(
      'INVALID_EXECUTION_PLAN_REFERENCE'
    )
    expect(
      await provider.transaction(async (tx) => ({
        commands: await tx.list('command-inbox'),
        executions: await tx.list('executions'),
        budgets: await tx.list('usage-budgets'),
      }))
    ).toEqual(before)
    expect(reads).toBeGreaterThanOrEqual(7)
  })
})

test('workspace parent delegates a real same-workspace project child with current narrowed authority and durable budget ancestry', async () => {
  await fixture(async ({ provider, reopen }) => {
    const { context, plan: parent } = workspaceFixture()
    await seed(provider, context, parent)
    const parentAccepted = await service(provider).acceptExecution(commandInput(parent))
    const projectContext = new ContextPackageCompiler('1.0.0').compile({
      objective: context.objective,
      projectState: {
        schemaVersion: 1,
        workspaceId: id('wsp'),
        projectId: id('prj'),
        revision: 4,
        items: [],
        createdAt: at,
        updatedAt: at,
      },
      expectedProjectStateRevision: 4,
      candidates: [],
      artifacts: [],
      constraints: context.constraints,
      permissions: [],
      successCriteria: context.successCriteria,
      returnContract: context.returnContract,
      budgets: context.budgets,
      compiledAt: context.compiledAt,
    })
    const bound = bindProjectContextPackageToWorkspaceParent(context, projectContext)
    const childInput = {
      correlation: {
        workspaceId: id('wsp'),
        projectId: id('prj'),
        executionScope: { schemaVersion: 1, kind: 'project', projectId: id('prj') },
        taskId: id('tsk', 'H'),
        agentId: id('agt'),
        requestId: id('req', 'H'),
      },
      contextPackage: bound,
      constraints: parent.constraints,
      runtimeRequirements: parent.runtimeRequirements.filter(
        (requirement) => requirement.capability !== 'execution.scope.workspace.v1'
      ),
      outputContract: parent.outputContract,
      compiledAt: parent.compiledAt,
    }
    let projectWorkspaceId = id('wsp', 'H')
    let audience = ['svc_scope-test']
    const authority = {
      readCurrent: async (input) => ({
        workspaceId: input.workspaceId,
        executionScope: input.executionScope,
        callerPrincipalId: input.callerPrincipalId,
        executionPlan: input.executionPlan,
        principalActive: true,
        grantActive: true,
        allowedPrincipalIds: audience,
        expiresAt: '2026-08-25T00:00:00.000Z',
        ...(input.executionScope.kind === 'project' ? { projectWorkspaceId } : {}),
      }),
    }
    const options = { callerPrincipalId: 'svc_scope-test', authority, now: at }
    await expect(deriveExecutionPlanWithAuthority(parent, childInput, options)).rejects.toThrow(
      'CHILD_AUTHORITY_EXPANSION'
    )
    projectWorkspaceId = id('wsp')
    audience = []
    await expect(deriveExecutionPlanWithAuthority(parent, childInput, options)).rejects.toThrow(
      'CHILD_AUTHORITY_EXPANSION'
    )
    audience = ['svc_scope-test']
    const child = await deriveExecutionPlanWithAuthority(parent, childInput, options)
    await seed(provider, bound, child)
    const request = {
      ...commandInput(child),
      commandId: id('cmd', 'H'),
      idempotencyKey: 'project-child-scope-0001',
      parentExecutionId: parentAccepted.execution.executionId,
    }
    const inputs = createExecutionPlanTestFixtureInputs({ contextPackage: context })
    const validator = new ExecutionPlanAcceptanceValidator(
      new SqliteExecutionPlanRepository(provider),
      {
        catalog: {
          profiles: {
            getAgentProfile: async () => ({
              profileId: inputs.profile.profileId,
              ownership: { scope: 'workspace', workspaceId: id('wsp') },
            }),
            getAgentProfileVersion: async () => inputs.profile,
          },
          skills: {
            getSkill: async () => ({
              skillId: inputs.skills[0].skillId,
              ownership: { scope: 'workspace', workspaceId: id('wsp') },
            }),
            getSkillVersion: async () => inputs.skills[0],
          },
        },
        scopeAuthority: authority,
        now: () => at,
      }
    )
    const childService = new CommandInboxService({
      repository: new SqliteCommandAcceptanceRepository(provider, { budgetAdmission: true }),
      executionIdFactory: () => id('exe', 'H'),
      executionPlanValidator: validator,
      now: () => at,
    })
    const accepted = await childService.acceptExecution(request)
    expect(accepted.execution.parentExecutionId).toBe(parentAccepted.execution.executionId)
    expect(accepted.execution.correlation.executionScope).toEqual(
      childInput.correlation.executionScope
    )
    const current = await reopen()
    expect(
      await new SqliteExecutionRepository(current).getExecution(accepted.execution.executionId)
    ).toEqual(accepted.execution)
    const budgets = await current.transaction((tx) => tx.list('usage-budgets'))
    expect(budgets).toHaveLength(2)
  })
})

test('independent SQLite connections admit one workspace owner under contention and preserve replay', async () => {
  await fixture(async ({ provider, path }) => {
    const { context, plan } = workspaceFixture()
    await seed(provider, context, plan)
    const second = new SqlitePersistenceProvider({ path })
    try {
      await second.migrate()
      const request = commandInput(plan)
      const attempts = await Promise.allSettled([
        service(provider).acceptExecution(request),
        service(second, 'H').acceptExecution(request),
      ])
      const fulfilled = attempts
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value)
      expect(fulfilled.filter((result) => !result.replayed)).toHaveLength(1)
      for (const rejected of attempts.filter((result) => result.status === 'rejected'))
        expect(rejected.reason).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5 })
      expect((await service(second, 'H').acceptExecution(request)).replayed).toBe(true)
      for (const namespace of ['command-inbox', 'executions', 'usage-budgets'])
        expect(await provider.transaction((tx) => tx.list(namespace))).toHaveLength(1)
    } finally {
      await second.close()
    }
  })
}, 15_000)

for (const foreign of [true, false]) {
  test(`repair: unbudgeted explicit child rejects ${foreign ? 'foreign project owner' : 'standalone same-workspace plan'}`, async () => {
    await fixture(async ({ provider }) => {
      const parent = foreign ? projectFixture(id('wsp', 'H')) : workspaceFixture()
      await seed(provider, parent.context, parent.plan)
      const acceptedParent = await service(provider, 'G', false).acceptExecution(
        commandInput(parent.plan)
      )
      const child = workspaceFixture()
      await seed(provider, child.context, child.plan)
      const request = {
        ...commandInput(child.plan),
        commandId: id('cmd', 'H'),
        idempotencyKey: 'unbudgeted-invalid-child-0001',
        parentExecutionId: acceptedParent.execution.executionId,
      }
      await expect(service(provider, 'H', false).acceptExecution(request)).rejects.toThrow(
        'INVALID_EXECUTION_PLAN_REFERENCE'
      )
      for (const namespace of ['command-inbox', 'executions'])
        expect(await provider.transaction((tx) => tx.list(namespace))).toHaveLength(1)
      expect(await provider.transaction((tx) => tx.list('usage-budgets'))).toHaveLength(0)
    })
  })
}

test('repair: unbudgeted explicit child verifies narrowed immutable ancestry without opening a ledger budget', async () => {
  await fixture(async ({ provider }) => {
    const parent = workspaceFixture()
    await seed(provider, parent.context, parent.plan)
    const acceptedParent = await service(provider, 'G', false).acceptExecution(
      commandInput(parent.plan)
    )
    const context = deriveContextPackage(parent.context, {
      objective: 'Narrow child context',
      allowedStateItemIds: [],
      allowedArtifactIds: [],
      budgets: parent.context.budgets,
      successCriteria: parent.context.successCriteria,
      returnContract: parent.context.returnContract,
      compiledAt: parent.context.compiledAt,
    })
    const plan = deriveExecutionPlan(parent.plan, {
      correlation: {
        ...parent.plan.correlation,
        taskId: id('tsk', 'H'),
        requestId: id('req', 'H'),
      },
      contextPackage: context,
      constraints: parent.plan.constraints,
      runtimeRequirements: parent.plan.runtimeRequirements,
      outputContract: parent.plan.outputContract,
      compiledAt: parent.plan.compiledAt,
    })
    await seed(provider, context, plan)
    const accepted = await service(provider, 'H', false).acceptExecution({
      ...commandInput(plan),
      commandId: id('cmd', 'H'),
      idempotencyKey: 'unbudgeted-valid-child-0001',
      parentExecutionId: acceptedParent.execution.executionId,
    })
    expect(accepted.execution.parentExecutionId).toBe(acceptedParent.execution.executionId)
    expect(await provider.transaction((tx) => tx.list('executions'))).toHaveLength(2)
    expect(await provider.transaction((tx) => tx.list('usage-budgets'))).toHaveLength(0)
  })
})

test('repair: legacy event spelling cannot bypass an explicit workspace owner', async () => {
  await fixture(async ({ provider }) => {
    const { context, plan } = workspaceFixture()
    await seed(provider, context, plan)
    const owner = await service(provider).acceptExecution(commandInput(plan))
    const { executionScope: _ignored, ...legacyCorrelation } = owner.execution.correlation
    const draft = {
      eventId: id('evt'),
      executionId: owner.execution.executionId,
      type: 'execution.progressed',
      schemaVersion: 1,
      correlation: {
        ...legacyCorrelation,
        projectId: id('prj'),
        commandId: id('cmd'),
        traceId: id('trc'),
      },
      payload: { progress: 25 },
      occurredAt: at,
      recordedAt: at,
      retentionExpiresAt: expiry,
    }
    const events = new SqliteExecutionEventRepository(provider)
    await expect(events.append(draft)).rejects.toThrow('SQLITE_EXECUTION_EVENT_SCOPE_MISMATCH')
    expect(await events.queryAfter(owner.execution.executionId, 0, 10)).toEqual([])
  })
})

test('repair: retained workspace event tombstone rejects replay after its owner was deleted', async () => {
  await fixture(async ({ provider }) => {
    const { context, plan } = workspaceFixture()
    await seed(provider, context, plan)
    const owner = await service(provider).acceptExecution(commandInput(plan))
    const draft = {
      eventId: id('evt'),
      executionId: owner.execution.executionId,
      type: 'execution.progressed',
      schemaVersion: 1,
      correlation: { ...owner.execution.correlation, commandId: id('cmd'), traceId: id('trc') },
      payload: { progress: 25 },
      occurredAt: at,
      recordedAt: at,
      retentionExpiresAt: expiry,
    }
    const events = new SqliteExecutionEventRepository(provider)
    const event = await events.append(draft)
    await provider.transaction((tx) =>
      tx.delete('executions', storedId(owner.execution.executionId))
    )
    expect(await events.append(draft)).toBeUndefined()
    await provider.transaction(async (tx) => {
      await tx.put({
        namespace: 'retired-execution-event-ids',
        id: storedId(event.eventId),
        value: {
          eventId: event.eventId,
          executionId: event.executionId,
          sequence: event.sequence,
          retiredAt: expiry,
        },
      })
      await tx.delete('execution-events', storedId(event.eventId))
      await tx.delete('executions', storedId(owner.execution.executionId))
    })
    expect(await events.append(draft)).toBeUndefined()
    expect(await events.queryAfter(owner.execution.executionId, 0, 10)).toEqual([])
  })
})

test('repair: legitimate historical project events retain their scope and query identity', async () => {
  await fixture(async ({ provider }) => {
    const { context, plan } = projectFixture()
    await seed(provider, context, plan)
    const owner = await service(provider, 'G', false).acceptExecution(commandInput(plan))
    const draft = {
      eventId: id('evt'),
      executionId: owner.execution.executionId,
      type: 'execution.progressed',
      schemaVersion: 1,
      correlation: { ...owner.execution.correlation, commandId: id('cmd'), traceId: id('trc') },
      payload: { progress: 25 },
      occurredAt: at,
      recordedAt: at,
      retentionExpiresAt: expiry,
    }
    const events = new SqliteExecutionEventRepository(provider)
    const event = await events.append(draft)
    expect(event.correlation.projectId).toBe(id('prj'))
    expect(event.correlation.executionScope).toBeUndefined()
    expect(await events.queryAfter(owner.execution.executionId, 0, 10)).toEqual([event])
  })
})
