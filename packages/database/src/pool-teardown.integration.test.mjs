// Real-driver pool teardown proof.
//
// The unit lane proves the teardown's contract with a stand-in. This lane
// proves it against the real driver and a real disposable database: a pool that
// drains is released, and a pool that is terminated because a query is still
// pending rejects that query and still resolves its end promise.
//
// It creates its own isolated database from the disposable instance the
// integration lane provides, and it never contacts a hosted database.

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
      try {
        // The handler is attached before the teardown, so the rejection is
        // observed rather than left to surface on its own.
        const pending = client`select pg_sleep(30)`.then(
          () => 'resolved',
          (error) => error
        )
        await new Promise((resolve) => setTimeout(resolve, 250))

        const outcome = await teardownPostgresPool(client, { timeoutSeconds: 1 })
        // The driver terminates the connection and resolves its end promise.
        expect(outcome.released).toBe(true)

        const rejection = await pending
        expect(rejection).not.toBe('resolved')
        expect(rejection).toBeInstanceOf(Error)
      } finally {
        await client.end({ timeout: 1 }).catch(() => undefined)
        await database.dispose()
      }
    },
    integrationTestTimeout()
  )
})
