import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  GraphDefinitionCatalog,
  GraphCatalogError,
  InMemoryGraphDefinitionRepository,
} from '@control-plane/orchestration'
import { eq, sql } from 'drizzle-orm'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { PostgresGraphDefinitionRepository } from './graph-definition-repository.ts'
import { graphDefinitionCommands } from './schema/graph-definitions.ts'

const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const otherWorkspaceId = 'wsp_01JABCDEF0123456789ABCDEGH'
const publishedAt = '2026-09-30T00:00:00.000Z'
const callerId = 'svc_graph-publisher'
const idempotencyKey = 'graph-command-key-0001'

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

function command(overrides = {}) {
  return {
    callerId,
    operation: 'publish',
    idempotencyKey,
    payloadHash: 'a'.repeat(64),
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
    }, integrationTestTimeout(60_000))

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

    test('serializes eight identical commands and replays the immutable result after lifecycle changes', async () => {
      const published = await graph('command-concurrency')
      const input = command({ idempotencyKey: 'graph-command-concurrency-0001' })
      const entered = deferred()
      const release = deferred()
      let actionCount = 0
      const execute = () =>
        repository.executeCommand(input, async (transactionRepository) => {
          actionCount += 1
          entered.resolve()
          await release.promise
          expect(await transactionRepository.insert(published)).toBe(true)
          return published
        })

      const first = execute()
      await entered.promise
      const concurrent = Array.from({ length: 7 }, execute)
      let lockError
      try {
        await isolated.waitForBlockedTransaction()
      } catch (error) {
        lockError = error
      } finally {
        release.resolve()
      }
      const results = await Promise.all([first, ...concurrent])
      if (lockError !== undefined) throw lockError

      expect(actionCount).toBe(1)
      expect(results).toEqual(Array.from({ length: 8 }, () => published))

      const deprecated = {
        ...published,
        revision: 2,
        lifecycle: 'deprecated',
        changedAt: '2026-09-30T01:00:00.000Z',
        reason: 'superseded',
      }
      expect(await repository.compareAndSet(1, deprecated)).toBe(true)

      const reconstructed = new PostgresGraphDefinitionRepository(isolated.application, workspaceId)
      await expect(
        reconstructed.executeCommand(input, async () => {
          throw new Error('EXACT_REPLAY_MUST_NOT_RUN_ACTION')
        })
      ).resolves.toEqual(published)
      const conflict = await reconstructed
        .executeCommand(command({ ...input, payloadHash: 'b'.repeat(64) }), async () => {
          throw new Error('CONFLICT_MUST_NOT_RUN_ACTION')
        })
        .catch((error) => error)
      expect(conflict).toBeInstanceOf(GraphCatalogError)
      expect(conflict).toMatchObject({ code: 'GRAPH_COMMAND_CONFLICT' })
      expect(await reconstructed.get('graph:command-concurrency', '1.0.0')).toEqual(deprecated)
    })

    test('isolates idempotency keys by workspace, caller, and operation', async () => {
      const primary = await graph('command-scope-primary')
      const otherWorkspace = await graph('command-scope-workspace')
      const otherCaller = await graph('command-scope-caller')
      const scopeInput = command({ idempotencyKey: 'graph-command-scopes-0001' })
      let actionCount = 0

      const primaryResult = await repository.executeCommand(scopeInput, async (scoped) => {
        actionCount += 1
        expect(await scoped.insert(primary)).toBe(true)
        return primary
      })
      const workspaceResult = await new PostgresGraphDefinitionRepository(
        isolated.application,
        otherWorkspaceId
      ).executeCommand(scopeInput, async (scoped) => {
        actionCount += 1
        expect(await scoped.insert(otherWorkspace)).toBe(true)
        return otherWorkspace
      })
      const callerResult = await repository.executeCommand(
        command({ ...scopeInput, callerId: 'svc_other-publisher' }),
        async (scoped) => {
          actionCount += 1
          expect(await scoped.insert(otherCaller)).toBe(true)
          return otherCaller
        }
      )

      const deprecated = {
        ...primary,
        revision: 2,
        lifecycle: 'deprecated',
        changedAt: '2026-09-30T01:00:00.000Z',
        reason: 'operation scope',
      }
      const operationResult = await repository.executeCommand(
        command({ ...scopeInput, operation: 'deprecate' }),
        async (scoped) => {
          actionCount += 1
          expect(await scoped.compareAndSet(1, deprecated)).toBe(true)
          return deprecated
        }
      )

      expect(actionCount).toBe(4)
      expect(primaryResult).toEqual(primary)
      expect(workspaceResult).toEqual(otherWorkspace)
      expect(callerResult).toEqual(otherCaller)
      expect(operationResult).toEqual(deprecated)
      await expect(
        repository.executeCommand(scopeInput, async () => {
          throw new Error('PUBLISH_REPLAY_MUST_NOT_RUN_ACTION')
        })
      ).resolves.toEqual(primary)
    })

    test('rolls back a failed mutation and its receipt together', async () => {
      const published = await graph('command-rollback')
      let actionCount = 0
      const input = command({ idempotencyKey: 'graph-command-rollback-0001' })

      await expect(
        repository.executeCommand(input, async (scoped) => {
          actionCount += 1
          expect(await scoped.insert(published)).toBe(true)
          throw new Error('ACTION_ABORTED')
        })
      ).rejects.toThrow('ACTION_ABORTED')
      expect(await repository.get('graph:command-rollback', '1.0.0')).toBeUndefined()
      const [receiptAfterRollback] = await isolated.application
        .select()
        .from(graphDefinitionCommands)
        .where(eq(graphDefinitionCommands.idempotencyKey, input.idempotencyKey))
      expect(receiptAfterRollback).toBeUndefined()

      await expect(
        repository.executeCommand(input, async (scoped) => {
          actionCount += 1
          expect(await scoped.insert(published)).toBe(true)
          return published
        })
      ).resolves.toEqual(published)
      expect(actionCount).toBe(2)
    })

    test('fails closed when a persisted command receipt is corrupted', async () => {
      const published = await graph('command-corruption')
      const input = command({ idempotencyKey: 'graph-command-corrupt-0001' })
      await repository.executeCommand(input, async (scoped) => {
        expect(await scoped.insert(published)).toBe(true)
        return published
      })
      await isolated.application
        .update(graphDefinitionCommands)
        .set({ receipt: null })
        .where(eq(graphDefinitionCommands.idempotencyKey, input.idempotencyKey))

      await expect(
        repository.executeCommand(input, async () => {
          throw new Error('CORRUPT_REPLAY_MUST_NOT_RUN_ACTION')
        })
      ).rejects.toThrow('POSTGRES_GRAPH_COMMAND_RECEIPT_CORRUPT')
    })

    test('validates workspace scope before opening a catalog', () => {
      expect(
        () => new PostgresGraphDefinitionRepository(isolated.application, 'workspace-any')
      ).toThrow()
    })
  }
)
