import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const API_URL = 'https://backboard.railway.com/graphql/v2'
const PROJECT_ID = '18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f'
const ENVIRONMENT_ID = '52f5b0ac-2af0-4792-aa56-30d80e5db31e'
const SERVICES = Object.freeze([
  { name: 'control-api', id: '9167a33b-af0f-4780-8614-a5a161697c9c' },
  { name: 'workflow-worker', id: 'd733ec0d-bda5-4be5-86b9-637154d282eb' },
])
const MIGRATION_TARGET = Object.freeze({
  hostname: 'ep-crimson-bird-ay77m275.c-5.us-east-2.aws.neon.tech',
  username: 'control_plane_migrator',
  database: 'neondb',
  sslmode: 'verify-full',
})
const RUNTIME_TARGET = Object.freeze({
  hostname: 'ep-crimson-bird-ay77m275-pooler.c-5.us-east-2.aws.neon.tech',
  username: 'control_plane_app',
  database: 'neondb',
})
const RUNTIME_CRUD_TABLES = Object.freeze(['catalog_approvals', 'retired_execution_event_ids'])
const RUNTIME_READ_ONLY_TABLES = Object.freeze(['admission_rollout_gate'])
const RUNTIME_TABLES = Object.freeze([...RUNTIME_CRUD_TABLES, ...RUNTIME_READ_ONLY_TABLES])
const ADVISORY_LOCK = Object.freeze([1_295_070_001, 11])
const MIGRATION_TIMEOUTS = Object.freeze({
  connectTimeoutSeconds: 10,
  statementTimeoutMs: 120_000,
  lockTimeoutMs: 5_000,
})
const MIGRATION_DIRECTORY = fileURLToPath(new URL('../packages/database/drizzle/', import.meta.url))
const DATABASE_PACKAGE_JSON = new URL('../packages/database/package.json', import.meta.url)
const requireFromDatabase = createRequire(DATABASE_PACKAGE_JSON)

const VARIABLES_QUERY = `query($projectId:String!,$environmentId:String!,$serviceId:String!) {
  variablesForServiceDeployment(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId)
}`

function gateError(code) {
  return new Error(`Production schema gate failed: ${code}`)
}

function decodeUrlPart(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return ''
  }
}

function parseDatabaseUrl(value, expected, { migration = false } = {}) {
  if (typeof value !== 'string' || value.length === 0) throw gateError('invalid database target')

  let url
  try {
    url = new URL(value)
  } catch {
    throw gateError('invalid database target')
  }

  const allowedSslModes = migration ? ['verify-full'] : ['require', 'verify-full']
  const sslModes = url.searchParams.getAll('sslmode')
  const channelBindings = url.searchParams.getAll('channel_binding')
  const queryEntries = [...url.searchParams.entries()]
  const allowedQueryKeys = new Set(['sslmode', 'channel_binding'])
  const duplicateQueryKeys = new Set()
  const seenQueryKeys = new Set()
  for (const [name] of queryEntries) {
    if (seenQueryKeys.has(name)) duplicateQueryKeys.add(name)
    seenQueryKeys.add(name)
  }

  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname.toLowerCase() !== expected.hostname ||
    (url.port !== '' && url.port !== '5432') ||
    decodeUrlPart(url.username) !== expected.username ||
    decodeUrlPart(url.pathname.slice(1)) !== expected.database ||
    url.password.length === 0 ||
    url.hash !== '' ||
    sslModes.length !== 1 ||
    !allowedSslModes.includes(sslModes[0]) ||
    channelBindings.length > 1 ||
    (channelBindings.length === 1 && !['require', 'prefer'].includes(channelBindings[0])) ||
    queryEntries.some(([name]) => !allowedQueryKeys.has(name)) ||
    duplicateQueryKeys.size > 0
  ) {
    throw gateError(
      'database target does not match the required role, database, host, or TLS policy'
    )
  }

  return url
}

export function assertProductionMigrationUrl(value) {
  return parseDatabaseUrl(value, MIGRATION_TARGET, { migration: true })
}

