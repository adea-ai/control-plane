import { afterEach, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  DurableUsageBudgetSchema,
  DurableUsageEffectSchema,
} from '@control-plane/usage-ledger/durable-contract'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { loadDatabaseCredentials } from '@control-plane/config'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { createPostgresConnection } from './connection.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresDurableUsageStore } from './usage-store.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const acceptedAt = '2026-09-20T10:00:00.000Z'
const queuedAt = '2026-09-20T10:00:01.000Z'
const plan = createExecutionPlanTestFixture()
const planReference = {
  executionPlanId: plan.executionPlanId,
  contentDigest: plan.contentDigest,
  schemaVersion: plan.schemaVersion,
}
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
let fixtureSequence = 0

function nextId(prefix) {
  fixtureSequence += 1
  const tail =
    alphabet[Math.floor(fixtureSequence / alphabet.length)] +
    alphabet[fixtureSequence % alphabet.length]
  return `${prefix}_01ARZ3NDEKTSV4RRFFQ69G5F${tail}`
}

function source(key) {
  return { sourceId: 'postgres-durable-usage-integration', idempotencyKey: key }
}

function ledger(database, now = () => '2026-09-20T10:01:00.000Z') {
  return new DurableUsageLedger({
    store: new PostgresDurableUsageStore(database),
    now,
  })
}

function idsForWorkspace(workspaceId) {
  return {
    workspaceId,
    projectId: nextId('prj'),
    taskId: nextId('tsk'),
    agentId: nextId('agt'),
    requestId: nextId('req'),
  }
}

async function createOwner(database, { workspaceId = nextId('wsp'), parentExecutionId } = {}) {
  const executionId = nextId('exe')
  const repository = new PostgresExecutionRepository(database)
  const lifecycle = new ExecutionLifecycleService(repository)
  const execution = await lifecycle.createExecution({
    executionId,
    correlation: idsForWorkspace(workspaceId),
    executionPlan: planReference,
    ...(parentExecutionId === undefined ? {} : { parentExecutionId }),
    acceptedAt,
  })
  const attempt = await lifecycle.createAttempt({
    executionId,
    attemptId: nextId('att'),
    expectedExecutionVersion: execution.version,
    queuedAt,
  })
  return { execution, attempt }
}

