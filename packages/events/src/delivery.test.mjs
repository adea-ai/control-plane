import { describe, expect, test } from 'bun:test'
import {
  ExecutionEventDispatcher,
  ExecutionEventService,
  HttpAgentHqEventTransport,
  InMemoryExecutionEventRepository,
} from './index.ts'

const eventInput = (overrides = {}) => ({
  eventId: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workflowId: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  type: 'execution.completed',
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
  payload: { state: 'completed', resultReference: 'artifact://result/1' },
  occurredAt: '2026-08-24T12:00:00.000Z',
  recordedAt: '2026-08-24T12:00:01.000Z',
  retentionExpiresAt: '2026-11-22T12:00:00.000Z',
  ...overrides,
})

describe('Agent HQ HTTP event transport', () => {
  test('uses the configured HTTPS boundary and service authorization without changing the envelope', async () => {
    const requests = []
    const transport = new HttpAgentHqEventTransport({
      endpoint: 'https://agent-hq.example.test/v1/event-inbox',
      authorization: { getHeader: async () => 'Bearer service-credential' },
      fetch: async (url, init) => {
        requests.push({ url, init })
        return { ok: true, status: 202 }
      },
    })
    const { service } = setup([])
    const event = await service.append(eventInput())

    expect(await transport.deliver(eventToEnvelope(event))).toEqual({ outcome: 'accepted' })
    expect(requests).toEqual([
      {
        url: 'https://agent-hq.example.test/v1/event-inbox',
        init: expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            authorization: 'Bearer service-credential',
            'content-type': 'application/json',
          }),
          body: JSON.stringify(eventToEnvelope(event)),
        }),
      },
    ])
    expect(
      () =>
        new HttpAgentHqEventTransport({
          endpoint: 'http://agent-hq.example.test/v1/event-inbox',
          authorization: { getHeader: async () => 'Bearer service-credential' },
        })
    ).toThrow('AGENT_HQ_DELIVERY_ENDPOINT_REQUIRES_HTTPS')
  })
})

function eventToEnvelope(event) {
  return {
    contractVersion: { major: 1, minor: 0 },
    eventId: event.eventId,
    eventType: event.type,
    executionId: event.executionId,
    attemptId: event.attemptId,
    workflowId: event.workflowId,
    workspaceId: event.correlation.workspaceId,
    projectId: event.correlation.projectId,
    taskId: event.correlation.taskId,
    agentId: event.correlation.agentId,
    sequence: event.sequence,
    schemaVersion: event.schemaVersion,
    payloadHash: event.payloadHash,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    correlation: {
      requestId: event.correlation.requestId,
      commandId: event.correlation.commandId,
      traceId: event.correlation.traceId,
    },
    data: event.payload,
  }
}

function setup(outcomes, now = { value: '2026-08-24T12:01:00.000Z' }) {
  const repository = new InMemoryExecutionEventRepository()
  const service = new ExecutionEventService(repository)
  const deliveries = []
  const transport = {
    deliver: async (envelope) => {
      deliveries.push(envelope)
      return outcomes.shift() ?? { outcome: 'accepted' }
    },
  }
  const dispatcher = new ExecutionEventDispatcher({
    repository,
    publicationService: service,
    transport,
    now: () => now.value,
    retry: { baseDelayMs: 1_000, maximumAttempts: 3, ...now.escalation },
  })
  return { deliveries, dispatcher, now, repository, service }
}