export function assertRuntimeDatabaseUrl(value) {
  return parseDatabaseUrl(value, RUNTIME_TARGET)
}

function assertCanonicalHistory(history) {
  if (!Array.isArray(history) || history.length === 0) {
    throw gateError('release migration history is missing')
  }

  let previousTimestamp = -1
  const tags = new Set()
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index]
    if (
      entry?.idx !== index ||
      !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previousTimestamp ||
      !/^[0-9a-f]{64}$/.test(entry.hash) ||
      tags.has(entry.tag)
    ) {
      throw gateError('release migration history is invalid')
    }
    tags.add(entry.tag)
    previousTimestamp = entry.when
  }
  return history
}

export async function loadCanonicalMigrationHistory(migrationsDirectory = MIGRATION_DIRECTORY) {
  try {
    const journal = JSON.parse(
      await readFile(join(migrationsDirectory, 'meta/_journal.json'), 'utf8')
    )
    if (
      journal.version !== '7' ||
      journal.dialect !== 'postgresql' ||
      !Array.isArray(journal.entries)
    ) {
      throw gateError('release migration journal is invalid')
    }

    const history = []
    for (const entry of journal.entries) {
      if (!/^\d{4}_[a-z0-9_]+$/.test(entry.tag))
        throw gateError('release migration journal is invalid')
      const sql = await readFile(join(migrationsDirectory, `${entry.tag}.sql`))
      history.push({
        idx: entry.idx,
        when: entry.when,
        tag: entry.tag,
        hash: createHash('sha256').update(sql).digest('hex'),
      })
    }
    return assertCanonicalHistory(history)
  } catch {
    throw gateError('release migration source is incomplete or invalid')
  }
}

function normalizeAppliedHistory(applied) {
  if (!Array.isArray(applied)) throw gateError('database migration history is invalid')
  return applied.map((entry) => ({
    hash: entry?.hash,
    when: typeof entry?.created_at === 'number' ? entry.created_at : Number(entry?.created_at),
  }))
}

export function assertAppliedHistoryPrefix(applied, canonical, { requireFull = false } = {}) {
  const expected = assertCanonicalHistory(canonical)
  const actual = normalizeAppliedHistory(applied)
  if (actual.length > expected.length || (requireFull && actual.length !== expected.length)) {
    throw gateError('database migration history is ahead of or differs from this release')
  }

  for (let index = 0; index < actual.length; index += 1) {
    if (
      !Number.isSafeInteger(actual[index].when) ||
      actual[index].when !== expected[index].when ||
      actual[index].hash !== expected[index].hash
    ) {
      throw gateError('database migration history is not an exact release prefix')
    }
  }
  return expected.slice(actual.length)
}

function assertRuntimeVariables(variables) {
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    throw gateError('Railway runtime variables are unavailable')
  }
  const value = variables.DATABASE_URL
  assertRuntimeDatabaseUrl(value)
  return value
}

export function createRailwayVariableReader({ token, fetchImpl = fetch }) {
  if (!token) throw gateError('RAILWAY_PRODUCTION_TOKEN is required')

  return {
    async getServiceVariables(serviceId) {
      const service = SERVICES.find((candidate) => candidate.id === serviceId)
      if (!service) throw gateError('unknown production service')

      let response
      let body
      try {
        response = await fetchImpl(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'Project-Access-Token': token,
          },
          body: JSON.stringify({
            query: VARIABLES_QUERY,
            variables: {
              projectId: PROJECT_ID,
              environmentId: ENVIRONMENT_ID,
              serviceId,
            },
          }),
          signal: AbortSignal.timeout(15_000),
        })
        body = await response.json()
      } catch {
        throw gateError('Railway runtime configuration lookup failed')
      }

      if (!response.ok || body?.errors || !body?.data?.variablesForServiceDeployment) {
        throw gateError('Railway runtime configuration lookup failed')
      }
      return body.data.variablesForServiceDeployment
    },
  }
}