describe.skipIf(!enabled)('PostgreSQL durable usage store', () => {
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

  test('opens, reserves, charges, settles, finalizes, reconnects, and replays receipts', async () => {
    const { isolated, credentials } = await createDatabase()
    const owner = await createOwner(isolated.application)
    const service = ledger(isolated.application)
    const openInput = {
      workspaceId: owner.execution.correlation.workspaceId,
      executionId: owner.execution.executionId,
      currency: 'USD',
      maximumMicrounits: 10_000,
      maximumTokens: 100,
      source: source('lifecycle-open'),
    }
    const opened = await service.openBudget(openInput)
    const reserveInput = {
      workspaceId: openInput.workspaceId,
      executionId: openInput.executionId,
      attemptId: owner.attempt.attemptId,
      reservationKey: 'model-call',
      maximumMicrounits: 5_000,
      maximumTokens: 50,
      source: source('lifecycle-reserve'),
    }
    const reserved = await service.reserve(reserveInput)
    const chargeInput = {
      workspaceId: openInput.workspaceId,
      executionId: openInput.executionId,
      attemptId: owner.attempt.attemptId,
      reservationKey: 'model-call',
      kind: 'model_usage',
      quantity: { unit: 'tokens', value: 22 },
      costMicrounits: 1_800,
      fundingSource: 'hq_managed',
      source: source('lifecycle-charge'),
    }
    const charged = await service.charge(chargeInput)
    const settleInput = {
      workspaceId: openInput.workspaceId,
      executionId: openInput.executionId,
      reservationKey: 'model-call',
      source: source('lifecycle-settle'),
    }
    const settled = await service.settle(settleInput)
    const finalizeInput = {
      workspaceId: openInput.workspaceId,
      executionId: openInput.executionId,
      source: source('lifecycle-finalize'),
    }
    const finalized = await service.finalizeBudget(finalizeInput)

    const databaseUrl = new URL(credentials.application.url)
    databaseUrl.pathname = `/${isolated.name}`
    const reconnected = createPostgresConnection({
      ...credentials.application,
      url: databaseUrl.toString(),
    })
    try {
      const reopened = ledger(reconnected.database)
      await expect(reopened.openBudget(openInput)).resolves.toEqual(opened)
      await expect(reopened.reserve(reserveInput)).resolves.toEqual(reserved)
      await expect(reopened.charge(chargeInput)).resolves.toEqual(charged)
      await expect(reopened.settle(settleInput)).resolves.toEqual(settled)
      await expect(reopened.finalizeBudget(finalizeInput)).resolves.toEqual(finalized)
      await expect(
        reopened.entries(openInput.workspaceId, openInput.executionId)
      ).resolves.toHaveLength(6)
      await expect(
        reopened.publicSummary(openInput.workspaceId, openInput.executionId)
      ).resolves.toEqual({
        executionId: openInput.executionId,
        currency: 'USD',
        funding: { hqManagedMicrounits: 1_800, externalSubscriptionEffects: 0 },
        usage: { tokens: 22 },
        settled: true,
      })
    } finally {
      await reconnected.close()
    }
  })

  test('rolls back budgets, immutable entries, and replay receipts when the callback throws', async () => {
    const { isolated } = await createDatabase()
    const owner = await createOwner(isolated.application)
    const workspaceId = owner.execution.correlation.workspaceId
    const executionId = owner.execution.executionId
    const store = new PostgresDurableUsageStore(isolated.application)
    const budget = DurableUsageBudgetSchema.parse({
      schemaVersion: 1,
      workspaceId,
      executionId,
      currency: 'USD',
      maximumMicrounits: 1_000,
      maximumTokens: 10,
      status: 'open',
      nextSequence: 2,
      reservations: [],
    })
    const entry = {
      entryId: nextId('usg'),
      sequence: 1,
      workspaceId,
      executionId,
      kind: 'credit',
      source: {
        sourceId: 'postgres-durable-usage-integration',
        idempotencyKey: 'rollback-entry',
      },
      fundingSource: 'hq_managed',
      quantity: { unit: 'microunits', value: 1_000 },
      currency: 'USD',
      costMicrounits: 0,
      costExact: true,
      recordedAt: '2026-09-20T10:01:00.000Z',
    }
    const effect = DurableUsageEffectSchema.parse({
      schemaVersion: 1,
      workspaceId,
      executionId,
      idempotencyKey: 'rollback-effect',
      fingerprint: `sha256:${'a'.repeat(64)}`,
      result: { executionId, initial: true },
    })

    await expect(
      store.transaction(workspaceId, async (transaction) => {
        await transaction.putBudget(budget)
        await transaction.appendEntry(entry)
        await transaction.putEffect(effect)
        throw new Error('ROLLBACK_SENTINEL')
      })
    ).rejects.toThrow('ROLLBACK_SENTINEL')

    await store.transaction(workspaceId, async (transaction) => {
      await expect(transaction.getBudget(executionId)).resolves.toBeUndefined()
      await expect(transaction.listEntries(executionId)).resolves.toEqual([])
      await expect(transaction.getEffect(effect.idempotencyKey)).resolves.toBeUndefined()
    })
  })

  test('serializes simultaneous money-only and token-only reservations at both ceilings', async () => {
    const { isolated } = await createDatabase()
    const owner = await createOwner(isolated.application)
    const workspaceId = owner.execution.correlation.workspaceId
    const executionId = owner.execution.executionId
    const service = ledger(isolated.application)
    await service.openBudget({
      workspaceId,
      executionId,
      currency: 'USD',
      maximumMicrounits: 1_000,
      maximumTokens: 100,
      source: source('orthogonal-open'),
    })

    const requests = [
      {
        workspaceId,
        executionId,
        reservationKey: 'money-only',
        maximumMicrounits: 1_000,
        maximumTokens: 0,
        source: source('orthogonal-money'),
      },
      {
        workspaceId,
        executionId,
        reservationKey: 'tokens-only',
        maximumMicrounits: 0,
        maximumTokens: 100,
        source: source('orthogonal-tokens'),
      },
    ]
    const results = await Promise.all(requests.map((request) => service.reserve(request)))
    expect(results).toHaveLength(2)
    await expect(service.summary(workspaceId, executionId)).resolves.toMatchObject({
      reservedMicrounits: 1_000,
      reservedTokens: 100,
      availableMicrounits: 0,
      availableTokens: 0,
    })

    const contested = await createOwner(isolated.application, { workspaceId })
    const contestedExecutionId = contested.execution.executionId
    await service.openBudget({
      workspaceId,
      executionId: contestedExecutionId,
      currency: 'USD',
      maximumMicrounits: 1_000,
      maximumTokens: 100,
      source: source('contested-open'),
    })
    const admissions = await Promise.allSettled([
      service.reserve({
        workspaceId,
        executionId: contestedExecutionId,
        reservationKey: 'money-first',
        maximumMicrounits: 600,
        maximumTokens: 0,
        source: source('contested-money-a'),
      }),
      service.reserve({
        workspaceId,
        executionId: contestedExecutionId,
        reservationKey: 'money-second',
        maximumMicrounits: 600,
        maximumTokens: 0,
        source: source('contested-money-b'),
      }),
      service.reserve({
        workspaceId,
        executionId: contestedExecutionId,
        reservationKey: 'tokens-first',
        maximumMicrounits: 0,
        maximumTokens: 60,
        source: source('contested-tokens-a'),
      }),
      service.reserve({
        workspaceId,
        executionId: contestedExecutionId,
        reservationKey: 'tokens-second',
        maximumMicrounits: 0,
        maximumTokens: 60,
        source: source('contested-tokens-b'),
      }),
    ])
    expect(admissions.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
    expect(admissions.filter((result) => result.status === 'rejected')).toHaveLength(2)
    await expect(service.summary(workspaceId, contestedExecutionId)).resolves.toMatchObject({
      reservedMicrounits: 600,
      reservedTokens: 60,
      availableMicrounits: 400,
      availableTokens: 40,
    })
  })
})
