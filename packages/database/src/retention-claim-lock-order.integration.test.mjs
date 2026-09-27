import { afterEach, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { eq, sql } from 'drizzle-orm'
import { loadDatabaseCredentials } from '@control-plane/config'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { CommandInboxService } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { PostgresCommandAcceptanceRepository } from './command-inbox-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import { commandInbox } from './schema/commands.ts'
import { executions } from './schema/executions.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const terminalAt = '2026-08-24T11:05:00.000Z'
const retiredAt = '2026-09-24T12:00:00.000Z'
const suffix = '01CRZ3NDEKTSV4RRFFQ69G5FFA'
const plan = createExecutionPlanTestFixture()
const planReference = {
  executionPlanId: plan.executionPlanId,
  contentDigest: plan.contentDigest,
  schemaVersion: plan.schemaVersion,
}

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function waitForExecutionRowLockWait(database) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const rows = await database.execute(sql`
      select query
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and cardinality(pg_blocking_pids(pid)) > 0
        and lower(query) like '%executions%'
        and lower(query) like '%for update%'
    `)
    if (rows.length > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

describe.skipIf(!enabled)('PostgreSQL retention claim lock ordering', () => {
  const isolatedDatabases = []

  async function createDatabase() {
    const isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    isolatedDatabases.push(isolated)
    await isolated.migrate()
    return isolated
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

  test('retireExpiredCommand locks the execution owner before claiming the command row', async () => {
    const isolated = await createDatabase()
    const database = isolated.application
    await new PostgresContextPackageRepository(database).put(
      contextPackageSerializationFixtures.futurePi
    )
    await new PostgresExecutionPlanRepository(database).put(plan)

    const repository = new PostgresCommandAcceptanceRepository(database)
    const input = {
      callerPrincipalId: 'svc_retention-lock-order',
      operation: 'execution.accept',
      commandId: `cmd_${suffix}`,
      requestId: `req_${suffix}`,
      idempotencyKey: 'integration-retention-lock-order-1',
      payloadHash: 'a'.repeat(64),
      correlation: {
        workspaceId: `wsp_${suffix}`,
        projectId: `prj_${suffix}`,
        taskId: `tsk_${suffix}`,
        agentId: `agt_${suffix}`,
      },
      executionPlan: planReference,
      receivedAt: '2026-07-31T11:00:00.000Z',
      retentionExpiresAt: '2026-09-01T11:00:00.000Z',
    }
    const accepted = await new CommandInboxService({
      repository,
      executionIdFactory: () => `exe_${suffix}`,
      executionPlanValidator: { validate: async () => true },
      now: () => input.receivedAt,
    }).acceptExecution(input)
    const scope = {
      callerPrincipalId: input.callerPrincipalId,
      operation: input.operation,
      workspaceId: input.correlation.workspaceId,
      projectId: input.correlation.projectId,
      idempotencyKey: input.idempotencyKey,
    }
    await database.execute(sql`
      update executions
      set state = 'completed', terminal_at = ${terminalAt}::timestamptz,
          updated_at = ${terminalAt}::timestamptz
      where execution_id = ${accepted.execution.executionId}
    `)
    await database.execute(sql`
      update command_inbox
      set status = 'completed', terminal_at = ${terminalAt}::timestamptz,
          result_reference = 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV'
      where command_id = ${input.commandId}
    `)

    const ownerLocked = deferred()
    const releaseOwner = deferred()
    const blocker = database.transaction(async (transaction) => {
      await transaction
        .select({ executionId: executions.executionId })
        .from(executions)
        .where(eq(executions.executionId, accepted.execution.executionId))
        .for('update')
      ownerLocked.resolve()
      await releaseOwner.promise
    })
    let retirement
    const claimErrors = []
    try {
      await ownerLocked.promise
      retirement = repository.retireExpiredCommand(scope, retiredAt)
      expect(await waitForExecutionRowLockWait(database)).toBe(true)

      // This must succeed while retirement is blocked on the execution row.
      // The previous command-first order held this row and produced SQLSTATE 55P03.
      const commandClaim = await database.transaction((transaction) =>
        transaction.execute(sql`
          select command_id from command_inbox
          where command_id = ${input.commandId}
          for update nowait
        `)
      )
      expect(commandClaim).toHaveLength(1)
    } catch (error) {
      claimErrors.push(error)
    } finally {
      releaseOwner.resolve()
      const settled = await Promise.allSettled([blocker, retirement])
      for (const result of settled) {
        if (result.status === 'rejected') claimErrors.push(result.reason)
      }
    }
    if (claimErrors.length > 0) throw new AggregateError(claimErrors, 'RETIREMENT_CLAIM_FAILED')

    await expect(retirement).resolves.toBe(true)
    expect(
      await database.select().from(commandInbox).where(eq(commandInbox.commandId, input.commandId))
    ).toHaveLength(1)
    expect(
      await database
        .select()
        .from(executions)
        .where(eq(executions.executionId, accepted.execution.executionId))
    ).toHaveLength(1)
  }, 30_000)
})
