import type { DatabaseCredentials } from '@control-plane/config'
import { drizzle } from 'drizzle-orm/postgres-js'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { assertPostgresUrl, type ControlPlaneDatabase } from './connection.js'
import { migrateDatabase } from './migration.js'
import {
  completeIsolatedDatabaseSetup,
  createIsolatedDatabaseDisposer,
  ownedClientBackendTerminationStatement,
} from './isolated-database-cleanup.js'
import * as schema from './schema/index.js'
import { withDomainTransaction, type DomainTransaction } from './transaction.js'

export interface IsolatedDatabaseCredentials {
  readonly administration: DatabaseCredentials<'administration'>
  readonly application: DatabaseCredentials<'application'>
  readonly migration: DatabaseCredentials<'migration'>
}

export interface IsolatedTestDatabase {
  readonly application: ControlPlaneDatabase
  readonly name: string
  assertApplicationCannotCreateOrAlter(): Promise<void>
  dispose(): Promise<void>
  migrate(): Promise<void>
  waitForBlockedTransaction(): Promise<void>
  withMigrationDatabase<Result>(
    operation: (database: ControlPlaneDatabase) => Promise<Result>
  ): Promise<Result>
  transaction<Result>(
    operation: (transaction: DomainTransaction) => Promise<Result>
  ): Promise<Result>
}

export class TestDatabaseError extends Error {
  readonly diagnostic: Readonly<Record<string, unknown>>

  constructor(code: string) {
    super('Isolated test database operation failed')
    this.name = 'TestDatabaseError'
    this.diagnostic = { code }
  }
}

export async function createIsolatedTestDatabase(
  credentials: IsolatedDatabaseCredentials
): Promise<IsolatedTestDatabase> {
  assertCredentials(credentials)
  const name = `control_plane_test_${randomUUID().replaceAll('-', '')}`
  const migrationUrl = replaceDatabaseName(credentials.migration.url, name)
  const applicationUrl = replaceDatabaseName(credentials.application.url, name)
  const administration = postgres(credentials.administration.url, { max: 1, prepare: false })
  const migrationRole = new URL(credentials.migration.url).username
  const applicationRole = new URL(credentials.application.url).username
  let applicationClient: ReturnType<typeof postgres> | undefined
  const dispose = createIsolatedDatabaseDisposer({
    closeApplication: async () => {
      await applicationClient?.end({ timeout: 5 })
    },
    terminateSessions: async () => {
      const statement = ownedClientBackendTerminationStatement(name)
      await administration.unsafe(statement.text, [...statement.parameters])
    },
    dropDatabase: async () => {
      // The generated name is owned even when CREATE's acknowledgement is
      // ambiguous. Never sweep names or touch an operator database here.
      await administration`drop database if exists ${administration(name)}`
    },
    closeAdministration: async () => administration.end({ timeout: 5 }),
  })
  return completeIsolatedDatabaseSetup(async () => {
    await administration`create database ${administration(name)} owner ${administration(migrationRole)}`
    applicationClient = postgres(applicationUrl, { max: 4, prepare: false })
    const application = drizzle(applicationClient, { schema })
    return {
      application,
      name,
      dispose,
      assertApplicationCannotCreateOrAlter: async () => {
        if (applicationClient === undefined) throw new TestDatabaseError('APPLICATION_NOT_OPEN')
        const suffix = randomUUID().replaceAll('-', '')
        await assertDdlDenied(
          applicationClient,
          `create table public.hosted_graph_ddl_probe_${suffix} (id integer)`
        )
        await assertDdlDenied(
          applicationClient,
          `alter table public.execution_plans add column hosted_graph_ddl_probe_${suffix} integer`
        )
      },
      async waitForBlockedTransaction() {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const rows = await administration`
            select pid
            from pg_stat_activity
            where datname = ${name}
              and wait_event_type = 'Lock'
              and cardinality(pg_blocking_pids(pid)) > 0
          `
          if (rows.length > 0) return
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new TestDatabaseError('EXPECTED_BLOCKED_POSTGRES_TRANSACTION')
      },
      async migrate() {
        await migrateDatabase({ role: 'migration', url: migrationUrl })
        await grantApplicationAccess(migrationUrl, applicationRole)
      },
      async withMigrationDatabase(operation) {
        const client = postgres(migrationUrl, { max: 1, prepare: false })
        try {
          return await operation(drizzle(client, { schema }))
        } finally {
          await client.end({ timeout: 5 })
        }
      },
      transaction: (operation) => withDomainTransaction(application, operation),
    }
  }, dispose)
}

