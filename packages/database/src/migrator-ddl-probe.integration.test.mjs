import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import postgres from 'postgres'
import { loadDatabaseCredentials } from '@control-plane/config'
import { verifyMigratorDdl } from '../scripts/migrator-ddl-probe.mjs'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'

async function assertDdlDenied(client, statement) {
  const unexpectedSuccess = new Error('APPLICATION_ROLE_DDL_ALLOWED')
  try {
    await client.begin(async (transaction) => {
      await transaction.unsafe(statement)
      throw unexpectedSuccess
    })
  } catch (error) {
    if (error === unexpectedSuccess) throw error
    if (error?.code === '42501') return
    throw error
  }
  throw new Error('APPLICATION_DDL_PROBE_INVALID')
}

describe.skipIf(!enabled)('PostgreSQL migrator DDL probe', () => {
  test(
    'creates and removes an absent app schema with the migrator while application DDL stays denied',
    async () => {
      const credentials = {
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      }
      const isolated = await createIsolatedTestDatabase(credentials)
      const applicationUrl = new URL(credentials.application.url)
      applicationUrl.pathname = `/${isolated.name}`
      const migrationUrl = new URL(credentials.migration.url)
      migrationUrl.pathname = `/${isolated.name}`
      let application
      let migration
      let testFailed = false
      let testError

      try {
        application = postgres(applicationUrl.href, { max: 1, prepare: false })
        migration = postgres(migrationUrl.href, { max: 1, prepare: false })
        const [{ schema_exists: schemaBefore }] = await migration`
          select to_regnamespace('app') is not null as schema_exists
        `
        expect(schemaBefore).toBe(false)

        await assertDdlDenied(application, 'create schema app')
        const failingProbe = {
          begin: (operation) =>
            migration.begin((transaction) =>
              operation({
                unsafe: async (statement, values) => {
                  if (statement.startsWith('INSERT INTO app.'))
                    throw new Error('SYNTHETIC_POSTGRES_DDL_PROBE_FAILURE')
                  return transaction.unsafe(statement, values)
                },
              })
            ),
        }
        await expect(verifyMigratorDdl(failingProbe)).rejects.toThrow(
          'SYNTHETIC_POSTGRES_DDL_PROBE_FAILURE'
        )
        const [{ schema_after_rollback: schemaAfterRollback }] = await migration`
          select to_regnamespace('app') is not null as schema_after_rollback
        `
        expect(schemaAfterRollback).toBe(false)

        await verifyMigratorDdl(migration)

        const [{ schema_exists: schemaAfter }] = await migration`
          select to_regnamespace('app') is not null as schema_exists
        `
        expect(schemaAfter).toBe(false)

        await migration.unsafe('create schema app')
        const applicationRole = new URL(credentials.application.url).username
        await migration`grant usage on schema app to ${migration(applicationRole)}`
        const table = `cp_neon_application_denied_${randomUUID().replaceAll('-', '')}`
        await assertDdlDenied(application, `create table app.${table} (id integer)`)
      } catch (error) {
        testFailed = true
        testError = error
      }

      const closeResults = await Promise.allSettled([
        Promise.resolve().then(() => application?.end({ timeout: 5 })),
        Promise.resolve().then(() => migration?.end({ timeout: 5 })),
      ])
      const cleanupErrors = closeResults.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      )
      try {
        await isolated.dispose()
      } catch (error) {
        cleanupErrors.push(error)
      }

      if (testFailed && cleanupErrors.length > 0)
        throw new AggregateError(
          [testError, ...cleanupErrors],
          'NEON_DDL_PROBE_TEST_AND_CLEANUP_FAILED',
          { cause: testError }
        )
      if (testFailed) throw testError
      if (cleanupErrors.length > 0)
        throw new AggregateError(cleanupErrors, 'NEON_DDL_PROBE_TEST_CLEANUP_FAILED')
    },
    integrationTestTimeout(60_000)
  )
})
