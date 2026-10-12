import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import postgres from 'postgres'
import { loadDatabaseCredentials } from '@control-plane/config'
import { verifyNeonMigratorDdl } from '../scripts/neon-ddl-probe.mjs'
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

describe.skipIf(!enabled)('Neon migrator DDL probe', () => {
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
                    throw new Error('SYNTHETIC_NEON_DDL_PROBE_FAILURE')
                  return transaction.unsafe(statement, values)
                },
              })
            ),
        }
        await expect(verifyNeonMigratorDdl(failingProbe)).rejects.toThrow(
          'SYNTHETIC_NEON_DDL_PROBE_FAILURE'
        )
        const [{ schema_after_rollback: schemaAfterRollback }] = await migration`
          select to_regnamespace('app') is not null as schema_after_rollback
        `
        expect(schemaAfterRollback).toBe(false)

        await verifyNeonMigratorDdl(migration)

        const [{ schema_exists: schemaAfter }] = await migration`
          select to_regnamespace('app') is not null as schema_exists
        `
        expect(schemaAfter).toBe(false)

        await migration.unsafe('create schema app')
        const applicationRole = new URL(credentials.application.url).username
        await migration`grant usage on schema app to ${migration(applicationRole)}`
        const table = `cp_neon_application_denied_${randomUUID().replaceAll('-', '')}`
        await assertDdlDenied(application, `create table app.${table} (id integer)`)
      } finally {
        const closeResults = await Promise.allSettled([
          application?.end({ timeout: 5 }),
          migration?.end({ timeout: 5 }),
        ])
        let disposeError
        try {
          await isolated.dispose()
        } catch (error) {
          disposeError = error
        }
        const closeErrors = closeResults.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        )
        if (disposeError) closeErrors.push(disposeError)
        if (closeErrors.length > 0)
          throw new AggregateError(closeErrors, 'NEON_DDL_PROBE_TEST_CLEANUP_FAILED')
      }
    },
    integrationTestTimeout(60_000)
  )
})
