import {
  resolveProductionDatabaseTarget,
  resolveProductionDatabaseTls,
} from '../scripts/production-database-target.mjs'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash, X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { createSecureContext, TLSSocket } from 'node:tls'
import { describe, test } from 'node:test'

import {
  assertMutationSucceeded,
  createRailwayClient,
  promoteRailwayImages,
} from '../scripts/promote-railway-images.mjs'
import {
  assertAppliedHistoryPrefix,
  assertProductionMigrationUrl as assertProductionMigrationUrlRecorded,
  assertRetentionReferenceColumns,
  assertRuntimeCapabilities as assertRuntimeCapabilitiesRecorded,
  assertRuntimeDatabaseUrl as assertRuntimeDatabaseUrlRecorded,
  createRailwayVariableReader,
  createPostgresSession,
  runtimeVerificationUrl,
  loadCanonicalMigrationHistory,
  productionSchemaGateFailure,
  migrateProductionSchema as migrateProductionSchemaRecorded,
} from '../scripts/migrate-production-schema.mjs'

const productionDatabaseContract = {
  schemaVersion: 1,
  provider: 'railway-postgres',
  status: 'verified',
  identity: {
    serviceId: '11111111-1111-4111-8111-111111111111',
    environmentId: '52f5b0ac-2af0-4792-aa56-30d80e5db31e',
    runtimeVerification: { hostname: 'migration.example.invalid', port: 6432 },
    tls: { serverName: 'migration.example.invalid', caSha256: null },
    database: 'control_plane_fixture',
    migration: { hostname: 'migration.example.invalid', port: 6432 },
    runtime: { hostname: 'runtime.example.invalid', port: 5432 },
  },
}
const assertProductionMigrationUrl = (value) =>
  assertProductionMigrationUrlRecorded(value, productionDatabaseContract)
const assertRuntimeDatabaseUrl = (value) =>
  assertRuntimeDatabaseUrlRecorded(value, productionDatabaseContract)
const assertRuntimeCapabilities = (capabilities, privileges) =>
  assertRuntimeCapabilitiesRecorded(capabilities, privileges, productionDatabaseContract)
const migrateProductionSchema = (options) =>
  migrateProductionSchemaRecorded({ ...options, productionDatabaseContract })

const migrationUrl =
  'postgresql://control_plane_migrator:placeholder@migration.example.invalid:6432/control_plane_fixture?sslmode=verify-full'
const runtimeUrl =
  'postgresql://control_plane_app:placeholder@runtime.example.invalid/control_plane_fixture?sslmode=require'
const canonicalHistory = [
  { idx: 0, when: 1000, tag: '0000_first_migration', hash: 'a'.repeat(64) },
  { idx: 1, when: 2000, tag: '0001_second_migration', hash: 'b'.repeat(64) },
  { idx: 2, when: 3000, tag: '0002_third_migration', hash: 'c'.repeat(64) },
]

function appliedHistory(entries) {
  return entries.map(({ hash, when }) => ({ hash, created_at: String(when) }))
}

function productionRuntimeVariables() {
  return new Map([['9167a33b-af0f-4780-8614-a5a161697c9c', { DATABASE_URL: runtimeUrl }]])
}

function runtimeCapabilities(overrides = {}) {
  return {
    application_role: true,
    database_name: 'control_plane_fixture',
    superuser: false,
    create_database: false,
    create_role: false,
    replication: false,
    bypass_row_security: false,
    database_connect: true,
    database_create: false,
    public_usage: true,
    public_create: false,
    has_role_memberships: false,
    owns_database: false,
    owns_public_objects: false,
    has_non_crud_table_privileges: false,
    ...overrides,
  }
}

function runtimeTablePrivileges() {
  return [
    {
      table_name: 'catalog_approvals',
      table_owner: 'control_plane_migrator',
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: true,
    },
    {
      table_name: 'retired_execution_event_ids',
      table_owner: 'control_plane_migrator',
      can_select: true,
      can_insert: true,
      can_update: true,
      can_delete: true,
    },
    {
      table_name: 'admission_rollout_gate',
      table_owner: 'control_plane_migrator',
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
      has_column_insert: false,
      has_column_update: false,
      has_column_references: false,
    },
    {
      table_name: 'retired_command_keys',
      table_owner: 'control_plane_migrator',
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
      has_column_insert: true,
      has_column_update: false,
      has_column_references: false,
    },
  ]
}

function createFakeSession({
  histories = [
    appliedHistory(canonicalHistory.slice(0, 2)),
    appliedHistory(canonicalHistory.slice(0, 2)),
    appliedHistory(canonicalHistory),
  ],
  lockAcquired = true,
  capabilities = runtimeCapabilities(),
  privileges = runtimeTablePrivileges(),
  columns = [
    {
      table_name: 'context_packages',
      column_name: 'unreferenced_since',
      data_type: 'timestamp with time zone',
      udt_name: 'timestamptz',
      is_nullable: 'YES',
      can_select: true,
    },
    {
      table_name: 'execution_plans',
      column_name: 'unreferenced_since',
      data_type: 'timestamp with time zone',
      udt_name: 'timestamptz',
      is_nullable: 'YES',
      can_select: true,
    },
  ],
} = {}) {
  const calls = []
  let connectedRoleReads = 0
  return {
    calls,
    session: {
      async readAppliedHistory() {
        calls.push('history')
        return histories.shift()
      },
      async tryAcquireAdvisoryLock() {
        calls.push('lock')
        return lockAcquired
      },
      async releaseAdvisoryLock() {
        calls.push('unlock')
        return true
      },
      async readConnectedRole() {
        calls.push('identity')
        connectedRoleReads += 1
        return {
          role_name: connectedRoleReads === 1 ? 'control_plane_migrator' : 'control_plane_app',
          database_name: 'control_plane_fixture',
        }
      },
      async readRuntimeRoleCapabilities() {
        calls.push('role-capabilities')
        return capabilities
      },
      async readRuntimeTablePrivileges() {
        calls.push('table-privileges')
        return privileges
      },
      async readRetentionReferenceColumns() {
        calls.push('reference-columns')
        return columns
      },
      async close() {
        calls.push('close')
      },
    },
  }
}

function fakeRailway(variables = productionRuntimeVariables(), calls = []) {
  return {
    calls,
    async getServiceVariables(serviceId) {
      calls.push(`variables:${serviceId}`)
      return variables.get(serviceId)
    },
  }
}

const manifests = [
  {
    target: 'control-api',
    image: 'ghcr.io/adea-ai/control-plane-control-api',
    digest: `sha256:${'a'.repeat(64)}`,
    sourceSha: 'source-sha',
  },
]

function deployment(overrides = {}) {
  return {
    id: 'deployment-prior',
    status: 'SUCCESS',
    canRollback: true,
    deploymentStopped: false,
    meta: {
      image: 'ghcr.io/adea-ai/control-plane-control-api@sha256:prior',
      imageDigest: 'sha256:prior',
    },
    ...overrides,
  }
}

