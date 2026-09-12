import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { createQueuedContextCommandRecord, contextCommandSemanticHash } from '@control-plane/domain'
import { SqlitePersistenceProvider } from './index.ts'
import { SqliteContextCommandRepository } from './context-command-repository.ts'
import { SqliteContextNodeInboxRepository } from './context-node-inbox-repository.ts'
import { SqliteRuntimeChannelSequenceRepository } from './runtime-channel-sequence-repository.ts'
import { createContextNodeInboxRecord } from '@control-plane/domain'

const now = '2026-09-12T12:00:00.000Z'

test('SQLite channel sequence reservations survive concurrency, ambiguous acknowledgement and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-channel-sequence-'))
  const path = join(directory, 'sequences.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    const channel = {
      nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      gatewayInstanceId: 'gateway-test',
      connectionId: 'connection-test',
      channelGeneration: 1,
      protocolVersion: { major: 1, minor: 5 },
      connectedAt: now,
      lastHeartbeatAt: now,
    }
    const request = { channel, count: 1, minimum: 1 }
    let repository = new SqliteRuntimeChannelSequenceRepository(provider)
    expect(
      await Promise.all([
        repository.reserve({ ...request, count: 2 }),
        repository.reserve({ ...request, count: 3 }),
        repository.reserve(request),
      ])
    ).toEqual([1, 3, 6])
    const ambiguous = new SqliteRuntimeChannelSequenceRepository({
      transaction: async (operation) => {
        await provider.transaction(operation)
        throw new Error('ACK_LOST_AFTER_COMMIT')
      },
    })
    await expect(ambiguous.reserve(request)).rejects.toThrow('ACK_LOST_AFTER_COMMIT')
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteRuntimeChannelSequenceRepository(provider)
    expect(await repository.reserve(request)).toBe(8)
    expect(await repository.reserve({ ...request, minimum: 100 })).toBe(100)
    expect(await repository.reserve({ ...request, minimum: 2147483647 })).toBe(2147483647)
    await expect(repository.reserve(request)).rejects.toThrow('SEQUENCE_EXHAUSTED')
    expect(
      await repository.reserve({ ...request, channel: { ...channel, channelGeneration: 2 } })
    ).toBe(1)
    await expect(repository.reserve({ ...request, count: 1001 })).rejects.toThrow()
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('SQLite node inbox atomically deduplicates and preserves uncertain calls after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'm11-node-inbox-'))
  const path = join(directory, 'inbox.sqlite')
  let provider = new SqlitePersistenceProvider({ path })
  try {
    await provider.migrate()
    let repository = new SqliteContextNodeInboxRepository(provider)
    const record = createContextNodeInboxRecord(queued().commandEnvelope, now)
    let writes = 0
    const failing = new SqliteContextNodeInboxRepository({
      transaction: (operation) =>
        provider.transaction((transaction) =>
          operation({
            get: transaction.get.bind(transaction),
            put: async (input) => {
              if (++writes === 2) throw new Error('INDEX_WRITE_FAILED')
              return transaction.put(input)
            },
          })
        ),
    })
    await expect(failing.accept(record)).rejects.toThrow('INDEX_WRITE_FAILED')
    const { workspaceId } = record.command.scope
    const { nodeId, commandId } = record.command
    expect(await repository.get(workspaceId, nodeId, commandId)).toBeUndefined()
    const race = createContextNodeInboxRecord(
      queued('cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW').commandEnvelope,
      now
    )
    expect(
      (await Promise.all([repository.accept(record), repository.accept(race)])).map(
        (entry) => entry.outcome
      )
    ).toEqual(['created', 'duplicate'])
    const executing = { ...record, version: 2, status: 'executing', startedAt: now }
    expect(await repository.compareAndSet(1, executing)).toBe(true)
    provider.close()
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    repository = new SqliteContextNodeInboxRepository(provider)
    expect(await repository.get(workspaceId, nodeId, commandId)).toEqual(executing)
    expect(
      await repository.get('wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW', nodeId, commandId)
    ).toBeUndefined()
    expect((await repository.accept(record)).record.status).toBe('executing')
    const uncertain = { ...executing, version: 3, status: 'reconciliation_required' }
    expect(await repository.compareAndSet(2, uncertain)).toBe(true)
    expect(await repository.compareAndSet(3, { ...executing, version: 4 })).toBe(false)
    const completed = {
      ...uncertain,
      version: 4,
      status: 'succeeded',
      terminalAt: now,
      result: { evidence: 'reconciled' },
    }
    expect(await repository.compareAndSet(3, completed)).toBe(true)
    expect((await repository.accept(record)).record).toEqual(completed)
    expect(await repository.compareAndSet(4, { ...completed, version: 5 })).toBe(false)
  } finally {
    provider.close()
    await rm(directory, { recursive: true, force: true })
  }
})

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
