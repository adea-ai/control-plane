import { describe, expect, test } from 'bun:test'
import {
  ExecutionEventError,
  ExecutionEventService,
  hashExecutionEventPayload,
  InMemoryExecutionEventRepository,
} from './index.ts'

const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const base = (eventId, type = 'execution.progressed') => ({
  eventId,
  executionId,
  type,
  schemaVersion: 1,
  correlation: {
    workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  },
  payload: { progress: 25 },
  occurredAt: '2026-08-24T12:00:00.000Z',
  recordedAt: '2026-08-24T12:00:01.000Z',
  retentionExpiresAt: '2026-11-22T12:00:00.000Z',
})

function setup() {
  const repository = new InMemoryExecutionEventRepository()
  return { repository, service: new ExecutionEventService(repository) }
}

describe('ExecutionEvent log', () => {
  test('hashes equivalent normalized payloads independently of object key order', () => {
    expect(hashExecutionEventPayload({ b: 2, a: { d: 4, c: 3 } })).toBe(
      hashExecutionEventPayload({ a: { c: 3, d: 4 }, b: 2 })
    )
  })

  test('appends immutable normalized events in deterministic per-execution order', async () => {
    const { repository, service } = setup()
    const inputs = Array.from({ length: 8 }, (_, index) =>
      base(`evt_01ARZ3NDEKTSV4RRFFQ69G5FA${String(index)}`)
    )
    const events = await Promise.all(inputs.map((input) => service.append(input)))
    const replay = await repository.queryAfter(executionId, 0, 100)

    expect(events.map(({ sequence }) => sequence).toSorted((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])
    expect(replay.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(await repository.queryAfter(executionId, 5, 2)).toEqual(replay.slice(5, 7))
    expect(events.every(({ payloadHash }) => /^[a-f0-9]{64}$/.test(payloadHash))).toBe(true)
  })

  test('keeps a secret canary out of persisted events', async () => {
    const secretCanary = 'secret-canary-event-9f4a'
    const { service } = setup()
    const event = await service.append({
      ...base('evt_01BRZ3NDEKTSV4RRFFQ69G5FAV'),
      payload: {
        token: secretCanary,
        nested: { prompt: secretCanary, note: `authorization=Bearer ${secretCanary}` },
      },
    })

    expect(event.payload).toEqual({
      token: '[REDACTED]',
      nested: { prompt: '[REDACTED]', note: 'authorization=[REDACTED]' },
    })
    expect(JSON.stringify(event)).not.toContain(secretCanary)
  })

  test('redacts compound secret keys before persisting generic event payloads', async () => {
    const secretCanary = 'compound-secret-canary-event-9f4a'
    const { repository, service } = setup()
    const event = await service.append({
      ...base('evt_01BBZ3NDEKTSV4RRFFQ69G5FAV'),
      payload: {
        privateKey: secretCanary,
        nested: {
          signingKey: secretCanary,
          encryption_key: secretCanary,
          secretValue: secretCanary,
          credentialRef: secretCanary,
          tokenizer: 'visible-tokenizer',
        },
      },
    })
    const [persisted] = await repository.queryAfter(executionId, 0, 10)

    expect(event.payload).toEqual({
      privateKey: '[REDACTED]',
      nested: {
        signingKey: '[REDACTED]',
        encryption_key: '[REDACTED]',
        secretValue: '[REDACTED]',
        credentialRef: '[REDACTED]',
        tokenizer: 'visible-tokenizer',
      },
    })
    expect(persisted).toEqual(event)
    expect(JSON.stringify(persisted)).not.toContain(secretCanary)
  })

  test('rejects oversized payloads and non-normalized event names', async () => {
    const { service } = setup()
    await expect(
      service.append({
        ...base('evt_01CRZ3NDEKTSV4RRFFQ69G5FAV'),
        payload: { value: 'x'.repeat(20_000) },
      })
    ).rejects.toMatchObject({ code: 'EVENT_PAYLOAD_TOO_LARGE' })
    await expect(
      service.append(base('evt_01DRZ3NDEKTSV4RRFFQ69G5FAV', 'pi.raw-token'))
    ).rejects.toBeInstanceOf(ExecutionEventError)
  })

  test('keeps a stable event identity across publication retries', async () => {
    const { repository, service } = setup()
    const event = await service.append(
      base('evt_01ERZ3NDEKTSV4RRFFQ69G5FAV', 'execution.completed')
    )
    expect(await repository.queryPending(10)).toEqual([event])
    const failed = await service.recordPublicationFailure({
      eventId: event.eventId,
      expectedPublicationVersion: event.publication.version,
      attemptedAt: '2026-08-24T12:01:00.000Z',
      errorReference: 'delivery://agent-hq/unavailable',
    })
    const published = await service.markPublished({
      eventId: event.eventId,
      expectedPublicationVersion: failed.publication.version,
      publishedAt: '2026-08-24T12:02:00.000Z',
    })

    expect(published).toMatchObject({
      eventId: event.eventId,
      sequence: event.sequence,
      publication: { status: 'published', attempts: 2, version: 3 },
    })
    expect(await repository.queryAfter(executionId, 0, 10)).toHaveLength(1)
    expect(await repository.queryPending(10)).toEqual([])
  })

  test('archives only retained events while preserving replay identity', async () => {
    const { repository, service } = setup()
    const event = await service.append(base('evt_01FRZ3NDEKTSV4RRFFQ69G5FAV'))
    await expect(
      service.archive({ eventId: event.eventId, archivedAt: '2026-08-25T12:00:00.000Z' })
    ).rejects.toMatchObject({ code: 'EVENT_RETENTION_ACTIVE' })
    const archived = await service.archive({
      eventId: event.eventId,
      archivedAt: '2026-11-22T12:00:00.001Z',
    })
    expect(archived).toMatchObject({ eventId: event.eventId, sequence: 1 })
    expect(await repository.queryAfter(executionId, 0, 10)).toEqual([])
  })
})
