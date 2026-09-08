import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'bun:test'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DirectLocalRuntimeTransport } from '@control-plane/runtime-sdk'
import { ManagedPiAdapter, ManagedPiDriver, translateExecutionPlanToManagedPi } from './index.ts'
import { ManagedPiProcessClient } from './process-client.ts'
import { writeManagedPiRpcFixture } from './test-support/managed-pi-rpc-fixture.mjs'

describe('ManagedPiProcessClient', () => {
  test('coalesces concurrent input resolution and retains rejected admission identity', async () => {
    let resolutions = 0
    const client = new ManagedPiProcessClient({
      executablePath: '/must-not-be-launched',
      dataDirectory: '/tmp/m11-pi-admission-must-not-be-created',
      inputResolver: {
        resolve: async () => {
          resolutions += 1
          await delay(5)
          throw new Error('TEST_INPUT_RESOLUTION_FAILED')
        },
      },
    })
    const command = {
      attemptId: `att_${'1'.repeat(26)}`,
      idempotencyKey: 'native-pi:admission',
      configuration: translateExecutionPlanToManagedPi(createExecutionPlanTestFixture(), '1.2.0'),
    }
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => client.start(command)))
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(resolutions).toBe(1)
    await expect(client.start(command)).rejects.toThrow('TEST_INPUT_RESOLUTION_FAILED')
    expect(resolutions).toBe(1)
    await expect(client.start({ ...command, idempotencyKey: 'native-pi:changed' })).rejects.toThrow(
      'PI_START_IDEMPOTENCY_CONFLICT'
    )
  })

  test('executes through strict Pi RPC with ambient authority disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-pi-rpc-'))
    const executablePath = join(directory, 'pi-fixture.mjs')
    const recordPath = join(directory, 'record.json')
    await writeManagedPiRpcFixture(executablePath)
    const client = new ManagedPiProcessClient({
      executablePath,
      dataDirectory: join(directory, 'executions'),
      environment: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        MOCK_RECORD_PATH: recordPath,
      },
      inputResolver: {
        resolve: async () => ({
          systemPrompt: 'immutable system instruction',
          prompt: 'bounded task context',
          provider: 'fixture-provider',
          model: 'fixture-model',
        }),
      },
    })
    const adapter = new ManagedPiAdapter({
      transport: new DirectLocalRuntimeTransport(
        new ManagedPiDriver({
          client,
          adapterVersion: '1.2.0',
          minimumRuntimeVersion: '0.84.0',
          maximumRuntimeVersionExclusive: '0.85.0',
        })
      ),
    })
    const plan = createExecutionPlanTestFixture({
      profileCapabilityRequirements: ['stream.output'],
      skillRequiredCapabilities: [],
    })
    let handle
    try {
      const inspection = await adapter.inspect(plan.runtimeRequirements)
      expect(inspection).toMatchObject({
        health: 'healthy',
        metadata: { harnessVersion: '0.84.2', transportKind: 'direct-local' },
        capabilityEvaluation: { eligible: true },
      })
      const nativeCommand = {
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'process-client:start',
        configuration: translateExecutionPlanToManagedPi(plan, '1.2.0'),
      }
      const admitted = await Promise.all(
        Array.from({ length: 8 }, () => client.start(nativeCommand))
      )
      handle = admitted[0]
      expect(admitted.every((entry) => entry.handleId === handle.handleId)).toBe(true)
      const changed = structuredClone(nativeCommand)
      changed.configuration.limits.duration.maximumMs += 1
      await expect(client.start(changed)).rejects.toThrow('PI_START_IDEMPOTENCY_CONFLICT')
      handle = await adapter.start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'process-client:start',
        executionPlan: plan,
      })
      const events = []
      for await (const event of adapter.progress(handle)) events.push(event)
      expect(events).toEqual([
        expect.objectContaining({ type: 'status', data: { state: 'running' } }),
        expect.objectContaining({ type: 'output', data: { text: 'fixture ' } }),
        expect.objectContaining({
          type: 'usage',
          data: { inputTokens: 11, outputTokens: 3, durationMs: expect.any(Number) },
        }),
        expect.objectContaining({ type: 'status', data: { state: 'completed' } }),
      ])
      const firstStatus = await adapter.status(handle)
      await delay(5)
      const replayedStatus = await adapter.status(handle)
      expect(replayedStatus.result).toEqual(firstStatus.result)
      expect(firstStatus).toMatchObject({
        state: 'completed',
        result: {
          output: { text: 'fixture result' },
          usage: { inputTokens: 11, outputTokens: 3 },
          artifacts: [],
        },
      })
      const record = JSON.parse(await readFile(recordPath, 'utf8'))
      expect(record.args).toEqual(
        expect.arrayContaining([
          '--mode',
          'rpc',
          '--no-session',
          '--no-tools',
          '--no-extensions',
          '--no-skills',
          '--no-context-files',
          '--no-approve',
        ])
      )
      expect(record.args).not.toContain('--api-key')
      expect(record.environment).toEqual({
        HOME: null,
        controlPlaneSecret: null,
        mockRecordPath: recordPath,
      })
      expect(record.prompt).toBe('bounded task context')
      expect(record.systemPrompt).toBe('immutable system instruction')
    } finally {
      if (handle !== undefined) await adapter.cleanup(handle).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('reports an unavailable runtime without leaking process errors', async () => {
    const client = new ManagedPiProcessClient({
      executablePath: '/definitely/not/a/pi/runtime',
      dataDirectory: '/tmp/control-plane-missing-pi',
      inputResolver: { resolve: async () => undefined },
    })
    expect(await client.inspect()).toMatchObject({
      health: 'unavailable',
      runtimeVersion: '0.0.0',
      capabilities: [],
      limitations: ['PI_RUNTIME_UNAVAILABLE:PROCESS_ERROR'],
    })
  })

  test('converges a post-start process crash to one bounded terminal failure', async () => {
    const fixture = await processAdapterFixture('crash')
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JBCDEF0123456789ABCDEFGH',
        idempotencyKey: 'process-client:crash',
        executionPlan: fixture.plan,
      })
      const events = []
      for await (const event of fixture.adapter.progress(handle)) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'status', data: { state: 'failed' } })
      expect(await fixture.adapter.status(handle)).toMatchObject({
        state: 'failed',
        error: {
          code: 'PI_RUNTIME_ERROR',
          message: 'Managed Pi runtime failed',
          retryable: false,
        },
      })
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('bounds unterminated RPC frames and converges the execution', async () => {
    const fixture = await processAdapterFixture('oversized-frame')
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'process-client:oversized-frame',
        executionPlan: fixture.plan,
      })
      const events = []
      for await (const event of fixture.adapter.progress(handle)) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'status', data: { state: 'failed' } })
      expect(await fixture.adapter.status(handle)).toMatchObject({
        state: 'failed',
        error: { code: 'PI_RUNTIME_ERROR', message: 'Managed Pi runtime failed' },
      })
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('does not let asynchronous settlement overwrite cancellation', async () => {
    const fixture = await processAdapterFixture('cancel-race')
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JCDEF0123456789ABCDEFGHJ',
        idempotencyKey: 'process-client:cancel-race',
        executionPlan: fixture.plan,
      })
      const status = await fixture.adapter.cancel(handle, {
        idempotencyKey: 'cancel-race',
        requestedAt: new Date().toISOString(),
      })
      expect(status.state).toBe('cancelled')
      await delay(30)
      expect((await fixture.adapter.status(handle)).state).toBe('cancelled')
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('removes private prompt material when RPC startup is rejected', async () => {
    const fixture = await processAdapterFixture('reject')
    const attemptId = 'att_01JDEF0123456789ABCDEFGHJK'
    try {
      await expect(
        fixture.adapter.start({
          attemptId,
          idempotencyKey: 'process-client:reject',
          executionPlan: fixture.plan,
        })
      ).rejects.toThrow('PI_RPC_REJECTED')
      await expect(stat(join(fixture.directory, 'executions', attemptId))).rejects.toThrow()
    } finally {
      await fixture.cleanup()
    }
  })
})

async function processAdapterFixture(mode) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-pi-rpc-case-'))
  const executablePath = join(directory, 'pi-fixture.mjs')
  await writeManagedPiRpcFixture(executablePath)
  const client = new ManagedPiProcessClient({
    executablePath,
    dataDirectory: join(directory, 'executions'),
    environment: { PATH: process.env.PATH ?? '/usr/bin:/bin', MOCK_MODE: mode },
    inputResolver: {
      resolve: async () => ({
        systemPrompt: 'immutable system instruction',
        prompt: 'bounded task context',
        provider: 'fixture-provider',
        model: 'fixture-model',
      }),
    },
  })
  const adapter = new ManagedPiAdapter({
    transport: new DirectLocalRuntimeTransport(
      new ManagedPiDriver({
        client,
        adapterVersion: '1.2.0',
        minimumRuntimeVersion: '0.84.0',
        maximumRuntimeVersionExclusive: '0.85.0',
      })
    ),
  })
  return {
    adapter,
    directory,
    plan: createExecutionPlanTestFixture({
      profileCapabilityRequirements: ['stream.output'],
      skillRequiredCapabilities: [],
    }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}