describe('container promotion', () => {
  test('rejects GraphQL mutations that return false', () => {
    assert.throws(
      () => assertMutationSucceeded({ serviceInstanceUpdate: false }, 'serviceInstanceUpdate'),
      /serviceInstanceUpdate returned false/
    )
    assert.doesNotThrow(() =>
      assertMutationSucceeded({ serviceInstanceUpdate: true }, 'serviceInstanceUpdate')
    )
  })

  test('connects and disconnects the service-level Railway source', async () => {
    const requests = []
    const client = createRailwayClient({
      token: 'project-token',
      workspaceToken: 'workspace-token',
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body)
        requests.push({ ...request, headers: options.headers })
        if (request.query.includes('serviceConnect')) {
          return Response.json({ data: { serviceConnect: { id: request.variables.id } } })
        }
        if (request.query.includes('serviceDisconnect')) {
          return Response.json({ data: { serviceDisconnect: { id: request.variables.id } } })
        }
        throw new Error('unexpected request')
      },
    })

    await client.updateSource('control-api', {
      image: `ghcr.io/adea-ai/control-plane-control-api@sha256:${'a'.repeat(64)}`,
      repo: null,
    })
    await client.updateSource('control-api', { image: null, repo: null })

    assert.match(requests[0].query, /serviceConnect/)
    assert.equal(requests[0].headers.Authorization, 'Bearer workspace-token')
    assert.equal(requests[0].headers['Project-Access-Token'], undefined)
    assert.deepEqual(requests[0].variables.input, {
      image: `ghcr.io/adea-ai/control-plane-control-api@sha256:${'a'.repeat(64)}`,
      repo: null,
    })
    assert.match(requests[1].query, /serviceDisconnect/)
    assert.equal(requests[1].headers.Authorization, 'Bearer workspace-token')
  })

  test('waits for the updated source before triggering deployment', async () => {
    const sources = new Map(
      manifests.map(({ target }) => [target, { image: `${target}@sha256:prior`, repo: null }])
    )
    const pendingSources = new Map()
    const deployments = new Map(
      manifests.map(({ target }) => [target, [deployment({ id: `${target}-prior` })]])
    )
    const sourceReads = new Map()

    const railway = {
      async getSource(target) {
        const reads = (sourceReads.get(target) ?? 0) + 1
        sourceReads.set(target, reads)
        if (reads >= 3 && pendingSources.has(target)) {
          sources.set(target, pendingSources.get(target))
          pendingSources.delete(target)
        }
        return sources.get(target)
      },
      async listDeployments(target) {
        return deployments.get(target)
      },
      async updateSource(target, source) {
        pendingSources.set(target, source)
      },
      async deploySource(target) {
        assert.equal(sourceReads.get(target), 3)
        assert.equal(pendingSources.has(target), false)
        const manifest = manifests.find((item) => item.target === target)
        deployments.set(target, [
          deployment({
            id: `${target}-promoted`,
            meta: {
              image: `${manifest.image}@${manifest.digest}`,
              imageDigest: manifest.digest,
            },
          }),
        ])
      },
      async rollbackDeployment() {},
      async removeDeployment() {},
    }

    await promoteRailwayImages({
      manifests,
      railway,
      pullImage: async () => {},
      sleep: async () => {},
      verifyRetries: 3,
    })

    assert.equal(sourceReads.get('control-api'), 3)
  })

  test('restores the prior service state when a mutation response is ambiguous', async () => {
    const sources = new Map([['control-api', { image: 'control-api@sha256:prior', repo: null }]])
    const deployments = new Map([
      [
        'control-api',
        [deployment({ id: 'control-prior', meta: { imageDigest: 'sha256:control-prior' } })],
      ],
    ])
    const calls = []
    const promoted = new Set()
    const rolledBack = new Set()
    let failNextRead = false
    let updateCount = 0
    const railway = {
      async getSource(target) {
        if (failNextRead) {
          failNextRead = false
          throw new Error('transient Railway read failure')
        }
        return sources.get(target)
      },
      async listDeployments(target) {
        const prior = deployments.get(target)[0]
        if (promoted.has(target) && !rolledBack.has(target)) {
          const manifest = manifests.find((item) => item.target === target)
          return [
            deployment({
              id: `${target}-promoted`,
              canRollback: false,
              meta: {
                image: `${manifest.image}@${manifest.digest}`,
                imageDigest: manifest.digest,
              },
            }),
            { ...prior, canRollback: true, deploymentStopped: true },
          ]
        }
        return [prior]
      },
      async updateSource(target, source) {
        calls.push(['update', target, source])
        sources.set(target, source)
        if (source.image?.includes('sha256:')) promoted.add(target)
        updateCount += 1
        if (updateCount === 1) {
          failNextRead = true
          throw new Error('response lost after commit')
        }
      },
      async deploySource(target) {
        calls.push(['deploy', target])
      },
      async rollbackDeployment(target, id) {
        calls.push(['rollback', target, id])
        rolledBack.add(target)
        throw new Error('rollback response lost after commit')
      },
      async removeDeployment(target, id) {
        calls.push(['remove', target, id])
      },
    }

    await assert.rejects(
      promoteRailwayImages({
        manifests,
        railway,
        pullImage: async () => {},
        sleep: async () => {},
        verifyRetries: 3,
      }),
      /response lost after commit/
    )

    assert.deepEqual(
      calls.filter(([operation]) => operation === 'rollback'),
      [['rollback', 'control-api', 'control-prior']]
    )
    assert(calls.some(([operation, target]) => operation === 'update' && target === 'control-api'))
  })

  test('returns a first activation to verified standby when the deployment never starts', async () => {
    const calls = []
    const sources = new Map([['control-api', { image: null, repo: null }]])
    const activeDeployments = new Set()
    const removed = new Set()
    const railway = {
      async getSource(target) {
        return sources.get(target)
      },
      async listDeployments(target) {
        if (activeDeployments.has(target) && !removed.has(`new-${target}`)) {
          const manifest = manifests.find((item) => item.target === target)
          return [
            deployment({
              id: `new-${target}`,
              canRollback: false,
              meta: {
                image: `${manifest.image}@${manifest.digest}`,
                imageDigest: manifest.digest,
              },
            }),
          ]
        }
        return []
      },
      async updateSource(target, source) {
        calls.push(['update', target, source])
        sources.set(target, source)
        if (source.image !== null) activeDeployments.add(target)
      },
      async deploySource(target) {
        calls.push(['deploy', target])
        throw new Error('activation deployment failed')
      },
      async rollbackDeployment(target, id) {
        calls.push(['rollback', target, id])
      },
      async removeDeployment(target, id) {
        calls.push(['remove', target, id])
        removed.add(id)
        throw new Error('remove response lost after commit')
      },
    }

    await assert.rejects(
      promoteRailwayImages({
        manifests,
        railway,
        pullImage: async () => {},
        sleep: async () => {},
        verifyRetries: 3,
      }),
      /activation deployment failed/
    )

    assert(
      calls.some(
        ([operation, target, id]) =>
          operation === 'remove' && target === 'control-api' && id === 'new-control-api'
      )
    )
    assert(
      calls.some(
        ([operation, target, source]) =>
          operation === 'update' && target === 'control-api' && source.image === null
      )
    )
    assert(!calls.some(([operation]) => operation === 'rollback'))
  })
})

