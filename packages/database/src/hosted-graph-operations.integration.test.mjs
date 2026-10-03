import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresHostedGraphToolConfigurationRepository } from './hosted-graph-tool-configuration-repository.ts'
import { PostgresGraphToolCancellationRepository } from './graph-tool-cancellation-repository.ts'
import { PostgresToolCallRepository } from './tool-repositories.ts'
import { PostgresToolRateLimiter } from './tool-rate-limiter.ts'
import * as schema from './schema/index.ts'
import { executions } from './schema/executions.ts'
import { hostedGraphToolConfigurations } from './schema/hosted-graph-tool-configurations.ts'
import { toolRateLimitEvents } from './schema/tool-rate-limit-events.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const toolDefinitionId = 'tld_01JABCDEF0123456789ABCDEFG'
const toolVersionId = 'tlv_01JABCDEF0123456789ABCDEFG'
const at = '2026-10-03T09:00:00.000Z'

describe.skipIf(!enabled)('PostgreSQL Hosted graph operations', () => {
  let isolated

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    process.stderr.write(`[hosted-graph-db] isolated=${isolated.name}\n`)
    await isolated.migrate()
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    await isolated?.dispose()
  })

  test(
    'serializes rate-window admission, ignores denied attempts, and preserves receipt identity',
    async () => {
      const limiter = new PostgresToolRateLimiter(isolated.application)
      const key = `${workspaceId}:service:runtime-worker:${toolDefinitionId}:store-json`
      expect(await limiter.consume(key, 1, 60_000, at, 'tlc_01JABCDEF0123456789ABCDEFG')).toBe(true)
      expect(await limiter.consume(key, 1, 60_000, at, 'tlc_01JABCDEF0123456789ABCDEFG')).toBe(true)
      expect(
        await limiter.consume(
          key,
          1,
          60_000,
          '2026-10-03T09:00:00.010Z',
          'tlc_01JABCDEF0123456789ABCDEFA'
        )
      ).toBe(false)
      // Age the admitted event using PostgreSQL state, rather than trusting a
      // caller-supplied timestamp to simulate window passage.
      await isolated.application
        .update(toolRateLimitEvents)
        .set({ consumedAt: new Date(Date.now() - 120_000) })
        .where(
          and(
            eq(toolRateLimitEvents.workspaceId, workspaceId),
            eq(toolRateLimitEvents.toolCallId, 'tlc_01JABCDEF0123456789ABCDEFG')
          )
        )
      expect(
        await limiter.consume(
          key,
          1,
          60_000,
          '2026-10-03T09:01:00.010Z',
          'tlc_01JABCDEF0123456789ABCDEFH'
        )
      ).toBe(true)

      const events = await isolated.application
        .select()
        .from(toolRateLimitEvents)
        .where(
          and(
            eq(toolRateLimitEvents.workspaceId, workspaceId),
            eq(toolRateLimitEvents.principalRef, 'service:runtime-worker'),
            eq(toolRateLimitEvents.toolDefinitionId, toolDefinitionId),
            eq(toolRateLimitEvents.operation, 'store-json')
          )
        )
      expect(events.map(({ toolCallId }) => toolCallId)).toEqual(['tlc_01JABCDEF0123456789ABCDEFH'])
    },
    integrationTestTimeout(30_000)
  )

  test('admits exactly one concurrent call at limit one', async () => {
    const limiter = new PostgresToolRateLimiter(isolated.application)
    const key = `${workspaceId}:service:parallel-worker:${toolDefinitionId}:store-json`
    const results = await Promise.all([
      limiter.consume(key, 1, 60_000, at, 'tlc_01JABCDEF0123456789ABCDEFA'),
      limiter.consume(key, 1, 60_000, at, 'tlc_01JABCDEF0123456789ABCDEFB'),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    const events = await isolated.application
      .select()
      .from(toolRateLimitEvents)
      .where(
        and(
          eq(toolRateLimitEvents.workspaceId, workspaceId),
          eq(toolRateLimitEvents.principalRef, 'service:parallel-worker'),
          eq(toolRateLimitEvents.toolDefinitionId, toolDefinitionId),
          eq(toolRateLimitEvents.operation, 'store-json')
        )
      )
    expect(events).toHaveLength(1)
  })

  test('counts future-dated admissions conservatively when caller clocks are skewed', async () => {
    const limiter = new PostgresToolRateLimiter(isolated.application)
    const key = `${workspaceId}:service:clock-skew-worker:${toolDefinitionId}:store-json`
    const futureAt = '2026-10-03T09:00:00.001Z'
    expect(await limiter.consume(key, 1, 60_000, futureAt, 'tlc_01JABCDEF0123456789ABCDEFC')).toBe(
      true
    )
    expect(await limiter.consume(key, 1, 60_000, at, 'tlc_01JABCDEF0123456789ABCDEFD')).toBe(false)

    const events = await isolated.application
      .select()
      .from(toolRateLimitEvents)
      .where(
        and(
          eq(toolRateLimitEvents.workspaceId, workspaceId),
          eq(toolRateLimitEvents.principalRef, 'service:clock-skew-worker'),
          eq(toolRateLimitEvents.toolDefinitionId, toolDefinitionId),
          eq(toolRateLimitEvents.operation, 'store-json')
        )
      )
    expect(events.map(({ toolCallId }) => toolCallId)).toEqual(['tlc_01JABCDEF0123456789ABCDEFC'])

    // The denied call did not occupy a slot; age the admitted receipt to model
    // window expiry without relying on application clock values.
    await isolated.application
      .update(toolRateLimitEvents)
      .set({ consumedAt: new Date(Date.now() - 120_000) })
      .where(
        and(
          eq(toolRateLimitEvents.workspaceId, workspaceId),
          eq(toolRateLimitEvents.toolCallId, 'tlc_01JABCDEF0123456789ABCDEFC')
        )
      )
    expect(
      await limiter.consume(
        key,
        1,
        60_000,
        '2026-10-03T09:01:00.002Z',
        'tlc_01JABCDEF0123456789ABCDEFE'
      )
    ).toBe(true)
  })

  test('does not expire a recent slot from a caller clock more than one window ahead', async () => {
    const limiter = new PostgresToolRateLimiter(isolated.application)
    const key = `${workspaceId}:service:clock-ahead-worker:${toolDefinitionId}:store-json`
    const admittedAt = new Date(Date.now() - 1_000).toISOString()
    const skewedAt = new Date(Date.parse(admittedAt) + 61_000).toISOString()

    expect(
      await limiter.consume(key, 1, 60_000, admittedAt, 'tlc_01JABCDEF0123456789ABCDEFM')
    ).toBe(true)
    expect(await limiter.consume(key, 1, 60_000, skewedAt, 'tlc_01JABCDEF0123456789ABCDEFN')).toBe(
      false
    )
  })

  test('uses database admission time after a delayed approval with an old request timestamp', async () => {
    const limiter = new PostgresToolRateLimiter(isolated.application)
    const key = `${workspaceId}:service:delayed-approval-worker:${toolDefinitionId}:store-json`
    const originalRequestAt = '2020-01-01T00:00:00.000Z'

    expect(
      await limiter.consume(key, 1, 60_000, originalRequestAt, 'tlc_01JABCDEF0123456789ABCDEFP')
    ).toBe(true)
    expect(
      await limiter.consume(
        key,
        1,
        60_000,
        new Date().toISOString(),
        'tlc_01JABCDEF0123456789ABCDEFR'
      )
    ).toBe(false)
  })

  test('fences a late replica tool-call insert against a persisted cancellation marker', async () => {
    const executionId = 'exe_01JABCDEF0123456789ABCDEFA'
    const now = new Date()
    await isolated.application.insert(executions).values({
      executionId,
      state: 'accepted',
      version: 1,
      workspaceId,
      projectId: 'prj_01JABCDEF0123456789ABCDEFG',
      taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
      agentId: 'agt_01JABCDEF0123456789ABCDEFG',
      requestId: 'req_01JABCDEF0123456789ABCDEFG',
      executionPlanId: 'epl_01JABCDEF0123456789ABCDEFG',
      executionPlanDigest: `sha256:${'a'.repeat(64)}`,
      executionPlanSchemaVersion: 1,
      attemptCount: 0,
      acceptedAt: now,
      createdAt: now,
      updatedAt: now,
    })

    const applicationCredentials = loadDatabaseCredentials(process.env, 'application')
    const secondDatabaseUrl = new URL(applicationCredentials.url)
    secondDatabaseUrl.pathname = `/${isolated.name}`
    const secondClient = postgres(secondDatabaseUrl.toString(), { max: 2, prepare: false })
    const secondDatabase = drizzle(secondClient, { schema })
    try {
      const invokingReplica = new PostgresGraphToolCancellationRepository(isolated.application)
      const cancellingReplica = new PostgresGraphToolCancellationRepository(secondDatabase)
      // Replica A observed no cancellation before yielding to budget preparation.
      expect(await invokingReplica.get(executionId, workspaceId)).toBeUndefined()
      await cancellingReplica.record({
        workspaceId,
        executionId,
        threadId: `graph:${executionId}`,
        idempotencyKey: 'graph-cancel-race-0001',
      })

      // The cancellation replica sees no call, while A has not crossed the
      // durable call-admission boundary yet. Its subsequent insert must be fenced.
      const callsOnCancellingReplica = new PostgresToolCallRepository(secondDatabase, workspaceId)
      expect(await callsOnCancellingReplica.listByExecution(executionId)).toEqual([])
      const callsOnInvokingReplica = new PostgresToolCallRepository(
        isolated.application,
        workspaceId,
        {
          admissionFence: (transaction, call) =>
            invokingReplica.assertNotCancelledInTransaction(
              transaction,
              call.executionId,
              call.workspaceId
            ),
        }
      )
      await expect(
        callsOnInvokingReplica.insert({
          toolCallId: 'tlc_01JABCDEF0123456789ABCDEFM',
          requestDigest: `sha256:${'b'.repeat(64)}`,
          executionId,
          attemptId: 'att_01JABCDEF0123456789ABCDEFG',
          workspaceId,
          profileId: 'prf_01JABCDEF0123456789ABCDEFG',
          principalRef: 'service:runtime-worker',
          toolDefinitionId,
          toolVersionId,
          operation: 'store-json',
          inputDigest: `sha256:${'c'.repeat(64)}`,
          policySnapshotRef: 'policy://workspace/v7',
          executor: { type: 'connector', reference: 'records-v1' },
          idempotencyKey: `graph-op-v1:${'d'.repeat(64)}`,
          status: 'requested',
          revision: 1,
          requestedAt: now.toISOString(),
          history: [{ status: 'requested', at: now.toISOString() }],
        })
      ).rejects.toThrow('HOSTED_GRAPH_TOOL_CANCELLED')
      expect(await callsOnCancellingReplica.listByExecution(executionId)).toEqual([])
    } finally {
      await secondClient.end({ timeout: 5 })
    }
  })

  test('serializes concurrent calls with unequal caller timestamps', async () => {
    let releaseFirstLock
    let firstLockAcquired
    let secondLockWaiting
    const firstLock = new Promise((resolve) => {
      firstLockAcquired = resolve
    })
    const secondLock = new Promise((resolve) => {
      secondLockWaiting = resolve
    })
    const release = new Promise((resolve) => {
      releaseFirstLock = resolve
    })
    let firstExecute = true
    const database = {
      transaction: (callback) =>
        isolated.application.transaction((transaction) =>
          callback(
            new Proxy(transaction, {
              get(target, property) {
                if (property === 'execute') {
                  return async (...args) => {
                    if (firstExecute) {
                      firstExecute = false
                      const result = await target.execute(...args)
                      firstLockAcquired()
                      await release
                      return result
                    }
                    secondLockWaiting()
                    return target.execute(...args)
                  }
                }
                const value = Reflect.get(target, property, target)
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          )
        ),
    }
    const limiter = new PostgresToolRateLimiter(database)
    const key = `${workspaceId}:service:parallel-clock-worker:${toolDefinitionId}:store-json`
    const future = limiter.consume(
      key,
      1,
      60_000,
      '2026-10-03T09:00:00.001Z',
      'tlc_01JABCDEF0123456789ABCDEFF'
    )
    await firstLock
    const earlier = limiter.consume(key, 1, 60_000, at, 'tlc_01JABCDEF0123456789ABCDEFJ')
    try {
      await secondLock
    } finally {
      releaseFirstLock()
    }
    const results = await Promise.all([future, earlier])
    expect(results.filter(Boolean)).toHaveLength(1)
    const events = await isolated.application
      .select()
      .from(toolRateLimitEvents)
      .where(
        and(
          eq(toolRateLimitEvents.workspaceId, workspaceId),
          eq(toolRateLimitEvents.principalRef, 'service:parallel-clock-worker'),
          eq(toolRateLimitEvents.toolDefinitionId, toolDefinitionId),
          eq(toolRateLimitEvents.operation, 'store-json')
        )
      )
    expect(events).toHaveLength(1)
  })

  test('pins operator tariff and immutable tool identity across restarts', async () => {
    const repository = new PostgresHostedGraphToolConfigurationRepository(isolated.application)
    const configuration = {
      schemaVersion: 1,
      toolDefinitionId,
      toolVersionId,
      contentDigest: `sha256:${'a'.repeat(64)}`,
      operation: 'store-json',
      currency: 'USD',
      costMicrounits: 25,
      configurationDigest: 'b'.repeat(64),
    }
    await repository.pin(configuration)
    await repository.pin(configuration)
    await expect(
      repository.pin({ ...configuration, costMicrounits: 26, configurationDigest: 'c'.repeat(64) })
    ).rejects.toThrow('HOSTED_GRAPH_TOOL_CONFIGURATION_CHANGED')

    const [persisted] = await isolated.application
      .select()
      .from(hostedGraphToolConfigurations)
      .where(eq(hostedGraphToolConfigurations.toolVersionId, toolVersionId))
    expect(persisted).toMatchObject({
      costMicrounits: 25,
      currency: 'USD',
      configurationDigest: 'b'.repeat(64),
    })
    await expect(
      (async () =>
        await isolated.application
          .update(hostedGraphToolConfigurations)
          .set({ costMicrounits: 26 })
          .where(eq(hostedGraphToolConfigurations.toolVersionId, toolVersionId)))()
    ).rejects.toThrow()
    await expect(
      (async () =>
        await isolated.application
          .delete(hostedGraphToolConfigurations)
          .where(eq(hostedGraphToolConfigurations.toolVersionId, toolVersionId)))()
    ).rejects.toThrow()
    const [stillPinned] = await isolated.application
      .select()
      .from(hostedGraphToolConfigurations)
      .where(eq(hostedGraphToolConfigurations.toolVersionId, toolVersionId))
    expect(stillPinned).toMatchObject({ costMicrounits: 25, configurationDigest: 'b'.repeat(64) })
  })
})
