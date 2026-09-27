import { afterEach, describe, expect, test as runTest } from 'bun:test'
import process from 'node:process'
import { readFile } from 'node:fs/promises'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { loadDatabaseCredentials } from '@control-plane/config'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { deriveExecutionPlan, executionBudgetAdmissionSource } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DurableUsageLedger, budgetOpeningEntryIdempotencyKey } from '@control-plane/usage-ledger'
import { PostgresAdmissionRolloutService } from './admission-rollout.ts'
import { createPostgresConnection } from './connection.ts'
import { PostgresCommandAcceptanceRepository } from './command-inbox-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { commandInbox } from './schema/commands.ts'
import { executions } from './schema/executions.ts'
import { usageBudgetStates, usageOperationReceipts } from './schema/usage-budget-state.ts'
import { usageLedgerEntries } from './schema/usage-ledger.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresDurableUsageStore } from './usage-store.ts'
import * as schema from './schema/index.ts'

const test = (name, operation, timeoutMs = 60_000) => runTest(name, operation, timeoutMs)
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
    budgetAdmission: options.budgetAdmission ?? true,
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

async function persistLegacyOutcome(database, service, accepted, executionState, commandStatus) {
  const lifecycle = new ExecutionLifecycleService(new PostgresExecutionRepository(database))
  let execution = accepted.execution
  let sequence = 0
  const transition = async (to, metadata = {}) => {
    sequence++
    execution = await lifecycle.transitionExecution({
      executionId: execution.executionId,
      expectedVersion: execution.version,
      to,
      transitionedAt: `2026-09-20T10:00:0${sequence}.000Z`,
      ...metadata,
    })
  }

  if (executionState === 'completed') {
    await transition('queued')
    await transition('running')
    await transition('completed', { terminalResultRef: nextId('art') })
  } else if (executionState === 'failed') {
    await transition('queued')
    await transition('failed', {
      failure: { classification: 'runtime_error', code: 'RUNTIME_EXITED' },
    })
  } else if (executionState === 'cancelled') {
    await transition('queued')
    await transition('cancelling')
    await transition('cancelled')
  } else if (executionState === 'timed_out') {
    await transition('queued')
    await transition('timed_out', { failure: { classification: 'timeout', code: 'DEADLINE' } })
  } else if (executionState === 'running') {
    await transition('queued')
    await transition('running')
  } else if (executionState === 'reconciliation_required') {
    await transition('reconciliation_required', {
      failure: { classification: 'infrastructure', code: 'DELIVERY_UNCONFIRMED' },
    })
  }

  const transitionedAt = `2026-09-20T10:00:0${sequence + 1}.000Z`
  await service.transitionCommand({
    callerPrincipalId: accepted.command.callerPrincipalId,
    operation: accepted.command.operation,
    workspaceId: accepted.command.workspaceId,
    projectId: accepted.command.projectId,
    idempotencyKey: accepted.command.idempotencyKey,
    expectedVersion: accepted.command.version,
    to: commandStatus,
    transitionedAt,
    ...(commandStatus === 'completed' ? { resultReference: nextId('art') } : {}),
    ...(['failed', 'reconciliation_required'].includes(commandStatus)
      ? { errorReference: 'https://example.test/legacy-terminal' }
      : {}),
  })
}