describe('production schema migration gate', () => {
  test('constructs and closes the installed postgres client without opening a remote connection', async () => {
    const session = createPostgresSession(
      new URL(
        'postgresql://local_test:placeholder@127.0.0.1:1/control_plane_fixture?sslmode=verify-full'
      )
    )
    await session.close()
  })

  test('loads the release journal and hashes every canonical migration file', async () => {
    const history = await loadCanonicalMigrationHistory()
    const tags = new Set(history.map(({ tag }) => tag))

    assert(history.length >= 50)
    assert.equal(Number.parseInt(history.at(-1).tag.slice(0, 4), 10), history.length - 1)
    assert(tags.has('0047_blushing_demogoblin'))
    assert(tags.has('0048_tense_thor'))
    assert(tags.has('0049_worried_vance_astro'))
    assert(history.every(({ hash }) => /^[0-9a-f]{64}$/.test(hash)))
  })

  test('requires the dedicated direct migrator URL with verified TLS and exact target', () => {
    assert.equal(
      new URL(assertProductionMigrationUrl(migrationUrl)).hostname,
      new URL(migrationUrl).hostname
    )
    assert.throws(() => assertProductionMigrationUrl(undefined), /invalid database target/)
    assert.throws(
      () =>
        assertProductionMigrationUrl(
          migrationUrl.replace('sslmode=verify-full', 'sslmode=require')
        ),
      /TLS policy/
    )
    assert.throws(
      () =>
        assertProductionMigrationUrl(
          migrationUrl.replace('control_plane_migrator', 'control_plane_app')
        ),
      /role, database, host, or TLS policy/
    )
    assert.throws(
      () => assertProductionMigrationUrl(`${migrationUrl}&options=-c%20role%3Dpostgres`),
      /role, database, host, or TLS policy/
    )
    assert.throws(
      () => assertProductionMigrationUrl(`${migrationUrl}&statement_timeout=0`),
      /role, database, host, or TLS policy/
    )
    assert.throws(
      () => assertProductionMigrationUrl(`${migrationUrl}&sslmode=disable`),
      /role, database, host, or TLS policy/
    )
  })

  test('preserves a safe provider failure label through the binding guard without provider response text', async () => {
    const secret = 'provider-response-secret-fixture'
    const railway = createRailwayVariableReader({
      token: 'token-fixture',
      fetchImpl: async () => ({ ok: false, json: async () => ({ errors: [{ message: secret }] }) }),
    })
    await assert.rejects(
      migrateProductionSchema({
        environment: { DATABASE_MIGRATION_URL: migrationUrl },
        railway,
        canonicalHistory,
        openMigrationSession: () => assert.fail('database must not open'),
      }),
      (error) => {
        assert.match(error.message, /runtime database bindings do not match production/)
        assert.equal(
          productionSchemaGateFailure(error),
          'Railway runtime configuration lookup failed'
        )
        assert.ok(!productionSchemaGateFailure(error).includes(secret))
        return true
      }
    )
  })

  test('validates the pooled runtime binding before opening the migration connection', async () => {
    const session = createFakeSession()
    const variables = productionRuntimeVariables()
    variables.set('9167a33b-af0f-4780-8614-a5a161697c9c', {
      DATABASE_URL: runtimeUrl.replace('control_plane_app', 'control_plane_migrator'),
    })
    let opened = false

    await assert.rejects(
      migrateProductionSchema({
        environment: { DATABASE_MIGRATION_URL: migrationUrl },
        railway: fakeRailway(variables),
        canonicalHistory,
        openMigrationSession: async () => {
          opened = true
          return session.session
        },
        migrate: async () => assert.fail('migration must not run'),
      }),
      /runtime database bindings do not match production/
    )
    assert.equal(opened, false)
    assert.deepEqual(session.calls, [])
  })

  test('checks the exact applied prefix, locks, rechecks, migrates, verifies all history and grants, then releases', async () => {
    const session = createFakeSession()
    const calls = []
    const railway = fakeRailway(productionRuntimeVariables(), calls)

    await migrateProductionSchema({
      environment: { DATABASE_MIGRATION_URL: migrationUrl },
      railway,
      canonicalHistory,
      openMigrationSession: async (url, timeouts, tls) => {
        assert.deepEqual(tls, { rejectUnauthorized: true, servername: 'migration.example.invalid' })
        assert.equal(url.hostname, 'migration.example.invalid')
        assert.equal(url.port, '6432')
        assert.deepEqual(timeouts, {
          connectTimeoutSeconds: 10,
          statementTimeoutMs: 120_000,
          lockTimeoutMs: 5_000,
        })
        calls.push(url.username === 'control_plane_migrator' ? 'open-migrator' : 'open-runtime')
        return session.session
      },
      migrate: async (credentials, tls) => {
        assert.deepEqual(tls, { rejectUnauthorized: true, servername: 'migration.example.invalid' })
        calls.push('migrate')
        assert.equal(credentials.role, 'migration')
        assert.equal(credentials.url, new URL(migrationUrl).href)
      },
    })

    assert.deepEqual(calls, [
      'variables:9167a33b-af0f-4780-8614-a5a161697c9c',
      'open-migrator',
      'migrate',
      'open-runtime',
    ])
    assert.deepEqual(session.calls, [
      'identity',
      'history',
      'lock',
      'history',
      'history',
      'identity',
      'role-capabilities',
      'table-privileges',
      'reference-columns',
      'close',
      'unlock',
      'close',
    ])
  })

  test('rejects foreign, gapped, ahead, or incomplete migration history', () => {
    assert.equal(
      assertAppliedHistoryPrefix(appliedHistory(canonicalHistory.slice(0, 2)), canonicalHistory)
        .length,
      1
    )
    assert.throws(
      () =>
        assertAppliedHistoryPrefix(
          [{ hash: 'f'.repeat(64), created_at: '1000' }],
          canonicalHistory
        ),
      /not an exact release prefix/
    )
    assert.throws(
      () =>
        assertAppliedHistoryPrefix(
          [
            { hash: canonicalHistory[0].hash, created_at: '1000' },
            { hash: canonicalHistory[2].hash, created_at: '3000' },
          ],
          canonicalHistory
        ),
      /not an exact release prefix/
    )
    assert.throws(
      () =>
        assertAppliedHistoryPrefix(
          appliedHistory([...canonicalHistory, { when: 4000, hash: 'd'.repeat(64) }]),
          canonicalHistory
        ),
      /ahead of or differs/
    )
    assert.throws(
      () =>
        assertAppliedHistoryPrefix(appliedHistory(canonicalHistory.slice(0, 2)), canonicalHistory, {
          requireFull: true,
        }),
      /ahead of or differs/
    )
  })

  test('does not migrate when the advisory lock is already held and always closes the session', async () => {
    const session = createFakeSession({ lockAcquired: false })
    let migrated = false

    await assert.rejects(
      migrateProductionSchema({
        environment: { DATABASE_MIGRATION_URL: migrationUrl },
        railway: fakeRailway(),
        canonicalHistory,
        openMigrationSession: async () => session.session,
        migrate: async () => {
          migrated = true
        },
      }),
      /migration, history, or runtime privilege verification failed/
    )
    assert.equal(migrated, false)
    assert.deepEqual(session.calls, ['identity', 'history', 'lock', 'close'])
  })

  test('sanitizes migration errors and releases the lock before closing', async () => {
    const session = createFakeSession()
    const secret = 'migration-url-secret-fixture'

    await assert.rejects(
      migrateProductionSchema({
        environment: { DATABASE_MIGRATION_URL: migrationUrl },
        railway: fakeRailway(),
        canonicalHistory,
        openMigrationSession: async () => session.session,
        migrate: async () => {
          throw new Error(secret)
        },
      }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(secret))
        return /migration, history, or runtime privilege verification failed/.test(error.message)
      }
    )
    assert.deepEqual(session.calls, ['identity', 'history', 'lock', 'history', 'unlock', 'close'])
  })

  test('requires individual CRUD grants, migrator ownership, and non-elevated runtime capabilities', () => {
    const capabilities = runtimeCapabilities()
    const privileges = runtimeTablePrivileges()
    assert.doesNotThrow(() => assertRuntimeCapabilities(capabilities, privileges))
    assert.throws(() =>
      assertRuntimeCapabilities({ ...capabilities, public_create: true }, privileges)
    )
    assert.throws(
      () =>
        assertRuntimeCapabilities(capabilities, [
          { ...privileges[0], can_update: false },
          privileges[1],
          privileges[2],
        ]),
      /table grants are unsafe/
    )
    assert.throws(
      () =>
        assertRuntimeCapabilities(capabilities, [
          { ...privileges[0], table_owner: 'control_plane_app' },
          privileges[1],
          privileges[2],
        ]),
      /table grants are unsafe/
    )
  })

  test('requires the admission rollout gate to exist and be read-only to the runtime role', () => {
    const capabilities = runtimeCapabilities()
    const privileges = runtimeTablePrivileges()

    assert.doesNotThrow(() => assertRuntimeCapabilities(capabilities, privileges))
    assert.throws(
      () => assertRuntimeCapabilities(capabilities, privileges.slice(0, 2)),
      /table grants are unsafe/
    )
    assert.throws(
      () =>
        assertRuntimeCapabilities(
          capabilities,
          privileges.map((privilege) =>
            privilege.table_name === 'admission_rollout_gate'
              ? { ...privilege, can_select: false }
              : privilege
          )
        ),
      /table grants are unsafe/
    )
    for (const privilegeName of ['can_insert', 'can_update', 'can_delete']) {
      assert.throws(
        () =>
          assertRuntimeCapabilities(
            capabilities,
            privileges.map((privilege) =>
              privilege.table_name === 'admission_rollout_gate'
                ? { ...privilege, [privilegeName]: true }
                : privilege
            )
          ),
        /table grants are unsafe/
      )
    }
    for (const privilegeName of [
      'has_column_insert',
      'has_column_update',
      'has_column_references',
    ]) {
      assert.throws(
        () =>
          assertRuntimeCapabilities(
            capabilities,
            privileges.map((privilege) =>
              privilege.table_name === 'admission_rollout_gate'
                ? { ...privilege, [privilegeName]: true }
                : privilege
            )
          ),
        /table grants are unsafe/
      )
    }
  })

  test('allows only SELECT and INSERT on replay tombstones, including effective column grants', () => {
    const capabilities = runtimeCapabilities()
    const privileges = runtimeTablePrivileges()
    assert.doesNotThrow(() => assertRuntimeCapabilities(capabilities, privileges))
    assert.throws(
      () =>
        assertRuntimeCapabilities(
          capabilities,
          privileges.filter((privilege) => privilege.table_name !== 'retired_command_keys')
        ),
      /table grants are unsafe/
    )
    for (const patch of [
      { can_select: false },
      { can_insert: false },
      { can_update: true },
      { can_delete: true },
      { has_column_update: true },
      { has_column_references: true },
      { table_owner: 'control_plane_app' },
    ]) {
      assert.throws(
        () =>
          assertRuntimeCapabilities(
            capabilities,
            privileges.map((privilege) =>
              privilege.table_name === 'retired_command_keys'
                ? { ...privilege, ...patch }
                : privilege
            )
          ),
        /table grants are unsafe/
      )
    }
  })

  test('rejects runtime role memberships even when membership inheritance is disabled', () => {
    assert.throws(
      () =>
        assertRuntimeCapabilities(
          runtimeCapabilities({ has_role_memberships: true }),
          runtimeTablePrivileges()
        ),
      /runtime database role capabilities are unsafe/
    )
  })

  test('rejects runtime ownership of the current database', () => {
    assert.throws(
      () =>
        assertRuntimeCapabilities(
          runtimeCapabilities({ owns_database: true }),
          runtimeTablePrivileges()
        ),
      /runtime database role capabilities are unsafe/
    )
  })

  test('rejects runtime ownership of any public object', () => {
    assert.throws(
      () =>
        assertRuntimeCapabilities(
          runtimeCapabilities({ owns_public_objects: true }),
          runtimeTablePrivileges()
        ),
      /runtime database role capabilities are unsafe/
    )
  })

  test('rejects effective non-CRUD privileges on public application tables', () => {
    assert.throws(
      () =>
        assertRuntimeCapabilities(
          runtimeCapabilities({ has_non_crud_table_privileges: true }),
          runtimeTablePrivileges()
        ),
      /runtime database role capabilities are unsafe/
    )
  })

  test('checks table MAINTAIN privilege starting with PostgreSQL 17', async () => {
    const migrationGate = await readFile(
      new URL('../scripts/migrate-production-schema.mjs', import.meta.url),
      'utf8'
    )

    assert.ok(migrationGate.includes("current_setting('server_version_num')::integer >= 170000"))
    assert.ok(migrationGate.includes("has_table_privilege(r.oid, public_table.oid, 'MAINTAIN')"))
  })

  test('requires both release columns to be nullable timestamptz values readable by the app role', () => {
    const columns = [
      {
        table_name: 'context_packages',
        column_name: 'unreferenced_since',
        data_type: 'timestamp with time zone',
        udt_name: 'timestamptz',
        is_nullable: 'YES',
        can_select: true,
      },
      {
        table_name: 'execution_plans',
        column_name: 'unreferenced_since',
        data_type: 'timestamp with time zone',
        udt_name: 'timestamptz',
        is_nullable: 'YES',
        can_select: true,
      },
    ]
    assert.doesNotThrow(() => assertRetentionReferenceColumns(columns))
    assert.throws(() =>
      assertRetentionReferenceColumns([{ ...columns[0], is_nullable: 'NO' }, columns[1]])
    )
    assert.throws(() =>
      assertRetentionReferenceColumns([{ ...columns[0], can_select: false }, columns[1]])
    )
  })

  test('queries Railway runtime variables with explicit production IDs without printing values', async () => {
    const requests = []
    const secretRuntimeUrl = runtimeUrl
    const railway = createRailwayVariableReader({
      token: 'token-fixture',
      fetchImpl: async (_url, options) => {
        requests.push({ body: JSON.parse(options.body), headers: options.headers })
        return Response.json({
          data: { variablesForServiceDeployment: { DATABASE_URL: secretRuntimeUrl } },
        })
      },
    })

    assert.deepEqual(await railway.getServiceVariables('9167a33b-af0f-4780-8614-a5a161697c9c'), {
      DATABASE_URL: secretRuntimeUrl,
    })
    assert.deepEqual(requests[0].body.variables, {
      projectId: '18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f',
      environmentId: '52f5b0ac-2af0-4792-aa56-30d80e5db31e',
      serviceId: '9167a33b-af0f-4780-8614-a5a161697c9c',
    })
    assert.equal(requests[0].headers['Project-Access-Token'], 'token-fixture')
    assert.equal(JSON.stringify(requests[0]).includes(secretRuntimeUrl), false)
    assert.throws(() =>
      assertRuntimeDatabaseUrl(runtimeUrl.replace('sslmode=require', 'sslmode=disable'))
    )
  })

  test('places the schema gate before promotion and serializes production deployments across tags', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/container-promotion.yml', import.meta.url),
      'utf8'
    )
    const gateIndex = workflow.indexOf('bun scripts/migrate-production-schema.mjs')
    const deployIndex = workflow.indexOf('bun scripts/promote-railway-images.mjs')

    assert.notEqual(gateIndex, -1)
    assert.ok(gateIndex < deployIndex)
    assert.match(workflow, /group: control-plane-production-deployment/)
    assert.match(workflow, /cancel-in-progress: false/)
    assert.match(workflow, /DATABASE_MIGRATION_URL: \$\{\{ secrets\.DATABASE_MIGRATION_URL \}\}/)
    // Production promotes control-api only while the cloud execution runtime
    // is disabled, and because the platform healthcheck is liveness-only the
    // deploy must still prove database readiness once.
    assert.match(workflow, /target: \[control-api\]/)
    const readyProbe = workflow.split('- name: Verify production readiness after deploy')[1]
    assert.match(readyProbe, /control-planecontrol-api-production\.up\.railway\.app\/ready/)
    assert.ok(deployIndex < workflow.indexOf('- name: Verify production readiness after deploy'))
  })
})

