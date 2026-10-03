import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { and, eq, sql } from 'drizzle-orm'
import {
  PostgresCommandAcceptanceRepository,
  PostgresContextPackageRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresGraphToolCancellationRepository,
  PostgresInteractionRepository,
  PostgresToolCallRepository,
  PostgresToolRateLimiter,
  PostgresDurableUsageStore,
  toolRateLimitEvents,
} from '@control-plane/database'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  createHostedGraphToolAdmissionRateLimiter,
  createHostedGraphToolBinding,
  HostedGraphToolOperations,
} from './hosted-graph-tool-operations.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFG'
const toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFG'
const profileId = 'prf_01JABCDEF0123456789ABCDEFG'
const amount = 25

describe.skipIf(!enabled)('Hosted graph tool operation cancellation recovery', () => {
  let isolated

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    process.stderr.write(`[hosted-graph-tool-operations-db] isolated=${isolated.name}\n`)
    await isolated.migrate()
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    const failures = []
    for (const cleanup of [() => isolated?.dispose()]) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'HOSTED_GRAPH_TEST_CLEANUP_FAILED')
  })

  test(
    'a crash after durable call creation but before admission leaves no reservation to reconcile',
    async () => {
      const ids = await seedExecutionAndBudget()
      const calls = new PostgresToolCallRepository(isolated.application, workspaceId)
      const call = authorizedCall(ids)
      expect(await calls.insert(call)).toBe(true)

      // The durable call receipt exists, but admission never created its
      // reservation. This models the new transaction boundary after restart.
      const ledger = new DurableUsageLedger({
        store: new PostgresDurableUsageStore(isolated.application),
      })
      await expect(ledger.summary(workspaceId, ids.executionId)).resolves.toMatchObject({
        spentMicrounits: 0,
        reservedMicrounits: 0,
      })

      // Reconstruct operations after the simulated process crash.
      const reopened = createOperations()
      await expect(
        reopened.cancel(ids.executionId, `graph:${ids.executionId}`, 'cancel-after-restart')
      ).resolves.toBe(true)
      await expect(ledger.summary(workspaceId, ids.executionId)).resolves.toMatchObject({
        spentMicrounits: 0,
        reservedMicrounits: 0,
      })
      await expect(
        reopened.cancel(ids.executionId, `graph:${ids.executionId}`, 'cancel-after-restart')
      ).resolves.toBe(true)
      await expect(ledger.summary(workspaceId, ids.executionId)).resolves.toMatchObject({
        spentMicrounits: 0,
        reservedMicrounits: 0,
      })
      await expect(calls.get(call.toolCallId)).resolves.toMatchObject({
        status: 'denied',
        errorCode: 'GRAPH_TOOL_CANCELLED',
      })
    },
    integrationTestTimeout(30_000)
  )

  test(
    'a persisted cancellation rejects late admission without a quota slot or reservation',
    async () => {
      const ids = await seedExecutionAndBudget()
      const operationKey = graphOperationKey()
      const call = authorizedCall(ids, operationKey)
      const calls = new PostgresToolCallRepository(isolated.application, workspaceId)
      expect(await calls.insert(call)).toBe(true)

      await expect(
        createOperations().cancel(ids.executionId, `graph:${ids.executionId}`, 'cancel-first')
      ).resolves.toBe(true)

      const configuration = hostedGraphConfiguration()
      const configurationDigest = createHostedGraphToolBinding(configuration).configurationDigest
      const admission = createHostedGraphToolAdmissionRateLimiter({
        database: isolated.application,
        cancellations: new PostgresGraphToolCancellationRepository(isolated.application),
        rateLimiter: new PostgresToolRateLimiter(isolated.application),
        now: () => new Date().toISOString(),
        workspaceId,
        executionId: ids.executionId,
        attemptId: ids.attemptId,
        reservationKey: operationKey,
        maximumMicrounits: amount,
        reserveSource: {
          sourceId: `${call.toolCallId}:${configurationDigest}`,
          idempotencyKey: `${operationKey}:reserve`,
        },
        toolCallId: call.toolCallId,
      })
      const rateKey = `${workspaceId}:${call.principalRef}:${toolDefinitionId}:store-json`
      await expect(
        admission.consume(rateKey, 60, 60_000, call.requestedAt, call.toolCallId)
      ).rejects.toThrow('HOSTED_GRAPH_TOOL_CANCELLED')

      const events = await isolated.application
        .select()
        .from(toolRateLimitEvents)
        .where(
          and(
            eq(toolRateLimitEvents.workspaceId, workspaceId),
            eq(toolRateLimitEvents.toolCallId, call.toolCallId)
          )
        )
      expect(events).toHaveLength(0)
      const ledger = new DurableUsageLedger({
        store: new PostgresDurableUsageStore(isolated.application),
      })
      await expect(ledger.summary(workspaceId, ids.executionId)).resolves.toMatchObject({
        spentMicrounits: 0,
        reservedMicrounits: 0,
      })
    },
    integrationTestTimeout(30_000)
  )

  test(
    'cancellation after admission commit settles the durable reservation once after reopen',
    async () => {
      const ids = await seedExecutionAndBudget()
      const operationKey = graphOperationKey()
      const call = authorizedCall(ids, operationKey)
      const calls = new PostgresToolCallRepository(isolated.application, workspaceId)
      expect(await calls.insert(call)).toBe(true)
      const configuration = hostedGraphConfiguration()
      const configurationDigest = createHostedGraphToolBinding(configuration).configurationDigest
      const rateKey = `${workspaceId}:${call.principalRef}:${toolDefinitionId}:store-json`
      const admission = createHostedGraphToolAdmissionRateLimiter({
        database: isolated.application,
        cancellations: new PostgresGraphToolCancellationRepository(isolated.application),
        rateLimiter: new PostgresToolRateLimiter(isolated.application),
        now: () => new Date().toISOString(),
        workspaceId,
        executionId: ids.executionId,
        attemptId: ids.attemptId,
        reservationKey: operationKey,
        maximumMicrounits: amount,
        reserveSource: {
          sourceId: `${call.toolCallId}:${configurationDigest}`,
          idempotencyKey: `${operationKey}:reserve`,
        },
        toolCallId: call.toolCallId,
      })

      await expect(
        admission.consume(rateKey, 60, 60_000, call.requestedAt, call.toolCallId)
      ).resolves.toBe(true)
      const ledger = new DurableUsageLedger({
        store: new PostgresDurableUsageStore(isolated.application),
      })
      await expect(ledger.summary(workspaceId, ids.executionId)).resolves.toMatchObject({
        spentMicrounits: 0,
        reservedMicrounits: amount,
      })

      const reopened = createOperations()
      await expect(
        reopened.cancel(ids.executionId, `graph:${ids.executionId}`, 'cancel-after-admission')
      ).resolves.toBe(true)
      const settledEntries = (await ledger.entries(workspaceId, ids.executionId)).filter(
        (entry) => entry.kind === 'settlement' && entry.reservationKey === operationKey
      )
      expect(settledEntries).toHaveLength(1)
      await expect(ledger.summary(workspaceId, ids.executionId)).resolves.toMatchObject({
        spentMicrounits: 0,
        reservedMicrounits: 0,
      })
      await expect(
        reopened.cancel(ids.executionId, `graph:${ids.executionId}`, 'cancel-after-admission')
      ).resolves.toBe(true)
      await expect(
        ledger
          .entries(workspaceId, ids.executionId)
          .then((entries) =>
            entries.filter(
              (entry) => entry.kind === 'settlement' && entry.reservationKey === operationKey
            )
          )
      ).resolves.toHaveLength(1)
      const events = await isolated.application
        .select()
        .from(toolRateLimitEvents)
        .where(
          and(
            eq(toolRateLimitEvents.workspaceId, workspaceId),
            eq(toolRateLimitEvents.toolCallId, call.toolCallId)
          )
        )
      expect(events).toHaveLength(0)
    },
    integrationTestTimeout(30_000)
  )

  test(
    'admission and cancellation serialize across a PostgreSQL rate lock without leaving a slot',
    async () => {
      const ids = await seedExecutionAndBudget()
      const operationKey = graphOperationKey()
      const calls = new PostgresToolCallRepository(isolated.application, workspaceId)
      const call = authorizedCall(ids, operationKey)
      expect(await calls.insert(call)).toBe(true)

      const ledger = new DurableUsageLedger({
        store: new PostgresDurableUsageStore(isolated.application),
      })
      const rateKey = `${workspaceId}:${call.principalRef}:${toolDefinitionId}:store-json`
      const configuration = hostedGraphConfiguration()
      const configurationDigest = createHostedGraphToolBinding(configuration).configurationDigest
      let releaseLock
      let signalLocked
      const locked = new Promise((resolve) => {
        signalLocked = resolve
      })
      const waitToRelease = new Promise((resolve) => {
        releaseLock = resolve
      })
      const blocker = isolated.application.transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${rateKey}, 0))`
        )
        signalLocked()
        await waitToRelease
      })
      let blockerFinished = false
      try {
        await Promise.race([
          locked,
          blocker.then(() => {
            throw new Error('HOSTED_GRAPH_RATE_LOCK_BLOCKER_EXITED_EARLY')
          }),
        ])
        const admission = createHostedGraphToolAdmissionRateLimiter({
          database: isolated.application,
          cancellations: new PostgresGraphToolCancellationRepository(isolated.application),
          rateLimiter: new PostgresToolRateLimiter(isolated.application),
          now: () => new Date().toISOString(),
          workspaceId,
          executionId: ids.executionId,
          attemptId: ids.attemptId,
          reservationKey: operationKey,
          maximumMicrounits: amount,
          reserveSource: {
            sourceId: `${call.toolCallId}:${configurationDigest}`,
            idempotencyKey: `${operationKey}:reserve`,
          },
          toolCallId: call.toolCallId,
        }).consume(rateKey, 60, 60_000, new Date().toISOString(), call.toolCallId)
        await isolated.waitForBlockedTransaction()

        const cancellation = createOperations().cancel(
          ids.executionId,
          `graph:${ids.executionId}`,
          'cancel-during-admission'
        )
        await isolated.waitForBlockedTransaction()
        releaseLock()
        await blocker
        blockerFinished = true
        expect(await admission).toBe(true)
        expect(await cancellation).toBe(true)
      } finally {
        releaseLock?.()
        if (!blockerFinished) await blocker
      }

      const events = await isolated.application
        .select()
        .from(toolRateLimitEvents)
        .where(
          and(
            eq(toolRateLimitEvents.workspaceId, workspaceId),
            eq(toolRateLimitEvents.toolCallId, call.toolCallId)
          )
        )
      expect(events).toHaveLength(0)
      await expect(ledger.summary(workspaceId, ids.executionId)).resolves.toMatchObject({
        reservedMicrounits: 0,
      })
    },
    integrationTestTimeout(30_000)
  )

  async function seedExecutionAndBudget() {
    const executionId = uniqueIdentifier('exe')
    const attemptId = uniqueIdentifier('att')
    const plan = createExecutionPlanTestFixture()
    await new PostgresContextPackageRepository(isolated.application).put(
      contextPackageSerializationFixtures.futurePi
    )
    await new PostgresExecutionPlanRepository(isolated.application).put(plan)
    const lifecycle = new ExecutionLifecycleService(
      new PostgresExecutionRepository(isolated.application)
    )
    const execution = await lifecycle.createExecution({
      executionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt: new Date().toISOString(),
    })
    await lifecycle.createAttempt({
      executionId,
      attemptId,
      expectedExecutionVersion: execution.version,
      queuedAt: new Date(Date.parse(execution.acceptedAt) + 1_000).toISOString(),
    })
    const ledger = new DurableUsageLedger({
      store: new PostgresDurableUsageStore(isolated.application),
    })
    await ledger.openBudget({
      workspaceId,
      executionId,
      currency: 'USD',
      maximumMicrounits: 10_000,
      maximumTokens: 0,
      source: { sourceId: `budget:${executionId}`, idempotencyKey: `budget:${executionId}` },
    })
    return { executionId, attemptId }
  }

  function authorizedCall(ids, idempotencyKey = graphOperationKey()) {
    const now = new Date().toISOString()
    const toolCallId = uniqueIdentifier('tlc')
    return {
      toolCallId,
      requestDigest: `sha256:${'b'.repeat(64)}`,
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      workspaceId,
      profileId,
      principalRef: 'service:runtime-worker',
      toolDefinitionId,
      toolVersionId,
      operation: 'store-json',
      inputDigest: `sha256:${'c'.repeat(64)}`,
      policySnapshotRef: 'policy://workspace/v1',
      executor: { type: 'internal', reference: 'hosted.object-store-json.v1' },
      idempotencyKey,
      status: 'authorized',
      revision: 2,
      requestedAt: now,
      authorizedAt: now,
      history: [
        { status: 'requested', at: now },
        { status: 'authorized', at: now },
      ],
    }
  }

  function createOperations() {
    return new HostedGraphToolOperations({
      configuration: {
        ...hostedGraphConfiguration(),
      },
      database: isolated.application,
      objectStore: {},
      plans: new PostgresExecutionPlanRepository(isolated.application),
      executions: new PostgresExecutionRepository(isolated.application),
      commands: new PostgresCommandAcceptanceRepository(isolated.application),
      interactions: new PostgresInteractionRepository(isolated.application),
    })
  }
})

function graphOperationKey() {
  return `graph-op-v1:${randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64)}`
}

function hostedGraphConfiguration() {
  return {
    schemaVersion: 1,
    toolDefinitionId,
    toolVersionId,
    currency: 'USD',
    costMicrounits: amount,
    createdAt: '2026-10-03T00:00:00.000Z',
    publishedAt: '2026-10-03T00:00:00.000Z',
  }
}

function uniqueIdentifier(prefix) {
  const seed = randomUUID()
    .replaceAll('-', '')
    .toUpperCase()
    .replace(/[ILOU]/g, 'A')
  return `${prefix}_${seed.slice(0, 26)}`
}
