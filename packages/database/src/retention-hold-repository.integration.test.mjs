import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import postgres from 'postgres'
import { loadDatabaseCredentials } from '@control-plane/config'
import { sql } from 'drizzle-orm'
import { createIsolatedTestDatabase } from './testing.ts'
import {
  PostgresRetentionHoldRepository,
  acquirePostgresRetentionHoldClassMutex,
  countPostgresMatchingActiveRetentionHolds,
} from './retention-hold-repository.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherWorkspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const otherProjectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAW'
const policy = {
  'context-packages': {
    owner: 'workspace-owner',
    scopes: ['class', 'workspace', 'project'],
    reasonCodes: ['legal-case'],
  },
  'runtime-ledgers': {
    owner: 'runtime-owner',
    scopes: ['class', 'workspace'],
    reasonCodes: ['legal-case'],
  },
  'evaluation-runs': {
    owner: 'release-owner',
    scopes: ['class'],
    reasonCodes: ['legal-case'],
  },
}
const provenance = {
  actorPrincipalRef: 'operator:os-user:postgres-test',
  authorityRef: 'authority:postgres:test-database',
}

describe.skipIf(!enabled)('PostgreSQL durable retention holds', () => {
  let isolated
  let repository

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    await installTestOnlyHoldTables(isolated.name)
    repository = new PostgresRetentionHoldRepository(isolated.application, policy)
  }, 60_000)

  afterAll(async () => {
    await isolated?.dispose()
  })

  test('persists immutable holds, explicit release revisions, and replay without reactivation', async () => {
    const hold = makeHold({ kind: 'project', workspaceId, projectId })
    expect(await repository.create(hold)).toEqual({ created: true, hold })
    expect(await repository.create(hold)).toEqual({ created: false, hold })

    const release = {
      requestId: randomUUID(),
      releasedAt: '2026-09-26T13:00:00.000Z',
      releasedBy: provenance,
    }
    const released = { ...hold, revision: 1, release }
    expect(await repository.release({ holdId: hold.holdId, expectedRevision: 0, release })).toEqual(
      { released: true, hold: released }
    )
    expect(await repository.release({ holdId: hold.holdId, expectedRevision: 0, release })).toEqual(
      { released: false, hold: released }
    )
    expect(await repository.create(hold)).toEqual({ created: false, hold: released })
    expect(await repository.get(hold.holdId)).toEqual(released)

    await expect(repository.create({ ...hold, reasonCode: 'different-case' })).rejects.toThrow(
      'RETENTION_HOLD_ID_CONFLICT'
    )
    await expect(
      repository.release({
        holdId: hold.holdId,
        expectedRevision: 1,
        release: { ...release, requestId: randomUUID() },
      })
    ).rejects.toThrow('RETENTION_HOLD_ALREADY_RELEASED')
  })

  test('matching counts isolate projects and fail closed when target scope is incomplete', async () => {
    const holds = [
      makeHold({ kind: 'class' }),
      makeHold({ kind: 'workspace', workspaceId }),
      makeHold({ kind: 'project', workspaceId, projectId }),
      makeHold({ kind: 'project', workspaceId: otherWorkspaceId, projectId: otherProjectId }),
    ]
    for (const hold of holds) await repository.create(hold)

    const count = (scope) =>
      isolated.application.transaction((transaction) =>
        countPostgresMatchingActiveRetentionHolds(
          transaction,
          { classId: 'context-packages', ...(scope === undefined ? {} : { scope }) },
          policy
        )
      )
    expect(await count({ kind: 'project', workspaceId, projectId })).toBe(3)
    expect(await count({ kind: 'project', workspaceId, projectId: otherProjectId })).toBe(2)
    await expect(count({ kind: 'workspace', workspaceId })).rejects.toThrow(
      'RETENTION_HOLD_TARGET_SCOPE_MISSING'
    )
    await expect(count(undefined)).rejects.toThrow('RETENTION_HOLD_TARGET_SCOPE_MISSING')
  })

  test('rejects inherited class-policy keys before writing a hold', async () => {
    const hold = makeHold({ kind: 'class' }, { classId: 'constructor' })
    await expect(repository.create(hold)).rejects.toThrow('RETENTION_HOLD_CLASS_UNCONFIGURED')
    expect(await repository.get(hold.holdId)).toBeUndefined()
    await expect(
      isolated.application.transaction((transaction) =>
        countPostgresMatchingActiveRetentionHolds(transaction, { classId: 'constructor' }, policy)
      )
    ).rejects.toThrow('RETENTION_HOLD_CLASS_UNCONFIGURED')
  })

  test('a hold writer waits behind a delete claim holding the shared class mutex', async () => {
    const hold = makeHold({ kind: 'class' }, { classId: 'evaluation-runs', owner: 'release-owner' })
    const targetId = randomUUID()
    await isolated.application.execute(
      sql`insert into retention_hold_test_targets (target_id) values (${targetId})`
    )

    const claimed = deferred()
    const finishClaim = deferred()
    const claim = isolated.application.transaction(async (transaction) => {
      await acquirePostgresRetentionHoldClassMutex(transaction, hold.classId)
      expect(
        await countPostgresMatchingActiveRetentionHolds(
          transaction,
          { classId: hold.classId, scope: { kind: 'class' } },
          policy
        )
      ).toBe(0)
      await transaction.execute(
        sql`delete from retention_hold_test_targets where target_id = ${targetId}`
      )
      claimed.resolve()
      await finishClaim.promise
    })
    await claimed.promise

    let writerSettled = false
    const write = repository.create(hold).then((result) => {
      writerSettled = true
      return result
    })
    expect(await waitForAdvisoryWait(isolated.application)).toBe(true)
    expect(writerSettled).toBe(false)
    finishClaim.resolve()
    await claim
    expect(await write).toEqual({ created: true, hold })
    const targets = await isolated.application.execute(
      sql`select target_id from retention_hold_test_targets where target_id = ${targetId}`
    )
    expect(targets).toHaveLength(0)
  })
})