async function executionSnapshot(database, executionId) {
  return {
    commands: await database
      .select()
      .from(commandInbox)
      .where(eq(commandInbox.executionId, executionId)),
    executions: await database
      .select()
      .from(executions)
      .where(eq(executions.executionId, executionId)),
    budgets: await database
      .select()
      .from(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, executionId)),
    entries: await database
      .select()
      .from(usageLedgerEntries)
      .where(eq(usageLedgerEntries.executionId, executionId)),
    receipts: await database
      .select()
      .from(usageOperationReceipts)
      .where(eq(usageOperationReceipts.executionId, executionId)),
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

  test('pauses all new owner inserts while retaining exact replay access', async () => {
    const { isolated, credentials } = await createDatabase()
    const legacy = acceptanceService(isolated.application, {
      budgetAdmission: false,
    })
    const accepted = await legacy.service.acceptExecution(commandInput(plan))
    await persistLegacyOutcome(
      isolated.application,
      legacy.service,
      accepted,
      'completed',
      'completed'
    )
    const operatorUrl = new URL(credentials.administration.url)
    operatorUrl.pathname = `/${isolated.name}`
    const operatorClient = postgres(operatorUrl.toString(), { max: 1, prepare: false })
    const operatorDatabase = drizzle(operatorClient, { schema })
    try {
      const gate = new PostgresAdmissionRolloutService(operatorDatabase)
      await expect(gate.getStatus()).resolves.toMatchObject({ state: 'open', revision: 0 })
      await expect(gate.pause()).resolves.toMatchObject({ state: 'paused', revision: 1 })
      await expect(gate.pause()).resolves.toMatchObject({ state: 'paused', revision: 1 })
      await expect(
        new PostgresAdmissionRolloutService(isolated.application).pause()
      ).rejects.toMatchObject({
        code: 'ADMISSION_ROLLOUT_AUTHORITY_DENIED',
      })

      const repository = new PostgresCommandAcceptanceRepository(isolated.application)
      await expect(repository.accept(accepted.command, accepted.execution)).resolves.toMatchObject({
        outcome: 'duplicate',
      })
      const freshInput = commandInput(plan)
      await expect(
        acceptanceService(isolated.application, { budgetAdmission: false }).service.acceptExecution(
          freshInput
        )
      ).rejects.toMatchObject({ code: 'ADMISSION_ROLLOUT_PAUSED' })

      const bareExecution = {
        ...accepted.execution,
        executionId: nextId('exe'),
        correlation: { ...accepted.execution.correlation, requestId: nextId('req') },
      }
      const executionRepository = new PostgresExecutionRepository(isolated.application)
      await expect(executionRepository.insertExecution(bareExecution)).rejects.toMatchObject({
        code: 'ADMISSION_ROLLOUT_PAUSED',
      })
      await expect(executionRepository.insertExecution(accepted.execution)).resolves.toBe(false)
      await expect(
        (async () =>
          await isolated.application.execute(
            sql`update admission_rollout_gate set state = 'open' where gate_key = 'intake'`
          ))()
      ).rejects.toThrow()

      // Re-provisioning's broad CRUD grant must not reopen the operator-only boundary.
      await operatorDatabase.execute(
        sql`grant select, insert, update, delete on all tables in schema public to control_plane_app`
      )
      await expect(
        new PostgresAdmissionRolloutService(isolated.application).pause()
      ).resolves.toMatchObject({ state: 'paused', revision: 1 })
      const bootstrap = await readFile(
        new URL('../../../infrastructure/compose/postgres/bootstrap-roles.sh', import.meta.url),
        'utf8'
      )
      const gateStatements = [
        ...bootstrap.matchAll(
          /SELECT '(?:REVOKE ALL PRIVILEGES|GRANT SELECT) ON TABLE public\.admission_rollout_gate (?:FROM|TO) control_plane_app'\nWHERE to_regclass\('public\.admission_rollout_gate'\) IS NOT NULL \\gexec/g
        ),
      ]
      expect(gateStatements).toHaveLength(2)
      for (const [statement] of gateStatements) {
        const commands = await operatorDatabase.execute(sql.raw(statement.replace(/\\gexec$/, '')))
        expect(commands).toHaveLength(1)
        for (const row of commands) {
          const command = Object.values(row)[0]
          expect(typeof command).toBe('string')
          await operatorDatabase.execute(sql.raw(command))
        }
      }
      await expect(
        new PostgresAdmissionRolloutService(isolated.application).pause()
      ).rejects.toMatchObject({ code: 'ADMISSION_ROLLOUT_AUTHORITY_DENIED' })
      await expect(
        (async () =>
          await isolated.application.execute(
            sql`update admission_rollout_gate set state = 'open' where gate_key = 'intake'`
          ))()
      ).rejects.toThrow()
      await expect(gate.getStatus()).resolves.toMatchObject({ state: 'paused', revision: 1 })

      expect(
        await isolated.application
          .select()
          .from(commandInbox)
          .where(eq(commandInbox.commandId, freshInput.commandId))
      ).toHaveLength(0)
      expect(await executionSnapshot(isolated.application, bareExecution.executionId)).toEqual({
        commands: [],
        executions: [],
        budgets: [],
        entries: [],
        receipts: [],
      })
      expect(
        await executionSnapshot(isolated.application, accepted.execution.executionId)
      ).toMatchObject({ budgets: [], entries: [], receipts: [] })
    } finally {
      await operatorClient.end({ timeout: 5 })
    }
  }, 30_000)

  test('replays only canonical legacy terminal outcomes without accounting writes', async () => {
    const { isolated } = await createDatabase()
    const scenarios = [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'failed'],
      ['timed_out', 'failed'],
    ]

    for (const [executionState, commandStatus] of scenarios) {
      const request = commandInput(plan)
      const legacy = acceptanceService(isolated.application, { budgetAdmission: false })
      const accepted = await legacy.service.acceptExecution(request)
      await persistLegacyOutcome(
        isolated.application,
        legacy.service,
        accepted,
        executionState,
        commandStatus
      )

      const repository = new PostgresCommandAcceptanceRepository(isolated.application, {
        budgetAdmission: true,
      })
      const storedCommand = await repository.getByExecutionId(accepted.execution.executionId)
      const storedExecution = await repository.getExecution(accepted.execution.executionId)
      const before = await executionSnapshot(isolated.application, accepted.execution.executionId)
      let idFactoryCalls = 0
      let validatorCalls = 0
      const replayService = new CommandInboxService({
        repository,
        executionIdFactory: () => {
          idFactoryCalls++
          return nextId('exe')
        },
        executionPlanValidator: {
          validate: async () => {
            validatorCalls++
            return true
          },
        },
        now: () => acceptedAt,
      })

      const replay = await replayService.acceptExecution(request)
      const duplicate = await repository.accept(accepted.command, accepted.execution)
      expect(replay).toMatchObject({ replayed: true })
      expect(replay.command).toEqual(storedCommand)
      expect(replay.execution).toEqual(storedExecution)
      expect(duplicate).toMatchObject({ outcome: 'duplicate' })
      expect(duplicate.command).toEqual(storedCommand)
      expect(duplicate.execution).toEqual(storedExecution)
      await expect(
        repository.verifyAdmission(accepted.command, accepted.execution)
      ).rejects.toMatchObject({ code: 'STORE_STATE_INVALID' })
      expect(idFactoryCalls).toBe(0)
      expect(validatorCalls).toBe(0)
      expect(await executionSnapshot(isolated.application, accepted.execution.executionId)).toEqual(
        before
      )
      expect(before).toMatchObject({ budgets: [], entries: [], receipts: [] })
    }
  })

  test('rejects one-sided, mismatched, forged, and reconciliation legacy terminal snapshots', async () => {
    const { isolated } = await createDatabase()
    const scenarios = [
      ['running', 'completed'],
      ['completed', 'failed'],
      ['reconciliation_required', 'reconciliation_required'],
    ]

    for (const [executionState, commandStatus] of scenarios) {
      const request = commandInput(plan)
      const legacy = acceptanceService(isolated.application, { budgetAdmission: false })
      const accepted = await legacy.service.acceptExecution(request)
      await persistLegacyOutcome(
        isolated.application,
        legacy.service,
        accepted,
        executionState,
        commandStatus
      )
      const before = await executionSnapshot(isolated.application, accepted.execution.executionId)
      await expect(
        acceptanceService(isolated.application).service.acceptExecution(request)
      ).rejects.toMatchObject({ code: 'STORE_STATE_INVALID' })
      expect(await executionSnapshot(isolated.application, accepted.execution.executionId)).toEqual(
        before
      )
    }

    const request = commandInput(plan)
    const legacy = acceptanceService(isolated.application, { budgetAdmission: false })
    const accepted = await legacy.service.acceptExecution(request)
    const forgedCommand = {
      ...accepted.command,
      status: 'completed',
      version: accepted.command.version + 1,
      lastSeenAt: acceptedAt,
      terminalAt: acceptedAt,
      resultReference: nextId('art'),
    }
    const before = await executionSnapshot(isolated.application, accepted.execution.executionId)
    await expect(
      new PostgresCommandAcceptanceRepository(isolated.application, {
        budgetAdmission: true,
      }).verifyAdmission(forgedCommand, accepted.execution)
    ).rejects.toMatchObject({ code: 'STORE_STATE_INVALID' })
    expect(await executionSnapshot(isolated.application, accepted.execution.executionId)).toEqual(
      before
    )
  })

  test('serializes concurrent acceptance across separate connections without duplicate allocation', async () => {
    const { isolated, credentials } = await createDatabase()
    const databaseUrl = new URL(credentials.application.url)
    databaseUrl.pathname = `/${isolated.name}`
    const second = createPostgresConnection({
      ...credentials.application,
      url: databaseUrl.toString(),
    })
    try {
      const input = commandInput(plan)
      const attempts = await Promise.allSettled([
        acceptanceService(isolated.application).service.acceptExecution(input),
        acceptanceService(second.database).service.acceptExecution(input),
      ])
      for (const attempt of attempts) expect(attempt.status).toBe('fulfilled')
      const results = attempts.map((attempt) => attempt.value)
      expect(results.map((result) => result.replayed).toSorted()).toEqual([false, true])
      expect(results[0].execution.executionId).toBe(results[1].execution.executionId)
      expect(await isolated.application.select().from(commandInbox)).toHaveLength(1)
      expect(await isolated.application.select().from(executions)).toHaveLength(1)
      expect(
        await ledger(second.database).entries(
          input.correlation.workspaceId,
          results[0].execution.executionId
        )
      ).toHaveLength(1)
    } finally {
      await second.close()
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
