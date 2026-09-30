import { afterEach, beforeEach, describe, expect, test as runTest } from 'bun:test'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { and, eq, sql } from 'drizzle-orm'
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
import { usageBudgetStates, usageOperationReceipts } from './schema/usage-budget-state.ts'
import { usageLedgerEntries } from './schema/usage-ledger.ts'
import { executions } from './schema/executions.ts'

const timingEnabled = process.env.RUN_DATABASE_INTEGRATION_TIMING === 'true'
const timingFile = 'usage-store'

async function timedPhase(phase, operation) {
  if (!timingEnabled) return operation()
  const startedAt = performance.now()
  try {
    return await operation()
  } finally {
    process.stderr.write(
      `[db-integration-timing] file=${timingFile} phase=${phase} duration_ms=${(performance.now() - startedAt).toFixed(1)}\n`
    )
  }
}

const test = (name, operation, timeoutMs = 30_000) =>
  runTest(name, () => timedPhase('body', operation), timeoutMs)

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

async function createOwner(
  database,
  { workspaceId = nextId('wsp'), parentExecutionId, withAttempt = true } = {}
) {
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
  const attempt = withAttempt
    ? await lifecycle.createAttempt({
        executionId,
        attemptId: nextId('att'),
        expectedExecutionVersion: execution.version,
        queuedAt,
      })
    : undefined
  return { execution, attempt }
}

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function waitForAdvisoryLockWait(database) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = await database.execute(sql`
      select pid
      from pg_stat_activity
      where datname = current_database()
        and wait_event_type = 'Lock'
        and cardinality(pg_blocking_pids(pid)) > 0
        and lower(query) like '%pg_advisory_xact_lock%'
      limit 1
    `)
    if (rows.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('EXPECTED_POSTGRES_ADVISORY_LOCK_WAIT')
}