export function createPostgresSession(url, timeouts = MIGRATION_TIMEOUTS) {
  const postgresModule = requireFromDatabase('postgres')
  const postgres = typeof postgresModule === 'function' ? postgresModule : postgresModule?.default
  if (typeof postgres !== 'function') throw gateError('postgres database driver is unavailable')
  const client = postgres(url.href, {
    max: 1,
    idle_timeout: null,
    max_lifetime: null,
    connect_timeout: timeouts.connectTimeoutSeconds,
    prepare: false,
    ssl: 'verify-full',
    connection: {
      application_name: 'control-plane-production-schema-gate',
      statement_timeout: timeouts.statementTimeoutMs,
      lock_timeout: timeouts.lockTimeoutMs,
    },
  })

  return {
    async readAppliedHistory() {
      return client`
        SELECT hash, created_at
        FROM "drizzle"."__drizzle_migrations"
        ORDER BY created_at ASC, id ASC
      `
    },
    async tryAcquireAdvisoryLock() {
      const [row] =
        await client`SELECT pg_try_advisory_lock(${ADVISORY_LOCK[0]}, ${ADVISORY_LOCK[1]}) AS acquired`
      return row?.acquired === true
    },
    async releaseAdvisoryLock() {
      const [row] =
        await client`SELECT pg_advisory_unlock(${ADVISORY_LOCK[0]}, ${ADVISORY_LOCK[1]}) AS released`
      return row?.released === true
    },
    async readConnectedRole() {
      const [row] = await client`
        SELECT current_user AS role_name, current_database() AS database_name
      `
      return row
    },
    async readRuntimeRoleCapabilities() {
      const [row] = await client`
        SELECT current_user = 'control_plane_app' AS application_role,
          current_database() AS database_name,
          r.rolsuper AS superuser,
          r.rolcreatedb AS create_database,
          r.rolcreaterole AS create_role,
          r.rolreplication AS replication,
          r.rolbypassrls AS bypass_row_security,
          has_database_privilege(r.oid, current_database(), 'CONNECT') AS database_connect,
          has_database_privilege(r.oid, current_database(), 'CREATE') AS database_create,
          has_schema_privilege(r.oid, 'public', 'USAGE') AS public_usage,
          has_schema_privilege(r.oid, 'public', 'CREATE') AS public_create,
          EXISTS (
            SELECT 1 FROM pg_auth_members AS membership
            WHERE membership.member = r.oid
          ) AS has_role_memberships,
          EXISTS (
            SELECT 1 FROM pg_database AS d
            WHERE d.datname = current_database() AND d.datdba = r.oid
          ) AS owns_database,
          (
            r.oid = (SELECT nspowner FROM pg_namespace WHERE nspname = 'public')
            OR EXISTS (
              SELECT 1
              FROM pg_class AS public_object
              JOIN pg_namespace AS public_schema ON public_schema.oid = public_object.relnamespace
              WHERE public_schema.nspname = 'public'
                AND public_object.relowner = r.oid
            )
          ) AS owns_public_objects,
          EXISTS (
            SELECT 1
            FROM pg_class AS public_table
            JOIN pg_namespace AS public_schema ON public_schema.oid = public_table.relnamespace
            WHERE public_schema.nspname = 'public'
              AND public_table.relkind IN ('r', 'p', 'v', 'm', 'f')
              AND (
                has_table_privilege(r.oid, public_table.oid, 'TRUNCATE')
                OR has_table_privilege(r.oid, public_table.oid, 'REFERENCES')
                OR has_table_privilege(r.oid, public_table.oid, 'TRIGGER')
                OR CASE
                  WHEN current_setting('server_version_num')::integer >= 170000
                    THEN has_table_privilege(r.oid, public_table.oid, 'MAINTAIN')
                  ELSE false
                END
              )
          ) AS has_non_crud_table_privileges
        FROM pg_roles AS r
        WHERE r.rolname = current_user
      `
      return row
    },
    async readRuntimeTablePrivileges() {
      return client`
        SELECT requested.table_name,
          owner.rolname AS table_owner,
          has_table_privilege(current_user, format('public.%I', requested.table_name), 'SELECT') AS can_select,
          has_table_privilege(current_user, format('public.%I', requested.table_name), 'INSERT') AS can_insert,
          has_table_privilege(current_user, format('public.%I', requested.table_name), 'UPDATE') AS can_update,
          has_table_privilege(current_user, format('public.%I', requested.table_name), 'DELETE') AS can_delete
        FROM (VALUES ('catalog_approvals'), ('retired_execution_event_ids'), ('admission_rollout_gate')) AS requested(table_name)
        LEFT JOIN pg_class AS c ON c.relname = requested.table_name
        LEFT JOIN pg_namespace AS n ON n.oid = c.relnamespace AND n.nspname = 'public'
        LEFT JOIN pg_roles AS owner ON owner.oid = c.relowner
        WHERE c.oid IS NULL OR n.oid IS NOT NULL
        ORDER BY requested.table_name
      `
    },
    async readRetentionReferenceColumns() {
      return client`
        SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
          has_column_privilege(current_user, format('public.%I', c.table_name), c.column_name, 'SELECT') AS can_select
        FROM information_schema.columns AS c
        WHERE c.table_schema = 'public'
          AND c.column_name = 'unreferenced_since'
          AND c.table_name IN ('context_packages', 'execution_plans')
        ORDER BY c.table_name
      `
    },
    async close() {
      await client.end({ timeout: 5 })
    },
  }
}

