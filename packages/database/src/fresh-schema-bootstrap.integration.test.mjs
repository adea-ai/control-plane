// A dedicated run sets RUN_CP_FRESH_SCHEMA_ACCEPTANCE=true; absent credentials
// then fail. Generic integration discovery leaves this local-only fixture inactive.
import { expect, test } from 'bun:test'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { sql } from 'drizzle-orm'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { createIsolatedTestDatabase } from './testing.ts'

function fixtureCredentials(environment) {
  if (environment.RUN_CP_FRESH_SCHEMA_ACCEPTANCE !== 'true')
    throw new Error('CP_FRESH_SCHEMA_EXPLICIT_OPT_IN_REQUIRED')
  // Even nominally local URLs must not be rerouted by inherited libpq configuration.
  if (Object.keys(environment).some((key) => /^PG/i.test(key)))
    throw new Error('CP_FRESH_SCHEMA_INHERITED_PG_CONFIGURATION_REFUSED')
  const inputs = [
    ['administration', 'DATABASE_ADMIN_URL'],
    ['application', 'DATABASE_URL'],
    ['migration', 'DATABASE_MIGRATION_URL'],
  ]
  let endpoint
  const usernames = new Set()
  const credentials = {}
  for (const [role, variable] of inputs) {
    let url
    try {
      url = new URL(environment[variable])
    } catch {
      throw new Error('CP_FRESH_SCHEMA_EXPLICIT_FIXTURE_URLS_REQUIRED')
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port ||
      !url.username ||
      !url.password ||
      !/^\/[A-Za-z_][A-Za-z0-9_]*$/.test(url.pathname) ||
      url.hash ||
      [...url.searchParams].some(([key, value]) => key !== 'sslmode' || value !== 'disable') ||
      url.searchParams.getAll('sslmode').length > 1
    )
      throw new Error('CP_FRESH_SCHEMA_LITERAL_LOOPBACK_FIXTURE_REQUIRED')
    const nextEndpoint = `${url.hostname}:${url.port}`
    if (endpoint !== undefined && endpoint !== nextEndpoint)
      throw new Error('CP_FRESH_SCHEMA_SAME_INSTANCE_REQUIRED')
    endpoint = nextEndpoint
    usernames.add(decodeURIComponent(url.username))
    credentials[role] = { role, url: url.href }
  }
  if (usernames.size !== inputs.length) throw new Error('CP_FRESH_SCHEMA_DISTINCT_ROLES_REQUIRED')
  return credentials
}

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const expectedMigrations = readMigrationFiles({ migrationsFolder }).map((entry) => ({
  hash: entry.hash,
  created_at: String(entry.folderMillis),
}))

async function journal(database) {
  return Array.from(
    await database.execute(sql`
    select hash, created_at::text as created_at
    from drizzle.__drizzle_migrations order by id
  `)
  )
}

// Semantic catalog: excludes volatile OIDs/statistics but includes every managed
// schema object definition and ACL represented below, not a table-name subset.
async function catalog(database) {
  return Array.from(
    await database.execute(sql`
    select kind, name, detail from (
      select 'schema' as kind, n.nspname as name,
        jsonb_build_object('owner', pg_get_userbyid(n.nspowner), 'acl', n.nspacl) as detail
      from pg_namespace n where n.nspname in ('public', 'drizzle')
      union all
      select 'relation', n.nspname || '.' || c.relname,
        jsonb_build_object('kind', c.relkind, 'owner', pg_get_userbyid(c.relowner),
          'acl', c.relacl, 'options', c.reloptions, 'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'drizzle')
      union all
      select 'column', n.nspname || '.' || c.relname || '.' || a.attname,
        jsonb_build_object('position', a.attnum, 'type', format_type(a.atttypid, a.atttypmod),
          'notNull', a.attnotnull, 'identity', a.attidentity, 'generated', a.attgenerated,
          'default', pg_get_expr(d.adbin, d.adrelid), 'acl', a.attacl)
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname in ('public', 'drizzle') and a.attnum > 0 and not a.attisdropped
      union all
      select 'constraint', n.nspname || '.' || c.relname || '.' || k.conname,
        jsonb_build_object('definition', pg_get_constraintdef(k.oid), 'validated', k.convalidated)
      from pg_constraint k join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'drizzle')
      union all
      select 'index', schemaname || '.' || indexname, to_jsonb(indexdef)
      from pg_indexes where schemaname in ('public', 'drizzle')
      union all
      select 'sequence', schemaname || '.' || sequencename,
        jsonb_build_object('type', data_type, 'start', start_value, 'min', min_value,
          'max', max_value, 'increment', increment_by, 'cycle', cycle, 'cache', cache_size)
      from pg_sequences where schemaname in ('public', 'drizzle')
      union all
      select 'view', schemaname || '.' || viewname, to_jsonb(definition)
      from pg_views where schemaname in ('public', 'drizzle')
      union all
      select 'policy', schemaname || '.' || tablename || '.' || policyname,
        jsonb_build_object('permissive', permissive, 'roles', roles, 'command', cmd,
          'using', qual, 'check', with_check)
      from pg_policies where schemaname in ('public', 'drizzle')
      union all
      select 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname,
        jsonb_build_object('definition', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled)
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'drizzle') and not t.tgisinternal
      union all
      select 'enum', n.nspname || '.' || t.typname,
        jsonb_agg(e.enumlabel order by e.enumsortorder)
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
      join pg_enum e on e.enumtypid = t.oid where n.nspname in ('public', 'drizzle')
      group by n.nspname, t.typname
      union all
      select 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
        jsonb_build_object('definition', pg_get_functiondef(p.oid),
          'owner', pg_get_userbyid(p.proowner), 'acl', p.proacl)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'drizzle') and p.prokind in ('f', 'p')
      union all
      select 'default_acl', pg_get_userbyid(d.defaclrole) || '.' || coalesce(n.nspname, '*') || '.' || d.defaclobjtype::text,
        to_jsonb(d.defaclacl)
      from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
      where n.nspname in ('public', 'drizzle') or d.defaclnamespace = 0
    ) objects order by kind, name
  `)
  )
}

