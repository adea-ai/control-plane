import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import {
  GraphDefinitionCatalog,
  InMemoryGraphDefinitionRepository,
} from '@control-plane/orchestration'
import { SqliteGraphDefinitionRepository, SqlitePersistenceProvider } from './index.ts'

const workspaceA = 'wsp_01JABCDEF0123456789ABCDEFG'
const workspaceB = 'wsp_01JABCDEF0123456789ABCDEFH'
const publishedAt = '2026-09-30T12:00:00.000Z'

function definition(graphDefinitionId, graphVersion) {
  return {
    graphDefinitionId,
    graphVersion,
    schemaVersion: 1,
    nodes: [{ node: 'run', operation: { kind: 'runtime', name: 'execute' } }],
    edges: [
      { from: '__start__', to: 'run' },
      { from: 'run', to: '__end__' },
    ],
    schemas: {
      input: 'schema://graph/input/v1',
      state: 'schema://graph/state/v1',
      output: 'schema://graph/output/v1',
    },
    requiredCapabilities: ['runtime.invoke'],
    compatibility: {
      contractMajorVersions: [1],
      compilerVersions: ['1.0.0'],
      adapterVersions: ['1.0.0'],
    },
  }
}

async function published(graphDefinitionId = 'graph:catalog:sample', graphVersion = '1.0.0') {
  const catalog = new GraphDefinitionCatalog(new InMemoryGraphDefinitionRepository())
  return catalog.publish({ definition: definition(graphDefinitionId, graphVersion), publishedAt })
}

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-graph-definitions-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    await run({
      path,
      provider: () => provider,
      reopen: async () => {
        await provider.close()
        provider = new SqlitePersistenceProvider({ path })
        await provider.migrate()
        return provider
      },
    })
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function deprecate(version, changedAt = '2026-09-30T13:00:00.000Z') {
  return {
    ...version,
    revision: version.revision + 1,
    lifecycle: 'deprecated',
    changedAt,
    reason: 'replaced by a newer graph version',
  }
}

test('SQLite graph definitions validate constructor scope and preserve definitions across reopen', async () => {
  await withDatabase(async ({ reopen, provider }) => {
    expect(() => new SqliteGraphDefinitionRepository(provider(), 'not-a-workspace-id')).toThrow()

    const version = await published('graph:catalog:with:colons', '1.0.0')
    const repository = new SqliteGraphDefinitionRepository(provider(), workspaceA)
    expect(await repository.insert(version)).toBe(true)
    expect(
      await repository.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).toEqual(version)
    expect(await repository.get('graph:catalog:missing', '1.0.0')).toBeUndefined()

    const reopened = new SqliteGraphDefinitionRepository(await reopen(), workspaceA)
    expect(
      await reopened.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).toEqual(version)
  })
})

test('SQLite graph-definition lookups reject malformed keys before opening a transaction', async () => {
  await withDatabase(async ({ provider }) => {
    const persistence = provider()
    let transactionCalls = 0
    const observedProvider = {
      transaction(operation) {
        transactionCalls += 1
        return persistence.transaction(operation)
      },
    }
    const repository = new SqliteGraphDefinitionRepository(observedProvider, workspaceA)
    const version = await published()
    expect(await repository.insert(version)).toBe(true)
    const before = await persistence.transaction((transaction) =>
      transaction.list('graph-definitions')
    )
    transactionCalls = 0

    const lookups = await Promise.allSettled([
      repository.get('graph id with spaces', '1.0.0'),
      repository.get('graph:catalog:sample', 'latest'),
    ])
    const after = await persistence.transaction((transaction) =>
      transaction.list('graph-definitions')
    )

    expect({
      outcomes: lookups.map(({ status }) => status),
      transactionCalls,
      recordCount: after.length,
    }).toEqual({
      outcomes: ['rejected', 'rejected'],
      transactionCalls: 0,
      recordCount: before.length,
    })
  })
})

test('SQLite graph definition insert and compare-and-set have one winner under concurrency', async () => {
  await withDatabase(async ({ provider }) => {
    const repository = new SqliteGraphDefinitionRepository(provider(), workspaceA)
    const version = await published()
    const inserts = await Promise.all(Array.from({ length: 8 }, () => repository.insert(version)))
    expect(inserts.filter(Boolean)).toHaveLength(1)
    expect(inserts.filter((inserted) => !inserted)).toHaveLength(7)

    const next = deprecate(version)
    const updates = await Promise.all(
      Array.from({ length: 8 }, () => repository.compareAndSet(1, next))
    )
    expect(updates.filter(Boolean)).toHaveLength(1)
    expect(updates.filter((updated) => !updated)).toHaveLength(7)
    expect(
      await repository.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).toEqual(next)
  })
})

