import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  GraphDefinitionCatalog,
  InMemoryGraphDefinitionRepository,
} from '@control-plane/orchestration'
import { sql } from 'drizzle-orm'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresGraphDefinitionRepository } from './graph-definition-repository.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const otherWorkspaceId = 'wsp_01JABCDEF0123456789ABCDEGH'
const publishedAt = '2026-09-30T00:00:00.000Z'

async function graph(name) {
  return new GraphDefinitionCatalog(new InMemoryGraphDefinitionRepository()).publish({
    publishedAt,
    definition: {
      graphDefinitionId: `graph:${name}`,
      graphVersion: '1.0.0',
      schemaVersion: 1,
      nodes: [{ node: 'run', operation: { kind: 'runtime', name: 'execute' } }],
      edges: [
        { from: '__start__', to: 'run' },
        { from: 'run', to: '__end__' },
      ],
      schemas: { input: 'input:v1', state: 'state:v1', output: 'output:v1' },
      requiredCapabilities: [],
      compatibility: {
        contractMajorVersions: [1],
        compilerVersions: ['1.0.0'],
        adapterVersions: ['1.4.12'],
      },
    },
  })
}

describe.skipIf(process.env.RUN_DATABASE_INTEGRATION !== 'true')(
  'workspace-scoped PostgreSQL graph definitions',
  () => {
    let isolated
    let repository

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase({
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      })
      await isolated.migrate()
      repository = new PostgresGraphDefinitionRepository(isolated.application, workspaceId)
    }, 60_000)

    afterAll(async () => {
      await isolated?.dispose()
    })

    test('persists immutable pins after repository reconstruction and isolates workspaces', async () => {
      const published = await graph('persist')
      expect(await repository.insert(published)).toBe(true)
      const reconstructed = new PostgresGraphDefinitionRepository(isolated.application, workspaceId)
      expect(await reconstructed.get('graph:persist', '1.0.0')).toEqual(published)
      const other = new PostgresGraphDefinitionRepository(isolated.application, otherWorkspaceId)
      expect(await other.get('graph:persist', '1.0.0')).toBeUndefined()
      expect(await other.insert(published)).toBe(true)
      expect(await other.get('graph:persist', '1.0.0')).toEqual(published)
      await expect(
        new GraphDefinitionCatalog(reconstructed).getPinned({
          ...published.reference,
          contentDigest: `sha256:${'a'.repeat(64)}`,
        })
      ).rejects.toMatchObject({ code: 'GRAPH_DIGEST_MISMATCH' })
    })

    test('concurrent insert and lifecycle CAS have one winner and preserve immutable history', async () => {
      const published = await graph('race')
      const inserted = await Promise.all(
        Array.from({ length: 8 }, () => repository.insert(published))
      )
      expect(inserted.filter(Boolean)).toHaveLength(1)
      const next = {
        ...published,
        revision: 2,
        lifecycle: 'deprecated',
        changedAt: '2026-09-30T01:00:00.000Z',
        reason: 'replacement',
      }
      const changes = await Promise.all(
        Array.from({ length: 8 }, () => repository.compareAndSet(1, next))
      )
      expect(changes.filter(Boolean)).toHaveLength(1)
      expect(await repository.get('graph:race', '1.0.0')).toEqual(next)
      expect(await repository.compareAndSet(1, next)).toBe(false)
      for (const invalid of [
        { ...next, revision: 4, lifecycle: 'revoked' },
        { ...next, revision: 3, lifecycle: 'published' },
        { ...next, revision: 3, lifecycle: 'revoked', publishedAt: '2026-09-29T00:00:00.000Z' },
        { ...next, revision: 3, lifecycle: 'revoked', changedAt: publishedAt },
        { ...next, revision: 3, lifecycle: 'revoked', changedAt: '2026-09-29T23:00:00.000Z' },
      ]) {
        expect(await repository.compareAndSet(2, invalid)).toBe(false)
      }
      expect(await repository.get('graph:race', '1.0.0')).toEqual(next)
      const revoked = { ...next, revision: 3, lifecycle: 'revoked', reason: 'unsafe' }
      expect(await repository.compareAndSet(2, revoked)).toBe(true)
      expect(await repository.compareAndSet(3, { ...next, revision: 4 })).toBe(false)
    })

    test('rejects forged digests before writing and inconsistent stored row identities', async () => {
      const published = await graph('corrupt')
      await expect(
        repository.insert({
          ...published,
          reference: { ...published.reference, contentDigest: `sha256:${'a'.repeat(64)}` },
        })
      ).rejects.toThrow()
      expect(await repository.get('graph:corrupt', '1.0.0')).toBeUndefined()
      expect(await repository.insert(published)).toBe(true)
      await isolated.application.execute(sql`
        update graph_definition_versions set revision = 2
        where workspace_id = ${workspaceId} and graph_definition_id = 'graph:corrupt'
      `)
      await expect(repository.get('graph:corrupt', '1.0.0')).rejects.toThrow(
        'GRAPH_DEFINITION_ROW_INCONSISTENT'
      )
      await expect(
        repository.compareAndSet(2, {
          ...published,
          revision: 3,
          lifecycle: 'revoked',
          reason: 'unsafe',
        })
      ).rejects.toThrow('GRAPH_DEFINITION_ROW_INCONSISTENT')
    })

    test('validates workspace scope before opening a catalog', () => {
      expect(
        () => new PostgresGraphDefinitionRepository(isolated.application, 'workspace-any')
      ).toThrow()
    })
  }
)
