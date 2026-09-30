import { afterEach, describe, expect, test as runTest } from 'bun:test'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import {
  decidedRetentionPolicy,
  loadDatabaseCredentials,
  retentionClassPolicy,
} from '@control-plane/config'
import { RuntimeConnectionRegistry } from '@control-plane/runtime-sdk'
import { PostgresDelegationRepository } from './delegation-repository.ts'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { retiredCommandKeyCandidates } from '@control-plane/domain'
import { deriveExecutionPlan, executionBudgetAdmissionSource } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DurableUsageLedger, budgetOpeningEntryIdempotencyKey } from '@control-plane/usage-ledger'
import { PostgresAdmissionRolloutService } from './admission-rollout.ts'
import { lockAdmissionRolloutInventory } from './admission-rollout-audit.ts'
import { createPostgresConnection } from './connection.ts'
import { PostgresCommandAcceptanceRepository } from './command-inbox-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { PostgresRuntimeConnectionRepository } from './runtime-connection-repository.ts'
import { PostgresRuntimeCommandRepository } from './runtime-command-repository.ts'
import { PostgresRetentionReapplication } from './retention-reapplication.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { commandInbox } from './schema/commands.ts'
import { delegations } from './schema/delegations.ts'
import { executions } from './schema/executions.ts'
import { usageBudgetStates, usageOperationReceipts } from './schema/usage-budget-state.ts'
import { usageLedgerEntries } from './schema/usage-ledger.ts'
import { retiredCommandKeys } from './schema/retired-command-keys.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresDurableUsageStore } from './usage-store.ts'
import * as schema from './schema/index.ts'
import { fileURLToPath } from 'node:url'

const test = (name, operation, timeoutMs = 60_000) => runTest(name, operation, timeoutMs)
const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const acceptedAt = '2026-09-20T10:00:00.000Z'
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000
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
      executionPlanValidator: { authorize: async () => true, validate: async () => true },
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

function commandScope(command) {
  return {
    callerPrincipalId: command.callerPrincipalId,
    operation: command.operation,
    workspaceId: command.workspaceId,
    projectId: command.projectId,
    idempotencyKey: command.idempotencyKey,
  }
}

