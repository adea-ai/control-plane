import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { loadDatabaseCredentials } from '@control-plane/config'
import { ControlApiFixtures } from '@control-plane/contracts'
import {
  ContextPackageCompiler,
  bindProjectContextPackageToWorkspaceParent,
  contextPackageSerializationFixtures,
} from '@control-plane/context'
import {
  CommandInboxRecordSchema,
  ExecutionLifecycleService,
  ExecutionSchema,
  retiredCommandKeyCandidates,
} from '@control-plane/domain'
import {
  ExecutionPlanCompiler,
  assertExecutionPlanIntegrity,
  deriveExecutionPlanWithAuthority,
  currentExecutionScopeAllows,
} from '@control-plane/execution-plan'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { PostgresDurableUsageStore } from './usage-store.ts'
import { PostgresDelegationRepository } from './delegation-repository.ts'
import { PostgresProjectStateRepository } from './project-state-repository.ts'
import { PostgresCommandAcceptanceRepository } from './command-inbox-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { PostgresExecutionRepository, toExecutionRow } from './execution-repository.ts'
import { PostgresExecutionCancellationRepository } from './execution-cancellation-repository.ts'
import { PostgresExecutionEventRepository } from './execution-event-repository.ts'
import { migrateDatabase } from './migration.ts'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { commandInbox } from './schema/commands.ts'
import { executionPlans } from './schema/execution-plans.ts'
import { executions } from './schema/executions.ts'
import { usageBudgetStates } from './schema/usage-budget-state.ts'
import { usageLedgerEntries } from './schema/usage-ledger.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const time = '2026-10-08T12:00:00.000Z'
const workspaceScope = { schemaVersion: 1, kind: 'workspace' }
const legacyPlan = createExecutionPlanTestFixture()
let sequence = 0
const id = (prefix) => `${prefix}_01JABCDEF0123456789ABCD${String(++sequence).padStart(3, '0')}`

function pair(plan, key = id('req')) {
  const executionPlan = {
    executionPlanId: plan.executionPlanId,
    contentDigest: plan.contentDigest,
    schemaVersion: plan.schemaVersion,
  }
  const execution = ExecutionSchema.parse({
    executionId: id('exe'),
    state: 'accepted',
    version: 1,
    correlation: plan.correlation,
    executionPlan,
    attemptCount: 0,
    acceptedAt: time,
    createdAt: time,
    updatedAt: time,
  })
  const command = CommandInboxRecordSchema.parse({
    commandId: id('cmd'),
    callerPrincipalId: 'svc_workspace-scope-fixture',
    operation: 'execution.accept',
    workspaceId: plan.correlation.workspaceId,
    ...(plan.correlation.projectId === undefined ? {} : { projectId: plan.correlation.projectId }),
    ...(plan.correlation.executionScope === undefined
      ? {}
      : { executionScope: plan.correlation.executionScope }),
    taskId: plan.correlation.taskId,
    agentId: plan.correlation.agentId,
    requestId: plan.correlation.requestId,
    idempotencyKey: key,
    payloadHash: 'a'.repeat(64),
    status: 'accepted',
    executionId: execution.executionId,
    executionPlan,
    version: 1,
    conflictCount: 0,
    receivedAt: time,
    lastSeenAt: time,
    retentionExpiresAt: '2026-11-08T12:00:00.000Z',
  })
  return { command, execution }
}

function workspacePlan() {
  const legacy = contextPackageSerializationFixtures.futurePi
  const context = new ContextPackageCompiler('1.0.0').compileWorkspace({
    workspaceId: legacy.projectState.workspaceId,
    executionScope: workspaceScope,
    revision: 1,
    objective: 'Run workspace lead',
    artifacts: [],
    constraints: { ...legacy.constraints, allowedArtifactIds: [] },
    permissions: [],
    successCriteria: legacy.successCriteria,
    returnContract: legacy.returnContract,
    budgets: legacy.budgets,
    compiledAt: legacy.compiledAt,
  })
  const input = createExecutionPlanTestFixtureInputs({ contextPackage: context })
  const { projectId: _projectId, ...correlation } = input.correlation
  return {
    context,
    plan: new ExecutionPlanCompiler('1.0.0').compile({
      ...input,
      correlation: { ...correlation, executionScope: workspaceScope },
    }),
  }
}