const productionTargetFixture = () => ({
  schemaVersion: 1,
  provider: 'railway-postgres',
  status: 'verified',
  identity: {
    serviceId: '11111111-1111-4111-8111-111111111111',
    environmentId: '52f5b0ac-2af0-4792-aa56-30d80e5db31e',
    runtimeVerification: { hostname: 'migration.example.invalid', port: 6432 },
    tls: { serverName: 'migration.example.invalid', caSha256: null },
    database: 'control_plane_fixture',
    migration: { hostname: 'migration.example.invalid', port: 6432 },
    runtime: { hostname: 'runtime.example.invalid', port: 5432 },
  },
})

test('unverified target metadata refuses migration before any provider or database I/O', async () => {
  await assert.rejects(
    migrateProductionSchemaRecorded({
      productionDatabaseContract: {
        schemaVersion: 1,
        provider: 'railway-postgres',
        status: 'pending-verification',
        identity: null,
      },
      environment: {
        DATABASE_MIGRATION_URL: 'postgresql://untrusted:placeholder@untrusted.invalid/database',
      },
      railway: {
        getServiceVariables() {
          assert.fail('provider must not be queried')
        },
      },
      openMigrationSession() {
        assert.fail('database must not open')
      },
    }),
    /not verified/
  )
})

test('URL roles, exact endpoint ports, database identity and verified TLS are enforced', () => {
  const contract = productionTargetFixture()
  const migration =
    'postgresql://control_plane_migrator:placeholder@migration.example.invalid:6432/control_plane_fixture?sslmode=verify-full'
  const runtime =
    'postgresql://control_plane_app:placeholder@runtime.example.invalid/control_plane_fixture?sslmode=require'
  assert.equal(assertProductionMigrationUrlRecorded(migration, contract).port, '6432')
  assert.equal(
    assertRuntimeDatabaseUrlRecorded(runtime, contract).hostname,
    'runtime.example.invalid'
  )
  for (const value of [
    migration.replace('migration.example.invalid', 'untrusted.example.invalid'),
    migration.replace(':6432/', ':5432/'),
    migration.replace('control_plane_fixture', 'other_database'),
    migration.replace('control_plane_migrator', 'control_plane_app'),
    migration.replace('verify-full', 'require'),
    migration.replace('verify-full', 'disable'),
    `${migration}&sslmode=disable`,
    `${migration}&options=-c%20role%3Dpostgres`,
  ])
    assert.throws(
      () => assertProductionMigrationUrlRecorded(value, contract),
      /role, database, host, or TLS policy/
    )
  assert.throws(
    () =>
      assertRuntimeDatabaseUrlRecorded(runtime.replace('control_plane_app', 'postgres'), contract),
    /role, database, host, or TLS policy/
  )
})

