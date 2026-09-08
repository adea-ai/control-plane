import { describe, expect, test } from 'bun:test'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
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
          queryAfter: async () => [
            {
              type: 'interaction.requested',
              payload: { interactionId: polls === 1 ? interactionId : nextId },
            },
          ],
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
      executions: { getExecution: async () => ({ state: 'awaiting_input' }) },
      events: {
        queryAfter: async () => [
          { type: 'interaction.requested', payload: { interactionId: 'int_01JABC' } },
        ],
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
        queryAfter: async () => [
          { type: 'interaction.requested', payload: { interactionId: 'int_old' } },
        ],
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

function fixture(overrides = {}) {
  return new PollingRemoteRuntimeOutcomeWaiter({
    executions: overrides.executions ?? { getExecution: async () => ({ state: 'running' }) },
    commands: overrides.commands ?? { get: async () => ({ status: 'acknowledged' }) },
    events: overrides.events ?? { queryAfter: async () => [] },
    now: overrides.now ?? (() => new Date('2026-08-25T12:00:00.000Z')),
    sleep: overrides.sleep ?? (async () => undefined),
    pollIntervalMs: 10,
  })
}
