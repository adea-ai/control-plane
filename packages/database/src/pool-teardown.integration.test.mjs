// Real-driver pool teardown proof.
//
// The unit lane proves the teardown's contract with a stand-in. This lane
// proves it against the real driver and a real disposable database: a pool that
// drains is released, and a pool that is terminated because a query is still
// pending rejects that query and still resolves its end promise.
//
// It creates its own isolated database on the disposable instance the
// integration lane provides: the runner-owned local fixture, or an approved
// remote disposable target. It reads no operator database, and the credentials
// and the access rules of the lane are unchanged.

import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import postgres from 'postgres'
import { loadDatabaseCredentials } from '@control-plane/config'

import { teardownPostgresPool } from './connection.ts'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'

/**
 * An isolated database and a driver client on it, so the test owns the pool it
 * tears down.
 */
async function isolatedPool() {
  const database = await createIsolatedTestDatabase({
    administration: loadDatabaseCredentials(process.env, 'administration'),
    application: loadDatabaseCredentials(process.env, 'application'),
    migration: loadDatabaseCredentials(process.env, 'migration'),
  })
  const url = new URL(loadDatabaseCredentials(process.env, 'application').url)
  url.pathname = `/${database.name}`
  const client = postgres(url.toString(), { max: 1, prepare: false })
  return { client, database }
}

/**
 * Waits until the named query is running in the isolated database, so the
 * termination proof is about a query the server is executing rather than about
 * a request that never reached it.
 */
async function waitForRunningQuery(administration, databaseName, fragment) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await administration`
      select pid
      from pg_stat_activity
      where datname = ${databaseName}
        and state = 'active'
        and query like ${`%${fragment}%`}
    `
    if (rows.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`the query containing ${fragment} never started running`)
}

const integrationEnabled = process.env.RUN_DATABASE_INTEGRATION === 'true'

describe.skipIf(!integrationEnabled)('the pool teardown against the real driver', () => {
  test(
    'a pool that drains is released and its end promise resolves',
    async () => {
      const { client, database } = await isolatedPool()
      try {
        const rows = await client`select 1 as ok`
        expect(rows[0].ok).toBe(1)

        const outcome = await teardownPostgresPool(client, { timeoutSeconds: 5 })
        expect(outcome.released).toBe(true)
        expect(outcome.reason).toBeUndefined()
      } finally {
        await client.end({ timeout: 1 }).catch(() => undefined)
        await database.dispose()
      }
    },
    integrationTestTimeout()
  )

  test(
    'a terminated pool rejects its pending query and still resolves its end promise',
    async () => {
      const { client, database } = await isolatedPool()
      const administration = postgres(loadDatabaseCredentials(process.env, 'administration').url, {
        max: 1,
        prepare: false,
      })
      try {
        // The handler is attached before the teardown, so the rejection is
        // observed rather than left to surface on its own.
        const pending = client`select pg_sleep(30)`.then(
          () => ({ rejected: false, error: undefined }),
          (error) => ({ rejected: true, error })
        )
        // The barrier: the query is running on the server before the teardown
        // is asked to terminate the pool.
        await waitForRunningQuery(administration, database.name, 'pg_sleep')

        const outcome = await teardownPostgresPool(client, { timeoutSeconds: 1 })
        // The driver terminates the connection and resolves its end promise.
        expect(outcome.released).toBe(true)

        const rejection = await pending
        // The query is rejected because the connection was terminated, not
        // because of an arbitrary failure.
        expect(rejection.rejected).toBe(true)
        expect(rejection.error).toBeInstanceOf(Error)
        expect(rejection.error.code).toBe('CONNECTION_DESTROYED')
      } finally {
        await client.end({ timeout: 1 }).catch(() => undefined)
        await administration.end({ timeout: 1 }).catch(() => undefined)
        await database.dispose()
      }
    },
    integrationTestTimeout()
  )
})