function makeHold(scope, overrides = {}) {
  return {
    holdId: randomUUID(),
    classId: 'context-packages',
    scope,
    owner: 'workspace-owner',
    reasonCode: 'legal-case',
    createdAt: '2026-09-26T12:00:00.000Z',
    createdBy: provenance,
    revision: 0,
    ...overrides,
  }
}

function deferred() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function waitForAdvisoryWait(database) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = await database.execute(
      sql`select query from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
    )
    if (rows.some((row) => row.query.includes('pg_advisory_xact_lock'))) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

async function installTestOnlyHoldTables(databaseName) {
  const credentials = loadDatabaseCredentials(process.env, 'migration')
  const url = new URL(credentials.url)
  url.pathname = `/${databaseName}`
  const migration = postgres(url.toString(), { max: 1, prepare: false })
  try {
    await migration.unsafe(`
      create table retention_holds (
        hold_id varchar(36) primary key,
        class_id varchar(64) not null,
        scope_kind varchar(16) not null,
        workspace_id varchar(30),
        project_id varchar(30),
        hold_owner varchar(64) not null,
        reason_code varchar(64) not null,
        created_at timestamptz not null,
        created_by_principal_ref varchar(256) not null,
        created_authority_ref varchar(256) not null,
        revision integer not null default 0,
        release_request_id varchar(36),
        released_at timestamptz,
        released_by_principal_ref varchar(256),
        release_authority_ref varchar(256),
        constraint retention_holds_scope_shape_check check (
          (scope_kind = 'class' and workspace_id is null and project_id is null) or
          (scope_kind = 'workspace' and workspace_id is not null and project_id is null) or
          (scope_kind = 'project' and workspace_id is not null and project_id is not null)
        ),
        constraint retention_holds_release_revision_check check (
          (revision = 0 and release_request_id is null and released_at is null and released_by_principal_ref is null and release_authority_ref is null) or
          (revision = 1 and release_request_id is not null and released_at is not null and released_by_principal_ref is not null and release_authority_ref is not null)
        )
      );
      create index retention_holds_scope_index on retention_holds (
        class_id, released_at, scope_kind, workspace_id, project_id
      );
      create table retention_hold_test_targets (target_id varchar(36) primary key);
    `)
  } finally {
    await migration.end({ timeout: 5 })
  }
}