export function assertRuntimeCapabilities(capabilities, privileges) {
  if (
    !capabilities ||
    capabilities.application_role !== true ||
    capabilities.database_name !== MIGRATION_TARGET.database ||
    capabilities.superuser !== false ||
    capabilities.create_database !== false ||
    capabilities.create_role !== false ||
    capabilities.replication !== false ||
    capabilities.bypass_row_security !== false ||
    capabilities.database_connect !== true ||
    capabilities.database_create !== false ||
    capabilities.public_usage !== true ||
    capabilities.public_create !== false ||
    capabilities.has_role_memberships !== false ||
    capabilities.owns_database !== false ||
    capabilities.owns_public_objects !== false ||
    capabilities.has_non_crud_table_privileges !== false ||
    !Array.isArray(privileges)
  ) {
    throw gateError('runtime database role capabilities are unsafe')
  }
  if (privileges.length !== RUNTIME_TABLES.length) {
    throw gateError('runtime database table grants are unsafe')
  }

  for (const table of RUNTIME_CRUD_TABLES) {
    const rows = privileges.filter((privilege) => privilege.table_name === table)
    const privilege = rows[0]
    if (
      rows.length !== 1 ||
      privilege.table_owner !== MIGRATION_TARGET.username ||
      privilege.can_select !== true ||
      privilege.can_insert !== true ||
      privilege.can_update !== true ||
      privilege.can_delete !== true
    ) {
      throw gateError('runtime database table grants are unsafe')
    }
  }

  for (const table of RUNTIME_READ_ONLY_TABLES) {
    const rows = privileges.filter((privilege) => privilege.table_name === table)
    const privilege = rows[0]
    if (
      rows.length !== 1 ||
      privilege.table_owner !== MIGRATION_TARGET.username ||
      privilege.can_select !== true ||
      privilege.can_insert !== false ||
      privilege.can_update !== false ||
      privilege.can_delete !== false
    ) {
      throw gateError('runtime database table grants are unsafe')
    }
  }
}

export function assertRetentionReferenceColumns(columns) {
  const expectedTables = ['context_packages', 'execution_plans']
  if (!Array.isArray(columns) || columns.length !== expectedTables.length) {
    throw gateError('retention reference columns are missing')
  }
  for (let index = 0; index < expectedTables.length; index += 1) {
    const column = columns[index]
    if (
      column.table_name !== expectedTables[index] ||
      column.column_name !== 'unreferenced_since' ||
      column.data_type !== 'timestamp with time zone' ||
      column.udt_name !== 'timestamptz' ||
      column.is_nullable !== 'YES' ||
      column.can_select !== true
    ) {
      throw gateError('retention reference columns do not match the release contract')
    }
  }
}

function assertConnectedRole(identity, expectedRole) {
  if (
    identity?.role_name !== expectedRole ||
    identity?.database_name !== MIGRATION_TARGET.database
  ) {
    throw gateError('database connection role or database does not match production')
  }
}