async function retireTerminalCommand(database, repository, service, accepted, retiredAt) {
  await persistLegacyOutcome(database, service, accepted, 'completed', 'completed')
  const retiredAtIso = retiredAt.toISOString()
  expect(await repository.retireExpiredCommand(commandScope(accepted.command), retiredAtIso)).toBe(
    true
  )
  return repository.deleteEligibleInbox(retiredAt, {
    policyRetainMs: retentionClassPolicy(decidedRetentionPolicy, 'command-inbox').retainMs,
    dryRun: false,
  })
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

function terminalOwnerRow(executionId, invalidVersion = false) {
  const timestamp = new Date('2026-09-20T10:00:01.000Z')
  return {
    executionId,
    state: 'failed',
    version: invalidVersion ? 0 : 2,
    workspaceId: plan.correlation.workspaceId,
    projectId: plan.correlation.projectId,
    taskId: plan.correlation.taskId,
    agentId: plan.correlation.agentId,
    requestId: plan.correlation.requestId,
    executionPlanId: plan.executionPlanId,
    executionPlanDigest: plan.contentDigest,
    executionPlanSchemaVersion: plan.schemaVersion,
    parentExecutionId: null,
    attemptCount: 0,
    latestAttemptId: null,
    failureClassification: 'validation',
    failureCode: 'OPERATOR_ABORTED',
    terminalResultRef: null,
    acceptedAt: new Date(acceptedAt),
    terminalAt: timestamp,
    createdAt: new Date(acceptedAt),
    updatedAt: timestamp,
  }
}

async function createTemporaryAdmissionGate(client, state, revision) {
  await client`create temporary table admission_rollout_gate (like public.admission_rollout_gate)`
  await client`
    insert into pg_temp.admission_rollout_gate
      (gate_key, state, schema_version, revision, updated_at, updated_by)
    values ('intake', ${state}, 1, ${revision}, now(), 'temporary-shadow')
  `
}

async function createTemporaryAdmissionInventory(client) {
  for (const table of [
    'executions',
    'execution_attempts',
    'command_inbox',
    'retired_command_keys',
    'runtime_commands',
    'delegations',
  ]) {
    await client.unsafe(`create temporary table ${table} (like public.${table})`)
  }
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

  async function auditWithMigration(isolated) {
    return isolated.withMigrationDatabase((database) =>
      new PostgresAdmissionRolloutService(database).audit()
    )
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
    const operatorUrl = new URL(credentials.migration.url)
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

      // Table-only preflight misses a separately granted column UPDATE.
      await operatorDatabase.execute(
        sql`grant update (state), insert (schema_version), references (gate_key) on admission_rollout_gate to control_plane_app`
      )
      const columnCapabilities = () =>
        isolated.application.execute(sql`
        select has_table_privilege(current_user, 'public.admission_rollout_gate', 'UPDATE') as table_update,
          has_any_column_privilege(current_user, 'public.admission_rollout_gate', 'UPDATE') as column_update,
          has_any_column_privilege(current_user, 'public.admission_rollout_gate', 'INSERT') as column_insert,
          has_any_column_privilege(current_user, 'public.admission_rollout_gate', 'REFERENCES') as column_reference
      `)
      expect(await columnCapabilities()).toMatchObject([
        { table_update: false, column_update: true, column_insert: true, column_reference: true },
      ])
      const migrationSource = await readFile(
        new URL('../../../scripts/migrate-production-schema.mjs', import.meta.url),
        'utf8'
      )
      const privilegeQuery = migrationSource.match(
        /async readRuntimeTablePrivileges\(\) \{\s*return client`([\s\S]*?)`/
      )?.[1]
      expect(typeof privilegeQuery).toBe('string')
      const runtimeGatePrivileges = async () =>
        (await isolated.application.execute(sql.raw(privilegeQuery))).find(
          (row) => row.table_name === 'admission_rollout_gate'
        )
      expect(await runtimeGatePrivileges()).toMatchObject({
        can_update: false,
        has_column_insert: true,
        has_column_update: true,
        has_column_references: true,
      })
      // Mutating the same value demonstrates the real permission without reopening intake.
      await isolated.application.execute(
        sql`update admission_rollout_gate set state = 'paused' where gate_key = 'intake'`
      )
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
      expect(await columnCapabilities()).toMatchObject([
        {
          table_update: false,
          column_update: false,
          column_insert: false,
          column_reference: false,
        },
      ])
      await expect(
        new PostgresAdmissionRolloutService(isolated.application).pause()
      ).rejects.toMatchObject({ code: 'ADMISSION_ROLLOUT_AUTHORITY_DENIED' })
      await expect(
        (async () =>
          await isolated.application.execute(
            sql`update admission_rollout_gate set state = 'open' where gate_key = 'intake'`
          ))()
      ).rejects.toThrow()
      expect(await runtimeGatePrivileges()).toMatchObject({
        can_select: true,
        can_insert: false,
        can_update: false,
        can_delete: false,
        has_column_insert: false,
        has_column_update: false,
        has_column_references: false,
      })
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

  test('a temporary gate table cannot shadow the paused public intake gate', async () => {
    const { isolated, credentials } = await createDatabase()
    await isolated.withMigrationDatabase((database) =>
      new PostgresAdmissionRolloutService(database).pause()
    )

    const applicationUrl = new URL(credentials.application.url)
    applicationUrl.pathname = `/${isolated.name}`
    const client = postgres(applicationUrl.toString(), { max: 1, prepare: false })
    try {
      await createTemporaryAdmissionGate(client, 'open', 0)
      const database = drizzle(client, { schema })
      const result = await acceptanceService(database, { budgetAdmission: false })
        .service.acceptExecution(commandInput(plan))
        .then(
          (accepted) => ({ accepted }),
          (error) => ({ error })
        )

      expect(result.error).toMatchObject({ code: 'ADMISSION_ROLLOUT_PAUSED' })
      expect(result.accepted).toBeUndefined()
    } finally {
      await client.end({ timeout: 5 })
    }
  }, 30_000)

  test('a temporary inventory cannot hide active public owners from resume audit', async () => {
    const { isolated } = await createDatabase()
    const accepted = await acceptanceService(isolated.application, {
      budgetAdmission: false,
    }).service.acceptExecution(commandInput(plan))
    const paused = await isolated.withMigrationDatabase((database) =>
      new PostgresAdmissionRolloutService(database).pause()
    )

    const result = await isolated.withMigrationDatabase(async (database) => {
      const client = database.$client
      await createTemporaryAdmissionGate(client, 'paused', paused.revision)
      await createTemporaryAdmissionInventory(client)
      const resumeError = await new PostgresAdmissionRolloutService(database).resume().then(
        (resumed) => ({ resumed }),
        (error) => ({ error })
      )
      const [publicGate] = await client`
        select state from public.admission_rollout_gate where gate_key = 'intake'
      `
      return { resumeError, publicGate }
    })

    expect(accepted.execution.state).toBe('accepted')
    expect(result.resumeError.error).toMatchObject({ code: 'ADMISSION_ROLLOUT_RESUME_BLOCKED' })
    expect(result.resumeError.resumed).toBeUndefined()
    expect(result.publicGate.state).toBe('paused')
  }, 30_000)

  test('audits and resumes an empty paused gate with durable readback', async () => {
    const { isolated, credentials } = await createDatabase()
    const operatorUrl = new URL(credentials.administration.url)
    operatorUrl.pathname = `/${isolated.name}`
    const operatorClient = postgres(operatorUrl.toString(), { max: 1, prepare: false })
    const operatorDatabase = drizzle(operatorClient, { schema })
    const gate = new PostgresAdmissionRolloutService(operatorDatabase)
    try {
      await expect(gate.pause()).resolves.toMatchObject({ state: 'paused', revision: 1 })
      await expect(gate.audit()).resolves.toMatchObject({
        gate: { state: 'paused', revision: 1 },
        complete: true,
        canResume: true,
      })
      await expect(
        new PostgresAdmissionRolloutService(isolated.application).resume()
      ).rejects.toMatchObject({
        code: 'ADMISSION_ROLLOUT_AUTHORITY_DENIED',
      })
      await expect(gate.audit()).resolves.toMatchObject({
        gate: { state: 'paused', revision: 1 },
        complete: true,
        canResume: true,
        counts: {
          executions: 0,
          activeExecutions: 0,
          attempts: 0,
          commands: 0,
          runtimeCommands: 0,
          unresolvedRuntimeCommands: 0,
          retiredCommandKeys: 0,
          delegations: 0,
          lineageErrors: 0,
        },
        diagnostics: [],
      })
      await expect(gate.resume()).resolves.toMatchObject({
        gate: { state: 'open', revision: 2 },
        audit: { complete: true, canResume: true },
      })

      const reconnectedClient = postgres(operatorUrl.toString(), { max: 1, prepare: false })
      try {
        await expect(
          new PostgresAdmissionRolloutService(drizzle(reconnectedClient, { schema })).getStatus()
        ).resolves.toMatchObject({ state: 'open', revision: 2 })
      } finally {
        await reconnectedClient.end({ timeout: 5 })
      }
    } finally {
      await operatorClient.end({ timeout: 5 })
    }
  }, 30_000)

  test('paginates terminal inventory and resumes only after a fresh complete audit', async () => {
    const { isolated, credentials } = await createDatabase()
    const operatorUrl = new URL(credentials.migration.url)
    operatorUrl.pathname = `/${isolated.name}`
    const operatorClient = postgres(operatorUrl.toString(), { max: 1, prepare: false })
    const operatorDatabase = drizzle(operatorClient, { schema })
    const gate = new PostgresAdmissionRolloutService(operatorDatabase)
    try {
      const rows = Array.from({ length: 130 }, () => terminalOwnerRow(nextId('exe')))
      await isolated.withMigrationDatabase((database) => database.insert(executions).values(rows))
      await gate.pause()
      const report = await gate.audit()
      expect(report).toMatchObject({
        complete: true,
        canResume: true,
        counts: { executions: 130, activeExecutions: 0, attempts: 0, commands: 0 },
        diagnostics: [],
      })
      await expect(gate.resume()).resolves.toMatchObject({
        gate: { state: 'open', revision: 2 },
        audit: { complete: true, canResume: true },
      })

      await gate.pause()
      const staleCleanReport = await gate.audit()
      expect(staleCleanReport.canResume).toBe(true)
      const injectedId = nextId('exe')
      await isolated.withMigrationDatabase((database) =>
        database.insert(executions).values({
          ...terminalOwnerRow(injectedId),
          state: 'accepted',
          version: 1,
          failureClassification: null,
          failureCode: null,
          terminalAt: null,
          updatedAt: new Date(acceptedAt),
        })
      )
      await expect(gate.resume()).rejects.toMatchObject({
        code: 'ADMISSION_ROLLOUT_RESUME_BLOCKED',
      })
      await expect(gate.getStatus()).resolves.toMatchObject({ state: 'paused', revision: 3 })
    } finally {
      await operatorClient.end({ timeout: 5 })
    }
  }, 30_000)

  test('reports active owners without attesting their allowance and keeps cancellation available', async () => {
    const { isolated, credentials } = await createDatabase()
    const acceptedBy = acceptanceService(isolated.application)
    const accepted = await acceptedBy.service.acceptExecution(commandInput(plan))
    const corruptedAccepted = await acceptedBy.service.acceptExecution(commandInput(plan))
    await isolated.application
      .delete(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, accepted.execution.executionId))
    const [corruptedBudget] = await isolated.application
      .select()
      .from(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, corruptedAccepted.execution.executionId))
      .limit(1)
    await isolated.application
      .update(usageBudgetStates)
      .set({
        state: {
          ...corruptedBudget.state,
          maximumTokens: corruptedBudget.state.maximumTokens + 1,
        },
      })
      .where(eq(usageBudgetStates.executionId, corruptedAccepted.execution.executionId))
    const operatorUrl = new URL(credentials.migration.url)
    operatorUrl.pathname = `/${isolated.name}`
    const operatorClient = postgres(operatorUrl.toString(), { max: 1, prepare: false })
    const gate = new PostgresAdmissionRolloutService(drizzle(operatorClient, { schema }))
    try {
      await gate.pause()
      const report = await gate.audit()
      expect(report).toMatchObject({
        complete: true,
        canResume: false,
        counts: { activeExecutions: 2, commands: 2 },
      })
      expect(report.diagnostics.map(({ code }) => code)).toContain(
        'ACTIVE_OWNER_ACCOUNTING_NOT_ATTESTED'
      )
      const beforeCancellation = await executionSnapshot(
        isolated.application,
        accepted.execution.executionId
      )
      const beforeCorruptedCancellation = await executionSnapshot(
        isolated.application,
        corruptedAccepted.execution.executionId
      )
      await expect(gate.resume()).rejects.toMatchObject({
        code: 'ADMISSION_ROLLOUT_RESUME_BLOCKED',
      })

      await persistLegacyOutcome(
        isolated.application,
        acceptedBy.service,
        accepted,
        'cancelled',
        'failed'
      )
      await persistLegacyOutcome(
        isolated.application,
        acceptedBy.service,
        corruptedAccepted,
        'cancelled',
        'failed'
      )
      const storedCommand = await acceptedBy.repository.getByExecutionId(
        accepted.execution.executionId
      )
      await isolated.application
        .update(commandInbox)
        .set({ status: 'completed', resultReference: nextId('art'), errorReference: null })
        .where(eq(commandInbox.commandId, storedCommand.commandId))
      const mismatched = await gate.audit()
      expect(mismatched.complete).toBe(false)
      expect(mismatched.diagnostics.map(({ code }) => code)).toContain(
        'COMMAND_EXECUTION_STATE_MISMATCH'
      )
      await isolated.application
        .update(commandInbox)
        .set({
          status: storedCommand.status,
          resultReference: storedCommand.resultReference ?? null,
          errorReference: storedCommand.errorReference ?? null,
        })
        .where(eq(commandInbox.commandId, storedCommand.commandId))
      const drained = await gate.audit()
      expect(drained).toMatchObject({ complete: true, canResume: true })
      const beforeResume = await executionSnapshot(
        isolated.application,
        accepted.execution.executionId
      )
      const beforeCorruptedResume = await executionSnapshot(
        isolated.application,
        corruptedAccepted.execution.executionId
      )
      await expect(gate.resume()).resolves.toMatchObject({ gate: { state: 'open' } })
      expect(await executionSnapshot(isolated.application, accepted.execution.executionId)).toEqual(
        beforeResume
      )
      expect(
        await executionSnapshot(isolated.application, corruptedAccepted.execution.executionId)
      ).toEqual(beforeCorruptedResume)
      expect(beforeCancellation.budgets).toEqual([])
      expect(beforeCorruptedCancellation.budgets[0].state.maximumTokens).toBe(
        corruptedBudget.state.maximumTokens + 1
      )
    } finally {
      await operatorClient.end({ timeout: 5 })
    }
  }, 30_000)

  test('fails closed on corrupt inventory and bounds diagnostics', async () => {
    const { isolated, credentials } = await createDatabase()
    const operatorUrl = new URL(credentials.migration.url)
    operatorUrl.pathname = `/${isolated.name}`
    const operatorClient = postgres(operatorUrl.toString(), { max: 1, prepare: false })
    const gate = new PostgresAdmissionRolloutService(drizzle(operatorClient, { schema }))
    try {
      await gate.pause()
      const invalidRows = Array.from({ length: 100 }, () => terminalOwnerRow(nextId('exe'), true))
      await isolated.withMigrationDatabase((database) =>
        database.insert(executions).values(invalidRows)
      )
      const report = await gate.audit()
      expect(report.complete).toBe(false)
      expect(report.canResume).toBe(false)
      expect(report.diagnostics).toHaveLength(96)
      await expect(gate.resume()).rejects.toMatchObject({
        code: 'ADMISSION_ROLLOUT_AUDIT_INCOMPLETE',
      })
    } finally {
      await operatorClient.end({ timeout: 5 })
    }
  }, 30_000)

  test('blocks expired runtime delivery and malformed attempt-chain evidence', async () => {
    const { isolated } = await createDatabase()
    const runtimeConnectionId = nextId('rtc')
    const nodeId = nextId('rnr')
    await new RuntimeConnectionRegistry(
      new PostgresRuntimeConnectionRepository(isolated.application)
    ).register({
      runtimeConnectionId,
      identityDigest: `sha256:${'9'.repeat(64)}`,
      connectionType: 'managed_local',
      runtimeNodeRefId: nodeId,
      runtimeDefinitionId: nextId('rtd'),
      location: 'local_device',
      adapterVersion: '1.0.0',
      driverVersion: '1.0.0',
      harnessVersion: '1.0.0',
      status: 'connected',
      health: 'healthy',
      capabilities: [],
      compatibilityState: 'compatible',
      limitations: [],
      lastDiscoveredAt: acceptedAt,
      lastHeartbeatAt: acceptedAt,
      lastHealthCheckAt: acceptedAt,
    })
    const lifecycle = new ExecutionLifecycleService(
      new PostgresExecutionRepository(isolated.application)
    )
    const firstExecution = await lifecycle.createExecution({
      executionId: nextId('exe'),
      correlation: {
        ...plan.correlation,
        taskId: nextId('tsk'),
        requestId: nextId('req'),
      },
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt,
    })
    const firstAttempt = await lifecycle.createAttempt({
      executionId: firstExecution.executionId,
      attemptId: nextId('att'),
      expectedExecutionVersion: firstExecution.version,
      queuedAt: '2026-09-20T10:00:01.000Z',
      runtime: { runtimeConnectionId },
    })
    const expired = {
      commandId: nextId('cmd'),
      executionId: firstExecution.executionId,
      attemptId: firstAttempt.attemptId,
      nodeId,
      runtimeConnectionId,
      workspaceId: plan.correlation.workspaceId,
      idempotencyKey: `m11-runtime-expired-${fixtureSequence}`,
      payloadHash: `sha256:${'6'.repeat(64)}`,
      commandEnvelope: { type: 'command', payload: { operation: 'runtime.execute' } },
      issuedAt: '2026-09-20T10:00:01.000Z',
      expiresAt: '2026-09-20T10:05:01.000Z',
      status: 'expired',
      version: 2,
      deliveryAttempts: 1,
      lastChannelGeneration: 1,
      lastSequence: 1,
      firstDispatchedAt: '2026-09-20T10:00:02.000Z',
      lastDispatchedAt: '2026-09-20T10:00:02.000Z',
      createdAt: '2026-09-20T10:00:01.000Z',
      updatedAt: '2026-09-20T10:05:01.000Z',
    }
    await new PostgresRuntimeCommandRepository(isolated.application).create(expired)
    const expiredReport = await auditWithMigration(isolated)
    expect(expiredReport).toMatchObject({
      complete: true,
      canResume: false,
      counts: { runtimeCommands: 1, unresolvedRuntimeCommands: 1 },
    })
    expect(expiredReport.diagnostics.map(({ code }) => code)).toContain(
      'RUNTIME_COMMAND_OUTCOME_UNRESOLVED'
    )

    const chainExecution = await lifecycle.createExecution({
      executionId: nextId('exe'),
      correlation: {
        ...plan.correlation,
        taskId: nextId('tsk'),
        requestId: nextId('req'),
      },
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt,
    })
    const firstQueuedAttempt = await lifecycle.createAttempt({
      executionId: chainExecution.executionId,
      attemptId: nextId('att'),
      expectedExecutionVersion: chainExecution.version,
      queuedAt: '2026-09-20T10:00:01.000Z',
    })
    const chainRepository = new PostgresExecutionRepository(isolated.application)
    const ownerAfterFirst = await chainRepository.getExecution(chainExecution.executionId)
    await lifecycle.createAttempt({
      executionId: chainExecution.executionId,
      attemptId: nextId('att'),
      expectedExecutionVersion: ownerAfterFirst.version,
      queuedAt: '2026-09-20T10:00:02.000Z',
    })
    const chainReport = await auditWithMigration(isolated)
    expect(chainReport.complete).toBe(false)
    expect(chainReport.diagnostics.map(({ code }) => code)).toContain('PRIOR_ATTEMPT_NOT_TERMINAL')
    await isolated.application
      .update(executions)
      .set({ latestAttemptId: nextId('att') })
      .where(eq(executions.executionId, chainExecution.executionId))
    const pointerReport = await auditWithMigration(isolated)
    expect(pointerReport.complete).toBe(false)
    expect(pointerReport.diagnostics.map(({ code }) => code)).toContain('ATTEMPT_CHAIN_INVALID')
    expect(firstQueuedAttempt.executionId).toBe(chainExecution.executionId)
  }, 30_000)

  test('requires explicit parent lineage and blocks unresolved or corrupt delegation records', async () => {
    const { isolated } = await createDatabase()
    const plans = new PostgresExecutionPlanRepository(isolated.application)
    const lifecycle = new ExecutionLifecycleService(
      new PostgresExecutionRepository(isolated.application)
    )
    const makeLineage = async (persistDelegation) => {
      const childPlanValue = childPlan(plan)
      await plans.put(childPlanValue)
      const parentExecutionId = nextId('exe')
      const childExecutionId = nextId('exe')
      const parentExecution = await lifecycle.createExecution({
        executionId: parentExecutionId,
        correlation: plan.correlation,
        executionPlan: {
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
          schemaVersion: plan.schemaVersion,
        },
        acceptedAt,
      })
      const childExecution = await lifecycle.createExecution({
        executionId: childExecutionId,
        parentExecutionId,
        correlation: childPlanValue.correlation,
        executionPlan: {
          executionPlanId: childPlanValue.executionPlanId,
          contentDigest: childPlanValue.contentDigest,
          schemaVersion: childPlanValue.schemaVersion,
        },
        acceptedAt,
      })
      if (!persistDelegation) return { parentExecution, childExecution }
      const record = {
        delegationId: nextId('dlg'),
        parentExecutionId,
        childExecutionId,
        parentExecutionPlanId: plan.executionPlanId,
        parentExecutionPlanDigest: plan.contentDigest,
        childExecutionPlanId: childPlanValue.executionPlanId,
        childExecutionPlanDigest: childPlanValue.contentDigest,
        contextPackageId: childPlanValue.contextPackage.contextPackageId,
        contextPackageDigest: childPlanValue.contextPackage.contentDigest,
        role: 'worker',
        profileVersionId: childPlanValue.profile.profileVersionId,
        objective: 'Complete a bounded child task.',
        policy: {
          cancellation: 'cascade',
          deadline: 'bounded_by_parent',
          failure: 'retry',
          maximumRetries: 1,
        },
        state: 'requested',
        retryCount: 0,
        inputDigest: `sha256:${'d'.repeat(64)}`,
        revision: 1,
        acceptedAt,
        updatedAt: acceptedAt,
      }
      expect(await new PostgresDelegationRepository(isolated.application).insert(record)).toBe(true)
      return { parentExecution, childExecution, delegation: record }
    }

    const requested = await makeLineage(true)
    const report = await auditWithMigration(isolated)
    expect(report).toMatchObject({ complete: true, canResume: false })
    expect(report.diagnostics.map(({ code }) => code)).toContain('DELEGATION_UNRESOLVED')

    const missing = await makeLineage(false)
    const missingReport = await auditWithMigration(isolated)
    expect(missingReport.complete).toBe(false)
    expect(missingReport.diagnostics.map(({ code }) => code)).toContain(
      'PARENTED_EXECUTION_LINEAGE_MISSING'
    )

    await isolated.application
      .update(delegations)
      .set({ revision: 2 })
      .where(eq(delegations.delegationId, requested.delegation.delegationId))
    const corruptedReport = await auditWithMigration(isolated)
    expect(corruptedReport.complete).toBe(false)
    expect(corruptedReport.diagnostics.map(({ code }) => code)).toContain(
      'DELEGATION_LINEAGE_INVALID'
    )
    expect(corruptedReport.diagnostics.map(({ code }) => code)).toContain(
      'PARENTED_EXECUTION_LINEAGE_MISSING'
    )
    expect(missing.childExecution.parentExecutionId).toBe(missing.parentExecution.executionId)
  }, 30_000)

  test('pause waits for a shared intake transaction and inventory share locks freeze owner inserts', async () => {
    const { isolated, credentials } = await createDatabase()
    const operatorUrl = new URL(credentials.migration.url)
    operatorUrl.pathname = `/${isolated.name}`
    const operatorClient = postgres(operatorUrl.toString(), { max: 1, prepare: false })
    const operatorDatabase = drizzle(operatorClient, { schema })
    const gate = new PostgresAdmissionRolloutService(operatorDatabase)
    let releaseShared
    let signalShared
    const sharedHeld = new Promise((resolve) => {
      signalShared = resolve
    })
    const sharedRelease = new Promise((resolve) => {
      releaseShared = resolve
    })
    let releaseInventory
    let signalInventory
    const inventoryHeld = new Promise((resolve) => {
      signalInventory = resolve
    })
    const inventoryRelease = new Promise((resolve) => {
      releaseInventory = resolve
    })
    try {
      const sharedTransaction = isolated.application.transaction(async (transaction) => {
        await transaction.execute(sql`select pg_advisory_xact_lock_shared(724193560984241)`)
        signalShared()
        await sharedRelease
      })
      await sharedHeld
      let pauseFinished = false
      const pausePromise = gate.pause().then((status) => {
        pauseFinished = true
        return status
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(pauseFinished).toBe(false)
      releaseShared()
      await sharedTransaction
      await expect(pausePromise).resolves.toMatchObject({ state: 'paused' })

      await gate.resume()
      const inventoryTransaction = operatorDatabase.transaction(async (transaction) => {
        await lockAdmissionRolloutInventory(transaction)
        signalInventory()
        await inventoryRelease
      })
      await inventoryHeld
      let writerFinished = false
      const executionService = new ExecutionLifecycleService(
        new PostgresExecutionRepository(isolated.application)
      )
      const insertPromise = executionService
        .createExecution({
          executionId: nextId('exe'),
          correlation: {
            ...plan.correlation,
            taskId: nextId('tsk'),
            requestId: nextId('req'),
          },
          executionPlan: {
            executionPlanId: plan.executionPlanId,
            contentDigest: plan.contentDigest,
            schemaVersion: plan.schemaVersion,
          },
          acceptedAt,
        })
        .then((value) => {
          writerFinished = true
          return value
        })
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(writerFinished).toBe(false)
      releaseInventory()
      await inventoryTransaction
      await expect(insertPromise).resolves.toBeDefined()
    } finally {
      releaseShared?.()
      releaseInventory?.()
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
          authorize: async () => true,
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

  test('writes verified v2 tombstones, rejects tampering, and preserves legacy replay denial', async () => {
    const { isolated, credentials } = await createDatabase()
    const { repository, service } = acceptanceService(isolated.application)
    const accepted = await service.acceptExecution(commandInput(plan))
    await persistLegacyOutcome(isolated.application, service, accepted, 'completed', 'completed')
    const before = await executionSnapshot(isolated.application, accepted.execution.executionId)
    const retiredAt = new Date('2027-01-01T00:00:00.000Z')
    const keys = retiredCommandKeyCandidates(commandScope(accepted.command))

    await expect(
      repository.retireExpiredCommand(commandScope(accepted.command), retiredAt.toISOString())
    ).resolves.toBe(true)
    await expect(
      repository.deleteEligibleInbox(retiredAt, {
        policyRetainMs: retentionClassPolicy(decidedRetentionPolicy, 'command-inbox').retainMs,
        dryRun: false,
      })
    ).resolves.toMatchObject({ deleted: 1 })

    const [written] = await isolated.application
      .select()
      .from(retiredCommandKeys)
      .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey))
    expect(written).toMatchObject({
      scopeKey: keys.metadata.scopeKey,
      commandId: accepted.command.commandId,
      executionId: accepted.execution.executionId,
      metadataVersion: 2,
      identityDigest: keys.metadata.identityDigest,
    })
    expect(
      await isolated.application
        .select()
        .from(commandInbox)
        .where(eq(commandInbox.commandId, accepted.command.commandId))
    ).toHaveLength(0)
    const afterRetirement = await executionSnapshot(
      isolated.application,
      accepted.execution.executionId
    )
    expect(afterRetirement.budgets).toEqual(before.budgets)
    expect(afterRetirement.entries).toEqual(before.entries)
    expect(afterRetirement.receipts).toEqual(before.receipts)

    await expect(repository.accept(accepted.command, accepted.execution)).rejects.toMatchObject({
      code: 'COMMAND_RETENTION_EXPIRED',
    })

    await isolated.withMigrationDatabase((database) =>
      database.execute(
        sql`grant select, insert, update, delete on retired_command_keys to control_plane_app`
      )
    )
    await expect(
      (async () =>
        await isolated.application
          .update(retiredCommandKeys)
          .set({ retiredAt })
          .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey)))()
    ).resolves.toBeDefined()
    const bootstrap = await readFile(
      new URL('../../../infrastructure/compose/postgres/bootstrap-roles.sh', import.meta.url),
      'utf8'
    )
    const tombstoneBootstrapStatements = [
      ...bootstrap.matchAll(
        /SELECT '(?:REVOKE ALL PRIVILEGES|GRANT SELECT, INSERT) ON TABLE public\.retired_command_keys (?:FROM|TO) control_plane_app'\nWHERE to_regclass\('public\.retired_command_keys'\) IS NOT NULL \\gexec/g
      ),
    ]
    expect(tombstoneBootstrapStatements).toHaveLength(2)
    await isolated.withMigrationDatabase(async (database) => {
      for (const [statement] of tombstoneBootstrapStatements) {
        const commands = await database.execute(sql.raw(statement.replace(/\\gexec$/, '')))
        expect(commands).toHaveLength(1)
        const command = Object.values(commands[0])[0]
        expect(typeof command).toBe('string')
        await database.execute(sql.raw(command))
      }
    })

    await expect(
      (async () =>
        await isolated.application
          .update(retiredCommandKeys)
          .set({ retiredAt })
          .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey)))()
    ).rejects.toThrow()
    await expect(
      (async () =>
        await isolated.application
          .delete(retiredCommandKeys)
          .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey)))()
    ).rejects.toThrow()

    const appPrivileges = await isolated.application.execute(sql`
      select current_user as role,
        coalesce((select rolsuper from pg_roles where rolname = current_user), true) as is_superuser,
        has_table_privilege(current_user, 'public.retired_command_keys', 'SELECT') as can_select,
        has_table_privilege(current_user, 'public.retired_command_keys', 'INSERT') as can_insert,
        has_table_privilege(current_user, 'public.retired_command_keys', 'UPDATE') as can_update,
        has_table_privilege(current_user, 'public.retired_command_keys', 'DELETE') as can_delete
    `)
    expect(appPrivileges).toMatchObject([
      {
        role: new URL(credentials.application.url).username,
        is_superuser: false,
        can_select: true,
        can_insert: true,
        can_update: false,
        can_delete: false,
      },
    ])
    await expect(
      new PostgresAdmissionRolloutService(isolated.application).audit()
    ).rejects.toMatchObject({ code: 'ADMISSION_ROLLOUT_GATE_UNAVAILABLE' })

    const operatorRole = await isolated.withMigrationDatabase((database) =>
      database.execute(sql`
        select current_user as role,
          coalesce((select rolsuper from pg_roles where rolname = current_user), true) as is_superuser
      `)
    )
    expect(operatorRole).toEqual([
      { role: new URL(credentials.migration.url).username, is_superuser: false },
    ])
    expect(operatorRole[0].role).not.toBe(new URL(credentials.application.url).username)

    const cleanAudit = await auditWithMigration(isolated)
    expect(cleanAudit).toMatchObject({ complete: true, canResume: true })

    const mismatchedScopeKey = 'f'.repeat(64)
    await isolated.withMigrationDatabase((database) =>
      database
        .update(retiredCommandKeys)
        .set({ scopeKey: mismatchedScopeKey })
        .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey))
    )
    const tampered = await auditWithMigration(isolated)
    expect(tampered.complete).toBe(false)
    expect(tampered.canResume).toBe(false)
    expect(tampered.diagnostics.map(({ code }) => code)).toContain(
      'RETIRED_COMMAND_KEY_METADATA_MISMATCH'
    )

    await isolated.withMigrationDatabase((database) =>
      database
        .update(retiredCommandKeys)
        .set({
          scopeKey: keys.legacyKey,
          metadataVersion: 1,
          identityDigest: null,
        })
        .where(eq(retiredCommandKeys.scopeKey, mismatchedScopeKey))
    )
    await expect(repository.accept(accepted.command, accepted.execution)).rejects.toMatchObject({
      code: 'COMMAND_RETENTION_EXPIRED',
    })
    const legacy = await auditWithMigration(isolated)
    expect(legacy.complete).toBe(false)
    expect(legacy.canResume).toBe(false)
    expect(legacy.diagnostics.map(({ code }) => code)).toContain('RETIRED_COMMAND_KEY_UNVERIFIABLE')

    await isolated.withMigrationDatabase((database) =>
      database
        .update(retiredCommandKeys)
        .set({
          scopeKey: keys.metadata.scopeKey,
          metadataVersion: 2,
          identityDigest: keys.metadata.identityDigest,
        })
        .where(eq(retiredCommandKeys.scopeKey, keys.legacyKey))
    )
    await expect(auditWithMigration(isolated)).resolves.toMatchObject({
      complete: true,
      canResume: true,
    })
    const afterAuditAndReplay = await executionSnapshot(
      isolated.application,
      accepted.execution.executionId
    )
    expect(afterAuditAndReplay.budgets).toEqual(before.budgets)
    expect(afterAuditAndReplay.entries).toEqual(before.entries)
    expect(afterAuditAndReplay.receipts).toEqual(before.receipts)
  }, 30_000)

  test('blocks resume when a terminal owner has both an inbox command and a retired key', async () => {
    const { isolated } = await createDatabase()
    const { service } = acceptanceService(isolated.application)
    const accepted = await service.acceptExecution(commandInput(plan))
    await persistLegacyOutcome(isolated.application, service, accepted, 'completed', 'completed')

    const otherScope = {
      ...commandScope(accepted.command),
      idempotencyKey: `${accepted.command.idempotencyKey}-retired`,
    }
    const keys = retiredCommandKeyCandidates(otherScope)
    await isolated.withMigrationDatabase((database) =>
      database.insert(retiredCommandKeys).values({
        scopeKey: keys.metadata.scopeKey,
        commandId: nextId('cmd'),
        executionId: accepted.execution.executionId,
        retiredAt: new Date('2026-09-21T00:00:00.000Z'),
        metadataVersion: keys.metadata.metadataVersion,
        identityDigest: keys.metadata.identityDigest,
      })
    )

    const report = await auditWithMigration(isolated)
    expect(report.complete).toBe(false)
    expect(report.canResume).toBe(false)
    expect(report.diagnostics.map(({ code }) => code)).toContain('RETIRED_COMMAND_LINEAGE_INVALID')
  }, 30_000)

  test('v2 retired-command metadata rejects a null identity digest in PostgreSQL', async () => {
    const { isolated } = await createDatabase()
    await expect(
      isolated.application
        .insert(retiredCommandKeys)
        .values({
          scopeKey: 'f'.repeat(64),
          commandId: nextId('cmd'),
          executionId: nextId('exe'),
          retiredAt: new Date(acceptedAt),
          metadataVersion: 2,
          identityDigest: null,
        })
        .execute()
    ).rejects.toThrow()
  }, 30_000)

  test('retired tombstones keep execution owners available for admission audit and resume', async () => {
    const { isolated } = await createDatabase()
    const { repository, service } = acceptanceService(isolated.application, {
      budgetAdmission: false,
    })
    const accepted = await service.acceptExecution(commandInput(plan))
    const retiredAt = new Date('2026-10-21T10:00:00.000Z')
    await expect(
      retireTerminalCommand(isolated.application, repository, service, accepted, retiredAt)
    ).resolves.toMatchObject({ deleted: 1 })

    const retiredKeysRetentionMs = retentionClassPolicy(
      decidedRetentionPolicy,
      'retired-command-keys'
    ).retainMs
    const executionRetentionMs = retentionClassPolicy(decidedRetentionPolicy, 'executions').retainMs
    const executionRepository = new PostgresExecutionRepository(isolated.application)
    await isolated.withMigrationDatabase((database) =>
      new PostgresAdmissionRolloutService(database).pause()
    )

    const afterTombstoneExpiry = new Date(retiredAt.getTime() + retiredKeysRetentionMs + 1)
    expect(
      await isolated.application
        .select()
        .from(retiredCommandKeys)
        .where(eq(retiredCommandKeys.executionId, accepted.execution.executionId))
    ).toHaveLength(1)
    await expect(
      executionRepository.deleteEligibleExecutions(afterTombstoneExpiry, {
        policyRetainMs: 1,
        dryRun: false,
      })
    ).resolves.toMatchObject({
      deleted: 0,
      retainedByReason: { reference_pending: 1 },
    })
    expect(
      await isolated.application
        .select()
        .from(executions)
        .where(eq(executions.executionId, accepted.execution.executionId))
    ).toHaveLength(1)
    await expect(auditWithMigration(isolated)).resolves.toMatchObject({
      complete: true,
      canResume: true,
    })
    await expect(
      isolated.withMigrationDatabase((database) =>
        new PostgresAdmissionRolloutService(database).resume()
      )
    ).resolves.toMatchObject({
      gate: { state: 'open' },
      audit: { complete: true, canResume: true },
    })

    const terminalAt = new Date('2026-09-20T10:00:03.000Z')
    const afterBothRetentionWindows = new Date(
      Math.max(
        terminalAt.getTime() + executionRetentionMs + 1,
        retiredAt.getTime() + retiredKeysRetentionMs + 1
      )
    )
    await isolated.withMigrationDatabase((database) =>
      new PostgresAdmissionRolloutService(database).pause()
    )
    await expect(
      isolated.withMigrationDatabase((database) =>
        new PostgresCommandAcceptanceRepository(database).deleteEligibleRetiredCommandKeys(
          afterBothRetentionWindows,
          { policyRetainMs: retiredKeysRetentionMs, dryRun: false }
        )
      )
    ).resolves.toMatchObject({ deleted: 1 })
    expect(
      await isolated.application
        .select()
        .from(retiredCommandKeys)
        .where(eq(retiredCommandKeys.executionId, accepted.execution.executionId))
    ).toHaveLength(0)
    await expect(
      executionRepository.deleteEligibleExecutions(afterBothRetentionWindows, {
        policyRetainMs: executionRetentionMs,
        dryRun: false,
      })
    ).resolves.toMatchObject({ deleted: 1 })
    expect(
      await isolated.application
        .select()
        .from(executions)
        .where(eq(executions.executionId, accepted.execution.executionId))
    ).toHaveLength(0)
    await expect(auditWithMigration(isolated)).resolves.toMatchObject({
      complete: true,
      canResume: true,
    })
    await expect(
      isolated.withMigrationDatabase((database) =>
        new PostgresAdmissionRolloutService(database).resume()
      )
    ).resolves.toMatchObject({
      gate: { state: 'open' },
      audit: { complete: true, canResume: true },
    })
  }, 30_000)

  test('retains v1 and v2 tombstones through day 30 and deletes only with migration authority', async () => {
    const { isolated } = await createDatabase()
    const repository = new PostgresCommandAcceptanceRepository(isolated.application)
    const retiredAt = new Date('2027-01-01T00:00:00.000Z')
    const acceptedCommands = []
    for (let index = 0; index < 2; index++) {
      const { service } = acceptanceService(isolated.application)
      const accepted = await service.acceptExecution(commandInput(plan))
      await expect(
        retireTerminalCommand(isolated.application, repository, service, accepted, retiredAt)
      ).resolves.toMatchObject({ deleted: 1 })
      acceptedCommands.push(accepted.command)
    }

    const legacyKeys = retiredCommandKeyCandidates(commandScope(acceptedCommands[1]))
    await isolated.withMigrationDatabase((database) =>
      database
        .update(retiredCommandKeys)
        .set({
          scopeKey: legacyKeys.legacyKey,
          metadataVersion: 1,
          identityDigest: null,
        })
        .where(eq(retiredCommandKeys.scopeKey, legacyKeys.metadata.scopeKey))
    )

    const policyRetainMs = retentionClassPolicy(
      decidedRetentionPolicy,
      'retired-command-keys'
    ).retainMs
    const migrationRepository = async (now, dryRun) =>
      isolated.withMigrationDatabase((database) =>
        new PostgresCommandAcceptanceRepository(database).deleteEligibleRetiredCommandKeys(now, {
          policyRetainMs,
          dryRun,
        })
      )
    const day29 = new Date(retiredAt.getTime() + thirtyDaysMs - 1)
    const day30 = new Date(retiredAt.getTime() + thirtyDaysMs)
    const day30AndOneMs = new Date(day30.getTime() + 1)

    await expect(migrationRepository(day29, false)).resolves.toMatchObject({
      dryRun: false,
      eligible: 0,
      deleted: 0,
      retainedByReason: { not_expired: 2 },
    })
    await expect(migrationRepository(day30, false)).resolves.toMatchObject({
      dryRun: false,
      eligible: 0,
      deleted: 0,
      retainedByReason: { not_expired: 2 },
    })
    await expect(migrationRepository(day30AndOneMs, true)).resolves.toMatchObject({
      dryRun: true,
      eligible: 2,
      deleted: 0,
    })
    expect(await isolated.application.select().from(retiredCommandKeys)).toHaveLength(2)
    await expect(migrationRepository(day30AndOneMs, false)).resolves.toMatchObject({
      dryRun: false,
      eligible: 2,
      deleted: 2,
    })
    expect(await isolated.application.select().from(retiredCommandKeys)).toHaveLength(0)
  }, 30_000)

  test('rebuilds a verified tombstone from inbox source and rejects source-less journal inserts', async () => {
    const { isolated } = await createDatabase()
    const { service } = acceptanceService(isolated.application)
    const accepted = await service.acceptExecution(commandInput(plan))
    const keys = retiredCommandKeyCandidates(commandScope(accepted.command))
    const legacyOperation = {
      kind: 'postgres.retireCommandKey',
      scopeKey: keys.legacyKey,
      commandId: accepted.command.commandId,
      executionId: accepted.execution.executionId,
      retiredAt: '2026-09-26T13:00:00.000Z',
    }
    const operation = {
      kind: 'postgres.retireCommandKey',
      scopeKey: keys.metadata.scopeKey,
      commandId: accepted.command.commandId,
      executionId: accepted.execution.executionId,
      retiredAt: '2026-09-26T13:00:00.000Z',
    }
    const reapplication = new PostgresRetentionReapplication(isolated.application)

    await isolated.withMigrationDatabase((database) =>
      database.insert(retiredCommandKeys).values({
        scopeKey: keys.legacyKey,
        commandId: accepted.command.commandId,
        executionId: accepted.execution.executionId,
        retiredAt: new Date(operation.retiredAt),
        metadataVersion: 1,
        identityDigest: null,
      })
    )
    await expect(reapplication.apply([legacyOperation])).resolves.toEqual({
      applied: 1,
      skipped: 0,
    })
    expect(
      await isolated.application
        .select()
        .from(retiredCommandKeys)
        .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey))
    ).toMatchObject([
      {
        scopeKey: keys.metadata.scopeKey,
        metadataVersion: 2,
        identityDigest: keys.metadata.identityDigest,
      },
    ])
    await expect(reapplication.apply([{ ...operation, scopeKey: 'f'.repeat(64) }])).rejects.toThrow(
      'RETENTION_RETIRED_COMMAND_JOURNAL_MISMATCH'
    )

    await isolated.withMigrationDatabase((database) =>
      database.delete(commandInbox).where(eq(commandInbox.commandId, accepted.command.commandId))
    )
    await expect(reapplication.apply([operation])).resolves.toEqual({ applied: 0, skipped: 1 })
    await isolated.withMigrationDatabase((database) =>
      database
        .delete(retiredCommandKeys)
        .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey))
    )
    await expect(reapplication.apply([operation])).rejects.toThrow(
      'RETENTION_RETIRED_COMMAND_SOURCE_MISSING'
    )
  }, 30_000)

  test('routes tombstone deletion journals through migration credentials only', async () => {
    const { isolated, credentials } = await createDatabase()
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-reapply-'))
    try {
      const accepted = await acceptanceService(isolated.application).service.acceptExecution(
        commandInput(plan)
      )
      const keys = retiredCommandKeyCandidates(commandScope(accepted.command))
      const journalPath = join(directory, 'retention.jsonl')
      const applicationUrl = new URL(credentials.application.url)
      applicationUrl.pathname = `/${isolated.name}`
      const migrationUrl = new URL(credentials.migration.url)
      migrationUrl.pathname = `/${isolated.name}`
      // Exercise the split-host shape used by pooled application and direct
      // migration URLs when running against the local Docker fixture.
      if (applicationUrl.hostname === '127.0.0.1') migrationUrl.hostname = 'localhost'
      const retentionReapplyScript = fileURLToPath(
        new URL('../../../scripts/retention-reapply.mjs', import.meta.url)
      )
      const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
      const runJournal = async (record, environment) => {
        await writeFile(journalPath, `${JSON.stringify(record)}\n`)
        const childEnvironment = { ...process.env, ...environment }
        for (const credentialName of [
          'DATABASE_URL',
          'DATABASE_ADMIN_URL',
          'DATABASE_MIGRATION_URL',
        ]) {
          if (!(credentialName in environment)) delete childEnvironment[credentialName]
        }
        const migrationRoleRequired = record.operations.some(
          (operation) => operation.kind === 'postgres.deleteRetiredCommandKey'
        )
        const targetUrl = migrationRoleRequired
          ? (environment.DATABASE_MIGRATION_URL ?? environment.DATABASE_URL)
          : environment.DATABASE_URL
        const result = spawnSync(
          process.execPath,
          [
            retentionReapplyScript,
            '--backend',
            'postgres',
            '--database',
            isolated.name,
            '--host',
            new URL(targetUrl).hostname,
            '--journal',
            journalPath,
          ],
          {
            cwd: repositoryRoot,
            encoding: 'utf8',
            timeout: 30000,
            env: childEnvironment,
          }
        )
        if (result.error) throw result.error
        return {
          status: result.status,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        }
      }
      const insertJournal = {
        version: 1,
        at: acceptedAt,
        backend: 'postgres',
        classId: 'command-inbox',
        operations: [
          {
            kind: 'postgres.retireCommandKey',
            scopeKey: keys.metadata.scopeKey,
            commandId: accepted.command.commandId,
            executionId: accepted.execution.executionId,
            retiredAt: '2026-09-26T13:00:00.000Z',
          },
        ],
      }
      const unavailableMigrationUrl = new URL(migrationUrl)
      unavailableMigrationUrl.port = '1'
      const inserted = await runJournal(insertJournal, {
        DATABASE_URL: applicationUrl.toString(),
        DATABASE_MIGRATION_URL: unavailableMigrationUrl.toString(),
      })
      expect(inserted.status).toBe(0)
      expect(JSON.parse(inserted.stdout)).toMatchObject({ applied: 1, skipped: 0 })
      expect(inserted.stderr).toBe('')
      expect(
        await isolated.application
          .select()
          .from(retiredCommandKeys)
          .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey))
      ).toMatchObject([{ metadataVersion: 2, identityDigest: keys.metadata.identityDigest }])

      const deleteJournal = {
        version: 1,
        at: acceptedAt,
        backend: 'postgres',
        classId: 'retired-command-keys',
        operations: [
          { kind: 'postgres.deleteRetiredCommandKey', scopeKey: keys.metadata.scopeKey },
        ],
      }
      const missingMigrationRole = await runJournal(deleteJournal, {
        DATABASE_URL: applicationUrl.toString(),
      })
      expect(missingMigrationRole.status).toBe(1)
      expect(missingMigrationRole.stdout).toBe('')
      expect(missingMigrationRole.stderr).toBe('RETENTION_REAPPLY_FAILED:ConfigurationError\n')
      expect(
        await isolated.application
          .select()
          .from(retiredCommandKeys)
          .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey))
      ).toHaveLength(1)

      const deleted = await runJournal(deleteJournal, {
        DATABASE_URL: applicationUrl.toString(),
        DATABASE_MIGRATION_URL: migrationUrl.toString(),
      })
      expect(deleted.status).toBe(0)
      expect(JSON.parse(deleted.stdout)).toMatchObject({ applied: 1, skipped: 0 })
      expect(deleted.stderr).toBe('')
      expect(
        await isolated.application
          .select()
          .from(retiredCommandKeys)
          .where(eq(retiredCommandKeys.scopeKey, keys.metadata.scopeKey))
      ).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)
})