async function withinBound(promise, label, timeoutMs = 15_000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`POSTGRES_TEST_TIMEOUT:${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe.skipIf(!enabled)('PostgreSQL durable usage store', () => {
  const isolatedDatabases = []
  let preparedDatabase

  async function createDatabase() {
    if (!preparedDatabase) throw new Error('ISOLATED_TEST_DATABASE_NOT_PREPARED')
    return preparedDatabase
  }

  beforeEach(async () => {
    let isolated
    try {
      const credentials = {
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      }
      isolated = await timedPhase('create', () => createIsolatedTestDatabase(credentials))
      isolatedDatabases.push(isolated)
      await timedPhase('migrate', () => isolated.migrate())
      await timedPhase('seed', async () => {
        await new PostgresContextPackageRepository(isolated.application).put(
          contextPackageSerializationFixtures.futurePi
        )
        await new PostgresExecutionPlanRepository(isolated.application).put(plan)
      })
      preparedDatabase = { isolated, credentials }
    } catch (error) {
      if (isolated) {
        const index = isolatedDatabases.indexOf(isolated)
        if (index >= 0) isolatedDatabases.splice(index, 1)
        try {
          await timedPhase('dispose', () => isolated.dispose())
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'ISOLATED_TEST_DATABASE_SETUP_FAILED', {
            cause: cleanupError,
          })
        }
      }
      throw error
    }
  }, 60_000)

  afterEach(async () => {
    preparedDatabase = undefined
    const created = isolatedDatabases.splice(0)
    const results = await Promise.allSettled(
      created.map((isolated) => timedPhase('dispose', () => isolated.dispose()))
    )
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length > 0)
      throw new AggregateError(errors, 'ISOLATED_TEST_DATABASE_DISPOSAL_FAILED')
  }, 30_000)

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
    // The lifecycle and a fresh-client replay completed in 51s on the real
    // Neon probe. This compound fixture has a bounded 60s body; individual
    // lock/operation bounds and the other case deadlines remain unchanged.
  }, 60_000)

  test('binds durable usage to an existing transaction, including rollback and lease scope', async () => {
    const { isolated } = await createDatabase()
    const owner = await createOwner(isolated.application)
    const workspaceId = owner.execution.correlation.workspaceId
    const executionId = owner.execution.executionId
    const store = new PostgresDurableUsageStore(isolated.application)
    const budget = {
      schemaVersion: 1,
      workspaceId,
      executionId,
      currency: 'USD',
      maximumMicrounits: 1_000,
      maximumTokens: 10,
      status: 'open',
      nextSequence: 1,
      reservations: [],
    }
    let escapedStore
    let escapedTransaction

    await isolated.application.transaction(async (transaction) => {
      await PostgresDurableUsageStore.acquireTransactionLocks(transaction, workspaceId)
      await PostgresDurableUsageStore.withTransaction(
        transaction,
        workspaceId,
        async (boundStore) => {
          escapedStore = boundStore
          await expect(
            boundStore.transaction(nextId('wsp'), async () => undefined)
          ).rejects.toMatchObject({ code: 'USAGE_LEDGER_SCOPE_MISMATCH' })

          await boundStore.transaction(workspaceId, async (usage) => {
            escapedTransaction = usage
            await usage.putBudget(budget)
            await expect(
              boundStore.transaction(workspaceId, async () => undefined)
            ).rejects.toMatchObject({ code: 'STORE_STATE_INVALID' })
          })
          await expect(escapedTransaction.getBudget(executionId)).rejects.toMatchObject({
            code: 'STORE_STATE_INVALID',
          })
          await expect(escapedTransaction.putBudget(budget)).rejects.toMatchObject({
            code: 'STORE_STATE_INVALID',
          })
        }
      )
    })

    await expect(
      store.transaction(workspaceId, (usage) => usage.getBudget(executionId))
    ).resolves.toEqual(budget)
    await expect(
      escapedStore.transaction(workspaceId, async () => undefined)
    ).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })

    const rollbackOwner = await createOwner(isolated.application)
    await expect(
      isolated.application.transaction(async (transaction) => {
        await PostgresDurableUsageStore.withTransaction(
          transaction,
          rollbackOwner.execution.correlation.workspaceId,
          async (boundStore) => {
            try {
              await boundStore.transaction(
                rollbackOwner.execution.correlation.workspaceId,
                async (usage) => {
                  await usage.putBudget({
                    ...budget,
                    workspaceId: rollbackOwner.execution.correlation.workspaceId,
                    executionId: rollbackOwner.execution.executionId,
                  })
                  throw new Error('BOUND_USAGE_CALLBACK_FAILURE')
                }
              )
            } catch (error) {
              expect(error.message).toBe('BOUND_USAGE_CALLBACK_FAILURE')
            }
          }
        )
      })
    ).rejects.toThrow('STORE_STATE_INVALID')
    await expect(
      store.transaction(rollbackOwner.execution.correlation.workspaceId, (usage) =>
        usage.getBudget(rollbackOwner.execution.executionId)
      )
    ).resolves.toBeUndefined()

    const originalFailure = new Error('BOUND_USAGE_ORIGINAL_FAILURE')
    await expect(
      isolated.application.transaction((transaction) =>
        PostgresDurableUsageStore.withTransaction(
          transaction,
          rollbackOwner.execution.correlation.workspaceId,
          (boundStore) =>
            boundStore.transaction(
              rollbackOwner.execution.correlation.workspaceId,
              async (usage) => {
                await usage.putBudget({
                  ...budget,
                  workspaceId: rollbackOwner.execution.correlation.workspaceId,
                  executionId: rollbackOwner.execution.executionId,
                })
                throw originalFailure
              }
            )
        )
      )
    ).rejects.toBe(originalFailure)
    await expect(
      store.transaction(rollbackOwner.execution.correlation.workspaceId, (usage) =>
        usage.getBudget(rollbackOwner.execution.executionId)
      )
    ).resolves.toBeUndefined()

    const pendingOwner = await createOwner(isolated.application)
    let pendingOperation
    await expect(
      isolated.application.transaction(async (transaction) => {
        await PostgresDurableUsageStore.withTransaction(
          transaction,
          pendingOwner.execution.correlation.workspaceId,
          (boundStore) => {
            pendingOperation = boundStore.transaction(
              pendingOwner.execution.correlation.workspaceId,
              async (usage) => {
                await new Promise((resolve) => setTimeout(resolve, 0))
                return usage.getBudget(pendingOwner.execution.executionId)
              }
            )
          }
        )
      })
    ).rejects.toMatchObject({ code: 'STORE_STATE_INVALID' })
    await expect(pendingOperation).rejects.toMatchObject({ code: 'STORE_STATE_INVALID' })
  })

  test('returns identical duplicates but rejects changed operation identity and inputs', async () => {
    const { isolated } = await createDatabase()
    const owner = await createOwner(isolated.application)
    const workspaceId = owner.execution.correlation.workspaceId
    const executionId = owner.execution.executionId
    const service = ledger(isolated.application)
    const openInput = {
      workspaceId,
      executionId,
      currency: 'USD',
      maximumMicrounits: 1_000,
      maximumTokens: 10,
      source: source('duplicate-open'),
    }
    const opened = await service.openBudget(openInput)
    await expect(service.openBudget(openInput)).resolves.toEqual(opened)
    await expect(
      service.openBudget({ ...openInput, maximumMicrounits: 1_001 })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const reserveInput = {
      workspaceId,
      executionId,
      reservationKey: 'duplicate-reservation',
      maximumMicrounits: 500,
      maximumTokens: 5,
      source: source('duplicate-reserve'),
    }
    const reservation = await service.reserve(reserveInput)
    await expect(service.reserve(reserveInput)).resolves.toEqual(reservation)
    await expect(service.reserve({ ...reserveInput, maximumTokens: 6 })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    })

    const otherOwner = await createOwner(isolated.application, { workspaceId })
    await expect(
      service.openBudget({
        ...openInput,
        executionId: otherOwner.execution.executionId,
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
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

  test('funds child money and tokens once, then rolls measured spend into its parent', async () => {
    const { isolated } = await createDatabase()
    const parent = await createOwner(isolated.application)
    const workspaceId = parent.execution.correlation.workspaceId
    const child = await createOwner(isolated.application, {
      workspaceId,
      parentExecutionId: parent.execution.executionId,
    })
    const service = ledger(isolated.application)
    await service.openBudget({
      workspaceId,
      executionId: parent.execution.executionId,
      currency: 'USD',
      maximumMicrounits: 10_000,
      maximumTokens: 1_000,
      source: source('child-parent-open'),
    })
    const childOpenInput = {
      workspaceId,
      executionId: child.execution.executionId,
      parentExecutionId: parent.execution.executionId,
      currency: 'USD',
      maximumMicrounits: 8_000,
      maximumTokens: 800,
      source: source('child-open'),
    }
    const childOpened = await service.openBudget(childOpenInput)
    expect(childOpened.maximumMicrounits).toBe(8_000)
    expect(childOpened.maximumTokens).toBe(800)
    await expect(service.summary(workspaceId, parent.execution.executionId)).resolves.toMatchObject(
      {
        reservedMicrounits: 8_000,
        reservedTokens: 800,
        availableMicrounits: 2_000,
        availableTokens: 200,
      }
    )

    await service.reserve({
      workspaceId,
      executionId: child.execution.executionId,
      attemptId: child.attempt.attemptId,
      reservationKey: 'child-model',
      maximumMicrounits: 5_000,
      maximumTokens: 500,
      source: source('child-reserve'),
    })
    await service.charge({
      workspaceId,
      executionId: child.execution.executionId,
      attemptId: child.attempt.attemptId,
      reservationKey: 'child-model',
      kind: 'model_usage',
      quantity: { unit: 'tokens', value: 100 },
      costMicrounits: 2_000,
      fundingSource: 'hq_managed',
      source: source('child-charge'),
    })
    await service.settle({
      workspaceId,
      executionId: child.execution.executionId,
      reservationKey: 'child-model',
      source: source('child-settle'),
    })
    const childFinalizeInput = {
      workspaceId,
      executionId: child.execution.executionId,
      source: source('child-finalize'),
    }
    const childFinalized = await service.finalizeBudget(childFinalizeInput)
    await expect(service.summary(workspaceId, parent.execution.executionId)).resolves.toMatchObject(
      {
        spentMicrounits: 2_000,
        spentTokens: 100,
        reservedMicrounits: 0,
        reservedTokens: 0,
        availableMicrounits: 8_000,
        availableTokens: 900,
      }
    )

    const parentFinalized = await service.finalizeBudget({
      workspaceId,
      executionId: parent.execution.executionId,
      source: source('child-parent-finalize'),
    })
    expect(parentFinalized.settled).toBe(true)
    const parentEntriesAfterRollup = await service.entries(
      workspaceId,
      parent.execution.executionId
    )
    expect(parentEntriesAfterRollup.map((entry) => entry.kind)).toEqual([
      'credit',
      'reservation',
      'release',
      'settlement',
      'settlement',
    ])

    await expect(service.openBudget(childOpenInput)).resolves.toEqual(childOpened)
    await expect(service.finalizeBudget(childFinalizeInput)).resolves.toEqual(childFinalized)
    await expect(service.entries(workspaceId, parent.execution.executionId)).resolves.toEqual(
      parentEntriesAfterRollup
    )
  })

  test('rejects cross-workspace owners, incorrect parent attribution, and foreign attempts', async () => {
    const { isolated } = await createDatabase()
    const workspaceId = nextId('wsp')
    const owner = await createOwner(isolated.application, { workspaceId })
    const foreignWorkspaceOwner = await createOwner(isolated.application)
    const service = ledger(isolated.application)
    await service.openBudget({
      workspaceId,
      executionId: owner.execution.executionId,
      currency: 'USD',
      maximumMicrounits: 5_000,
      maximumTokens: 50,
      source: source('scope-owner-open'),
    })

    const store = new PostgresDurableUsageStore(isolated.application)
    await expect(
      store.transaction(foreignWorkspaceOwner.execution.correlation.workspaceId, (scope) =>
        scope.getBudget(owner.execution.executionId)
      )
    ).resolves.toBeUndefined()
    await expect(
      ledger(isolated.application).openBudget({
        workspaceId: foreignWorkspaceOwner.execution.correlation.workspaceId,
        executionId: owner.execution.executionId,
        currency: 'USD',
        maximumMicrounits: 5_000,
        maximumTokens: 50,
        source: source('scope-cross-workspace-open'),
      })
    ).rejects.toMatchObject({ code: 'USAGE_LEDGER_SCOPE_MISMATCH' })
    await expect(
      service.summary(workspaceId, foreignWorkspaceOwner.execution.executionId)
    ).rejects.toMatchObject({
      code: 'BUDGET_NOT_FOUND',
    })

    const firstParent = await createOwner(isolated.application, { workspaceId })
    const otherParent = await createOwner(isolated.application, { workspaceId })
    const child = await createOwner(isolated.application, {
      workspaceId,
      parentExecutionId: firstParent.execution.executionId,
    })
    for (const parent of [firstParent, otherParent]) {
      await service.openBudget({
        workspaceId,
        executionId: parent.execution.executionId,
        currency: 'USD',
        maximumMicrounits: 2_000,
        maximumTokens: 20,
        source: source(`scope-parent-${parent.execution.executionId}`),
      })
    }
    await expect(
      service.openBudget({
        workspaceId,
        executionId: child.execution.executionId,
        parentExecutionId: otherParent.execution.executionId,
        currency: 'USD',
        maximumMicrounits: 1_000,
        maximumTokens: 10,
        source: source('scope-wrong-parent'),
      })
    ).rejects.toThrow()
    await expect(service.summary(workspaceId, child.execution.executionId)).rejects.toMatchObject({
      code: 'BUDGET_NOT_FOUND',
    })
    await expect(
      service.summary(workspaceId, otherParent.execution.executionId)
    ).resolves.toMatchObject({
      reservedMicrounits: 0,
      reservedTokens: 0,
    })

    await expect(
      service.reserve({
        workspaceId,
        executionId: owner.execution.executionId,
        attemptId: foreignWorkspaceOwner.attempt.attemptId,
        reservationKey: 'foreign-attempt',
        maximumMicrounits: 100,
        maximumTokens: 1,
        source: source('scope-foreign-attempt'),
      })
    ).rejects.toMatchObject({ code: 'USAGE_LEDGER_SCOPE_MISMATCH' })
    await expect(service.entries(workspaceId, owner.execution.executionId)).resolves.toHaveLength(1)
  })

  test('fails closed on schema-valid indexed-payload and persisted attempt ownership corruption', async () => {
    const { isolated } = await createDatabase()
    const workspaceId = nextId('wsp')
    const service = ledger(isolated.application)
    const damagedBudgetOwner = await createOwner(isolated.application, { workspaceId })
    const budgetInput = {
      workspaceId,
      executionId: damagedBudgetOwner.execution.executionId,
      currency: 'USD',
      maximumMicrounits: 1_000,
      maximumTokens: 10,
      source: source('corruption-budget-open'),
    }
    await service.openBudget(budgetInput)
    const [storedBudget] = await isolated.application
      .select()
      .from(usageBudgetStates)
      .where(eq(usageBudgetStates.executionId, budgetInput.executionId))
    await isolated.application
      .update(usageBudgetStates)
      .set({
        state: {
          ...storedBudget.state,
          executionId: nextId('exe'),
        },
      })
      .where(eq(usageBudgetStates.executionId, budgetInput.executionId))
    await expect(service.summary(workspaceId, budgetInput.executionId)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })

    const damagedReceiptOwner = await createOwner(isolated.application, { workspaceId })
    const receiptInput = {
      workspaceId,
      executionId: damagedReceiptOwner.execution.executionId,
      currency: 'USD',
      maximumMicrounits: 1_000,
      maximumTokens: 10,
      source: source('corruption-receipt-open'),
    }
    await service.openBudget(receiptInput)
    const [storedReceipt] = await isolated.application
      .select()
      .from(usageOperationReceipts)
      .where(eq(usageOperationReceipts.idempotencyKey, receiptInput.source.idempotencyKey))
    await isolated.application
      .update(usageOperationReceipts)
      .set({
        receipt: {
          ...storedReceipt.receipt,
          fingerprint: `sha256:${'b'.repeat(64)}`,
        },
      })
      .where(
        and(
          eq(usageOperationReceipts.workspaceId, workspaceId),
          eq(usageOperationReceipts.idempotencyKey, receiptInput.source.idempotencyKey)
        )
      )
    await expect(service.openBudget(receiptInput)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })

    const attemptOwner = await createOwner(isolated.application, { workspaceId })
    const foreignAttemptOwner = await createOwner(isolated.application, { workspaceId })
    await service.openBudget({
      workspaceId,
      executionId: attemptOwner.execution.executionId,
      currency: 'USD',
      maximumMicrounits: 1_000,
      maximumTokens: 10,
      source: source('corruption-attempt-open'),
    })
    await service.reserve({
      workspaceId,
      executionId: attemptOwner.execution.executionId,
      reservationKey: 'unbound-reservation',
      maximumMicrounits: 1_000,
      maximumTokens: 10,
      source: source('corruption-attempt-reserve'),
    })
    await service.charge({
      workspaceId,
      executionId: attemptOwner.execution.executionId,
      attemptId: attemptOwner.attempt.attemptId,
      reservationKey: 'unbound-reservation',
      kind: 'model_usage',
      quantity: { unit: 'tokens', value: 1 },
      costMicrounits: 1,
      fundingSource: 'hq_managed',
      source: source('corruption-attempt-charge'),
    })
    await isolated.application
      .update(usageLedgerEntries)
      .set({ attemptId: foreignAttemptOwner.attempt.attemptId })
      .where(
        and(
          eq(usageLedgerEntries.executionId, attemptOwner.execution.executionId),
          eq(usageLedgerEntries.kind, 'model_usage')
        )
      )
    await expect(
      service.summary(workspaceId, attemptOwner.execution.executionId)
    ).rejects.toMatchObject({ code: 'STORE_STATE_INVALID' })
  })

  test('rejects raw immutable-entry deletion when the budget sequence high-water mark remains', async () => {
    const { isolated } = await createDatabase()
    const owner = await createOwner(isolated.application)
    const workspaceId = owner.execution.correlation.workspaceId
    const service = ledger(isolated.application)
    await service.openBudget({
      workspaceId,
      executionId: owner.execution.executionId,
      currency: 'USD',
      maximumMicrounits: 1_000,
      maximumTokens: 10,
      source: source('raw-delete-open'),
    })
    await isolated.application
      .delete(usageLedgerEntries)
      .where(
        and(
          eq(usageLedgerEntries.executionId, owner.execution.executionId),
          eq(usageLedgerEntries.sequence, 1)
        )
      )
    await expect(service.summary(workspaceId, owner.execution.executionId)).rejects.toMatchObject({
      code: 'STORE_STATE_INVALID',
    })
  })

  test('linearizes execution deletion and usage admission in both lock orders without deadlock', async () => {
    const { isolated } = await createDatabase()
    const database = isolated.application
    const firstOwner = await createOwner(database, { withAttempt: false })
    const lifecycle = new ExecutionLifecycleService(new PostgresExecutionRepository(database))
    const firstTerminal = await lifecycle.transitionExecution({
      executionId: firstOwner.execution.executionId,
      expectedVersion: firstOwner.execution.version,
      to: 'cancelled',
      transitionedAt: '2026-09-20T10:02:00.000Z',
    })
    const firstWorkspaceId = firstTerminal.correlation.workspaceId
    const firstStore = new PostgresDurableUsageStore(database)
    const writerEntered = deferred()
    const allowWriter = deferred()
    const gatedStore = {
      transaction(workspaceId, operation) {
        return firstStore.transaction(workspaceId, async (transaction) => {
          writerEntered.resolve()
          await allowWriter.promise
          return operation(transaction)
        })
      },
    }
    const blockedWriter = new DurableUsageLedger({ store: gatedStore }).openBudget({
      workspaceId: firstWorkspaceId,
      executionId: firstTerminal.executionId,
      currency: 'USD',
      maximumMicrounits: 500,
      maximumTokens: 5,
      source: source('retention-writer-first'),
    })
    const retention = new PostgresExecutionRepository(database)
    let waitingDelete
    let firstOutcomes
    try {
      await withinBound(writerEntered.promise, 'writer-has-retention-class-lock')
      waitingDelete = retention.deleteEligibleExecutions(new Date('2026-09-21T10:00:00.000Z'), {
        policyRetainMs: 0,
        bound: 8,
        dryRun: false,
      })
      await waitForAdvisoryLockWait(database)
    } finally {
      allowWriter.resolve()
      const started = [blockedWriter, ...(waitingDelete ? [waitingDelete] : [])]
      firstOutcomes = await withinBound(Promise.allSettled(started), 'writer-retention-drain')
    }
    const writerOutcome = firstOutcomes[0]
    const deleteOutcome = waitingDelete ? firstOutcomes[1] : undefined
    expect(writerOutcome.status).toBe('fulfilled')
    expect(deleteOutcome?.status).toBe('fulfilled')
    const writerFirstResult = writerOutcome.value
    expect(writerFirstResult.maximumMicrounits).toBe(500)
    const [firstStillOwned] = await database
      .select({ executionId: executions.executionId })
      .from(executions)
      .where(eq(executions.executionId, firstTerminal.executionId))
    expect(firstStillOwned).toBeDefined()

    const secondOwner = await createOwner(database, { withAttempt: false })
    const secondLifecycle = new ExecutionLifecycleService(new PostgresExecutionRepository(database))
    const secondTerminal = await secondLifecycle.transitionExecution({
      executionId: secondOwner.execution.executionId,
      expectedVersion: secondOwner.execution.version,
      to: 'cancelled',
      transitionedAt: '2026-09-20T10:03:00.000Z',
    })
    const journalEntered = deferred()
    const allowRetention = deferred()
    const deleting = retention.deleteEligibleExecutions(new Date('2026-09-21T10:00:00.000Z'), {
      policyRetainMs: 0,
      bound: 8,
      dryRun: false,
      journal: async () => {
        journalEntered.resolve()
        await allowRetention.promise
      },
    })
    let writerAfterDelete
    let secondOutcomes
    try {
      await withinBound(journalEntered.promise, 'retention-holds-owner-and-class-lock')
      writerAfterDelete = ledger(database)
        .openBudget({
          workspaceId: secondTerminal.correlation.workspaceId,
          executionId: secondTerminal.executionId,
          currency: 'USD',
          maximumMicrounits: 500,
          maximumTokens: 5,
          source: source('retention-delete-first'),
        })
        .then(
          (value) => ({ status: 'fulfilled', value }),
          (error) => ({ status: 'rejected', error })
        )
      await waitForAdvisoryLockWait(database)
    } finally {
      allowRetention.resolve()
      const started = [deleting, ...(writerAfterDelete ? [writerAfterDelete] : [])]
      secondOutcomes = await withinBound(Promise.allSettled(started), 'retention-writer-drain')
    }
    const deleteAfterWriterOutcome = secondOutcomes[0]
    expect(deleteAfterWriterOutcome.status).toBe('fulfilled')
    const deleteResult = deleteAfterWriterOutcome.value
    expect(deleteResult.deleted).toBe(1)
    expect(writerAfterDelete).toBeDefined()
    const writerAfterDeleteOutcome = secondOutcomes[1]
    expect(writerAfterDeleteOutcome.status).toBe('fulfilled')
    expect(writerAfterDeleteOutcome.value.status).toBe('rejected')
    expect(writerAfterDeleteOutcome.value.error).toMatchObject({
      code: 'USAGE_LEDGER_SCOPE_MISMATCH',
    })
    const [secondStillOwned] = await database
      .select({ executionId: executions.executionId })
      .from(executions)
      .where(eq(executions.executionId, secondTerminal.executionId))
    expect(secondStillOwned).toBeUndefined()
  })
})
