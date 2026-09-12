import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { createQueuedContextCommandRecord, contextCommandSemanticHash } from '@control-plane/domain'
import { SqlitePersistenceProvider } from './index.ts'
import { SqliteContextCommandRepository } from './context-command-repository.ts'

const now = '2026-09-12T12:00:00.000Z'
function queued(commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV', objective = 'Read evidence') {
  const command = {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 5 },
    commandId,
    workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    sequence: 1,
    channelGeneration: 1,
    sentAt: now,
    issuedAt: now,
    expiresAt: '2026-09-12T12:01:00.000Z',
    idempotencyKey: 'context-read:sqlite-0001',
    providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    authorizationRef: 'authz:sqlite-context-read',
    family: 'context_provider',
    operation: 'context.read',
    driver: { family: 'context-provider', version: '1.0.0' },
    requiredCapabilities: ['context.read'],
    payload: {
      version: 1,
      parameters: {
        operationId: 'context-author:sqlite-0001',
        principalRef: 'service:author',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        objective,
      },
    },
  }
  return createQueuedContextCommandRecord(
    { ...command, payloadHash: contextCommandSemanticHash(command) },
    now
  )
}

test('SQLite context commands survive reopen with scoped operation deduplication and CAS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-context-ledger-'))
  const path = join(directory, 'context.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let repository = new SqliteContextCommandRepository(provider)
    const record = queued()
    for (const failAt of [2, 3]) {
      let writes = 0
      const failing = new SqliteContextCommandRepository({
        transaction: (operation) =>
          provider.transaction((transaction) =>
            operation({
              get: transaction.get.bind(transaction),
              put: async (write) => {
                if (++writes === failAt) throw new Error('INJECTED_OPERATION_INDEX_FAILURE')
                return transaction.put(write)
              },
            })
          ),
      })
      await expect(failing.create(record)).rejects.toThrow('INJECTED_OPERATION_INDEX_FAILURE')
      expect(await repository.get(record.scope.workspaceId, record.commandId)).toBeUndefined()
      expect(await repository.getByOperation(record.scope)).toBeUndefined()
      expect(
        await repository.listPending({
          workspaceId: record.scope.workspaceId,
          nodeId: record.nodeId,
          limit: 1,
        })
      ).toEqual([])
    }
    const racing = queued('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW')
    const results = await Promise.all([repository.create(record), repository.create(racing)])
    expect(results.map((result) => result.outcome)).toEqual(['created', 'duplicate'])
    expect(results[1].record.commandId).toBe(record.commandId)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteContextCommandRepository(provider)
    expect(await repository.getByOperation(record.scope)).toEqual(record)
    const query = { workspaceId: record.scope.workspaceId, nodeId: record.nodeId, limit: 1 }
    expect(await repository.listPending(query)).toEqual([record])
    expect(await repository.listPending({ ...query, afterCommandId: record.commandId })).toEqual([])
    expect(
      await repository.listPending({ ...query, nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
    ).toEqual([])
    expect(
      await repository.listPending({ ...query, workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
    ).toEqual([])
    await expect(repository.listPending({ ...query, limit: 129 })).rejects.toThrow()
    expect(await repository.get('wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW', record.commandId)).toBeUndefined()
    expect((await repository.create(queued(record.commandId, 'Changed objective'))).outcome).toBe(
      'conflict'
    )
    const dispatched = {
      ...record,
      status: 'dispatched',
      version: 2,
      deliveryAttempts: 1,
      lastDelivery: { channelGeneration: 2, sequence: 1, at: now },
    }
    expect(await repository.compareAndSet(1, dispatched)).toBe(true)
    expect(await repository.compareAndSet(1, dispatched)).toBe(false)
    expect(await repository.compareAndSet(2, { ...dispatched, version: 4 })).toBe(false)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    expect(
      await new SqliteContextCommandRepository(provider).get(
        record.scope.workspaceId,
        record.commandId
      )
    ).toEqual(dispatched)
    repository = new SqliteContextCommandRepository(provider)
    expect(
      await repository.compareAndSet(2, {
        ...dispatched,
        version: 3,
        status: 'cancelled',
        terminalAt: now,
      })
    ).toBe(true)
    expect(await repository.listPending(query)).toEqual([])
    expect((await repository.getByOperation(record.scope)).status).toBe('cancelled')
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})
