import { afterEach, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { eq } from 'drizzle-orm'
import { loadDatabaseCredentials } from '@control-plane/config'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresMessagingRetention } from './messaging-retention.ts'
import { inboxMessages, outboxEvents } from './schema/messaging.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const expiredAt = new Date('2026-09-24T12:00:00.000Z')
const retentionMs = 1_000

function wrapBuilder(builder, onRows) {
  return new Proxy(builder, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property === 'then') {
        return (resolve, reject) =>
          new Promise((complete, fail) => Reflect.apply(value, target, [complete, fail]))
            .then(async (rows) => {
              await onRows(rows)
              return resolve(rows)
            })
            .catch(reject)
      }
      if (typeof value !== 'function') return value
      return (...args) => {
        const result = Reflect.apply(value, target, args)
        return result !== null && typeof result === 'object' ? wrapBuilder(result, onRows) : result
      }
    },
  })
}

function deleteFirstOutboxAfterSelection(database) {
  let intercepted = false
  return new Proxy(database, {
    get(target, property) {
      if (property === 'select') {
        return (...args) => {
          const builder = target.select(...args)
          if (intercepted) return builder
          intercepted = true
          return wrapBuilder(builder, async (rows) => {
            const candidate = rows[0]
            if (candidate === undefined) return
            // A second, real application-role connection deletes the already
            // selected row before the production claim transaction starts.
            await database.delete(outboxEvents).where(eq(outboxEvents.id, candidate.id))
          })
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function countTransactionExecuteCalls(database, counter) {
  function wrapTransaction(transaction) {
    return new Proxy(transaction, {
      get(target, property) {
        if (property === 'execute') {
          return (...args) => {
            counter.calls += 1
            return target.execute(...args)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') {
        return (operation, ...args) =>
          target.transaction((transaction) => operation(wrapTransaction(transaction)), ...args)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

describe.skipIf(!enabled)('PostgreSQL retention claim budget', () => {
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

  test('a raced first outbox candidate consumes bound before inbox compaction', async () => {
    const isolated = await createDatabase()
    const database = isolated.application
    const oldTime = new Date('2024-01-01T00:00:00.000Z')
    const laterOldTime = new Date('2024-01-02T00:00:00.000Z')
    const [first] = await database
      .insert(outboxEvents)
      .values([
        {
          aggregateType: 'retention-budget-test',
          aggregateId: 'first',
          eventType: 'retention.test',
          payload: { sequence: 1 },
          status: 'published',
          publishedAt: oldTime,
        },
        {
          aggregateType: 'retention-budget-test',
          aggregateId: 'second',
          eventType: 'retention.test',
          payload: { sequence: 2 },
          status: 'published',
          publishedAt: laterOldTime,
        },
      ])
      .returning({ id: outboxEvents.id })
    await database.insert(inboxMessages).values({
      consumer: 'retention-budget-test',
      messageId: 'delivery-1',
      payload: { original: true },
      createdAt: oldTime,
    })

    const journal = []
    const racedDatabase = deleteFirstOutboxAfterSelection(database)
    const result = await new PostgresMessagingRetention(racedDatabase).sweepEligibleMessaging(
      expiredAt,
      {
        policyRetainMs: retentionMs,
        bound: 1,
        dryRun: false,
        journal: async (entries) => journal.push(...entries),
      }
    )
    expect(result).toMatchObject({
      scanned: 1,
      raced: 1,
      truncated: true,
      deleted: 0,
      compacted: 0,
    })
    expect(journal).toEqual([])
    expect(
      await database.select().from(outboxEvents).where(eq(outboxEvents.id, first.id))
    ).toHaveLength(0)
    expect(
      await database.select().from(outboxEvents).where(eq(outboxEvents.aggregateId, 'second'))
    ).toHaveLength(1)
    const [inbox] = await database
      .select()
      .from(inboxMessages)
      .where(eq(inboxMessages.messageId, 'delivery-1'))
    expect(inbox).toMatchObject({ payload: { original: true }, deletedAt: null, revision: 1n })
  }, 30_000)

  test('zero bound admits no candidate claim or class-mutex query', async () => {
    const isolated = await createDatabase()
    const database = isolated.application
    await database.insert(outboxEvents).values({
      aggregateType: 'retention-budget-test',
      aggregateId: 'zero-bound',
      eventType: 'retention.test',
      payload: { untouched: true },
      status: 'published',
      publishedAt: new Date('2024-01-01T00:00:00.000Z'),
    })
    await database.insert(inboxMessages).values({
      consumer: 'retention-budget-test',
      messageId: 'zero-bound-delivery',
      payload: { original: true },
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    })
    const counter = { calls: 0 }
    const countedDatabase = countTransactionExecuteCalls(database, counter)
    const result = await new PostgresMessagingRetention(countedDatabase).sweepEligibleMessaging(
      expiredAt,
      { policyRetainMs: retentionMs, bound: 0, dryRun: false }
    )
    expect(result).toMatchObject({
      scanned: 0,
      truncated: true,
      raced: 0,
      deleted: 0,
      compacted: 0,
    })
    expect(counter.calls).toBe(0)
    const [outbox] = await database
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, 'zero-bound'))
    const [inbox] = await database
      .select()
      .from(inboxMessages)
      .where(eq(inboxMessages.messageId, 'zero-bound-delivery'))
    expect(outbox).toMatchObject({ status: 'published', payload: { untouched: true } })
    expect(inbox).toMatchObject({ payload: { original: true }, deletedAt: null, revision: 1n })
  }, 30_000)
})