describe('Agent HQ execution event delivery', () => {
  test('delivers a versioned normalized envelope and marks the retained event published', async () => {
    const { deliveries, dispatcher, repository, service } = setup([])
    const event = await service.append(eventInput())

    expect(await dispatcher.dispatchBatch(10)).toEqual({ delivered: 1, failed: 0, quarantined: 0 })
    expect(deliveries).toEqual([
      expect.objectContaining({
        contractVersion: { major: 1, minor: 0 },
        eventId: event.eventId,
        eventType: event.type,
        executionId: event.executionId,
        attemptId: event.attemptId,
        workflowId: event.workflowId,
        workspaceId: event.correlation.workspaceId,
        projectId: event.correlation.projectId,
        taskId: event.correlation.taskId,
        agentId: event.correlation.agentId,
        sequence: event.sequence,
        schemaVersion: event.schemaVersion,
        payloadHash: event.payloadHash,
        correlation: {
          requestId: event.correlation.requestId,
          commandId: event.correlation.commandId,
          traceId: event.correlation.traceId,
        },
      }),
    ])
    expect((await repository.get(event.eventId)).publication.status).toBe('published')
  })

  test('backs off after an outage and retries the identical event after the due time', async () => {
    const { deliveries, dispatcher, now, repository, service } = setup([
      { outcome: 'retryable_failure', code: 'UNAVAILABLE' },
      { outcome: 'accepted' },
    ])
    const event = await service.append(eventInput())

    expect(await dispatcher.dispatchBatch(10)).toEqual({ delivered: 0, failed: 1, quarantined: 0 })
    expect((await repository.get(event.eventId)).publication).toMatchObject({
      status: 'failed',
      attempts: 1,
      nextAttemptAt: '2026-08-24T12:01:01.000Z',
    })
    expect(await dispatcher.dispatchBatch(10)).toEqual({ delivered: 0, failed: 0, quarantined: 0 })
    now.value = '2026-08-24T12:01:01.000Z'
    expect(await dispatcher.dispatchBatch(10)).toEqual({ delivered: 1, failed: 0, quarantined: 0 })
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]).toEqual(deliveries[1])
  })

  test('concurrent duplicate delivery converges after one publication writer wins', async () => {
    const repository = new InMemoryExecutionEventRepository()
    const service = new ExecutionEventService(repository)
    const deliveries = []
    let release
    const bothDeliveriesStarted = new Promise((resolve) => {
      release = resolve
    })
    const transport = {
      deliver: async (envelope) => {
        deliveries.push(envelope)
        if (deliveries.length === 2) release()
        await bothDeliveriesStarted
        return { outcome: 'accepted' }
      },
    }
    const options = {
      repository,
      publicationService: service,
      transport,
      now: () => '2026-08-24T12:01:00.000Z',
    }
    const event = await service.append(eventInput())

    const outcomes = await Promise.all([
      new ExecutionEventDispatcher(options).dispatchBatch(1),
      new ExecutionEventDispatcher(options).dispatchBatch(1),
    ])

    expect(outcomes).toEqual([
      { delivered: 1, failed: 0, quarantined: 0 },
      { delivered: 1, failed: 0, quarantined: 0 },
    ])
    expect(deliveries.map(({ eventId }) => eventId)).toEqual([event.eventId, event.eventId])
    expect((await repository.get(event.eventId)).publication.status).toBe('published')
  })

  test('quarantines raw runtime payloads and schema mismatches without sending them', async () => {
    const { deliveries, dispatcher, repository, service } = setup([])
    const event = await service.append(
      eventInput({ payload: { state: 'completed', temporalPayload: { unsafe: true } } })
    )

    expect(await dispatcher.dispatchBatch(10)).toEqual({ delivered: 0, failed: 0, quarantined: 1 })
    expect(deliveries).toEqual([])
    expect((await repository.get(event.eventId)).publication).toMatchObject({
      status: 'quarantined',
      errorReference: 'delivery://agent-hq/schema-mismatch',
    })
  })

  test('replays a quarantined retained event with the same identity after remediation', async () => {
    const { deliveries, dispatcher, repository, service } = setup([
      { outcome: 'permanent_failure', code: 'SCHEMA_MISMATCH' },
      { outcome: 'accepted' },
    ])
    const event = await service.append(eventInput())
    await dispatcher.dispatchBatch(10)
    expect((await repository.get(event.eventId)).publication.status).toBe('quarantined')

    await service.requeuePublication({
      eventId: event.eventId,
      expectedPublicationVersion: 2,
      requestedAt: '2026-08-24T12:02:00.000Z',
    })
    await dispatcher.dispatchBatch(10)

    expect(deliveries).toHaveLength(2)
    expect(deliveries[0].eventId).toBe(deliveries[1].eventId)
    expect(deliveries[0].payloadHash).toBe(deliveries[1].payloadHash)
    expect((await repository.get(event.eventId)).publication.status).toBe('published')
  })
})

describe('retry escalation to manual remediation', () => {
  test('quarantines a continuously failing delivery once it exceeds the escalation window', async () => {
    const now = { value: '2026-08-24T12:01:00.000Z' }
    const repository = new InMemoryExecutionEventRepository()
    const service = new ExecutionEventService(repository)
    const deliveries = []
    const dispatcher = new ExecutionEventDispatcher({
      repository,
      publicationService: service,
      transport: {
        deliver: async () => {
          deliveries.push(1)
          return { outcome: 'retryable_failure', code: 'HTTP_503' }
        },
      },
      now: () => now.value,
      retry: { baseDelayMs: 1_000, maximumAttempts: 100, escalationAfterMs: 3_600_000 },
    })
    const event = await service.append(eventInput())

    await dispatcher.dispatchBatch(10)
    expect(deliveries).toHaveLength(1)
    expect((await repository.get(event.eventId)).publication.status).toBe('failed')

    now.value = '2026-08-24T13:01:00.000Z'
    await dispatcher.dispatchBatch(10)
    const quarantined = await repository.get(event.eventId)
    expect(quarantined.publication.status).toBe('quarantined')
    expect(quarantined.publication.attempts).toBe(2)
  })

  test('rejects an invalid escalation window at construction', () => {
    const repository = new InMemoryExecutionEventRepository()
    expect(
      () =>
        new ExecutionEventDispatcher({
          repository,
          publicationService: new ExecutionEventService(repository),
          transport: { deliver: async () => ({ outcome: 'accepted' }) },
          retry: { baseDelayMs: 1_000, maximumAttempts: 3, escalationAfterMs: 0 },
        })
    ).toThrow('INVALID_EVENT_DELIVERY_RETRY_POLICY')
  })
})
