import { describe, expect, test } from 'bun:test'
import {
  InMemoryRuntimeCommandRepository,
  RuntimeCommandRecordSchema,
  createQueuedRuntimeCommandRecord,
} from './runtime-command.js'

const queued = {
  commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  nodeId: 'rnr_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  runtimeConnectionId: 'rtc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  idempotencyKey: 'runtime-command:test:1',
  payloadHash: `sha256:${'a'.repeat(64)}`,
  commandEnvelope: { type: 'command', payload: { operation: 'run' } },
  issuedAt: '2026-08-25T12:00:00.000Z',
  expiresAt: '2026-08-25T12:01:00.000Z',
  status: 'queued',
  version: 1,
  deliveryAttempts: 0,
  createdAt: '2026-08-25T12:00:00.000Z',
  updatedAt: '2026-08-25T12:00:00.000Z',
}

describe('runtime command correlation', () => {
  const envelope = (extra) => ({
    type: 'command',
    commandId: queued.commandId,
    executionId: queued.executionId,
    attemptId: queued.attemptId,
    nodeId: queued.nodeId,
    runtimeConnectionId: queued.runtimeConnectionId,
    workspaceId: queued.workspaceId,
    idempotencyKey: queued.idempotencyKey,
    payloadHash: queued.payloadHash,
    issuedAt: queued.issuedAt,
    expiresAt: queued.expiresAt,
    payload: { version: 1, parameters: {} },
    ...extra,
  })

  test('carries envelope-provided correlation and never invents missing members', () => {
    const withTrace = createQueuedRuntimeCommandRecord(
      envelope({ traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV' }),
      queued.createdAt
    )
    expect(withTrace.correlation).toEqual({ traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV' })

    const full = createQueuedRuntimeCommandRecord(
      envelope({
        traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
      queued.createdAt
    )
    expect(full.correlation).toEqual({
      traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })

    const bare = createQueuedRuntimeCommandRecord(envelope({}), queued.createdAt)
    expect(bare.correlation).toBeUndefined()
  })
})

describe('runtime command ledger', () => {
  test('constructs the canonical queued record from a validated transport envelope', () => {
    expect(
      createQueuedRuntimeCommandRecord(
        {
          type: 'command',
          commandId: queued.commandId,
          executionId: queued.executionId,
          attemptId: queued.attemptId,
          nodeId: queued.nodeId,
          runtimeConnectionId: queued.runtimeConnectionId,
          workspaceId: queued.workspaceId,
          idempotencyKey: queued.idempotencyKey,
          payloadHash: queued.payloadHash,
          issuedAt: queued.issuedAt,
          expiresAt: queued.expiresAt,
          payload: { version: 1, parameters: {} },
        },
        queued.createdAt
      )
    ).toEqual({
      ...queued,
      commandEnvelope: {
        type: 'command',
        commandId: queued.commandId,
        executionId: queued.executionId,
        attemptId: queued.attemptId,
        nodeId: queued.nodeId,
        runtimeConnectionId: queued.runtimeConnectionId,
        workspaceId: queued.workspaceId,
        idempotencyKey: queued.idempotencyKey,
        payloadHash: queued.payloadHash,
        issuedAt: queued.issuedAt,
        expiresAt: queued.expiresAt,
        payload: { version: 1, parameters: {} },
      },
    })
  })

  test('requires complete delivery metadata for dispatched commands', () => {
    expect(() => RuntimeCommandRecordSchema.parse({ ...queued, status: 'dispatched' })).toThrow()
  })

  test('preserves stable command identity and detects payload conflicts', async () => {
    const repository = new InMemoryRuntimeCommandRepository()
    expect((await repository.create(queued)).outcome).toBe('created')
    expect((await repository.create(queued)).outcome).toBe('duplicate')
    expect(
      (await repository.create({ ...queued, payloadHash: `sha256:${'b'.repeat(64)}` })).outcome
    ).toBe('conflict')
    expect(
      (await repository.create({ ...queued, workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW' }))
        .outcome
    ).toBe('conflict')
  })

  test('uses compare-and-set and returns immutable dispatchable records', async () => {
    const repository = new InMemoryRuntimeCommandRepository()
    await repository.create(queued)
    const dispatched = {
      ...queued,
      status: 'dispatched',
      version: 2,
      deliveryAttempts: 1,
      lastChannelGeneration: 1,
      lastSequence: 7,
      firstDispatchedAt: '2026-08-25T12:00:01.000Z',
      lastDispatchedAt: '2026-08-25T12:00:01.000Z',
      updatedAt: '2026-08-25T12:00:01.000Z',
    }
    expect(await repository.compareAndSet(1, dispatched)).toBe(true)
    expect(await repository.compareAndSet(1, { ...dispatched, version: 3 })).toBe(false)

    const listed = await repository.listDispatchable(queued.nodeId, '2026-08-25T12:00:02.000Z', 10)
    listed[0].commandEnvelope.payload.operation = 'mutated'
    expect((await repository.get(queued.commandId)).commandEnvelope).toEqual(queued.commandEnvelope)
  })
})
