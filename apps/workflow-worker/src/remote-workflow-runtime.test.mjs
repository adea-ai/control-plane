import { describe, expect, test } from 'bun:test'
import { InMemoryRuntimeCommandRepository } from '@control-plane/domain'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { golden } from '@control-plane/runtime-gateway-protocol/fixtures'
import { DurableRemoteWorkflowRuntime } from './remote-workflow-runtime.js'

describe('durable remote workflow runtime', () => {
  test('replay retains the first command lease when the factory clock advances', async () => {
    const commands = new InMemoryRuntimeCommandRepository()
    let invocation = 0
    const runtime = fixture(commands, { wait: async () => ({ outcome: 'completed' }) }, () => {
      const offset = invocation++ * 1000
      return {
        ...golden.command,
        sentAt: new Date(Date.parse(golden.command.sentAt) + offset).toISOString(),
        issuedAt: new Date(Date.parse(golden.command.issuedAt) + offset).toISOString(),
        expiresAt: new Date(Date.parse(golden.command.expiresAt) + offset).toISOString(),
      }
    })
    const input = {
      executionId: golden.command.executionId,
      attemptId: golden.command.attemptId,
      executionPlan: createExecutionPlanTestFixture(),
      effectKey: 'workflow:dispatch:stable',
    }
    await runtime.dispatch(input)
    const original = await commands.get(golden.command.commandId)
    expect(await runtime.dispatch(input)).toEqual({ outcome: 'completed' })
    expect(await commands.get(golden.command.commandId)).toEqual(original)
  })

  test('queues one attempt-bound command and converges replay on the same outcome', async () => {
    const commands = new InMemoryRuntimeCommandRepository()
    const waits = []
    const runtime = fixture(commands, {
      wait: async (input) => {
        waits.push(input)
        return { outcome: 'completed', resultReference: 'art_01JABCDEF0123456789ABCDEFG' }
      },
    })
    const plan = createExecutionPlanTestFixture()
    const input = {
      executionId: golden.command.executionId,
      attemptId: golden.command.attemptId,
      executionPlan: plan,
      effectKey: 'workflow:dispatch:stable',
    }

    expect(await runtime.dispatch(input)).toEqual({
      outcome: 'completed',
      resultReference: 'art_01JABCDEF0123456789ABCDEFG',
    })
    expect(await runtime.dispatch(input)).toEqual({
      outcome: 'completed',
      resultReference: 'art_01JABCDEF0123456789ABCDEFG',
    })
    expect(await commands.get(golden.command.commandId)).toMatchObject({
      executionId: input.executionId,
      attemptId: input.attemptId,
      nodeId: golden.command.nodeId,
      runtimeConnectionId: golden.command.runtimeConnectionId,
      status: 'queued',
    })
    expect(waits).toHaveLength(2)
    expect(waits[0].command.commandId).toBe(golden.command.commandId)
  })

  test('concurrent clock-shifted retries retain one command without renewing its lease', async () => {
    const commands = new InMemoryRuntimeCommandRepository()
    let invocation = 0
    const runtime = fixture(commands, { wait: async () => ({ outcome: 'completed' }) }, () => ({
      ...golden.command,
      sentAt: new Date(Date.parse(golden.command.sentAt) + invocation++ * 1000).toISOString(),
    }))
    const input = {
      executionId: golden.command.executionId,
      attemptId: golden.command.attemptId,
      executionPlan: createExecutionPlanTestFixture(),
      effectKey: 'workflow:dispatch:stable',
    }
    await Promise.all(Array.from({ length: 8 }, () => runtime.dispatch(input)))
    expect((await commands.get(golden.command.commandId)).commandEnvelope).toEqual(golden.command)
  })

  test('clock-shifted replay still rejects changed command semantics', async () => {
    for (const change of [
      { payload: { ...golden.command.payload, parameters: { changed: true } } },
      { requiredCapabilities: ['execution.cancel'] },
      { driver: { ...golden.command.driver, version: '99.0.0' } },
      { idempotencyKey: 'remote:different-effect-key' },
    ]) {
      const commands = new InMemoryRuntimeCommandRepository()
      let replay = false
      const runtime = fixture(commands, { wait: async () => ({ outcome: 'completed' }) }, () => ({
        ...golden.command,
        ...(replay ? { ...change, sentAt: '2026-08-25T12:00:01.000Z' } : {}),
      }))
      const input = {
        executionId: golden.command.executionId,
        attemptId: golden.command.attemptId,
        executionPlan: createExecutionPlanTestFixture(),
        effectKey: 'workflow:dispatch:stable',
      }
      await runtime.dispatch(input)
      replay = true
      await expect(runtime.dispatch(input)).rejects.toThrow('REMOTE_RUNTIME_COMMAND_CONFLICT')
      expect((await commands.get(golden.command.commandId)).commandEnvelope).toEqual(golden.command)
    }
  })

  test('fails closed before persistence when the command widens frozen attempt scope', async () => {
    const commands = new InMemoryRuntimeCommandRepository()
    const runtime = fixture(commands, { wait: async () => ({ outcome: 'cancelled' }) }, () => ({
      ...golden.command,
      workspaceId: 'wsp_01JBBCDEF0123456789ABCDEFG',
    }))
    const plan = createExecutionPlanTestFixture()

    await expect(
      runtime.dispatch({
        executionId: golden.command.executionId,
        attemptId: golden.command.attemptId,
        executionPlan: plan,
        effectKey: 'workflow:dispatch:stable',
      })
    ).rejects.toThrow('REMOTE_RUNTIME_COMMAND_SCOPE_MISMATCH')
    expect(await commands.get(golden.command.commandId)).toBeUndefined()
  })

  test('queues and waits for an attempt-bound runtime cancellation command', async () => {
    const commands = new InMemoryRuntimeCommandRepository()
    const waits = []
    const runtime = fixture(commands, {
      wait: async (input) => {
        waits.push(input)
        return { outcome: 'cancelled' }
      },
    })

    await runtime.cancel({
      executionId: golden.command.executionId,
      attemptId: golden.command.attemptId,
      effectKey: 'workflow:cancel:stable',
      reason: 'deadline',
    })

    expect(waits).toHaveLength(1)
    expect(waits[0].command.commandEnvelope.operation).toBe('runtime.cancel')
  })
})

function fixture(commands, waiter, createExecute = () => golden.command) {
  return new DurableRemoteWorkflowRuntime({
    attempts: {
      getAttempt: async () => ({
        attemptId: golden.command.attemptId,
        executionId: golden.command.executionId,
        runtime: {
          runtimeNodeRefId: golden.command.nodeId,
          runtimeConnectionId: golden.command.runtimeConnectionId,
        },
      }),
    },
    commands,
    factory: {
      createExecute,
      createCancel: () => ({
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
      }),
    },
    waiter,
    now: () => new Date('2026-08-25T12:00:00.000Z'),
  })
}
