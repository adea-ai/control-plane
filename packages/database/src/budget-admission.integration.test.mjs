import { afterEach, describe, expect, test as runTest } from 'bun:test'
import process from 'node:process'
import { eq } from 'drizzle-orm'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { loadDatabaseCredentials } from '@control-plane/config'
import { CommandInboxService } from '@control-plane/domain'
import { deriveExecutionPlan, executionBudgetAdmissionSource } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DurableUsageLedger, budgetOpeningEntryIdempotencyKey } from '@control-plane/usage-ledger'
import { createPostgresConnection } from './connection.ts'
import { PostgresCommandAcceptanceRepository } from './command-inbox-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { commandInbox } from './schema/commands.ts'
import { executions } from './schema/executions.ts'
import { usageBudgetStates } from './schema/usage-budget-state.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresDurableUsageStore } from './usage-store.ts'

const test = (name, operation) => runTest(name, operation, 60_000)
const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const acceptedAt = '2026-09-20T10:00:00.000Z'
const plan = createExecutionPlanTestFixture()
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let fixtureSequence = 0

function nextId(prefix) {
  fixtureSequence += 1
  const tail =
    alphabet[Math.floor(fixtureSequence / alphabet.length)] +
    alphabet[fixtureSequence % alphabet.length]
  return `${prefix}_01ARZ3NDEKTSV4RRFFQ69G5F${tail}`
}

function commandInput(executionPlan, options = {}) {
  const correlation = executionPlan.correlation
  const sequence = fixtureSequence + 1
  return {
    callerPrincipalId: 'svc_budget-admission-integration',
    operation: 'execution.accept',
    commandId: nextId('cmd'),
    requestId: correlation.requestId,
    idempotencyKey: `budget-admission-${sequence}`,
    payloadHash: String(sequence).padStart(64, 'a'),
    correlation: {
      workspaceId: correlation.workspaceId,
      projectId: correlation.projectId,
      taskId: correlation.taskId,
      agentId: correlation.agentId,
    },
    executionPlan: {
      executionPlanId: executionPlan.executionPlanId,
      contentDigest: executionPlan.contentDigest,
      schemaVersion: executionPlan.schemaVersion,
    },
    ...(options.parentExecutionId === undefined
      ? {}
      : { parentExecutionId: options.parentExecutionId }),
    receivedAt: acceptedAt,
    retentionExpiresAt: '2026-10-20T10:00:00.000Z',
  }
}

function acceptanceService(database, options = {}) {
  const repository = new PostgresCommandAcceptanceRepository(database, {
    budgetAdmission: true,
  })
  return {
    repository,
    service: new CommandInboxService({
      repository,
      executionIdFactory: options.executionIdFactory ?? (() => nextId('exe')),
      executionPlanValidator: { validate: async () => true },
      now: () => acceptedAt,
    }),
  }
}

function ledger(database) {
  return new DurableUsageLedger({ store: new PostgresDurableUsageStore(database) })
}

function childPlan(parentPlan) {
  return deriveExecutionPlan(parentPlan, {
    correlation: {
      ...parentPlan.correlation,
      taskId: nextId('tsk'),
      requestId: nextId('req'),
    },
    contextPackage: contextPackageSerializationFixtures.futurePi,
    constraints: structuredClone(parentPlan.constraints),
    runtimeRequirements: parentPlan.runtimeRequirements,
    outputContract: parentPlan.outputContract,
    compiledAt: '2026-09-20T10:00:02.000Z',
  })
}

