import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { GraphDefinitionCatalog } from '@control-plane/orchestration'
import { SqliteGraphDefinitionRepository, SqlitePersistenceProvider } from './index.ts'

const workspaceA = 'wsp_01JABCDEF0123456789ABCDEFG'
const workspaceB = 'wsp_01JABCDEF0123456789ABCDEFH'
const command = {
  callerId: 'svc_graph-admin',
  operation: 'publish',
  idempotencyKey: 'graph:publish:receipt:1',
  payloadHash: 'a'.repeat(64),
}
const publication = {
  publishedAt: '2026-09-30T12:00:00.000Z',
  definition: {
    graphDefinitionId: 'graph:command',
    graphVersion: '1.0.0',
    schemaVersion: 1,
    nodes: [{ node: 'run', operation: { kind: 'runtime', name: 'execute' } }],
    edges: [
      { from: '__start__', to: 'run' },
      { from: 'run', to: '__end__' },
    ],
    schemas: { input: 'schema:input', state: 'schema:state', output: 'schema:output' },
    requiredCapabilities: [],
    compatibility: {
      contractMajorVersions: [1],
      compilerVersions: ['1.0.0'],
      adapterVersions: ['1.0.0'],
    },
  },
}
const publish = (repository) => new GraphDefinitionCatalog(repository).publish(publication)

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'sqlite-graph-command-'))
  const path = join(directory, 'state.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    await run({
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

test('graph command deduplicates concurrent mutations and retains the original result after reopen', async () => {
  await withDatabase(async ({ provider, reopen }) => {
    const repository = new SqliteGraphDefinitionRepository(provider(), workspaceA)
    let mutations = 0
    const action = async (transactionRepository) => {
      mutations += 1
      return publish(transactionRepository)
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repository.executeCommand(command, action))
    )
    expect(mutations).toBe(1)
    for (const result of results) expect(result).toEqual(results[0])
    const version = results[0]
    await new GraphDefinitionCatalog(repository).deprecate({
      reference: version.reference,
      expectedRevision: 1,
      changedAt: '2026-09-30T13:00:00.000Z',
      reason: 'preserve original response',
    })
    const reopened = new SqliteGraphDefinitionRepository(await reopen(), workspaceA)
    expect(await reopened.executeCommand(command, action)).toEqual(version)
    expect(mutations).toBe(1)
    await expect(
      reopened.executeCommand({ ...command, payloadHash: 'b'.repeat(64) }, action)
    ).rejects.toMatchObject({ code: 'GRAPH_COMMAND_CONFLICT' })
  })
})

test('mutation and receipt roll back together after an action failure', async () => {
  await withDatabase(async ({ provider }) => {
    const repository = new SqliteGraphDefinitionRepository(provider(), workspaceA)
    await expect(
      repository.executeCommand(command, async (transactionRepository) => {
        await publish(transactionRepository)
        throw new Error('lost before receipt')
      })
    ).rejects.toThrow('lost before receipt')
    expect(await repository.get('graph:command', '1.0.0')).toBeUndefined()
    expect(
      await provider().transaction((transaction) => transaction.list('graph-definition-commands'))
    ).toHaveLength(0)
    expect((await repository.executeCommand(command, publish)).revision).toBe(1)
  })
})

test('receipt identity isolates workspace, caller, and operation; corrupted scope fails closed', async () => {
  await withDatabase(async ({ provider }) => {
    const repository = new SqliteGraphDefinitionRepository(provider(), workspaceA)
    const otherWorkspace = new SqliteGraphDefinitionRepository(provider(), workspaceB)
    const version = await repository.executeCommand(command, publish)
    expect(await otherWorkspace.executeCommand(command, publish)).toEqual(version)
    await expect(
      repository.executeCommand({ ...command, callerId: 'svc_other-admin' }, publish)
    ).rejects.toMatchObject({ code: 'GRAPH_VERSION_CONFLICT' })
    const deprecated = await repository.executeCommand(
      { ...command, operation: 'deprecate' },
      (transactionRepository) =>
        new GraphDefinitionCatalog(transactionRepository).deprecate({
          reference: version.reference,
          expectedRevision: 1,
          changedAt: '2026-09-30T13:00:00.000Z',
          reason: 'separate operation scope',
        })
    )
    expect(deprecated.revision).toBe(2)
    await provider().transaction(async (transaction) => {
      const records = await transaction.list('graph-definition-commands')
      const receipt = records.find(
        (record) =>
          record.value.workspaceId === workspaceA && record.value.command.operation === 'publish'
      )
      expect(receipt).toBeDefined()
      await transaction.put({
        namespace: receipt.namespace,
        id: receipt.id,
        expectedRevision: receipt.revision,
        value: { ...receipt.value, workspaceId: workspaceB },
      })
    })
    await expect(repository.executeCommand(command, publish)).rejects.toThrow(
      'SQLITE_GRAPH_COMMAND_RECEIPT_CORRUPT'
    )
  })
})