function projectPlan(workspaceId) {
  const source = contextPackageSerializationFixtures.futurePi
  const context = new ContextPackageCompiler('1.0.0').compile({
    objective: 'Run a standalone project execution',
    projectState: {
      schemaVersion: 1,
      workspaceId,
      projectId: legacyPlan.correlation.projectId,
      revision: 1,
      items: [],
      createdAt: time,
      updatedAt: time,
    },
    expectedProjectStateRevision: 1,
    candidates: [],
    artifacts: [],
    constraints: { ...source.constraints, allowedArtifactIds: [] },
    permissions: [],
    successCriteria: source.successCriteria,
    returnContract: source.returnContract,
    budgets: source.budgets,
    compiledAt: source.compiledAt,
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

let isolated
let database
let workspace
let legacy
let historicalFolder

describe.skipIf(!enabled)('PostgreSQL workspace execution scope migration and command path', () => {
  beforeAll(async () => {
    const credentials = {
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    }
    isolated = await createIsolatedTestDatabase(credentials)
    database = isolated.application
    historicalFolder = await mkdtemp(join(tmpdir(), 'cp-scope-migrations-'))
    await cp(new URL('../drizzle', import.meta.url), historicalFolder, { recursive: true })
    const journalPath = join(historicalFolder, 'meta/_journal.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.entries = journal.entries.filter(({ idx }) => idx < 68)
    await writeFile(journalPath, JSON.stringify(journal))
    const url = new URL(credentials.migration.url)
    url.pathname = `/${isolated.name}`
    await migrateDatabase(
      { role: 'migration', url: url.toString() },
      { migrationsFolder: historicalFolder }
    )
    legacy = pair(legacyPlan, 'legacy-project-idempotency')
    // Seed the exact pre-0068 representation: current Drizzle schema cannot address absent columns.
    await isolated.withMigrationDatabase(async (old) => {
      const context = contextPackageSerializationFixtures.futurePi
      await old.execute(
        sql`insert into context_packages (context_package_id, content_digest, schema_version, workspace_id, project_id, context_package, compiled_at) values (${context.contextPackageId}, ${context.contentDigest}, ${context.schemaVersion}, ${context.projectState.workspaceId}, ${context.projectState.projectId}, ${JSON.stringify(context)}::jsonb, ${context.compiledAt})`
      )
      await old.execute(
        sql`insert into execution_plans (execution_plan_id, content_digest, schema_version, workspace_id, project_id, task_id, agent_id, plan, compiled_at) values (${legacyPlan.executionPlanId}, ${legacyPlan.contentDigest}, ${legacyPlan.schemaVersion}, ${legacyPlan.correlation.workspaceId}, ${legacyPlan.correlation.projectId}, ${legacyPlan.correlation.taskId}, ${legacyPlan.correlation.agentId}, ${JSON.stringify(legacyPlan)}::jsonb, ${legacyPlan.compiledAt})`
      )
      const execution = legacy.execution
      await old.execute(
        sql`insert into executions (execution_id, state, version, workspace_id, project_id, task_id, agent_id, request_id, execution_plan_id, execution_plan_digest, execution_plan_schema_version, attempt_count, accepted_at, created_at, updated_at) values (${execution.executionId}, 'accepted', 1, ${execution.correlation.workspaceId}, ${execution.correlation.projectId}, ${execution.correlation.taskId}, ${execution.correlation.agentId}, ${execution.correlation.requestId}, ${execution.executionPlan.executionPlanId}, ${execution.executionPlan.contentDigest}, 1, 0, ${time}, ${time}, ${time})`
      )
      const command = legacy.command
      await old.execute(
        sql`insert into command_inbox (command_id, caller_principal_id, operation, workspace_id, project_id, task_id, agent_id, request_id, idempotency_key, payload_hash, status, execution_id, execution_plan_id, execution_plan_digest, execution_plan_schema_version, version, conflict_count, received_at, last_seen_at, retention_expires_at) values (${command.commandId}, ${command.callerPrincipalId}, ${command.operation}, ${command.workspaceId}, ${command.projectId}, ${command.taskId}, ${command.agentId}, ${command.requestId}, ${command.idempotencyKey}, ${command.payloadHash}, 'accepted', ${command.executionId}, ${command.executionPlan.executionPlanId}, ${command.executionPlan.contentDigest}, 1, 1, 0, ${time}, ${time}, ${command.retentionExpiresAt})`
      )
    })
    await isolated.migrate()
    await isolated.migrate()
    workspace = workspacePlan()
    await new PostgresContextPackageRepository(database).put(workspace.context)
    await new PostgresExecutionPlanRepository(database).put(workspace.plan)
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    await isolated?.dispose()
    if (historicalFolder) await rm(historicalFolder, { recursive: true, force: true })
  }, integrationTestTimeout())

  test('upgrade preserves old canonical digest, absent scope fields and replay identity', async () => {
    const plans = new PostgresExecutionPlanRepository(database)
    expect(await plans.get(legacy.command.executionPlan)).toEqual(legacyPlan)
    const commands = new PostgresCommandAcceptanceRepository(database)
    const accepted = await commands.accept(legacy.command, legacy.execution)
    expect(accepted.outcome).toBe('duplicate')
    expect(accepted.command).toEqual(legacy.command)
    expect(accepted.execution).toEqual(legacy.execution)
    expect(retiredCommandKeyCandidates(accepted.command)).toEqual(
      retiredCommandKeyCandidates(legacy.command)
    )
    for (const changed of [
      { ...legacyPlan, schemaVersion: 2 },
      {
        ...legacyPlan,
        correlation: {
          ...legacyPlan.correlation,
          executionScope: {
            schemaVersion: 1,
            kind: 'project',
            projectId: legacyPlan.correlation.projectId,
          },
        },
      },
    ])
      expect(() => assertExecutionPlanIntegrity(changed)).toThrow()
  })

  test('workspace context, plan, command and execution round trip with one concurrent admission', async () => {
    const repository = new PostgresCommandAcceptanceRepository(database)
    const first = pair(workspace.plan, 'workspace-concurrent')
    const second = pair(workspace.plan, 'workspace-concurrent')
    const results = await Promise.all([
      repository.accept(first.command, first.execution),
      repository.accept(second.command, second.execution),
    ])
    expect(results.map(({ outcome }) => outcome).toSorted()).toEqual(['accepted', 'duplicate'])
    expect(results[0].command.commandId).toBe(results[1].command.commandId)
    expect(results[0].execution.correlation).toEqual(workspace.plan.correlation)
    expect(
      await new PostgresExecutionPlanRepository(database).get(first.command.executionPlan)
    ).toEqual(workspace.plan)
    expect(
      await new PostgresContextPackageRepository(database).get({
        contextPackageId: workspace.context.contextPackageId,
        contentDigest: workspace.context.contentDigest,
      })
    ).toEqual(workspace.context)
    expect(
      await database
        .select()
        .from(commandInbox)
        .where(eq(commandInbox.idempotencyKey, 'workspace-concurrent'))
    ).toHaveLength(1)
  })

  test('raw storage rejects both-null scope, mismatched project scope and duplicate null-project key', async () => {
    const input = pair(workspace.plan, 'workspace-constraints')
    const repository = new PostgresCommandAcceptanceRepository(database)
    await repository.accept(input.command, input.execution)
    for (const malformed of [
      { projectId: null, executionScope: null },
      { projectId: legacyPlan.correlation.projectId, executionScope: workspaceScope },
      { projectId: null, executionScope: { schemaVersion: 2, kind: 'workspace' } },
    ]) {
      await expect(
        database
          .insert(executions)
          .values({ ...toExecutionRow(input.execution), executionId: id('exe'), ...malformed })
          .execute()
      ).rejects.toMatchObject({ cause: { code: '23514' } })
    }
    const [row] = await database
      .select()
      .from(commandInbox)
      .where(eq(commandInbox.commandId, input.command.commandId))
    await expect(
      database
        .insert(commandInbox)
        .values({ ...row, commandId: id('cmd') })
        .execute()
    ).rejects.toMatchObject({ cause: { code: '23505' } })
    await expect(
      database
        .insert(executionPlans)
        .values({
          executionPlanId: id('pln'),
          contentDigest: workspace.plan.contentDigest,
          schemaVersion: 2,
          workspaceId: workspace.plan.correlation.workspaceId,
          projectId: null,
          taskId: workspace.plan.correlation.taskId,
          agentId: workspace.plan.correlation.agentId,
          plan: workspace.plan,
          compiledAt: new Date(time),
        })
        .execute()
    ).rejects.toMatchObject({ cause: { code: '23514' } })
  })

  test('workspace cancellation survives restart, lists exact scope and rejects cross-workspace ownership', async () => {
    const input = pair(workspace.plan, 'workspace-cancel')
    await new PostgresCommandAcceptanceRepository(database).accept(input.command, input.execution)
    const { projectId: _projectId, ...base } = ControlApiFixtures.executionAcceptance.request
    const request = {
      ...base,
      commandId: id('cmd'),
      workspaceId: workspace.plan.correlation.workspaceId,
      executionScope: workspaceScope,
      operation: 'execution.cancel',
      idempotencyKey: 'workspace-cancel',
      payload: { executionId: input.execution.executionId },
    }
    const receipts = new PostgresExecutionCancellationRepository(database)
    expect((await receipts.reserve({ request })).inserted).toBe(true)
    await receipts.markAccepted(request, time)
    const restarted = new PostgresExecutionCancellationRepository(database)
    expect(await restarted.get(request)).toEqual({ request, acceptedAt: time })
    expect(
      await restarted.listByExecution({
        executionId: input.execution.executionId,
        workspaceId: request.workspaceId,
        limit: 10,
      })
    ).toEqual([{ request, acceptedAt: time }])
    await expect(
      restarted.reserve({
        request: {
          ...request,
          workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH',
          idempotencyKey: 'cross-workspace-0001',
        },
      })
    ).rejects.toThrow('EXECUTION_CANCELLATION_SCOPE_MISMATCH')
    const lifecycle = new ExecutionLifecycleService(new PostgresExecutionRepository(database))
    let execution = await lifecycle.transitionExecution({
      executionId: input.execution.executionId,
      expectedVersion: 1,
      to: 'queued',
      transitionedAt: time,
    })
    execution = await lifecycle.transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: 'cancelling',
      transitionedAt: time,
    })
    execution = await lifecycle.transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to: 'cancelled',
      transitionedAt: time,
    })
    expect(
      (await new PostgresExecutionRepository(database).getExecution(execution.executionId))
        .correlation
    ).toEqual(workspace.plan.correlation)
  })

  test('workspace budget admission and attempt survive repository reconstruction without duplicate credits', async () => {
    const input = pair(workspace.plan, 'workspace-budget-attempt')
    const repository = new PostgresCommandAcceptanceRepository(database, { budgetAdmission: true })
    await repository.accept(input.command, input.execution)
    const ledger = new DurableUsageLedger({ store: new PostgresDurableUsageStore(database) })
    expect(
      await ledger.summary(input.command.workspaceId, input.execution.executionId)
    ).toMatchObject({
      maximumMicrounits: workspace.plan.constraints.limits.budget.maximumMicrounits,
      maximumTokens: workspace.plan.constraints.limits.tokens.maximumTotal,
      spentMicrounits: 0,
      reservedMicrounits: 0,
    })
    const lifecycle = new ExecutionLifecycleService(new PostgresExecutionRepository(database))
    const attempt = await lifecycle.createAttempt({
      executionId: input.execution.executionId,
      expectedExecutionVersion: 1,
      attemptId: id('att'),
      queuedAt: time,
    })
    expect(await new PostgresExecutionRepository(database).getAttempt(attempt.attemptId)).toEqual(
      attempt
    )
    await repository.verifyAdmission(input.command, input.execution)
    expect((await repository.accept(input.command, input.execution)).outcome).toBe('duplicate')
    expect(
      await ledger.entries(input.command.workspaceId, input.execution.executionId)
    ).toHaveLength(1)
    expect(
      (await new PostgresExecutionRepository(database).getExecution(input.execution.executionId))
        .correlation
    ).toEqual(workspace.plan.correlation)
  })

  test('workspace parent narrows to a stored real project through current authority and retains scoped child outcome', async () => {
    const projects = new PostgresProjectStateRepository(database)
    const projectId = legacyPlan.correlation.projectId
    const workspaceId = workspace.plan.correlation.workspaceId
    expect(
      await projects.create({
        schemaVersion: 1,
        workspaceId,
        projectId,
        revision: 1,
        items: [],
        createdAt: time,
        updatedAt: time,
      })
    ).toBe(true)
    let audience = true
    let grant = true
    const authority = {
      readCurrent: async (input) => {
        const project =
          input.executionScope.kind === 'project'
            ? await projects.get(input.workspaceId, input.executionScope.projectId)
            : undefined
        return {
          workspaceId: input.workspaceId,
          executionScope: input.executionScope,
          callerPrincipalId: input.callerPrincipalId,
          executionPlan: input.executionPlan,
          principalActive: true,
          grantActive: grant,
          allowedPrincipalIds: audience ? [input.callerPrincipalId] : [],
          expiresAt: '2026-11-08T12:00:00.000Z',
          ...(project === undefined ? {} : { projectWorkspaceId: project.workspaceId }),
        }
      },
    }
    const childContext = bindProjectContextPackageToWorkspaceParent(
      workspace.context,
      contextPackageSerializationFixtures.futurePi
    )
    const childInput = {
      correlation: {
        ...workspace.plan.correlation,
        projectId,
        executionScope: { schemaVersion: 1, kind: 'project', projectId },
        taskId: id('tsk'),
        requestId: id('req'),
      },
      contextPackage: childContext,
      constraints: workspace.plan.constraints,
      runtimeRequirements: workspace.plan.runtimeRequirements.filter(
        ({ capability }) => capability !== 'execution.scope.workspace.v1'
      ),
      outputContract: workspace.plan.outputContract,
      compiledAt: workspace.plan.compiledAt,
    }
    const options = { callerPrincipalId: 'svc_workspace-scope-fixture', authority, now: time }
    audience = false
    await expect(
      deriveExecutionPlanWithAuthority(workspace.plan, childInput, options)
    ).rejects.toThrow('current-scope-authority')
    audience = true
    grant = false
    await expect(
      deriveExecutionPlanWithAuthority(workspace.plan, childInput, options)
    ).rejects.toThrow('current-scope-authority')
    grant = true
    const childPlan = await deriveExecutionPlanWithAuthority(workspace.plan, childInput, options)
    const planPin = {
      executionPlanId: childPlan.executionPlanId,
      contentDigest: childPlan.contentDigest,
      schemaVersion: childPlan.schemaVersion,
    }
    expect(
      await currentExecutionScopeAllows(
        authority,
        {
          ...childPlan.correlation,
          callerPrincipalId: options.callerPrincipalId,
          executionPlan: planPin,
        },
        time
      )
    ).toBe(true)
    expect(
      await currentExecutionScopeAllows(
        authority,
        {
          ...childPlan.correlation,
          workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH',
          callerPrincipalId: options.callerPrincipalId,
          executionPlan: planPin,
        },
        time
      )
    ).toBe(false)
    await new PostgresContextPackageRepository(database).put(childContext)
    await new PostgresExecutionPlanRepository(database).put(childPlan)
    const parent = pair(workspace.plan, 'workspace-parent-budget')
    const child = pair(childPlan, 'workspace-child-budget')
    child.execution = ExecutionSchema.parse({
      ...child.execution,
      parentExecutionId: parent.execution.executionId,
    })
    const repository = new PostgresCommandAcceptanceRepository(database, { budgetAdmission: true })
    await repository.accept(parent.command, parent.execution)
    await repository.accept(child.command, child.execution)
    const record = {
      delegationId: id('dlg'),
      parentExecutionId: parent.execution.executionId,
      childExecutionId: child.execution.executionId,
      parentExecutionPlanId: workspace.plan.executionPlanId,
      parentExecutionPlanDigest: workspace.plan.contentDigest,
      childExecutionPlanId: childPlan.executionPlanId,
      childExecutionPlanDigest: childPlan.contentDigest,
      contextPackageId: childContext.contextPackageId,
      contextPackageDigest: childContext.contentDigest,
      role: 'researcher',
      profileVersionId: childPlan.profile.profileVersionId,
      objective: 'Run the narrowed project child',
      policy: {
        cancellation: 'cascade',
        deadline: 'bounded_by_parent',
        failure: 'retry',
        maximumRetries: 2,
      },
      state: 'requested',
      retryCount: 0,
      inputDigest: `sha256:${'a'.repeat(64)}`,
      revision: 1,
      acceptedAt: time,
      updatedAt: time,
    }
    const delegations = new PostgresDelegationRepository(database)
    expect(await delegations.insert(record)).toBe(true)
    const completed = { ...record, state: 'completed', terminalResultRef: id('art'), revision: 2 }
    expect(await delegations.compareAndSet(1, completed)).toBe(true)
    expect(
      await new PostgresDelegationRepository(database).listByParent(parent.execution.executionId)
    ).toEqual([completed])
    expect(
      (await new PostgresExecutionRepository(database).getExecution(parent.execution.executionId))
        .correlation.executionScope
    ).toEqual(workspaceScope)
    expect(
      (await new PostgresExecutionRepository(database).getExecution(child.execution.executionId))
        .correlation
    ).toEqual(childPlan.correlation)
  })

  for (const foreign of [true, false]) {
    test(`default unbudgeted explicit child rejects ${foreign ? 'foreign project owner' : 'standalone same-workspace plan'} atomically`, async () => {
      const parent = foreign ? projectPlan('wsp_01JABCDEF0123456789ABCDEFH') : workspace
      await new PostgresContextPackageRepository(database).put(parent.context)
      await new PostgresExecutionPlanRepository(database).put(parent.plan)
      const repository = new PostgresCommandAcceptanceRepository(database)
      const parentInput = pair(parent.plan, `unbudgeted-parent-${foreign}`)
      expect((await repository.accept(parentInput.command, parentInput.execution)).outcome).toBe(
        'accepted'
      )
      const child = pair(workspace.plan, `unbudgeted-invalid-child-${foreign}`)
      child.execution = ExecutionSchema.parse({
        ...child.execution,
        parentExecutionId: parentInput.execution.executionId,
      })
      await expect(repository.accept(child.command, child.execution)).rejects.toThrow(
        'INVALID_EXECUTION_PLAN_REFERENCE'
      )
      expect(await repository.get(child.command)).toBeUndefined()
      expect(
        await new PostgresExecutionRepository(database).getExecution(child.execution.executionId)
      ).toBeUndefined()
      expect(
        await database
          .select()
          .from(usageBudgetStates)
          .where(eq(usageBudgetStates.executionId, child.execution.executionId))
      ).toEqual([])
      expect(
        await database
          .select()
          .from(usageLedgerEntries)
          .where(eq(usageLedgerEntries.executionId, child.execution.executionId))
      ).toEqual([])
    })
  }

  test('default unbudgeted explicit child verifies async narrowed real-project ancestry without reserving budget', async () => {
    const projects = new PostgresProjectStateRepository(database)
    const projectId = legacyPlan.correlation.projectId
    const workspaceId = workspace.plan.correlation.workspaceId
    await projects.create({
      schemaVersion: 1,
      workspaceId,
      projectId,
      revision: 1,
      items: [],
      createdAt: time,
      updatedAt: time,
    })
    const context = bindProjectContextPackageToWorkspaceParent(
      workspace.context,
      contextPackageSerializationFixtures.futurePi
    )
    const plan = await deriveExecutionPlanWithAuthority(
      workspace.plan,
      {
        correlation: {
          ...workspace.plan.correlation,
          projectId,
          executionScope: { schemaVersion: 1, kind: 'project', projectId },
          taskId: id('tsk'),
          requestId: id('req'),
        },
        contextPackage: context,
        constraints: workspace.plan.constraints,
        runtimeRequirements: workspace.plan.runtimeRequirements.filter(
          ({ capability }) => capability !== 'execution.scope.workspace.v1'
        ),
        outputContract: workspace.plan.outputContract,
        compiledAt: workspace.plan.compiledAt,
      },
      {
        callerPrincipalId: 'svc_workspace-scope-fixture',
        now: time,
        authority: {
          readCurrent: async (input) => {
            const project =
              input.executionScope.kind === 'project'
                ? await projects.get(input.workspaceId, input.executionScope.projectId)
                : undefined
            return {
              workspaceId: input.workspaceId,
              executionScope: input.executionScope,
              callerPrincipalId: input.callerPrincipalId,
              executionPlan: input.executionPlan,
              principalActive: true,
              grantActive: true,
              allowedPrincipalIds: [input.callerPrincipalId],
              expiresAt: '2026-11-08T12:00:00.000Z',
              ...(project === undefined ? {} : { projectWorkspaceId: project.workspaceId }),
            }
          },
        },
      }
    )
    await new PostgresContextPackageRepository(database).put(context)
    await new PostgresExecutionPlanRepository(database).put(plan)
    const parent = pair(workspace.plan, 'unbudgeted-valid-parent')
    const child = pair(plan, 'unbudgeted-valid-child')
    child.execution = ExecutionSchema.parse({
      ...child.execution,
      parentExecutionId: parent.execution.executionId,
    })
    const repository = new PostgresCommandAcceptanceRepository(database)
    expect((await repository.accept(parent.command, parent.execution)).outcome).toBe('accepted')
    expect((await repository.accept(child.command, child.execution)).outcome).toBe('accepted')
    expect(
      await new PostgresExecutionRepository(database).getExecution(child.execution.executionId)
    ).toEqual(child.execution)
    expect((await repository.accept(child.command, child.execution)).outcome).toBe('duplicate')
    for (const execution of [parent.execution, child.execution]) {
      expect(
        await database
          .select()
          .from(usageBudgetStates)
          .where(eq(usageBudgetStates.executionId, execution.executionId))
      ).toEqual([])
      expect(
        await database
          .select()
          .from(usageLedgerEntries)
          .where(eq(usageLedgerEntries.executionId, execution.executionId))
      ).toEqual([])
    }
  })

  test('workspace progress replay keeps scope and event effects reject cross-workspace correlation', async () => {
    const input = pair(workspace.plan, 'workspace-progress')
    await new PostgresCommandAcceptanceRepository(database).accept(input.command, input.execution)
    const repository = new PostgresExecutionEventRepository(database)
    const draft = {
      eventId: id('evt'),
      executionId: input.execution.executionId,
      type: 'execution.progress',
      schemaVersion: 1,
      correlation: { ...workspace.plan.correlation, traceId: id('trc') },
      payload: { step: 'deterministic' },
      occurredAt: time,
      recordedAt: time,
      retentionExpiresAt: '2026-11-08T12:00:00.000Z',
    }
    const first = await repository.append(draft)
    expect(first.correlation).toEqual(draft.correlation)
    expect(
      await new PostgresExecutionEventRepository(database).queryAfter(
        input.execution.executionId,
        0,
        10
      )
    ).toEqual([first])
    expect(await repository.append(draft)).toBeUndefined()
    await expect(
      repository.append({
        ...draft,
        eventId: id('evt'),
        correlation: { ...draft.correlation, workspaceId: 'wsp_01JABCDEF0123456789ABCDEFH' },
      })
    ).rejects.toThrow('EXECUTION_EVENT_SCOPE_MISMATCH')
  })
})