async function verifyRemoved(credentials, name) {
  const admin = postgres(credentials.administration.url, { max: 1, prepare: false })
  try {
    const [row] =
      await admin`select exists(select 1 from pg_database where datname = ${name}) as exists`
    if (row.exists) throw new Error('CP_FRESH_SCHEMA_OWNED_DATABASE_SURVIVED_CLEANUP')
  } finally {
    await admin.end({ timeout: 5 })
  }
}

test.skipIf(process.env.RUN_CP_FRESH_SCHEMA_ACCEPTANCE !== 'true')(
  'fresh CP bootstrap preserves complete migration journal and semantic catalog on replay',
  async () => {
    // Evaluated before creating any postgres client. Inputs must identify a dedicated
    // runner-owned disposable instance; loopback alone does not establish ownership.
    const credentials = fixtureCredentials(process.env)
    expect(expectedMigrations.length).toBeGreaterThan(0)
    const fixture = await createIsolatedTestDatabase(credentials)
    let primaryFailure
    const cleanupFailures = []
    try {
      expect(fixture.name).toMatch(/^control_plane_test_[a-f0-9]{32}$/)
      await fixture.withMigrationDatabase(async (database) => {
        const [before] = await database.execute(sql`
        select to_regnamespace('drizzle') is null as no_ledger_schema,
          to_regnamespace('postgres_auth') is null as no_legacy_auth_schema
      `)
        expect(before).toEqual({ no_ledger_schema: true, no_legacy_auth_schema: true })
      })
      await fixture.migrate({ applicationGrants: 'migrations-only' })
      const first = await fixture.withMigrationDatabase(async (database) => {
        const ledger = await journal(database)
        expect(ledger).toEqual(expectedMigrations)
        const rows = await catalog(database)
        expect(rows.length).toBeGreaterThan(expectedMigrations.length)
        const migrationRole = decodeURIComponent(new URL(credentials.migration.url).username)
        for (const row of rows.filter((entry) => entry.kind === 'relation'))
          expect(row.detail.owner).toBe(migrationRole)
        const roleNames = [credentials.migration, credentials.application].map((entry) =>
          decodeURIComponent(new URL(entry.url).username)
        )
        const roles = await database.execute(sql`
        select rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
        from pg_roles where rolname in (${roleNames[0]}, ${roleNames[1]}) order by rolname
      `)
        expect(roles).toHaveLength(2)
        for (const role of roles)
          for (const flag of [
            'rolsuper',
            'rolcreatedb',
            'rolcreaterole',
            'rolinherit',
            'rolreplication',
            'rolbypassrls',
          ])
            expect(role[flag]).toBe(false)
        const memberships = await database.execute(sql`
          select member from pg_auth_members
          where member in (select oid from pg_roles where rolname in (${roleNames[0]}, ${roleNames[1]}))
        `)
        expect(memberships).toHaveLength(0)
        const [counts] = await database.execute(sql`
        select (select count(*)::int from public.executions) as executions,
          (select count(*)::int from public.execution_attempts) as attempts,
          (select count(*)::int from public.execution_plans) as plans,
          (select count(*)::int from public.delegations) as delegations,
          (select count(*)::int from public.inbox_messages) as inbox,
          (select count(*)::int from public.outbox_events) as outbox
      `)
        expect(counts).toEqual({
          executions: 0,
          attempts: 0,
          plans: 0,
          delegations: 0,
          inbox: 0,
          outbox: 0,
        })
        return { ledger, catalog: rows, counts }
      })
      await fixture.assertApplicationCannotCreateOrAlter()
      await fixture.migrate({ applicationGrants: 'migrations-only' })
      await fixture.withMigrationDatabase(async (database) => {
        expect(await journal(database)).toEqual(first.ledger)
        expect(await catalog(database)).toEqual(first.catalog)
        const [after] = await database.execute(sql`
        select (select count(*)::int from public.executions) as executions,
          (select count(*)::int from public.execution_attempts) as attempts,
          (select count(*)::int from public.execution_plans) as plans,
          (select count(*)::int from public.delegations) as delegations,
          (select count(*)::int from public.inbox_messages) as inbox,
          (select count(*)::int from public.outbox_events) as outbox
      `)
        expect(after).toEqual(first.counts)
      })
    } catch (error) {
      primaryFailure = error
    } finally {
      try {
        await fixture.dispose()
      } catch (error) {
        cleanupFailures.push(error)
      }
      try {
        await verifyRemoved(credentials, fixture.name)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (cleanupFailures.length)
      throw new AggregateError(
        primaryFailure === undefined ? cleanupFailures : [primaryFailure, ...cleanupFailures],
        'CP_FRESH_SCHEMA_OPERATION_OR_CLEANUP_FAILED'
      )
    if (primaryFailure !== undefined) throw primaryFailure
  },
  30000
)