async function assertDdlDenied(
  client: ReturnType<typeof postgres>,
  statement: string
): Promise<void> {
  try {
    await client.begin(async (transaction) => {
      await transaction.unsafe(statement)
      throw new DdlProbeRollback()
    })
  } catch (error) {
    if (error instanceof DdlProbeRollback)
      throw new TestDatabaseError('APPLICATION_ROLE_DDL_ALLOWED')
    if (postgresErrorCode(error) === '42501') return
    throw new TestDatabaseError('APPLICATION_DDL_PROBE_FAILED')
  }
  throw new TestDatabaseError('APPLICATION_DDL_PROBE_INVALID')
}

class DdlProbeRollback extends Error {}

function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

async function grantApplicationAccess(
  migrationUrl: string,
  applicationRole: string
): Promise<void> {
  const migration = postgres(migrationUrl, { max: 1, prepare: false })
  try {
    await migration`grant usage on schema public to ${migration(applicationRole)}`
    await migration`grant select, insert, update, delete on all tables in schema public to ${migration(applicationRole)}`
    await migration`revoke insert, update, delete on admission_rollout_gate from ${migration(applicationRole)}`
    await migration`grant select on admission_rollout_gate to ${migration(applicationRole)}`
    await migration`revoke all privileges on retired_command_keys from ${migration(applicationRole)}`
    await migration`grant select, insert on retired_command_keys to ${migration(applicationRole)}`
    await migration`grant usage, select on all sequences in schema public to ${migration(applicationRole)}`
    await migration`alter default privileges grant select, insert, update, delete on tables to ${migration(applicationRole)}`
    await migration`alter default privileges grant usage, select on sequences to ${migration(applicationRole)}`
  } finally {
    await migration.end({ timeout: 5 })
  }
}

function assertCredentials(credentials: IsolatedDatabaseCredentials): void {
  if (
    credentials.administration.role !== 'administration' ||
    credentials.application.role !== 'application' ||
    credentials.migration.role !== 'migration'
  ) {
    throw new TestDatabaseError('INVALID_CREDENTIAL_ROLE')
  }
  for (const credentialsForRole of Object.values(credentials))
    assertPostgresUrl(credentialsForRole.url)
  const usernames = new Set(Object.values(credentials).map(({ url }) => new URL(url).username))
  if (usernames.size !== 3) throw new TestDatabaseError('CREDENTIAL_ROLES_MUST_BE_DISTINCT')
}

function replaceDatabaseName(value: string, name: string): string {
  const url = new URL(value)
  url.pathname = `/${name}`
  return url.toString()
}

/**
 * Explicit per-test and per-hook timeouts in the PostgreSQL integration
 * suites are authored against the local fixture, where a case finishes in
 * seconds. The remote Neon lane runs the same suites against a distant
 * disposable branch where every query legitimately stretches several-fold,
 * so the integration runner exports INTEGRATION_TEST_TIMEOUT_MS and suites
 * scale their explicit budgets through this helper instead of being clamped
 * to the local value regardless of the bun CLI --timeout flag (an explicit
 * per-test argument always overrides the CLI default).
 */
export function integrationTestTimeout(fallbackMs = 30_000): number {
  const raw = process.env['INTEGRATION_TEST_TIMEOUT_MS']
  const parsed = raw === undefined ? Number.NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(parsed, fallbackMs) : fallbackMs
}
