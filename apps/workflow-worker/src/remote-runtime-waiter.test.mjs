import { describe, expect, test } from 'bun:test'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import { hashExecutionEventPayloadV2 } from '@control-plane/events'
import { PollingRemoteRuntimeOutcomeWaiter } from './remote-runtime-waiter.js'

const command = {
  commandId: golden.command.commandId,
  commandEnvelope: golden.command,
  expiresAt: '2026-08-25T12:01:00.000Z',
}
const input = {
  command,
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
}

describe('remote runtime durable outcome waiter', () => {
  test.each(['completed', 'failed', 'cancelled'])(
    'recovers attributed %s terminal usage from durable events',
    async (state) => {
      const { waiter, event } = terminalFixture(state)
      expect(await waiter.wait(input)).toMatchObject({ terminalUsage: event.payload.terminalUsage })
    }
  )

  test.each(['hash', 'attempt', 'workspace', 'node', 'command', 'state', 'measurement', 'archive'])(
    'rejects invalid terminal usage %s evidence',
    async (fault) => {
      const { waiter, event } = terminalFixture('completed')
      if (fault === 'hash') event.payloadHash = 'b'.repeat(64)
      if (fault === 'attempt') event.attemptId = 'att_01JABCDEF0123456789ABCDEFH'
      if (fault === 'workspace') event.correlation.workspaceId = 'wsp_01JABCDEF0123456789ABCDEFH'
      if (fault === 'node')
        event.payload.runtimeUsageSource.nodeId = 'rnr_01JABCDEF0123456789ABCDEFH'
      if (fault === 'command')
        event.payload.runtimeUsageSource.commandId = 'cmd_01JABCDEF0123456789ABCDEFH'
      if (fault === 'state') event.type = 'execution.failed'
      if (fault === 'measurement') event.payload.terminalUsage.inputTokens = -1
      if (fault === 'archive') event.archivedAt = event.recordedAt
      if (fault !== 'hash') event.payloadHash = hashExecutionEventPayloadV2(event.payload)
      await expect(waiter.wait(input)).rejects.toThrow()
    }
  )

  test('does not fabricate usage for an old terminal event', async () => {
    const { waiter, event } = terminalFixture('completed')
    delete event.payload.terminalUsage
    delete event.payload.runtimeUsageSource
    event.payloadHash = hashExecutionEventPayloadV2(event.payload)
    expect(await waiter.wait(input)).toEqual({
      outcome: 'completed',
      resultReference: 'art_01JABCDEF0123456789ABCDEFG',
    })
  })
  test.each(['runtime.approval', 'runtime.input'])(
    '%s waits past its answered interaction for the next durable interaction',
    async (operation) => {
      let polls = 0
      const interactionId = 'int_01JABCDEF0123456789ABCDEFG'
      const nextId = 'int_01JABCDEF0123456789ABCDEFH'
      const waiter = fixture({
        executions: {
          getExecution: async () => {
            polls++
            return { state: 'awaiting_input' }
          },
        },
        events: {
          latestInteraction: async () => ({
            type: 'interaction.requested',
            payload: { interactionId: polls === 1 ? interactionId : nextId },
          }),
        },
      })
      expect(
        await waiter.wait({
          ...input,
          command: {
            ...command,
            commandEnvelope: {
              ...golden.command,
              operation,
              requiredCapabilities: [
                operation === 'runtime.input' ? 'interaction.user-input' : 'interaction.approval',
              ],
              payload: {
                version: 1,
                parameters: {
                  handleId: `managed-pi:${input.attemptId}`,
                  interactionId,
                  ...(operation === 'runtime.input'
                    ? { text: 'continue' }
                    : { decision: 'approve' }),
                },
              },
            },
          },
        })
      ).toEqual({ outcome: 'awaiting_input', interactionId: nextId })
      expect(polls).toBe(2)
    }
  )
  test('observes a recovered terminal execution without requiring process-local state', async () => {
    let polls = 0
    const waiter = fixture({
      executions: {
        getExecution: async () =>
          ++polls === 1
            ? { state: 'running' }
            : {
                state: 'completed',
                terminalResultRef: 'art_01JABCDEF0123456789ABCDEFG',
              },
      },
    })

    expect(await waiter.wait(input)).toEqual({
      outcome: 'completed',
      resultReference: 'art_01JABCDEF0123456789ABCDEFG',
    })
    expect(polls).toBe(2)
  })

  test('returns the durable interaction identity and terminal command failures', async () => {
    const interaction = fixture({
      executions: {
        getExecution: async () => ({ executionId: input.executionId, state: 'awaiting_input' }),
      },
      events: {
        latestInteraction: async (executionId, attemptId) => {
          expect([executionId, attemptId]).toEqual([input.executionId, input.attemptId])
          return { type: 'interaction.requested', payload: { interactionId: 'int_01JABC' } }
        },
      },
    })
    expect(await interaction.wait(input)).toEqual({
      outcome: 'awaiting_input',
      interactionId: 'int_01JABC',
    })

    const failed = fixture({
      executions: { getExecution: async () => ({ state: 'running' }) },
      commands: { get: async () => ({ status: 'failed' }) },
    })
    expect(await failed.wait(input)).toEqual({
      outcome: 'failed',
      failureCode: 'REMOTE_RUNTIME_COMMAND_FAILED',
      retryable: false,
    })
  })

  test('bounds an unavailable command by its durable expiry', async () => {
    let now = new Date('2026-08-25T12:00:59.000Z')
    const waiter = fixture({
      executions: { getExecution: async () => ({ state: 'running' }) },
      now: () => now,
      sleep: async () => {
        now = new Date('2026-08-25T12:01:00.000Z')
      },
    })

    expect(await waiter.wait(input)).toEqual({
      outcome: 'failed',
      failureCode: 'REMOTE_RUNTIME_COMMAND_EXPIRED',
      retryable: true,
    })
  })

  test('treats a succeeded runtime cancellation command as cancellation confirmation', async () => {
    let sleeps = 0
    const waiter = fixture({
      executions: { getExecution: async () => ({ state: 'awaiting_input' }) },
      commands: { get: async () => ({ status: 'succeeded' }) },
      events: {
        latestInteraction: async () => ({
          type: 'interaction.requested',
          payload: { interactionId: 'int_old' },
        }),
      },
      sleep: async () => {
        sleeps += 1
      },
    })

    expect(
      await waiter.wait({
        ...input,
        command: {
          ...command,
          commandEnvelope: {
            ...golden.command,
            operation: 'runtime.cancel',
            requiredCapabilities: ['execution.cancel'],
            payload: {
              version: 1,
              parameters: {
                handleId: `managed-pi:${golden.command.attemptId}`,
                requestedAt: '2026-08-25T12:00:00.000Z',
              },
            },
          },
        },
      })
    ).toEqual({ outcome: 'cancelled' })
    expect(sleeps).toBe(0)
  })
})