test('only the reviewed provider identity supplies endpoint and database policy', () => {
  const target = resolveProductionDatabaseTarget(productionTargetFixture())
  assert.deepEqual(target.migration, {
    hostname: 'migration.example.invalid',
    port: 6432,
    database: 'control_plane_fixture',
    username: 'control_plane_migrator',
  })
  assert.equal(target.runtime.username, 'control_plane_app')
  assert.equal(target.runtime.database, target.database)
})

test('missing, malformed, unverified and credential-bearing metadata is rejected', () => {
  for (const mutate of [
    (value) => {
      value.status = 'pending-verification'
    },
    (value) => {
      value.provider = 'postgres'
    },
    (value) => {
      value.identity = null
    },
    (value) => {
      value.identity.serviceId = 'unverified-service'
    },
    (value) => {
      value.identity.database = 'database/other'
    },
    (value) => {
      value.identity.migration.hostname = 'user:secret@database.invalid'
    },
    (value) => {
      value.identity.migration.port = 0
    },
    (value) => {
      value.identity.runtime.port = 65536
    },
    (value) => {
      value.identity.runtime.password = 'must-not-be-source-metadata'
    },
    (value) => {
      value.identity.unexpected = true
    },
  ]) {
    const value = productionTargetFixture()
    mutate(value)
    assert.throws(() => resolveProductionDatabaseTarget(value), /not verified|invalid/)
  }
})

test('runtime verification maps only the reviewed host and port and preserves runtime credentials', () => {
  const value = runtimeUrl.replace('placeholder', 'synthetic%40password%3Avalue')
  const mapped = runtimeVerificationUrl(value, productionDatabaseContract)
  const original = new URL(value)
  const expected = new URL(value)
  expected.hostname = 'migration.example.invalid'
  expected.port = '6432'
  assert.equal(mapped.href, expected.href)
  assert.equal(mapped.username, original.username)
  assert.equal(mapped.password, original.password)
  assert.equal(mapped.pathname, original.pathname)
  for (const mutation of [
    (contract) => {
      contract.identity.environmentId = '11111111-1111-4111-8111-111111111111'
    },
    (contract) => {
      contract.identity.runtimeVerification.hostname = 'untrusted.invalid'
    },
    (contract) => {
      contract.identity.runtimeVerification.port = 5432
    },
    (contract) => {
      contract.identity.runtimeVerification.password = 'forbidden'
    },
  ]) {
    const contract = structuredClone(productionDatabaseContract)
    mutation(contract)
    assert.throws(() => runtimeVerificationUrl(value, contract), /not verified|invalid/)
  }
  for (const invalidUrl of [
    runtimeUrl.replace('runtime.example.invalid', 'other.invalid'),
    runtimeUrl.replace('control_plane_app', 'postgres'),
    runtimeUrl.replace('control_plane_fixture', 'other_database'),
    runtimeUrl.replace('/control_plane_fixture', ':6432/control_plane_fixture'),
  ])
    assert.throws(
      () => runtimeVerificationUrl(invalidUrl, productionDatabaseContract),
      /TLS policy/
    )
})

