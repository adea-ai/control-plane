import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { loadDatabaseCredentials } from '@control-plane/config'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  disposeMemoryRootProcessLoss,
  exerciseMemoryRootProcessLoss,
  memoryProcessLossDeadlines,
} from './fixtures/memory-root-process-loss.mjs'

test('process fixture reserves recovery time within a capped PostgreSQL budget', () => {
  const original = process.env.INTEGRATION_TEST_TIMEOUT_MS
  try {
    delete process.env.INTEGRATION_TEST_TIMEOUT_MS
    expect(memoryProcessLossDeadlines('cloud')).toEqual({ readyMs: 20_000, childMs: 25_000 })
    process.env.INTEGRATION_TEST_TIMEOUT_MS = '120000'
    for (const profile of ['cloud', 'hosted-server'])
      expect(memoryProcessLossDeadlines(profile)).toEqual({ readyMs: 80_000, childMs: 100_000 })
    for (const profile of ['local', 'hosted-simple'])
      expect(memoryProcessLossDeadlines(profile)).toEqual({ readyMs: 8_000, childMs: 10_000 })
    process.env.INTEGRATION_TEST_TIMEOUT_MS = '900000'
    expect(memoryProcessLossDeadlines('cloud')).toEqual({ readyMs: 80_000, childMs: 100_000 })
  } finally {
    if (original === undefined) delete process.env.INTEGRATION_TEST_TIMEOUT_MS
    else process.env.INTEGRATION_TEST_TIMEOUT_MS = original
  }
})

for (const failure of ['persistence', 'connection']) {
  test(`memory process fixture removes its directory when ${failure} close fails`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cp-m11-memory-loss-'))
    const closed = []
    const close = (storage) => () => {
      closed.push(storage)
      if (storage === failure) throw new Error('synthetic storage close failure')
    }
    try {
      await expect(
        disposeMemoryRootProcessLoss({
          directory,
          profile: 'cleanup-regression',
          root: {
            persistence: { close: close('persistence') },
            connection: { close: close('connection') },
          },
        })
      ).rejects.toThrow('synthetic storage close failure')
      expect(existsSync(directory)).toBe(false)
      expect(closed).toEqual(['persistence', 'connection'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}

for (const profile of ['local', 'hosted-simple']) {
  test(`${profile} recovers a memory effect after SIGKILL with durable committing intent`, async () => {
    expect(await exerciseMemoryRootProcessLoss(profile)).toEqual({
      profile,
      signal: 'SIGKILL',
      persistedState: 'committing',
      recoveredState: 'committed',
      writeCalls: 1,
      statusCalls: 1,
      records: 1,
      operations: ['status'],
      fixtureRemoved: true,
      childReaped: true,
    })
  }, 12_000)
}

for (const profile of ['cloud', 'hosted-server']) {
  describe.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
    `${profile} memory process recovery`,
    () => {
      let database
      beforeAll(async () => {
        database = await createIsolatedTestDatabase({
          administration: loadDatabaseCredentials(process.env, 'administration'),
          application: loadDatabaseCredentials(process.env, 'application'),
          migration: loadDatabaseCredentials(process.env, 'migration'),
        })
        await database.migrate()
      }, integrationTestTimeout())
      afterAll(async () => {
        await database?.dispose()
      }, integrationTestTimeout())
      test(
        `${profile} recovers a memory effect after SIGKILL with durable committing intent`,
        async () => {
          const url = new URL(process.env.DATABASE_URL)
          url.pathname = `/${database.name}`
          expect(await exerciseMemoryRootProcessLoss(profile, url.toString())).toEqual({
            profile,
            signal: 'SIGKILL',
            persistedState: 'committing',
            recoveredState: 'committed',
            writeCalls: 1,
            statusCalls: 1,
            records: 1,
            operations: ['status'],
            fixtureRemoved: true,
            childReaped: true,
          })
        },
        integrationTestTimeout()
      )
    }
  )
}