function terminalFixture(state) {
  const correlation = {
    workspaceId: golden.command.workspaceId,
    projectId: 'prj_01JABCDEF0123456789ABCDEFG',
    taskId: 'tsk_01JABCDEF0123456789ABCDEFG',
    agentId: 'agt_01JABCDEF0123456789ABCDEFG',
    requestId: 'req_01JABCDEF0123456789ABCDEFG',
    commandId: command.commandId,
    traceId: golden.command.traceId,
  }
  const payload = {
    terminalUsage: { inputTokens: 12, outputTokens: 4, durationMs: 120 },
    runtimeUsageSource: {
      nodeId: golden.command.nodeId,
      runtimeConnectionId: golden.command.runtimeConnectionId,
      commandId: command.commandId,
      channelGeneration: 1,
    },
  }
  const event = {
    eventId: 'evt_01JABCDEF0123456789ABCDEFG',
    executionId: input.executionId,
    attemptId: input.attemptId,
    sequence: 1,
    type: `execution.${state}`,
    schemaVersion: 1,
    correlation: { ...correlation },
    payload,
    payloadHash: hashExecutionEventPayloadV2(payload),
    payloadBytes: Buffer.byteLength(JSON.stringify(payload)),
    occurredAt: '2026-08-25T12:00:01.000Z',
    recordedAt: '2026-08-25T12:00:01.000Z',
    retentionExpiresAt: '2026-09-25T12:00:01.000Z',
    publication: { status: 'pending', attempts: 0, version: 1 },
  }
  const waiter = fixture({
    executions: {
      getExecution: async () => ({
        executionId: input.executionId,
        state,
        correlation,
        terminalResultRef: 'art_01JABCDEF0123456789ABCDEFG',
      }),
    },
    commands: {
      get: async () => ({
        ...command,
        executionId: input.executionId,
        attemptId: input.attemptId,
        workspaceId: golden.command.workspaceId,
        lastChannelGeneration: 1,
        nodeId: golden.command.nodeId,
        runtimeConnectionId: golden.command.runtimeConnectionId,
      }),
    },
    events: { latestInteraction: async () => undefined, latestTerminal: async () => event },
  })
  return { waiter, event }
}

function fixture(overrides = {}) {
  return new PollingRemoteRuntimeOutcomeWaiter({
    executions: overrides.executions ?? { getExecution: async () => ({ state: 'running' }) },
    commands: overrides.commands ?? { get: async () => ({ status: 'acknowledged' }) },
    events: overrides.events ?? { latestInteraction: async () => undefined },
    now: overrides.now ?? (() => new Date('2026-08-25T12:00:00.000Z')),
    sleep: overrides.sleep ?? (async () => undefined),
    pollIntervalMs: 10,
  })
}
