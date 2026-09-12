import { describe, expect, test } from 'bun:test'
import {
  ContextCommandRecordSchema,
  InMemoryContextCommandRepository,
  contextCommandSemanticHash,
  createQueuedContextCommandRecord,
} from './context-command.ts'

const now = '2026-09-12T12:00:00.000Z'
const workspaceId = 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV'
function command(overrides = {}) {
  const value = {
    type: 'command',
    schemaVersion: 1,
    protocolVersion: { major: 1, minor: 5 },
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    workspaceId,
    traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    channelGeneration: 1,
    sequence: 1,
    sentAt: now,
    issuedAt: now,
    expiresAt: '2026-09-12T12:01:00.000Z',
    idempotencyKey: 'context-command:test:1',
    providerRef: 'pvr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    authorizationRef: 'authz:context-read-policy-v1',
    family: 'context_provider',
    operation: 'context.read',
    driver: { family: 'context-provider', version: '1.0.0' },
    requiredCapabilities: ['context.read'],
    payload: {
      version: 1,
      parameters: {
        operationId: 'context-author:operation-test-0001',
        principalRef: 'service:author',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        objective: 'Find bounded evidence',
      },
    },
    ...overrides,
  }
  return { ...value, payloadHash: contextCommandSemanticHash(value) }
}