test('SQLite graph definition CAS rejects stale, replayed, skipped, and invalid lifecycle writes', async () => {
  await withDatabase(async ({ provider }) => {
    const repository = new SqliteGraphDefinitionRepository(provider(), workspaceA)
    const version = await published()
    expect(await repository.insert(version)).toBe(true)

    expect(await repository.compareAndSet(0, deprecate(version))).toBe(false)
    expect(
      await repository.compareAndSet(1, {
        ...deprecate(version),
        revision: 3,
        lifecycle: 'revoked',
        reason: 'unsafe graph',
      })
    ).toBe(false)
    expect(
      await repository.compareAndSet(1, {
        ...version,
        revision: 2,
        changedAt: '2026-09-30T11:59:59.000Z',
        lifecycle: 'deprecated',
        reason: 'timestamp predates the current definition',
      })
    ).toBe(false)
    expect(
      await repository.compareAndSet(1, {
        ...version,
        revision: 2,
        changedAt: '2026-09-30T13:00:00.000Z',
      })
    ).toBe(false)
    expect(
      await repository.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).toEqual(version)

    const next = deprecate(version)
    expect(await repository.compareAndSet(1, next)).toBe(true)
    expect(await repository.compareAndSet(1, next)).toBe(false)
    const revoked = {
      ...next,
      revision: 3,
      lifecycle: 'revoked',
      changedAt: '2026-09-30T14:00:00.000Z',
      reason: 'graph was revoked after review',
    }
    expect(await repository.compareAndSet(2, revoked)).toBe(true)
    expect(await repository.compareAndSet(3, { ...revoked, revision: 4 })).toBe(false)
  })
})

test('SQLite graph definitions reject invalid writes and keep identical references workspace-scoped', async () => {
  await withDatabase(async ({ provider }) => {
    const inWorkspaceA = new SqliteGraphDefinitionRepository(provider(), workspaceA)
    const inWorkspaceB = new SqliteGraphDefinitionRepository(provider(), workspaceB)
    const version = await published('graph:catalog:shared', '1.0.0')

    expect(() =>
      inWorkspaceA.insert({
        ...version,
        reference: { ...version.reference, contentDigest: `sha256:${'0'.repeat(64)}` },
      })
    ).toThrow()
    expect(
      await inWorkspaceA.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).toBe(undefined)

    expect(await inWorkspaceA.insert(version)).toBe(true)
    expect(await inWorkspaceB.insert(version)).toBe(true)
    expect(
      await inWorkspaceA.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).toEqual(version)
    expect(
      await inWorkspaceB.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).toEqual(version)
  })
})

test('SQLite graph definition reads fail closed for corrupt digest, workspace scope, and reference identity', async () => {
  await withDatabase(async ({ provider }) => {
    const persistence = provider()
    const repository = new SqliteGraphDefinitionRepository(persistence, workspaceA)
    const version = await published()
    expect(await repository.insert(version)).toBe(true)

    const [record] = await persistence.transaction((transaction) =>
      transaction.list('graph-definitions')
    )
    expect(record).toBeDefined()
    const original = record.value
    const replaceValue = async (value) => {
      const current = await persistence.transaction((transaction) =>
        transaction.get(record.namespace, record.id)
      )
      await persistence.transaction((transaction) =>
        transaction.put({
          namespace: record.namespace,
          id: record.id,
          expectedRevision: current.revision,
          value,
        })
      )
    }
    const restore = async () => {
      const current = await persistence.transaction((transaction) =>
        transaction.get(record.namespace, record.id)
      )
      await persistence.transaction((transaction) =>
        transaction.put({
          namespace: record.namespace,
          id: record.id,
          expectedRevision: current.revision,
          value: original,
        })
      )
    }

    await replaceValue({
      ...original,
      version: {
        ...original.version,
        reference: { ...original.version.reference, contentDigest: `sha256:${'0'.repeat(64)}` },
      },
    })
    await expect(
      repository.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).rejects.toThrow()
    await restore()

    await replaceValue({ ...original, workspaceId: workspaceB })
    await expect(
      repository.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).rejects.toThrow()
    await restore()

    await replaceValue({ ...original, graphDefinitionId: 'graph:catalog:tampered' })
    await expect(
      repository.get(version.reference.graphDefinitionId, version.reference.graphVersion)
    ).rejects.toThrow()
  })
})
