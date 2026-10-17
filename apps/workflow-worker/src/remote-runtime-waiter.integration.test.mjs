import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import process from 'node:process'
import { loadDatabaseCredentials } from '@control-plane/config'
import { ExecutionLifecycleService } from '@control-plane/domain'
import {
  ExecutionEventService,
  hashExecutionEventPayload,
  hashExecutionEventPayloadV2,
} from '@control-plane/events'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import {
  PostgresContextPackageRepository,
  PostgresExecutionEventRepository,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
} from '@control-plane/database'
import { createIsolatedTestDatabase, integrationTestTimeout } from '@control-plane/database/testing'
import { PollingRemoteRuntimeOutcomeWaiter } from './remote-runtime-waiter.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const executionId = 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const attemptId = 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const eventId = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV'
const recordedAt = '2026-08-24T12:00:01.000Z'
const terminalResultRef = 'art_01JABCDEF0123456789ABCDEFG'
const plan = createExecutionPlanTestFixture()
const planReference = {
  executionPlanId: plan.executionPlanId,
  contentDigest: plan.contentDigest,
  schemaVersion: plan.schemaVersion,
}
const commandEnvelope = {
  ...golden.command,
  executionId,
  attemptId,
  workspaceId: plan.correlation.workspaceId,
}
const correlation = {
  ...plan.correlation,
  commandId: commandEnvelope.commandId,
  traceId: commandEnvelope.traceId,
}
const historicalPayload = {
  terminalUsage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
  runtimeUsageSource: {
    nodeId: commandEnvelope.nodeId,
    runtimeConnectionId: commandEnvelope.runtimeConnectionId,
    commandId: commandEnvelope.commandId,
    channelGeneration: 1,
  },
  schemaVersion: 1,
  schemas: ['v1'],
  ä: 1,
  z: 2,
}
// Fixed historical en-US digest. Its order differs from the sv-SE and code-point forms.
const historicalPayloadHash = '1df92fd148b428dd38446de650c4af83be7a054203b5a4e0891f18fa5dd0dcdb'

describe.skipIf(!enabled)('remote runtime waiter historical event compatibility', () => {
  let isolated
  let repository

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

    repository = new PostgresExecutionEventRepository(isolated.application)
    const event = await new ExecutionEventService(repository).append({
      eventId,
      executionId,
      attemptId,
      type: 'execution.completed',
      schemaVersion: 1,
      correlation,
      payload: historicalPayload,
      occurredAt: recordedAt,
      recordedAt,
      retentionExpiresAt: '2026-11-22T12:00:00.000Z',
    })
    expect(event.payloadHashVersion).toBe(2)
    expect(event.payloadHash).toBe(hashExecutionEventPayloadV2(historicalPayload))

    await isolated.application.$client.unsafe(
      'update execution_events set payload_hash = $1, payload_hash_version = null where event_id = $2',
      [historicalPayloadHash, eventId]
    )
  }, integrationTestTimeout(60_000))

  afterAll(async () => {
    await isolated?.dispose()
  })

  test(
    'loads and consumes a fixed en-US untagged terminal usage event under pinned sv-SE sorting',
    async () => {
      expect(hashExecutionEventPayload(historicalPayload, 'en-US')).toBe(historicalPayloadHash)
      expect(hashExecutionEventPayload(historicalPayload, 'sv-SE')).not.toBe(historicalPayloadHash)
      expect(hashExecutionEventPayloadV2(historicalPayload)).not.toBe(historicalPayloadHash)

      let terminalReads = 0
      let consumedEvent
      const waiter = new PollingRemoteRuntimeOutcomeWaiter({
        executions: {
          getExecution: async (requestedExecutionId) => {
            expect(requestedExecutionId).toBe(executionId)
            return {
              executionId,
              state: 'completed',
              terminalResultRef,
              correlation: {
                workspaceId: plan.correlation.workspaceId,
                projectId: plan.correlation.projectId,
                taskId: plan.correlation.taskId,
                agentId: plan.correlation.agentId,
              },
            }
          },
        },
        commands: {
          get: async (requestedCommandId) =>
            requestedCommandId === commandEnvelope.commandId
              ? {
                  commandId: commandEnvelope.commandId,
                  commandEnvelope,
                  executionId,
                  attemptId,
                  workspaceId: plan.correlation.workspaceId,
                  nodeId: commandEnvelope.nodeId,
                  runtimeConnectionId: commandEnvelope.runtimeConnectionId,
                  lastChannelGeneration: 1,
                  expiresAt: '2026-08-24T12:01:00.000Z',
                }
              : undefined,
        },
        events: {
          latestInteraction: async () => undefined,
          latestTerminal: async (requestedExecutionId, requestedAttemptId) => {
            terminalReads++
            consumedEvent = await repository.latestTerminal(
              requestedExecutionId,
              requestedAttemptId
            )
            return consumedEvent
          },
        },
        now: () => new Date('2026-08-24T12:00:00.000Z'),
        sleep: async () => undefined,
        pollIntervalMs: 10,
      })

      let outcome
      await withDefaultLocale('sv-SE', async () => {
        expect(hashExecutionEventPayload(historicalPayload)).not.toBe(historicalPayloadHash)
        expect(hashExecutionEventPayload(historicalPayload)).toBe(
          hashExecutionEventPayload(historicalPayload, 'sv-SE')
        )
        expect(hashExecutionEventPayload(historicalPayload, 'en-US')).toBe(historicalPayloadHash)
        outcome = await waiter.wait({
          command: {
            commandId: commandEnvelope.commandId,
            commandEnvelope,
            expiresAt: '2026-08-24T12:01:00.000Z',
          },
          executionId,
          attemptId,
        })
      })
      expect(outcome).toEqual({
        outcome: 'completed',
        resultReference: terminalResultRef,
        terminalUsage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
      })
      expect(terminalReads).toBe(1)
      expect(consumedEvent).toMatchObject({
        eventId,
        executionId,
        attemptId,
        payload: historicalPayload,
        payloadHash: historicalPayloadHash,
      })
      expect(consumedEvent.payloadHashVersion).toBeUndefined()

      const [stored] = await isolated.application.$client.unsafe(
        'select payload, payload_hash, payload_hash_version, payload_bytes from execution_events where event_id = $1',
        [eventId]
      )
      expect(stored.payload).toEqual(historicalPayload)
      expect(stored.payload_hash).toBe(historicalPayloadHash)
      expect(stored.payload_hash_version).toBeNull()
      expect(stored.payload_bytes).toBe(Buffer.byteLength(JSON.stringify(historicalPayload)))
    },
    integrationTestTimeout()
  )
})

async function withDefaultLocale(locale, body) {
  const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'localeCompare')
  if (typeof descriptor?.value !== 'function') throw new Error('STRING_LOCALE_COMPARE_MISSING')
  const original = descriptor.value
  // oxlint-disable-next-line no-extend-native -- test-only locale pin for legacy sorting.
  Object.defineProperty(String.prototype, 'localeCompare', {
    ...descriptor,
    value(compareString, ...args) {
      return args.length === 0
        ? original.call(this, compareString, locale)
        : original.call(this, compareString, ...args)
    },
  })
  try {
    return await body()
  } finally {
    // oxlint-disable-next-line no-extend-native -- restore the locale comparator after the test.
    Object.defineProperty(String.prototype, 'localeCompare', descriptor)
  }
}
