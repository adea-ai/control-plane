import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { and, eq } from 'drizzle-orm'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresHostedGraphToolConfigurationRepository } from './hosted-graph-tool-configuration-repository.ts'
import { PostgresToolRateLimiter } from './tool-rate-limiter.ts'
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
      // The admitted event expires before the rejected attempt; the rejected call must not occupy a slot.
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

    // The denied call did not occupy a slot; once the admitted event is outside
    // this caller's window, the next unique receipt can be admitted.
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