// These are real postgres.js SSLRequest/TLS handshakes on loopback, including
// the actual migration executor. No database, credential or external route is used.
//
// Every scenario and runtime still gets its own child process. Inside one child, the three operations run one after
// another, and each builds its own contract, TLS policy and client, so nothing but the process (and its fixed
// environment, which never depended on the operation) is shared between operations. Each child prints one labelled
// JSON line per operation: 6 scenarios give 27 labels over 9 children.
const TLS_OPERATIONS = ['inspection', 'runtime-verification', 'migration']
const TLS_SCENARIOS = [
  'trusted',
  'untrusted',
  'expired',
  'wrong-host',
  'pinned-peer',
  'pinned-wrong-peer',
]
const TLS_EXPECTED_CODES = {
  trusted: 'XX999',
  'pinned-peer': 'XX999',
  untrusted: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  expired: 'CERT_HAS_EXPIRED',
  'wrong-host': 'ERR_TLS_CERT_ALTNAME_INVALID',
  'pinned-wrong-peer': 'ERR_TLS_CERT_ALTNAME_INVALID',
}
const tlsRuntimes = (scenario) =>
  scenario.startsWith('pinned-') || scenario === 'trusted'
    ? [
        { name: 'node', command: 'node' },
        { name: 'host', command: process.execPath },
      ]
    : [{ name: 'node', command: 'node' }]
const tlsLabel = (scenario, runtime, operation) => `${scenario}/${runtime}/${operation}`
const tlsLabels = (scenario, runtime) =>
  TLS_OPERATIONS.map((operation) => tlsLabel(scenario, runtime, operation))

/** Parses a child's labelled JSON lines against the labels it must have printed. */
function parseTlsResults(stdout, expectedLabels) {
  const results = new Map()
  const problems = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    let result
    try {
      result = JSON.parse(line)
    } catch {
      problems.push(`unparseable result line: ${line.slice(0, 80)}`)
      continue
    }
    if (typeof result?.label !== 'string') {
      problems.push(`result line without a label: ${line.slice(0, 80)}`)
    } else if (!expectedLabels.includes(result.label)) {
      problems.push(`unexpected result label: ${result.label}`)
    } else if (results.has(result.label)) {
      problems.push(`duplicate result label: ${result.label}`)
    } else {
      results.set(result.label, result)
    }
  }
  for (const label of expectedLabels)
    if (!results.has(label)) problems.push(`missing result label: ${label}`)
  return { results, problems }
}

/** Runs one child to completion and keeps whatever it printed, so a failed exit never hides its results. */
async function runTlsChild(execFile, command, args, options) {
  try {
    const { stdout } = await execFile(command, args, options)
    return { stdout, failure: undefined }
  } catch (error) {
    return {
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      failure: `exit ${error.code ?? 'none'} signal ${error.signal ?? 'none'}${error.killed ? ' (killed)' : ''}`,
    }
  }
}

