import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'

import {
  assertMutationSucceeded,
  createRailwayClient,
  promoteRailwayImages,
} from '../scripts/promote-railway-images.mjs'
import {
  assertAppliedHistoryPrefix,
  assertProductionMigrationUrl,
  assertRetentionReferenceColumns,
  assertRuntimeCapabilities,
  assertRuntimeDatabaseUrl,
  createRailwayVariableReader,
  createPostgresSession,
  loadCanonicalMigrationHistory,
  migrateProductionSchema,
} from '../scripts/migrate-production-schema.mjs'

const migrationUrl =
  'postgresql://control_plane_migrator:placeholder@ep-crimson-bird-ay77m275.c-5.us-east-2.aws.neon.tech/neondb?sslmode=verify-full'
const runtimeUrl =
  'postgresql://control_plane_app:placeholder@ep-crimson-bird-ay77m275-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require'
const canonicalHistory = [
  { idx: 0, when: 1000, tag: '0000_first_migration', hash: 'a'.repeat(64) },
  { idx: 1, when: 2000, tag: '0001_second_migration', hash: 'b'.repeat(64) },
  { idx: 2, when: 3000, tag: '0002_third_migration', hash: 'c'.repeat(64) },
]

function appliedHistory(entries) {
  return entries.map(({ hash, when }) => ({ hash, created_at: String(when) }))
}

function productionRuntimeVariables() {
  return new Map([
    ['9167a33b-af0f-4780-8614-a5a161697c9c', { DATABASE_URL: runtimeUrl }],
    ['d733ec0d-bda5-4be5-86b9-637154d282eb', { DATABASE_URL: runtimeUrl }],
  ])
}

function runtimeCapabilities(overrides = {}) {
  return {
    application_role: true,
    database_name: 'neondb',
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
          database_name: 'neondb',
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
  {
    target: 'workflow-worker',
    image: 'ghcr.io/adea-ai/control-plane-workflow-worker',
    digest: `sha256:${'b'.repeat(64)}`,
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
    assert.equal(sourceReads.get('workflow-worker'), 3)
  })

  test('restores every intended service when a later mutation is ambiguous', async () => {
    const sources = new Map([
      ['control-api', { image: 'control-api@sha256:prior', repo: null }],
      ['workflow-worker', { image: 'workflow-worker@sha256:prior', repo: null }],
    ])
    const deployments = new Map([
      [
        'control-api',
        [deployment({ id: 'control-prior', meta: { imageDigest: 'sha256:control-prior' } })],
      ],
      [
        'workflow-worker',
        [deployment({ id: 'worker-prior', meta: { imageDigest: 'sha256:worker-prior' } })],
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
        if (updateCount === 2) {
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
      [
        ['rollback', 'workflow-worker', 'worker-prior'],
        ['rollback', 'control-api', 'control-prior'],
      ]
    )
    assert(calls.some(([operation, target]) => operation === 'update' && target === 'control-api'))
    assert(calls.some(([operation, target]) => operation === 'deploy' && target === 'control-api'))
    assert(
      calls.some(([operation, target]) => operation === 'update' && target === 'workflow-worker')
    )
  })

  test('returns a first activation to verified standby when no prior deployment exists', async () => {
    const calls = []
    const sources = new Map([
      ['control-api', { image: null, repo: null }],
      ['workflow-worker', { image: null, repo: null }],
    ])
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
        if (target === 'workflow-worker' && source.image !== null) {
          throw new Error('second service failed')
        }
      },
      async deploySource(target) {
        calls.push(['deploy', target])
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
      /second service failed/
    )

    assert(
      calls.some(
        ([operation, target, id]) =>
          operation === 'remove' && target === 'control-api' && id === 'new-control-api'
      )
    )
    assert(!calls.some(([operation]) => operation === 'rollback'))
  })
})

describe('production schema migration gate', () => {
  test('constructs and closes the installed postgres client without opening a remote connection', async () => {
    const session = createPostgresSession(
      new URL('postgresql://local_test:placeholder@127.0.0.1:1/neondb?sslmode=verify-full')
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

  test('validates both pooled runtime bindings before opening the migration connection', async () => {
    const session = createFakeSession()
    const variables = productionRuntimeVariables()
    variables.set('d733ec0d-bda5-4be5-86b9-637154d282eb', {
      DATABASE_URL: runtimeUrl.replace('control_plane_app', 'control_plane_migrator'),
    })
    let opened = false

    await assert.rejects(
      migrateProductionSchema({
        environment: { NEON_PRODUCTION_MIGRATION_URL: migrationUrl },
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
      environment: { NEON_PRODUCTION_MIGRATION_URL: migrationUrl },
      railway,
      canonicalHistory,
      openMigrationSession: async (url, timeouts) => {
        assert.equal(
          url.hostname,
          url.username === 'control_plane_migrator'
            ? 'ep-crimson-bird-ay77m275.c-5.us-east-2.aws.neon.tech'
            : 'ep-crimson-bird-ay77m275-pooler.c-5.us-east-2.aws.neon.tech'
        )
        assert.deepEqual(timeouts, {
          connectTimeoutSeconds: 10,
          statementTimeoutMs: 120_000,
          lockTimeoutMs: 5_000,
        })
        calls.push(url.username === 'control_plane_migrator' ? 'open-migrator' : 'open-runtime')
        return session.session
      },
      migrate: async (credentials) => {
        calls.push('migrate')
        assert.equal(credentials.role, 'migration')
        assert.equal(credentials.url, new URL(migrationUrl).href)
      },
    })

    assert.deepEqual(calls, [
      'variables:9167a33b-af0f-4780-8614-a5a161697c9c',
      'variables:d733ec0d-bda5-4be5-86b9-637154d282eb',
      'open-migrator',
      'migrate',
      'open-runtime',
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
        environment: { NEON_PRODUCTION_MIGRATION_URL: migrationUrl },
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
        environment: { NEON_PRODUCTION_MIGRATION_URL: migrationUrl },
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
    assert.match(
      workflow,
      /NEON_PRODUCTION_MIGRATION_URL: \$\{\{ secrets\.NEON_PRODUCTION_MIGRATION_URL \}\}/
    )
  })
})