async function verifyRuntimeDatabase(url, openMigrationSession) {
  let session
  let failure
  try {
    session = await openMigrationSession(url, MIGRATION_TIMEOUTS)
    assertConnectedRole(await session.readConnectedRole(), RUNTIME_TARGET.username)
    assertRuntimeCapabilities(
      await session.readRuntimeRoleCapabilities(),
      await session.readRuntimeTablePrivileges()
    )
    assertRetentionReferenceColumns(await session.readRetentionReferenceColumns())
  } catch {
    failure = gateError('runtime database privilege or schema verification failed')
  } finally {
    if (session) {
      try {
        await session.close()
      } catch {
        failure ??= gateError('runtime database connection could not be closed')
      }
    }
  }
  if (failure) throw failure
}

async function migrateWithRepository(credentials) {
  const { migrateDatabase } = await import('@control-plane/database/migration')
  await migrateDatabase(credentials, {
    ...MIGRATION_TIMEOUTS,
    verifyTls: true,
  })
}

export async function migrateProductionSchema({
  environment = process.env,
  railway,
  openMigrationSession = createPostgresSession,
  migrate = migrateWithRepository,
  canonicalHistory,
}) {
  const migrationUrl = assertProductionMigrationUrl(environment.NEON_PRODUCTION_MIGRATION_URL)
  const canonical = assertCanonicalHistory(
    canonicalHistory ?? (await loadCanonicalMigrationHistory())
  )

  if (!railway || typeof railway.getServiceVariables !== 'function') {
    throw gateError('Railway runtime configuration reader is required')
  }

  let runtimeVariables
  try {
    runtimeVariables = await Promise.all(
      SERVICES.map(async ({ id }) => ({
        id,
        url: assertRuntimeVariables(await railway.getServiceVariables(id)),
      }))
    )
  } catch {
    throw gateError('Railway runtime database bindings do not match production')
  }
  if (runtimeVariables.length !== SERVICES.length) {
    throw gateError('Railway runtime database bindings do not match production')
  }

  let session
  try {
    session = await openMigrationSession(migrationUrl, MIGRATION_TIMEOUTS)
  } catch {
    throw gateError('production migration database connection failed')
  }
  if (!session) throw gateError('production migration database connection failed')

  let lockAcquired = false
  let failure
  try {
    assertConnectedRole(await session.readConnectedRole(), MIGRATION_TARGET.username)
    const beforeLock = await session.readAppliedHistory()
    assertAppliedHistoryPrefix(beforeLock, canonical)

    lockAcquired = await session.tryAcquireAdvisoryLock()
    if (!lockAcquired) throw gateError('production migration lock is already held')

    const afterLock = await session.readAppliedHistory()
    assertAppliedHistoryPrefix(afterLock, canonical)

    await migrate({ role: 'migration', url: migrationUrl.href })

    const afterMigration = await session.readAppliedHistory()
    assertAppliedHistoryPrefix(afterMigration, canonical, { requireFull: true })
    for (const binding of runtimeVariables) {
      await verifyRuntimeDatabase(assertRuntimeDatabaseUrl(binding.url), openMigrationSession)
    }
  } catch {
    failure = gateError('migration, history, or runtime privilege verification failed')
  } finally {
    if (lockAcquired) {
      try {
        if (!(await session.releaseAdvisoryLock())) {
          failure ??= gateError('production migration lock could not be released')
        }
      } catch {
        failure ??= gateError('production migration lock could not be released')
      }
    }
    try {
      await session.close()
    } catch {
      failure ??= gateError('production migration database connection could not be closed')
    }
  }

  if (failure) throw failure
}

async function main() {
  const railway = createRailwayVariableReader({ token: process.env.RAILWAY_PRODUCTION_TOKEN })
  await migrateProductionSchema({ environment: process.env, railway })
  process.stdout.write('Production database schema and runtime privilege gate passed.\n')
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    process.stderr.write(
      'Production database schema gate failed; Railway promotion was not started.\n'
    )
    process.exitCode = 1
  }
}
