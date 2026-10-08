import { expect, test } from 'bun:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { countPostgresMatchingActiveRetentionHolds } from './retention-hold-repository.ts'

const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const projectId = 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const policy = {
  'context-packages': {
    owner: 'workspace-owner',
    scopes: ['class', 'workspace', 'project'],
    reasonCodes: ['legal-case'],
  },
}

test('PostgreSQL hold lookup filters active rows to a matching project scope', async () => {
  const captured = captureQuery()
  const count = await countPostgresMatchingActiveRetentionHolds(
    captured.transaction,
    { classId: 'context-packages', scope: { kind: 'project', workspaceId, projectId } },
    policy
  )

  expect(count).toBe(0)
  expect(captured.query.params).toEqual([
    'context-packages',
    'class',
    'workspace',
    workspaceId,
    'project',
    workspaceId,
    projectId,
  ])
  expect(captured.query.sql).toContain('"released_at" is null')
  expect(captured.query.sql).toContain('"project_id" = $7')
})

test('workspace lookup also reads nested project holds to fail closed on incomplete scope', async () => {
  const captured = captureQuery()
  const count = await countPostgresMatchingActiveRetentionHolds(
    captured.transaction,
    { classId: 'context-packages', scope: { kind: 'workspace', workspaceId } },
    policy
  )

  expect(count).toBe(0)
  expect(captured.query.params).toEqual([
    'context-packages',
    'class',
    'workspace',
    workspaceId,
    'project',
    workspaceId,
  ])
  expect(captured.query.sql).not.toContain('"project_id" =')
})

test('explicit workspace execution ownership ignores unrelated project holds while incomplete legacy scope fails closed', async () => {
  const row = {
    holdId: '00000000-0000-4000-8000-000000000001',
    classId: 'context-packages',
    scopeKind: 'project',
    workspaceId,
    projectId,
    owner: 'workspace-owner',
    reasonCode: 'legal-case',
    createdAt: new Date('2026-10-08T12:00:00.000Z'),
    createdByPrincipalRef: 'principal://fixture',
    createdAuthorityRef: 'authority://fixture',
    revision: 0,
    releaseRequestId: null,
    releasedAt: null,
    releasedByPrincipalRef: null,
    releaseAuthorityRef: null,
  }
  const target = {
    classId: 'context-packages',
    scope: {
      kind: 'workspace',
      workspaceId,
      executionScope: { schemaVersion: 1, kind: 'workspace' },
    },
  }
  expect(
    await countPostgresMatchingActiveRetentionHolds(captureQuery([row]).transaction, target, policy)
  ).toBe(0)
  expect(
    await countPostgresMatchingActiveRetentionHolds(
      captureQuery([{ ...row, scopeKind: 'workspace', projectId: null }]).transaction,
      target,
      policy
    )
  ).toBe(1)
  await expect(
    countPostgresMatchingActiveRetentionHolds(
      captureQuery([row]).transaction,
      { classId: target.classId, scope: { kind: 'workspace', workspaceId } },
      policy
    )
  ).rejects.toThrow('RETENTION_HOLD_TARGET_SCOPE_MISSING')
  await expect(
    countPostgresMatchingActiveRetentionHolds(
      captureQuery().transaction,
      {
        classId: target.classId,
        scope: {
          kind: 'workspace',
          workspaceId,
          executionScope: { schemaVersion: 1, kind: 'project', projectId },
        },
      },
      policy
    )
  ).rejects.toThrow('RETENTION_HOLD_TARGET_SCOPE_MISSING')
})

function captureQuery(rows = []) {
  const captured = {}
  return {
    get query() {
      return captured.query
    },
    transaction: {
      select() {
        return {
          from() {
            return {
              where(predicate) {
                captured.query = new PgDialect().sqlToQuery(predicate)
                return Promise.resolve(rows)
              },
            }
          },
        }
      },
    },
  }
}