describe.skipIf(!enabled)('PostgreSQL command budget admission', () => {
  const isolatedDatabases = []

  async function createDatabase() {
    const credentials = {
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    }
    const isolated = await createIsolatedTestDatabase(credentials)
    isolatedDatabases.push(isolated)
    await isolated.migrate()
    await new PostgresContextPackageRepository(isolated.application).put(
      contextPackageSerializationFixtures.futurePi
    )
    await new PostgresExecutionPlanRepository(isolated.application).put(plan)
    return { isolated, credentials }
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

  test('commits plan-bounded allocation and replays without adding a second opening credit', async () => {
    const { isolated, credentials } = await createDatabase()
    const input = commandInput(plan)
    const { repository, service } = acceptanceService(isolated.application)
    const accepted = await service.acceptExecution(input)
    const initialLedger = ledger(isolated.application)
    const initialSummary = await initialLedger.summary(
      accepted.command.workspaceId,
      accepted.execution.executionId
    )
    const initialEntries = await initialLedger.entries(
      accepted.command.workspaceId,
      accepted.execution.executionId
    )
    const source = executionBudgetAdmissionSource(accepted.command, accepted.execution)

    expect(initialSummary).toMatchObject({
      maximumMicrounits: plan.constraints.limits.budget.maximumMicrounits,
      maximumTokens: plan.constraints.limits.tokens.maximumTotal,
      spentMicrounits: 0,
      reservedMicrounits: 0,
      spentTokens: 0,
      reservedTokens: 0,
      settled: false,
    })
    expect(initialEntries).toHaveLength(1)
    expect(initialEntries[0]).toMatchObject({
      sequence: 1,
      kind: 'credit',
      source: {
        sourceId: source.sourceId,
        idempotencyKey: budgetOpeningEntryIdempotencyKey(
          source.idempotencyKey,
          accepted.execution.executionId
        ),
      },
    })

    await expect(repository.accept(accepted.command, accepted.execution)).resolves.toMatchObject({
      outcome: 'duplicate',
    })

    const databaseUrl = new URL(credentials.application.url)
    databaseUrl.pathname = `/${isolated.name}`
    const reconnected = createPostgresConnection({
      ...credentials.application,
      url: databaseUrl.toString(),
    })
    try {
      const reopenedRepository = new PostgresCommandAcceptanceRepository(reconnected.database, {
        budgetAdmission: true,
      })
      await reopenedRepository.verifyAdmission(accepted.command, accepted.execution)
      await expect(
        reopenedRepository.accept(accepted.command, accepted.execution)
      ).resolves.toMatchObject({
        outcome: 'duplicate',
      })
      await expect(
        ledger(reconnected.database).entries(
          accepted.command.workspaceId,
          accepted.execution.executionId
        )
      ).resolves.toHaveLength(1)
    } finally {
      await reconnected.close()
    }
  })

  test('rolls back command and owner when parent budget exhaustion denies child admission', async () => {
    const { isolated } = await createDatabase()
    const parentInput = commandInput(plan)
    const { service: parentService } = acceptanceService(isolated.application)
    const parent = await parentService.acceptExecution(parentInput)
    const parentSummary = await ledger(isolated.application).summary(
      parent.command.workspaceId,
      parent.execution.executionId
    )
    await ledger(isolated.application).reserve({
      workspaceId: parent.command.workspaceId,
      executionId: parent.execution.executionId,
      reservationKey: 'consume-parent-authority',
      maximumMicrounits: parentSummary.maximumMicrounits,
      maximumTokens: parentSummary.maximumTokens,
      source: {
        sourceId: 'budget-admission-integration',
        idempotencyKey: 'consume-parent-authority',
      },
    })

    const planForChild = childPlan(plan)
    await new PostgresExecutionPlanRepository(isolated.application).put(planForChild)
    const childInput = commandInput(planForChild, {
      parentExecutionId: parent.execution.executionId,
    })
    const childExecutionId = nextId('exe')
    const { service: childService } = acceptanceService(isolated.application, {
      executionIdFactory: () => childExecutionId,
    })
    await expect(childService.acceptExecution(childInput)).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    })
    expect(
      await isolated.application
        .select()
        .from(commandInbox)
        .where(eq(commandInbox.commandId, childInput.commandId))
    ).toHaveLength(0)
    expect(
      await isolated.application
        .select()
        .from(executions)
        .where(eq(executions.executionId, childExecutionId))
    ).toHaveLength(0)
    expect(
      await isolated.application
        .select()
        .from(usageBudgetStates)
        .where(eq(usageBudgetStates.executionId, childExecutionId))
    ).toHaveLength(0)
  })

  test('rejects a parent owner in another project before creating the child owner', async () => {
    const { isolated } = await createDatabase()
    const { service: parentService } = acceptanceService(isolated.application)
    const parent = await parentService.acceptExecution(commandInput(plan))
    const planForChild = childPlan(plan)
    await new PostgresExecutionPlanRepository(isolated.application).put(planForChild)
    const wrongProjectId = nextId('prj')
    await isolated.application
      .update(executions)
      .set({ projectId: wrongProjectId })
      .where(eq(executions.executionId, parent.execution.executionId))

    const childExecutionId = nextId('exe')
    const childInput = commandInput(planForChild, {
      parentExecutionId: parent.execution.executionId,
    })
    const { service: childService } = acceptanceService(isolated.application, {
      executionIdFactory: () => childExecutionId,
    })
    await expect(childService.acceptExecution(childInput)).rejects.toMatchObject({
      code: 'INVALID_EXECUTION_PLAN_REFERENCE',
    })
    expect(
      await isolated.application
        .select()
        .from(commandInbox)
        .where(eq(commandInbox.commandId, childInput.commandId))
    ).toHaveLength(0)
    expect(
      await isolated.application
        .select()
        .from(executions)
        .where(eq(executions.executionId, childExecutionId))
    ).toHaveLength(0)
  })

  test('fails closed for missing or schema-valid corrupted budget state on replay', async () => {
    const { isolated } = await createDatabase()
    const { repository, service } = acceptanceService(isolated.application)
    const missing = await service.acceptExecution(commandInput(plan))
    await isolated.application
      .delete(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, missing.execution.executionId))
    await expect(
      repository.verifyAdmission(missing.command, missing.execution)
    ).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })

    const corrupted = await service.acceptExecution(commandInput(plan))
    const [budget] = await isolated.application
      .select()
      .from(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, corrupted.execution.executionId))
      .limit(1)
    expect(budget).toBeDefined()
    await isolated.application
      .update(usageBudgetStates)
      .set({ state: { ...budget.state, maximumTokens: budget.state.maximumTokens + 1 } })
      .where(eq(usageBudgetStates.executionId, corrupted.execution.executionId))
    await expect(
      repository.verifyAdmission(corrupted.command, corrupted.execution)
    ).rejects.toMatchObject({ code: 'STORE_STATE_INVALID' })
  })
})
