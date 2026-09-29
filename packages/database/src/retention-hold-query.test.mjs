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

function captureQuery() {
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
                return Promise.resolve([])
              },
            }
          },
        }
      },
    },
  }
}
