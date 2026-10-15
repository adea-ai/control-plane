import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { eq } from 'drizzle-orm'
import { loadDatabaseCredentials } from '@control-plane/config'
import { ExecutionLifecycleService } from '@control-plane/domain'
import { hashExecutionEventPayloadV2, ExecutionEventService } from '@control-plane/events'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionEventRepository } from './execution-event-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { createIsolatedTestDatabase, integrationTestTimeout } from './testing.ts'
import { executionEvents } from './schema/events.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const legacyEventId = 'evt_01BRZ3NDEKTSV4RRFFQ69G5FAV'
const recordedAt = '2026-08-24T12:00:01.000Z'
const plan = createExecutionPlanTestFixture()
const planReference = {
  executionPlanId: plan.executionPlanId,
  contentDigest: plan.contentDigest,
  schemaVersion: plan.schemaVersion,
}
const payload = { schemaVersion: 1, schemas: ['v1'], 'a-b': 1, a_b: 2 }
const historicalPayload = { schemaVersion: 1, schemas: ['v1'], 'a-b': 1, a_b: 2 }
const historicalHash = '2a64697fcbc2d74f77b9dceaec97f0bd170aab9592edd2e0248bd5f70f91b735'

function draft(id, value = payload) {
  return {
    eventId: id,
    executionId,
    type: 'execution.progressed',
    schemaVersion: 1,
    correlation: {
      workspaceId: plan.correlation.workspaceId,
      projectId: plan.correlation.projectId,
      taskId: plan.correlation.taskId,
      agentId: plan.correlation.agentId,
      requestId: plan.correlation.requestId,
      traceId: 'trc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    },
    payload: value,
    occurredAt: recordedAt,
    recordedAt,
    retentionExpiresAt: '2026-11-22T12:00:00.000Z',
  }
}

describe.skipIf(!enabled)('PostgreSQL event payload hash versioning', () => {
  let isolated

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase({
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    })
    await isolated.migrate()
    await new PostgresContextPackageRepository(isolated.application).put(
      contextPackageSerializationFixtures.futurePi
    )
    await new PostgresExecutionPlanRepository(isolated.application).put(plan)
    await new ExecutionLifecycleService(
      new PostgresExecutionRepository(isolated.application)
    ).createExecution({
      executionId,
      correlation: plan.correlation,
      executionPlan: planReference,
      acceptedAt: recordedAt,
    })
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    await isolated?.dispose()
  })

  test('persists tagged V2 rows, keeps publication CAS identity, and reads untagged history', async () => {
    const repository = new PostgresExecutionEventRepository(isolated.application)
    const service = new ExecutionEventService(repository)
    const event = await service.append(draft(eventId))

    expect(event).toMatchObject({
      payloadHashVersion: 2,
      payloadHash: hashExecutionEventPayloadV2(payload),
    })
    const [stored] = await isolated.application
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.eventId, eventId))
    expect(stored.payloadHashVersion).toBe(2)

    await expect(service.append(draft(eventId))).rejects.toMatchObject({ code: 'EVENT_EXISTS' })
    const [afterRetry] = await isolated.application
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.eventId, eventId))
    expect(afterRetry.payloadHash).toBe(event.payloadHash)
    expect(afterRetry.payloadHashVersion).toBe(2)

    expect(
      await repository.compareAndSetPublication(1, {
        ...event,
        payloadHashVersion: undefined,
        publication: { ...event.publication, version: 2 },
      })
    ).toBe(false)
    const failed = await service.recordPublicationFailure({
      eventId,
      expectedPublicationVersion: 1,
      attemptedAt: '2026-08-24T12:01:00.000Z',
      errorReference: 'delivery://agent-hq/unavailable',
    })
    expect(failed).toMatchObject({ payloadHashVersion: 2, payloadHash: event.payloadHash })

    const [currentRow] = await isolated.application
      .select()
      .from(executionEvents)
      .where(eq(executionEvents.eventId, eventId))
    await isolated.application.insert(executionEvents).values({
      ...currentRow,
      eventId: legacyEventId,
      sequence: 2,
      payload: historicalPayload,
      payloadBytes: Buffer.byteLength(JSON.stringify(historicalPayload)),
      payloadHash: historicalHash,
      payloadHashVersion: null,
      publicationStatus: 'pending',
      publicationAttempts: 0,
      publicationVersion: 1,
      lastAttemptAt: null,
      nextAttemptAt: null,
      publishedAt: null,
      quarantinedAt: null,
      publicationErrorReference: null,
    })

    const historical = await repository.get(legacyEventId)
    expect(historical).toMatchObject({ payloadHash: historicalHash })
    expect(historical.payloadHashVersion).toBeUndefined()
    await expect(service.append(draft(legacyEventId))).rejects.toMatchObject({
      code: 'EVENT_EXISTS',
    })
    expect(await repository.get(legacyEventId)).toEqual(historical)

    await isolated.application
      .update(executionEvents)
      .set({ payloadHashVersion: 9 })
      .where(eq(executionEvents.eventId, eventId))
    await expect(repository.get(eventId)).rejects.toThrow()
    await isolated.application
      .update(executionEvents)
      .set({ payloadHashVersion: 2, payloadHash: '0'.repeat(64) })
      .where(eq(executionEvents.eventId, eventId))
    await expect(repository.get(eventId)).rejects.toThrow()
  })
})