/** One accepted PostgreSQL SSLRequest per connection; the secure context may differ per connection. */
async function startTlsServer(contextFor) {
  const sockets = new Set()
  const connections = []
  const server = createServer((socket) => {
    const connection = { sessionReused: undefined }
    const index = connections.push(connection) - 1
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    let request = Buffer.alloc(0)
    const receive = (chunk) => {
      request = Buffer.concat([request, chunk])
      if (request.length < 8) return
      socket.off('data', receive)
      assert.deepEqual([...request.subarray(0, 8)], [0, 0, 0, 8, 4, 210, 22, 47])
      socket.write('S')
      const secure = new TLSSocket(socket, { isServer: true, secureContext: contextFor(index) })
      secure.on('error', () => {})
      secure.once('secure', () => {
        connection.sessionReused = secure.isSessionReused()
      })
      secure.once('data', () => {
        // A trusted handshake reaches PostgreSQL startup. This synthetic
        // error proves that success was beyond TLS, without executing SQL.
        const fields = Buffer.from('SERROR\0CXX999\0Msynthetic TLS accepted\0\0')
        const header = Buffer.alloc(5)
        header[0] = 69
        header.writeInt32BE(fields.length + 4, 1)
        secure.end(Buffer.concat([header, fields]))
      })
    }
    socket.on('data', receive)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    port: server.address().port,
    connections,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** The child program: the three operations in order, each with a fresh contract, TLS policy and client. */
function tlsChildScript({ port, tlsIdentity, certificate, prefix }) {
  return `
    import { resolveProductionDatabaseTls } from './scripts/production-database-target.mjs';
    import { createPostgresSession, runtimeVerificationUrl } from './scripts/migrate-production-schema.mjs';
    import { migrateDatabase } from './packages/database/dist/migration.js';
    const url = 'postgresql://synthetic:synthetic@localhost:${port}/synthetic?sslmode=require';
    const baseContract = ${JSON.stringify(productionDatabaseContract)};
    const tlsIdentity = ${JSON.stringify(tlsIdentity)};
    const certificate = ${JSON.stringify(certificate) ?? 'undefined'};
    async function attempt(operation) {
      const label = ${JSON.stringify(prefix)} + '/' + operation;
      const contract = structuredClone(baseContract);
      contract.identity.migration = {hostname:'localhost', port:${port}};
      contract.identity.runtimeVerification = {...contract.identity.migration};
      contract.identity.tls = structuredClone(tlsIdentity);
      const tls = resolveProductionDatabaseTls(contract, certificate);
      let session;
      try {
        if (operation !== 'migration') {
          let target = new URL(url);
          if (operation === 'runtime-verification') {
            target = runtimeVerificationUrl(${JSON.stringify(runtimeUrl)}, contract);
          }
          session = createPostgresSession(target, {connectTimeoutSeconds:2, statementTimeoutMs:1000, lockTimeoutMs:1000}, tls);
          await session.readConnectedRole();
        } else {
          await migrateDatabase({role:'migration',url}, {verifyTls:true,connectTimeoutSeconds:2,...(typeof tls === 'object' ? {tls} : {})});
        }
        return {label, connected: true};
      } catch (error) {
        return {label, code: error.code ?? error.cause?.code, message: error.cause?.message ?? error.message};
      } finally {
        if (session) await session.close();
      }
    }
    for (const operation of ${JSON.stringify(TLS_OPERATIONS)}) {
      let result;
      try {
        result = await attempt(operation);
      } catch (error) {
        result = {label: ${JSON.stringify(prefix)} + '/' + operation, code: 'HARNESS_ERROR', message: String(error?.message ?? error)};
      }
      // A connection that succeeded or a harness error is never the expected outcome.
      if (result.connected || result.code === 'HARNESS_ERROR') process.exitCode = 1;
      console.log(JSON.stringify(result));
    }
  `
}

const tlsChildEnvironment = (scenario, certificatePath) => {
  const env = { ...process.env }
  delete env.NODE_TLS_REJECT_UNAUTHORIZED
  delete env.NODE_EXTRA_CA_CERTS
  if (!scenario.startsWith('pinned-') && scenario !== 'untrusted')
    env.NODE_EXTRA_CA_CERTS = certificatePath
  return env
}
const tlsChildArguments = (runtime, script) =>
  runtime.name === 'node'
    ? ['--dns-result-order=ipv4first', '--input-type=module', '-e', script]
    : ['--eval', script]

async function generateCertificate(execFile, directory, name, { san, days = '1' }) {
  const key = join(directory, `${name}.key`)
  const cert = join(directory, `${name}.crt`)
  await execFile('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    cert,
    '-days',
    days,
    '-subj',
    '/CN=synthetic-local-test',
    '-addext',
    `subjectAltName=DNS:${san}`,
  ])
  return { key, cert }
}

test('TLS batch results are verified for missing, duplicate, unexpected and malformed lines', () => {
  const labels = tlsLabels('untrusted', 'node')
  const line = (label) => JSON.stringify({ label, code: 'X' })
  const ok = parseTlsResults(labels.map(line).join('\n'), labels)
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.results.size, 3)
  assert.deepEqual(parseTlsResults(labels.slice(0, 2).map(line).join('\n'), labels).problems, [
    `missing result label: ${labels[2]}`,
  ])
  assert.deepEqual(parseTlsResults([...labels, labels[0]].map(line).join('\n'), labels).problems, [
    `duplicate result label: ${labels[0]}`,
  ])
  assert.deepEqual(
    parseTlsResults([...labels, 'other/node/migration'].map((l) => line(l)).join('\n'), labels)
      .problems,
    ['unexpected result label: other/node/migration']
  )
  assert.deepEqual(
    parseTlsResults([labels[0], labels[1]].map(line).join('\n') + '\nnot json', labels).problems,
    ['unparseable result line: not json', `missing result label: ${labels[2]}`]
  )
  assert.deepEqual(parseTlsResults(`${line(labels[0])}\n{"code":"X"}`, labels).problems, [
    'result line without a label: {"code":"X"}',
    `missing result label: ${labels[1]}`,
    `missing result label: ${labels[2]}`,
  ])
})

test('a TLS child that exits non-zero or is killed is reported together with what it printed', async () => {
  const execFile = promisify(execFileCallback)
  const printed = JSON.stringify({ label: 'untrusted/node/inspection', code: 'X' })
  const failed = await runTlsChild(
    execFile,
    'node',
    ['-e', `console.log(${JSON.stringify(printed)}); process.exitCode = 3`],
    { timeout: 10000 }
  )
  assert.equal(failed.failure, 'exit 3 signal none')
  assert.deepEqual(
    parseTlsResults(failed.stdout, tlsLabels('untrusted', 'node')).problems,
    tlsLabels('untrusted', 'node')
      .slice(1)
      .map((label) => `missing result label: ${label}`)
  )
  const killed = await runTlsChild(execFile, 'node', ['-e', 'setTimeout(() => {}, 30000)'], {
    timeout: 300,
  })
  assert.match(killed.failure, /signal SIGTERM \(killed\)/)
  const clean = await runTlsChild(execFile, 'node', ['-e', '0'], { timeout: 10000 })
  assert.equal(clean.failure, undefined)
})

test(
  'inspection, runtime verification and migration enforce certificate chain, expiry and hostname',
  { timeout: 60000 },
  async () => {
    const execFile = promisify(execFileCallback)
    const directory = await mkdtemp(join(tmpdir(), 'cp-schema-tls-'))
    const problems = []
    const seen = new Map()
    try {
      for (const scenario of TLS_SCENARIOS) {
        const { key, cert } = await generateCertificate(execFile, directory, scenario, {
          san: scenario.startsWith('pinned-')
            ? 'synthetic-peer.invalid'
            : scenario === 'wrong-host'
              ? 'other.invalid'
              : 'localhost',
        })
        if (scenario === 'expired') {
          const request = join(directory, 'expired.csr')
          const config = join(directory, 'ca.cnf')
          await writeFile(join(directory, 'index'), '')
          await writeFile(join(directory, 'serial'), '01\n')
          await writeFile(
            config,
            `[ca]\ndefault_ca=local\n[local]\ndatabase=${directory}/index\nserial=${directory}/serial\nnew_certs_dir=${directory}\ndefault_md=sha256\npolicy=policy\nx509_extensions=extensions\n[policy]\ncommonName=supplied\n[extensions]\nsubjectAltName=DNS:localhost\n`
          )
          await execFile('openssl', [
            'req',
            '-new',
            '-key',
            key,
            '-out',
            request,
            '-subj',
            '/CN=synthetic-local-test',
          ])
          await execFile('openssl', [
            'ca',
            '-batch',
            '-selfsign',
            '-config',
            config,
            '-cert',
            cert,
            '-keyfile',
            key,
            '-in',
            request,
            '-out',
            cert,
            '-startdate',
            '20000101000000Z',
            '-enddate',
            '20010101000000Z',
          ])
        }
        if (scenario === 'pinned-peer') {
          const pem = await readFile(cert, 'utf8')
          const contract = structuredClone(productionDatabaseContract)
          contract.identity.tls = { serverName: 'synthetic-peer.invalid', caSha256: '0'.repeat(64) }
          assert.throws(() => resolveProductionDatabaseTls(contract, pem), /CA does not match/)
          contract.identity.tls.caSha256 = createHash('sha256')
            .update(new X509Certificate(pem).raw)
            .digest('hex')
          assert.throws(
            () => resolveProductionDatabaseTls(contract, pem + pem),
            /CA does not match/
          )
          const tlsPolicy = resolveProductionDatabaseTls(contract, pem)
          const session = createFakeSession()
          let calls = 0
          await migrateProductionSchemaRecorded({
            productionDatabaseContract: contract,
            canonicalHistory,
            environment: {
              DATABASE_MIGRATION_URL: migrationUrl,
              DATABASE_MIGRATION_CA_CERTIFICATE: pem,
            },
            railway: fakeRailway(),
            openMigrationSession: async (url, _timeouts, tls) => {
              assert.equal(url.hostname, 'migration.example.invalid')
              assert.deepEqual(tls, tlsPolicy)
              calls += 1
              return session.session
            },
            migrate: async (_credentials, tls) => {
              assert.deepEqual(tls, tlsPolicy)
              calls += 1
            },
          })
          assert.equal(calls, 3)
        }
        const context = createSecureContext({
          key: await readFile(key),
          cert: await readFile(cert),
        })
        const pinnedPem = scenario.startsWith('pinned-') ? await readFile(cert, 'utf8') : undefined
        const tlsIdentity = scenario.startsWith('pinned-')
          ? {
              serverName:
                scenario === 'pinned-peer' ? 'synthetic-peer.invalid' : 'wrong-peer.invalid',
              caSha256: createHash('sha256')
                .update(new X509Certificate(await readFile(cert)).raw)
                .digest('hex'),
            }
          : { serverName: 'localhost', caSha256: null }
        const server = await startTlsServer(() => context)
        try {
          for (const runtime of tlsRuntimes(scenario)) {
            const labels = tlsLabels(scenario, runtime.name)
            const connectionsBefore = server.connections.length
            const script = tlsChildScript({
              port: server.port,
              tlsIdentity,
              certificate: pinnedPem,
              prefix: `${scenario}/${runtime.name}`,
            })
            const { stdout, failure } = await runTlsChild(
              execFile,
              runtime.command,
              tlsChildArguments(runtime, script),
              { env: tlsChildEnvironment(scenario, cert), timeout: 10000 }
            )
            if (failure !== undefined)
              problems.push(`${scenario}/${runtime.name}: child ${failure}`)
            const parsed = parseTlsResults(stdout, labels)
            problems.push(
              ...parsed.problems.map((problem) => `${scenario}/${runtime.name}: ${problem}`)
            )
            // Each of the three operations opened its own connection, and none resumed an earlier TLS session.
            const connections = server.connections.slice(connectionsBefore)
            if (connections.length !== TLS_OPERATIONS.length)
              problems.push(
                `${scenario}/${runtime.name}: expected ${TLS_OPERATIONS.length} connections, saw ${connections.length}`
              )
            if (connections.some((connection) => connection.sessionReused === true))
              problems.push(`${scenario}/${runtime.name}: a TLS session was resumed`)
            // Where the handshake completes the server can see it, so there the fresh session is observed, not assumed.
            if (
              TLS_EXPECTED_CODES[scenario] === 'XX999' &&
              connections.some((connection) => connection.sessionReused !== false)
            )
              problems.push(
                `${scenario}/${runtime.name}: a completed handshake was not observed fresh`
              )
            for (const [label, result] of parsed.results) {
              seen.set(label, result)
              const expected = TLS_EXPECTED_CODES[scenario]
              if (result.code !== expected)
                problems.push(
                  `${label}: expected code ${expected}, got ${result.code ?? 'connected'}`
                )
              else if (
                expected !== 'XX999' &&
                !/certificate|CERT|self.signed|hostname|altname/i.test(
                  `${result.code} ${result.message}`
                )
              )
                problems.push(`${label}: unexpected message ${result.message}`)
            }
          }
        } finally {
          await server.close()
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    assert.equal(seen.size, 27, `expected 27 labelled results, got ${seen.size}`)
    assert.deepEqual(problems, [])
  }
)

test(
  'a valid handshake earlier in the same process cannot mask an invalid certificate later',
  { timeout: 60000 },
  async () => {
    // Connection 0 presents the certificate the child trusts; every later connection to the same host and port presents
    // an untrusted one. If anything cached the first verification, a later operation would connect.
    const execFile = promisify(execFileCallback)
    const directory = await mkdtemp(join(tmpdir(), 'cp-schema-tls-control-'))
    const problems = []
    try {
      const good = await generateCertificate(execFile, directory, 'good', { san: 'localhost' })
      const other = await generateCertificate(execFile, directory, 'other', { san: 'localhost' })
      const contexts = [good, other].map(({ key, cert }) =>
        Promise.all([readFile(key), readFile(cert)]).then(([k, c]) =>
          createSecureContext({ key: k, cert: c })
        )
      )
      const [goodContext, otherContext] = await Promise.all(contexts)
      for (const runtime of [
        { name: 'node', command: 'node' },
        { name: 'host', command: process.execPath },
      ]) {
        const server = await startTlsServer((index) => (index === 0 ? goodContext : otherContext))
        try {
          const prefix = `control/${runtime.name}`
          const labels = TLS_OPERATIONS.map((operation) => `${prefix}/${operation}`)
          const script = tlsChildScript({
            port: server.port,
            tlsIdentity: { serverName: 'localhost', caSha256: null },
            certificate: undefined,
            prefix,
          })
          const { stdout, failure } = await runTlsChild(
            execFile,
            runtime.command,
            tlsChildArguments(runtime, script),
            { env: tlsChildEnvironment('trusted', good.cert), timeout: 10000 }
          )
          if (failure !== undefined) problems.push(`${prefix}: child ${failure}`)
          const parsed = parseTlsResults(stdout, labels)
          problems.push(...parsed.problems)
          if (server.connections.length !== TLS_OPERATIONS.length)
            problems.push(`${prefix}: expected 3 connections, saw ${server.connections.length}`)
          assert.equal(parsed.results.get(labels[0])?.code, 'XX999', labels[0])
          for (const label of labels.slice(1))
            assert.equal(parsed.results.get(label)?.code, 'DEPTH_ZERO_SELF_SIGNED_CERT', label)
        } finally {
          await server.close()
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    assert.deepEqual(problems, [])
  }
)

test('pinned TLS identity fails before provider or database I/O without the exact reviewed CA', async () => {
  const contract = structuredClone(productionDatabaseContract)
  contract.identity.tls = { serverName: 'synthetic-peer.invalid', caSha256: '0'.repeat(64) }
  for (const certificate of [undefined, '', 'not a certificate']) {
    assert.throws(() => resolveProductionDatabaseTls(contract, certificate), /CA does not match/)
    await assert.rejects(
      migrateProductionSchemaRecorded({
        productionDatabaseContract: contract,
        environment: {
          DATABASE_MIGRATION_CA_CERTIFICATE: certificate,
          DATABASE_MIGRATION_URL: migrationUrl,
        },
        railway: {
          getServiceVariables() {
            assert.fail('provider must not be queried')
          },
        },
        openMigrationSession() {
          assert.fail('database must not open')
        },
      }),
      /CA does not match/
    )
  }
  for (const mutate of [
    (value) => {
      value.identity.tls.caSha256 = 'invalid'
    },
    (value) => {
      value.identity.tls.serverName = 'user:password@invalid'
    },
    (value) => {
      value.identity.tls.rejectUnauthorized = false
    },
  ]) {
    const value = structuredClone(contract)
    mutate(value)
    assert.throws(() => resolveProductionDatabaseTls(value, ''), /TLS identity is invalid/)
  }
  assert.throws(
    () => resolveProductionDatabaseTls(productionDatabaseContract, 'arbitrary CA'),
    /CA does not match/
  )
})

test('database clients reject permissive TLS options before creating a connection', async () => {
  const { migrateDatabase } = await import('../packages/database/dist/migration.js')
  for (const tls of [
    { rejectUnauthorized: false },
    { rejectUnauthorized: true, servername: 'peer.invalid', checkServerIdentity: () => undefined },
    { rejectUnauthorized: true, servername: 'peer.invalid', ca: 42 },
  ]) {
    assert.throws(
      () => createPostgresSession(new URL(migrationUrl), undefined, tls),
      /strict database TLS policy/
    )
    await assert.rejects(
      migrateDatabase({ role: 'migration', url: migrationUrl }, { verifyTls: true, tls }),
      /PostgreSQL connection configuration is invalid/
    )
  }
})

test('schema gate CI diagnostics reject arbitrary exception properties and credential-bearing messages', () => {
  const secret = 'postgresql://account:password-fixture@database.invalid/private'
  for (const error of [
    new Error(secret),
    { message: secret, code: secret },
    new Error('Production schema gate failed: ' + secret),
    null,
    secret,
  ]) {
    assert.equal(productionSchemaGateFailure(error), 'unclassified failure')
  }
  assert.throws(
    () => assertProductionMigrationUrl(secret),
    (error) => {
      assert.equal(
        productionSchemaGateFailure(error),
        'database target does not match the required role, database, host, or TLS policy'
      )
      assert.ok(!productionSchemaGateFailure(error).includes('password-fixture'))
      return true
    }
  )
})