describe('context command ledger', () => {
  test('paginates pending work by node and workspace without skipping expired grants', async () => {
    const repository = new InMemoryContextCommandRepository()
    const first = createQueuedContextCommandRecord(command(), now)
    const other = command({ commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
    other.payload.parameters.operationId = 'context-author:second-operation'
    other.payloadHash = contextCommandSemanticHash(other)
    const second = createQueuedContextCommandRecord(other, now)
    await repository.create(second)
    await repository.create(first)
    const query = { workspaceId, nodeId: first.nodeId, limit: 1 }
    expect(await repository.listPending(query)).toEqual([first])
    expect(await repository.listPending({ ...query, afterCommandId: first.commandId })).toEqual([
      second,
    ])
    expect(await repository.listPending({ ...query, afterCommandId: second.commandId })).toEqual([])
    expect(
      await repository.listPending({ ...query, workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
    ).toEqual([])
    expect(
      await repository.listPending({ ...query, nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAW' })
    ).toEqual([])
    await expect(repository.listPending({ ...query, limit: 129 })).rejects.toThrow()
    const later = '2026-09-12T12:02:00.000Z'
    expect(
      await repository.compareAndSet(1, {
        ...first,
        version: 2,
        status: 'expired',
        terminalAt: later,
        updatedAt: later,
      })
    ).toBe(true)
    expect(await repository.listPending(query)).toEqual([second])
  })
  test('creates a bounded context-read record without fabricated runtime identities', () => {
    const record = createQueuedContextCommandRecord(command(), now)
    expect(record.scope).toEqual({
      workspaceId,
      principalRef: 'service:author',
      providerRef: command().providerRef,
      operationId: 'context-author:operation-test-0001',
    })
    expect(record.status).toBe('queued')
    expect(record).not.toHaveProperty('executionId')
    expect(record).not.toHaveProperty('runtimeConnectionId')
    expect(() =>
      createQueuedContextCommandRecord(
        { ...command(), payloadHash: `sha256:${'b'.repeat(64)}` },
        now
      )
    ).toThrow()
    expect(() =>
      createQueuedContextCommandRecord(
        { ...command(), executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        now
      )
    ).toThrow()
  })

  test('deduplicates a scoped operation even if a racing allocator chose another command ID', async () => {
    const repository = new InMemoryContextCommandRepository()
    const first = createQueuedContextCommandRecord(command(), now)
    const second = createQueuedContextCommandRecord(
      command({ commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW' }),
      now
    )
    const results = await Promise.all([repository.create(first), repository.create(second)])
    expect(results.map((result) => result.outcome)).toEqual(['created', 'duplicate'])
    expect(results[1].record.commandId).toBe(first.commandId)
    const changed = command()
    changed.payload.parameters.objective = 'Different evidence'
    changed.payloadHash = contextCommandSemanticHash(changed)
    expect((await repository.create(createQueuedContextCommandRecord(changed, now))).outcome).toBe(
      'conflict'
    )
  })

  test('isolates workspaces and enforces monotonically versioned delivery transitions', async () => {
    const repository = new InMemoryContextCommandRepository()
    const record = createQueuedContextCommandRecord(command(), now)
    await repository.create(record)
    expect(await repository.get('wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW', record.commandId)).toBeUndefined()
    const dispatched = {
      ...record,
      status: 'dispatched',
      version: 2,
      deliveryAttempts: 1,
      lastDelivery: { channelGeneration: 1, sequence: 2, at: now },
    }
    expect(await repository.compareAndSet(1, dispatched)).toBe(true)
    expect(await repository.compareAndSet(1, dispatched)).toBe(false)
    expect(await repository.compareAndSet(2, { ...dispatched, version: 4 })).toBe(false)
    expect(await repository.compareAndSet(2, { ...record, version: 3 })).toBe(false)
    const completed = {
      ...dispatched,
      version: 3,
      status: 'succeeded',
      terminalAt: now,
      resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    }
    expect(await repository.compareAndSet(2, completed)).toBe(true)
    expect(await repository.compareAndSet(3, { ...dispatched, version: 4 })).toBe(false)
    const copy = await repository.get(workspaceId, record.commandId)
    copy.commandEnvelope.payload.parameters.objective = 'mutated'
    expect(
      (await repository.get(workspaceId, record.commandId)).commandEnvelope.payload.parameters
        .objective
    ).toBe('Find bounded evidence')
  })

  test('rejects incomplete successful records and changed immutable scope', () => {
    const record = createQueuedContextCommandRecord(command(), now)
    expect(() =>
      ContextCommandRecordSchema.parse({ ...record, status: 'succeeded', terminalAt: now })
    ).toThrow()
    expect(() =>
      ContextCommandRecordSchema.parse({
        ...record,
        scope: { ...record.scope, principalRef: 'service:other' },
      })
    ).toThrow()
  })

  test('rejects inconsistent chronology, delivery, terminal metadata, and oversized commands', () => {
    const record = createQueuedContextCommandRecord(command(), now)
    for (const change of [
      { createdAt: '2026-09-12T11:59:59.000Z' },
      { updatedAt: '2026-09-12T11:59:59.000Z' },
      { deliveryAttempts: 1 },
      { terminalAt: now },
      { errorCode: 'UNEXPECTED_ERROR' },
      { resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
      {
        status: 'failed',
        version: 2,
        deliveryAttempts: 1,
        lastDelivery: { channelGeneration: 1, sequence: 2, at: now },
        terminalAt: now,
      },
      {
        status: 'dispatched',
        version: 2,
        deliveryAttempts: 1,
        lastDelivery: { channelGeneration: 1, sequence: 2, at: '2026-09-12T12:00:01.000Z' },
      },
    ])
      expect(() => ContextCommandRecordSchema.parse({ ...record, ...change })).toThrow()
    const oversized = command()
    oversized.payload.parameters.padding = 'x'.repeat(262144)
    oversized.payloadHash = contextCommandSemanticHash(oversized)
    expect(() => createQueuedContextCommandRecord(oversized, now)).toThrow()
    expect(() =>
      createQueuedContextCommandRecord({ ...command(), operation: 'context.write' }, now)
    ).toThrow()
  })

  test('does not disclose a colliding command across scopes and rejects stale redelivery', async () => {
    const repository = new InMemoryContextCommandRepository()
    const record = createQueuedContextCommandRecord(command(), now)
    await repository.create(record)
    const other = createQueuedContextCommandRecord(
      command({ workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' }),
      now
    )
    await expect(repository.create(other)).rejects.toThrow('CONTEXT_COMMAND_ID_CONFLICT')
    expect(await repository.getByOperation(other.scope)).toBeUndefined()
    const dispatched = {
      ...record,
      version: 2,
      status: 'dispatched',
      deliveryAttempts: 1,
      lastDelivery: { channelGeneration: 2, sequence: 3, at: now },
    }
    expect(await repository.compareAndSet(1, dispatched)).toBe(true)
    for (const lastDelivery of [
      { channelGeneration: 1, sequence: 4, at: now },
      { channelGeneration: 2, sequence: 3, at: now },
    ])
      expect(
        await repository.compareAndSet(2, {
          ...dispatched,
          version: 3,
          deliveryAttempts: 2,
          lastDelivery,
        })
      ).toBe(false)
  })
})
