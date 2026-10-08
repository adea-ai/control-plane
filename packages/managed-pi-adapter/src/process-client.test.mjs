import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'bun:test'
import { ProcessRpcLink } from '@control-plane/deployment'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { DirectLocalRuntimeTransport } from '@control-plane/runtime-sdk'
import { ManagedPiAdapter, ManagedPiDriver, translateExecutionPlanToManagedPi } from './index.ts'
import { ManagedPiProcessClient } from './process-client.ts'
import { writeManagedPiRpcFixture } from './test-support/managed-pi-rpc-fixture.mjs'

describe('ManagedPiProcessClient', () => {
  test('shutdown waits for workspace preflight without writing a late admission', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-workspace-preflight-'))
    const workspace = Promise.withResolvers()
    const began = Promise.withResolvers()
    const plan = createExecutionPlanTestFixture()
    const configuration = translateExecutionPlanToManagedPi(plan, '1.2.0')
    const attemptId = `att_${'6'.repeat(26)}`
    const executionId = `exe_${'6'.repeat(26)}`
    const client = new ManagedPiProcessClient({
      executablePath: '/must-not-spawn',
      dataDirectory: directory,
      inputResolver: {
        resolveWorkspace: async () => {
          began.resolve()
          return workspace.promise
        },
        resolve: async () => {
          throw new Error('must not prepare')
        },
      },
    })
    const start = client
      .start({
        attemptId,
        executionId,
        configuration,
        idempotencyKey: 'workspace-preflight',
        attemptBudget: {
          schemaVersion: 1,
          workspaceId: plan.correlation.workspaceId,
          executionId,
          attemptId,
          executionPlanId: plan.executionPlanId,
          executionPlanDigest: plan.contentDigest,
          reservationKey: `runtime-attempt:${attemptId}`,
          currency: 'USD',
          maximumMicrounits: configuration.limits.budget.maximumMicrounits,
          maximumTokens: configuration.limits.tokens.maximumTotal,
        },
      })
      .catch((error) => error)
    try {
      await began.promise
      let closed = false
      const closing = client.close().then(() => {
        closed = true
      })
      await delay(0)
      expect(closed).toBe(false)
      workspace.resolve(plan.correlation.workspaceId)
      await closing
      expect((await start).message).toBe('PI_CLIENT_CLOSED')
      expect(await readdir(directory)).toEqual([])
    } finally {
      workspace.resolve(plan.correlation.workspaceId)
      await start
      await client.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  test('shutdown waits for and closes a late prepared connection without spawning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-late-connection-'))
    const preparation = Promise.withResolvers()
    const began = Promise.withResolvers()
    let closed = 0
    let observedSignal
    const client = new ManagedPiProcessClient({
      executablePath: '/must-not-spawn',
      dataDirectory: directory,
      inputResolver: {
        resolve: async (_configuration, context) => {
          observedSignal = context.signal
          began.resolve()
          await preparation.promise
          return {
            systemPrompt: 'bounded',
            prompt: 'data',
            provider: 'control-plane',
            model: 'reasoning.standard',
            modelConnection: {
              environment: {},
              close: async () => {
                closed++
              },
            },
          }
        },
      },
    })
    const command = {
      attemptId: `att_${'9'.repeat(26)}`,
      idempotencyKey: 'late-connection',
      configuration: translateExecutionPlanToManagedPi(createExecutionPlanTestFixture(), '1.2.0'),
    }
    const start = client.start(command)
    const observed = start.then(
      () => undefined,
      (error) => error
    )
    try {
      await began.promise
      const closing = client.close()
      expect(observedSignal.aborted).toBe(true)
      preparation.resolve()
      await closing
      expect((await observed).message).toBe('PI_CLIENT_CLOSED')
      expect(closed).toBe(1)
      await expect(access(join(directory, command.attemptId))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      preparation.resolve()
      await client.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.each(['success', 'reject', 'cancel', 'shutdown', 'filesystem', 'unconfirmed-stop'])(
    'owns the model connection through %s termination',
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), 'control-plane-pi-model-lease-'))
      const executablePath = join(directory, 'pi-fixture.mjs')
      const recordPath = join(directory, 'record.json')
      const dataDirectory = join(directory, 'executions')
      const attemptId = `att_${'7'.repeat(26)}`
      let closed = 0
      let handle
      const originalStop = ProcessRpcLink.prototype.stop
      await writeManagedPiRpcFixture(executablePath)
      const client = new ManagedPiProcessClient({
        executablePath,
        dataDirectory,
        environment: { HOME: '/ambient/home', CONTROL_PLANE_SECRET: 'must-not-leak' },
        inputResolver: {
          resolve: async () => ({
            systemPrompt: 'private instruction',
            prompt: 'task',
            provider: 'control-plane',
            model: 'reasoning.standard',
            modelConnection: {
              environment: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: '/private/attempt/home',
                MOCK_RECORD_PATH: recordPath,
                ...(mode === 'reject'
                  ? { MOCK_MODE: 'reject' }
                  : mode === 'cancel' || mode === 'shutdown' || mode === 'unconfirmed-stop'
                    ? { MOCK_MODE: 'hold' }
                    : {}),
              },
              close: async () => {
                closed++
              },
            },
          }),
        },
      })
      try {
        if (mode === 'filesystem') {
          await mkdir(dataDirectory)
          await writeFile(join(dataDirectory, attemptId), 'blocks directory creation')
        }
        const command = {
          attemptId,
          idempotencyKey: `model-lease:${mode}`,
          configuration: translateExecutionPlanToManagedPi(
            createExecutionPlanTestFixture(),
            '1.2.0'
          ),
        }
        if (mode === 'filesystem' || mode === 'reject')
          await expect(client.start(command)).rejects.toThrow()
        else {
          handle = await client.start(command)
          if (mode === 'unconfirmed-stop') {
            ProcessRpcLink.prototype.stop = async function (options) {
              await originalStop.call(this, options)
              return false
            }
            await expect(client.cancel(handle)).rejects.toThrow('PI_PROCESS_STOP_UNCONFIRMED')
            expect(closed).toBe(1)
            return
          } else if (mode === 'shutdown') {
            expect(closed).toBe(0)
            await client.close()
            await expect(
              client.start({ ...command, attemptId: `att_${'8'.repeat(26)}` })
            ).rejects.toThrow('PI_CLIENT_CLOSED')
          } else if (mode === 'cancel') {
            expect(closed).toBe(0)
            await client.cancel(handle)
          } else
            for await (const _event of client.progress(handle)) {
              /* drain terminal receipt */
            }
          expect(await client.status(handle)).toMatchObject({
            state: mode === 'cancel' || mode === 'shutdown' ? 'cancelled' : 'succeeded',
          })
          const record = JSON.parse(await readFile(recordPath, 'utf8'))
          expect(record.environment.HOME).toBe('/private/attempt/home')
          expect(record.environment.controlPlaneSecret).toBeNull()
          await client.cleanup(handle)
          handle = undefined
        }
        expect(closed).toBe(1)
      } finally {
        ProcessRpcLink.prototype.stop = originalStop
        if (handle) await client.cleanup(handle).catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
      }
    }
  )

  test('coalesces concurrent input resolution and retains rejected admission identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-pi-admission-'))
    let resolutions = 0
    const options = {
      executablePath: '/must-not-be-launched',
      dataDirectory: directory,
      inputResolver: {
        resolve: async () => {
          resolutions += 1
          await delay(5)
          throw new Error('TEST_INPUT_RESOLUTION_FAILED')
        },
      },
    }
    const client = new ManagedPiProcessClient(options)
    const command = {
      attemptId: `att_${'1'.repeat(26)}`,
      idempotencyKey: 'native-pi:admission',
      configuration: translateExecutionPlanToManagedPi(createExecutionPlanTestFixture(), '1.2.0'),
    }
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => client.start(command))
      )
      expect(results.every((result) => result.status === 'rejected')).toBe(true)
      expect(resolutions).toBe(1)
      await expect(client.start(command)).rejects.toThrow('TEST_INPUT_RESOLUTION_FAILED')
      expect(resolutions).toBe(1)
      await expect(
        client.start({ ...command, idempotencyKey: 'native-pi:changed' })
      ).rejects.toThrow('PI_START_IDEMPOTENCY_CONFLICT')
      await expect(new ManagedPiProcessClient(options).start(command)).rejects.toThrow(
        'PI_START_RECONCILIATION_REQUIRED'
      )
      expect(resolutions).toBe(1)
      const markerPath = join(directory, 'admissions', `${command.attemptId}.json`)
      expect(JSON.parse(await readFile(markerPath, 'utf8'))).toEqual({
        schemaVersion: 1,
        commandDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
      expect((await stat(markerPath)).mode & 0o777).toBe(0o600)
      await writeFile(markerPath, '{')
      await expect(new ManagedPiProcessClient(options).start(command)).rejects.toThrow(
        'PI_START_RECONCILIATION_REQUIRED'
      )
      expect(resolutions).toBe(1)
      const other = { ...command, attemptId: `att_${'2'.repeat(26)}` }
      const competing = await Promise.allSettled(
        Array.from({ length: 8 }, () => new ManagedPiProcessClient(options).start(other))
      )
      expect(
        competing.filter(
          (result) =>
            result.status === 'rejected' && result.reason.message === 'TEST_INPUT_RESOLUTION_FAILED'
        )
      ).toHaveLength(1)
      expect(
        competing.filter(
          (result) =>
            result.status === 'rejected' &&
            result.reason.message === 'PI_START_RECONCILIATION_REQUIRED'
        )
      ).toHaveLength(7)
      expect(resolutions).toBe(2)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('executes through strict Pi RPC with ambient authority disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-pi-rpc-'))
    const executablePath = join(directory, 'pi-fixture.mjs')
    const recordPath = join(directory, 'record.json')
    await writeManagedPiRpcFixture(executablePath)
    const clientOptions = {
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
    }
    const client = new ManagedPiProcessClient(clientOptions)
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
      const nativeStatus = await client.status(handle)
      const nativeEvents = []
      for await (const event of client.progress(handle)) nativeEvents.push(event)
      await adapter.cleanup(handle)
      const recoveredHandle = handle
      handle = undefined
      const recreated = new ManagedPiProcessClient(clientOptions)
      const recovered = await recreated.reconcile(recoveredHandle)
      expect(recovered).toMatchObject({
        state: 'succeeded',
        result: nativeStatus.result,
      })
      expect(await recreated.cancel(recoveredHandle)).toEqual(recovered)
      expect(await recreated.start(nativeCommand)).toEqual(recoveredHandle)
      const parallelReplays = await Promise.all(
        Array.from({ length: 8 }, () =>
          new ManagedPiProcessClient(clientOptions).start(nativeCommand)
        )
      )
      expect(parallelReplays).toEqual(Array.from({ length: 8 }, () => recoveredHandle))
      await recreated.cleanup(recoveredHandle)
      expect((await recreated.status(recoveredHandle)).result).toEqual(nativeStatus.result)
      await expect(new ManagedPiProcessClient(clientOptions).start(changed)).rejects.toThrow(
        'PI_START_IDEMPOTENCY_CONFLICT'
      )
      const recoveredEvents = []
      for await (const event of recreated.progress(recoveredHandle)) recoveredEvents.push(event)
      expect(recoveredEvents).toEqual(nativeEvents)
      const resumedEvents = []
      for await (const event of recreated.progress(recoveredHandle, 2)) resumedEvents.push(event)
      expect(resumedEvents).toEqual(nativeEvents.filter((event) => event.sequence > 2))
      expect(await recreated.progress(recoveredHandle, 0, AbortSignal.abort()).next()).toEqual({
        done: true,
        value: undefined,
      })
      const terminalPath = join(
        directory,
        'executions',
        'terminal-results',
        `${recoveredHandle.attemptId}.json`
      )
      const originalRecord = JSON.parse(await readFile(terminalPath, 'utf8'))
      const legacy = structuredClone(originalRecord)
      delete legacy.events
      await writeFile(terminalPath, JSON.stringify(legacy))
      expect((await recreated.status(recoveredHandle)).result).toEqual(nativeStatus.result)
      await expect(recreated.progress(recoveredHandle).next()).rejects.toMatchObject({
        code: 'PI_TERMINAL_RECONCILIATION_REQUIRED',
      })
      const corrupted = structuredClone(originalRecord)
      corrupted.events[0].sequence = 2
      await writeFile(terminalPath, JSON.stringify(corrupted))
      await expect(recreated.progress(recoveredHandle).next()).rejects.toMatchObject({
        code: 'PI_TERMINAL_RECONCILIATION_REQUIRED',
      })
      await writeFile(terminalPath, JSON.stringify(originalRecord))
      await expect(
        recreated.reconcile({ ...recoveredHandle, startedAt: '2026-01-01T00:00:00.000Z' })
      ).rejects.toMatchObject({ code: 'PI_TERMINAL_RECONCILIATION_REQUIRED' })
      await expect(
        recreated.cancel({ ...recoveredHandle, startedAt: '2026-01-01T00:00:00.000Z' })
      ).rejects.toMatchObject({ code: 'PI_TERMINAL_RECONCILIATION_REQUIRED' })
      await writeFile(
        join(directory, 'executions', 'terminal-results', `${recoveredHandle.attemptId}.json`),
        '{'
      )
      await expect(recreated.status(recoveredHandle)).rejects.toMatchObject({
        code: 'PI_TERMINAL_RECONCILIATION_REQUIRED',
        classification: 'unknown',
        retryable: false,
      })
      await expect(recreated.cancel(recoveredHandle)).rejects.toMatchObject({
        code: 'PI_TERMINAL_RECONCILIATION_REQUIRED',
      })
    } finally {
      if (handle !== undefined) await adapter.cleanup(handle).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('does not publish completed status when terminal storage fails', async () => {
    const fixture = await processAdapterFixture('complete')
    let handle
    const events = []
    try {
      await mkdir(join(fixture.directory, 'executions'), { recursive: true })
      await writeFile(join(fixture.directory, 'executions', 'terminal-results'), 'blocked')
      handle = await fixture.adapter.start({
        attemptId: `att_${'3'.repeat(26)}`,
        idempotencyKey: 'process-client:terminal-write-failure',
        executionPlan: fixture.plan,
      })
      await expect(
        (async () => {
          for await (const event of fixture.adapter.progress(handle)) events.push(event)
        })()
      ).rejects.toMatchObject({
        code: 'PI_TERMINAL_RECONCILIATION_REQUIRED',
        classification: 'unknown',
        retryable: false,
      })
      expect(
        events.some((event) => event.type === 'status' && event.data.state === 'completed')
      ).toBe(false)
      await expect(fixture.adapter.status(handle)).rejects.toMatchObject({
        code: 'PI_TERMINAL_RECONCILIATION_REQUIRED',
      })
    } finally {
      if (handle) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
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

  test('keeps runtime version probing independent from the RPC deadline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-pi-version-probe-'))
    const executablePath = join(directory, 'pi-fixture.mjs')
    try {
      await writeManagedPiRpcFixture(executablePath)
      const client = new ManagedPiProcessClient({
        executablePath,
        dataDirectory: join(directory, 'executions'),
        environment: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        rpcTimeoutMs: 1,
        inputResolver: { resolve: async () => undefined },
      })
      expect(await client.inspect()).toMatchObject({
        health: 'healthy',
        runtimeVersion: '0.84.2',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
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
      await fixture.adapter.cleanup(handle)
      expect(await fixture.recreate().reconcile(handle)).toMatchObject({
        state: 'errored',
        error: { code: 'PI_RUNTIME_ERROR', retryable: false },
      })
      expect(await fixture.recreate().cancel(handle)).toMatchObject({
        state: 'errored',
        error: { code: 'PI_RUNTIME_ERROR', retryable: false },
      })
      handle = undefined
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
      await fixture.adapter.cleanup(handle)
      expect((await fixture.recreate().reconcile(handle)).state).toBe('cancelled')
      expect((await fixture.recreate().cancel(handle)).state).toBe('cancelled')
      handle = undefined
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('preserves validated final usage for failed status and cold terminal recovery', async () => {
    const fixture = await processAdapterFixture('error-with-stats')
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JD0000000000000000000001',
        idempotencyKey: 'process-client:error-with-stats',
        executionPlan: fixture.plan,
      })
      const events = []
      for await (const event of fixture.adapter.progress(handle)) events.push(event)
      const status = await fixture.adapter.status(handle)
      expect(status).toMatchObject({
        state: 'failed',
      })
      expectTerminalUsage(status, 17, 4)
      expect(events.at(-1)).toMatchObject({ type: 'status', data: { state: 'failed' } })
      await fixture.adapter.cleanup(handle)
      const recovered = await fixture.recreate().reconcile(handle)
      expect(recovered).toMatchObject({
        state: 'errored',
      })
      expectTerminalUsage(recovered, 17, 4)
      handle = undefined
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('preserves validated final usage for cancellation and cold terminal recovery', async () => {
    const fixture = await processAdapterFixture('cancel-with-stats')
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JD0000000000000000000002',
        idempotencyKey: 'process-client:cancel-with-stats',
        executionPlan: fixture.plan,
      })
      const status = await fixture.adapter.cancel(handle, {
        idempotencyKey: 'cancel-with-stats',
        requestedAt: new Date().toISOString(),
      })
      expect(status).toMatchObject({
        state: 'cancelled',
      })
      expectTerminalUsage(status, 23, 6)
      await fixture.adapter.cleanup(handle)
      const recovered = await fixture.recreate().reconcile(handle)
      expect(recovered).toMatchObject({
        state: 'cancelled',
      })
      expectTerminalUsage(recovered, 23, 6)
      handle = undefined
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('does not fabricate successful usage from missing, malformed, or unsafe final stats', async () => {
    const attemptIds = [
      'att_01JABCDEF0123456789ABCDEFG',
      'att_01JBCDEF0123456789ABCDEFGH',
      'att_01JCDEF0123456789ABCDEFGHJ',
      'att_01JDEF0123456789ABCDEFGHJK',
    ]
    for (const [index, mode] of [
      'stats-missing',
      'stats-malformed',
      'stats-unsafe',
      'stats-total-overflow',
    ].entries()) {
      const fixture = await processAdapterFixture(mode)
      let handle
      try {
        handle = await fixture.adapter.start({
          attemptId: attemptIds[index],
          idempotencyKey: `process-client:${mode}`,
          executionPlan: fixture.plan,
        })
        const events = []
        for await (const event of fixture.adapter.progress(handle)) events.push(event)
        const status = await fixture.adapter.status(handle)
        expect(status.state, mode).toBe('failed')
        expect(status.result, mode).toBeUndefined()
        expect(status.terminalUsage, mode).toBeUndefined()
        expect(events.at(-1), mode).toMatchObject({ type: 'status', data: { state: 'failed' } })
        await fixture.adapter.cleanup(handle)
        expect(await fixture.recreate().reconcile(handle), mode).toMatchObject({
          state: 'errored',
          error: { code: 'PI_RUNTIME_ERROR' },
        })
        handle = undefined
      } finally {
        if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
        await fixture.cleanup()
      }
    }
  })

  test('status and progress wait for the one measured cancellation snapshot', async () => {
    const fixture = await processAdapterFixture('cancel-stats-delayed', { rpcTimeoutMs: 1_000 })
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'process-client:cancel-stats-delayed',
        executionPlan: fixture.plan,
      })
      const cancelPromise = fixture.adapter.cancel(handle, {
        idempotencyKey: 'cancel-stats-delayed',
        requestedAt: new Date().toISOString(),
      })
      await delay(20)
      const progressPromise = (async () => {
        const events = []
        for await (const event of fixture.adapter.progress(handle)) events.push(event)
        return events
      })()
      const [cancelled, observed, events] = await Promise.all([
        cancelPromise,
        fixture.adapter.status(handle),
        progressPromise,
      ])
      for (const status of [cancelled, observed]) {
        expect(status.state).toBe('cancelled')
        expectTerminalUsage(status, 23, 6)
      }
      expect(events.at(-1)).toMatchObject({ type: 'status', data: { state: 'cancelled' } })
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('a progress iterator paused before cancellation does not yield an unmeasured terminal event', async () => {
    const fixture = await processAdapterFixture('cancel-stats-delayed', { rpcTimeoutMs: 1_000 })
    let handle
    let iterator
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'process-client:progress-cancel-finalization',
        executionPlan: fixture.plan,
      })
      iterator = fixture.adapter.progress(handle)[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.value).toMatchObject({ type: 'status', data: { state: 'running' } })

      const cancelPromise = fixture.adapter.cancel(handle, {
        idempotencyKey: 'progress-cancel-finalization',
        requestedAt: new Date().toISOString(),
      })
      await delay(20)
      let terminalResolved = false
      const terminalPromise = iterator.next().then((result) => {
        terminalResolved = true
        return result
      })
      await delay(30)
      expect(terminalResolved).toBe(false)

      const [cancelled, terminal] = await Promise.all([cancelPromise, terminalPromise])
      expectTerminalUsage(cancelled, 23, 6)
      expect(terminal.value).toMatchObject({ type: 'status', data: { state: 'cancelled' } })
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      if (iterator !== undefined) await iterator.return().catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('cleanup drains cancellation measurement before stopping and removing the execution', async () => {
    const fixture = await processAdapterFixture('cancel-stats-delayed', { rpcTimeoutMs: 1_000 })
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JABCDEF0123456789ABCDEFG',
        idempotencyKey: 'process-client:cleanup-cancel-finalization',
        executionPlan: fixture.plan,
      })
      const cancelPromise = fixture.adapter.cancel(handle, {
        idempotencyKey: 'cleanup-cancel-finalization',
        requestedAt: new Date().toISOString(),
      })
      await delay(20)
      let cleanupResolved = false
      const cleanupPromise = fixture.adapter.cleanup(handle).then(() => {
        cleanupResolved = true
      })
      await delay(30)
      expect(cleanupResolved).toBe(false)
      const cancelled = await cancelPromise
      await cleanupPromise
      expectTerminalUsage(cancelled, 23, 6)
      const recovered = await fixture.recreate().reconcile(handle)
      expect(recovered.state).toBe('cancelled')
      expectTerminalUsage(recovered, 23, 6)
      handle = undefined
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('bounded stats timeout reaps the native child without zero or late mutation', async () => {
    const fixture = await processAdapterFixture('cancel-stats-after-window', {
      rpcTimeoutMs: 5_000,
      captureStatsResponse: true,
      captureProcess: true,
    })
    const statsResponsePath = fixture.statsResponsePath
    let handle
    let rpcCapture
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JBCDEF0123456789ABCDEFGH',
        idempotencyKey: 'process-client:cancel-stats-after-window',
        executionPlan: fixture.plan,
      })
      rpcCapture = captureProcessRpcLinkRequest('get_session_stats', { after: 'abort' })
      let status
      try {
        status = await fixture.adapter.cancel(handle, {
          idempotencyKey: 'cancel-stats-after-window',
          requestedAt: new Date().toISOString(),
        })
      } finally {
        rpcCapture.restore()
      }
      expect(status.state).toBe('cancelled')
      expect(status.terminalUsage).toBeUndefined()
      expect(status.result).toBeUndefined()
      expect(nativeChildAlive(await fixture.nativePid())).toBe(false)
      expect(rpcCapture.captured).toBe(true)
      // The measured window has ended and the same native link is closed.
      // Its delayed stats response must not be produced or retrofit a charge.
      await expect(
        rpcCapture.request(
          { type: 'get_state' },
          { id: 'late-stats-read-barrier', timeoutMs: 5_000 }
        )
      ).rejects.toThrow(/PI_RPC_(?:EXITED|NOT_RUNNING)/)
      await delay(350)
      await expect(access(statsResponsePath)).rejects.toThrow()
      expect((await fixture.adapter.status(handle)).terminalUsage).toBeUndefined()
      await fixture.adapter.cleanup(handle)
      const recovered = await fixture.recreate().reconcile(handle)
      expect(recovered.state).toBe('cancelled')
      expect(recovered.terminalUsage).toBeUndefined()
      handle = undefined
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('late stats from pre-cancel settlement cannot mutate the terminal record', async () => {
    const fixture = await processAdapterFixture('cancel-race-late-stats')
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JCDEF0123456789ABCDEFGHJ',
        idempotencyKey: 'process-client:cancel-race-late-stats',
        executionPlan: fixture.plan,
      })
      const start = performance.now()
      const status = await fixture.adapter.cancel(handle, {
        idempotencyKey: 'cancel-race-late-stats',
        requestedAt: new Date().toISOString(),
      })
      // The late response must not be awaited; leave headroom for slower CI runners.
      expect(performance.now() - start).toBeLessThan(1_500)
      expect(status.state).toBe('cancelled')
      expect(status.terminalUsage).toBeUndefined()
      await delay(350)
      expect((await fixture.adapter.status(handle)).terminalUsage).toBeUndefined()
      await fixture.adapter.cleanup(handle)
      expect((await fixture.recreate().reconcile(handle)).terminalUsage).toBeUndefined()
      handle = undefined
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('does not expose a final snapshot as terminal usage while text settlement is pending', async () => {
    const fixture = await processAdapterFixture('settle-delayed-text')
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JDEF0123456789ABCDEFGHJK',
        idempotencyKey: 'process-client:settle-delayed-text',
        executionPlan: fixture.plan,
      })
      await delay(30)
      expect(await fixture.adapter.status(handle)).toMatchObject({ state: 'running' })
      const events = []
      for await (const event of fixture.adapter.progress(handle)) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'status', data: { state: 'completed' } })
      expect(await fixture.adapter.status(handle)).toMatchObject({
        state: 'completed',
        result: { usage: { inputTokens: 11, outputTokens: 3 } },
      })
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('retains independently validated stats when final text retrieval fails', async () => {
    const fixture = await processAdapterFixture('text-fails-with-stats')
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JD0000000000000000000003',
        idempotencyKey: 'process-client:text-fails-with-stats',
        executionPlan: fixture.plan,
      })
      const events = []
      for await (const event of fixture.adapter.progress(handle)) events.push(event)
      const status = await fixture.adapter.status(handle)
      expect(status.state).toBe('failed')
      expectTerminalUsage(status, 11, 3)
      await fixture.adapter.cleanup(handle)
      const recovered = await fixture.recreate().reconcile(handle)
      expect(recovered).toMatchObject({
        state: 'errored',
      })
      expectTerminalUsage(recovered, 11, 3)
      handle = undefined
    } finally {
      if (handle !== undefined) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('freezes already-observed stats if the process exits while text retrieval is pending', async () => {
    const fixture = await processAdapterFixture('exit-with-stats-pending-text')
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JDEF0123456789ABCDEFGHJK',
        idempotencyKey: 'process-client:exit-with-stats-pending-text',
        executionPlan: fixture.plan,
      })
      const events = []
      for await (const event of fixture.adapter.progress(handle)) events.push(event)
      const status = await fixture.adapter.status(handle)
      expect(status.state).toBe('failed')
      expectTerminalUsage(status, 11, 3)
      await fixture.adapter.cleanup(handle)
      const recovered = await fixture.recreate().reconcile(handle)
      expect(recovered.state).toBe('errored')
      expectTerminalUsage(recovered, 11, 3)
      handle = undefined
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

describe('terminal native child lifecycle', () => {
  test('lost abort acknowledgement still reaps the cancelled child and recovers usage', async () => {
    const fixture = await processAdapterFixture('cancel-abort-unacknowledged', {
      captureProcess: true,
      rpcTimeoutMs: 200,
    })
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId: 'att_01JD0000000000000000000104',
        idempotencyKey: 'unacknowledged-native-abort',
        executionPlan: fixture.plan,
      })
      const startedAt = performance.now()
      const status = await fixture.adapter.cancel(handle, {
        idempotencyKey: 'unacknowledged-native-abort:cancel',
        requestedAt: new Date().toISOString(),
      })
      expect(performance.now() - startedAt).toBeLessThan(1_500)
      expect(status.state).toBe('cancelled')
      expectTerminalUsage(status, 23, 6)
      expect(nativeChildAlive(await fixture.nativePid())).toBe(false)
      const recovered = await fixture.recreate().reconcile(handle)
      expect(recovered.state).toBe('cancelled')
      expectTerminalUsage(recovered, 23, 6)
    } finally {
      if (handle) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  test('unconfirmed child stopping retains admission and working state', async () => {
    const fixture = await processAdapterFixture('cancel-with-stats', { captureProcess: true })
    const originalStop = ProcessRpcLink.prototype.stop
    const attemptId = 'att_01JD0000000000000000000103'
    let handle
    try {
      handle = await fixture.adapter.start({
        attemptId,
        idempotencyKey: 'unconfirmed-native-stop',
        executionPlan: fixture.plan,
      })
      ProcessRpcLink.prototype.stop = async function (options) {
        await originalStop.call(this, options)
        return false // The child is reaped, but its stopping acknowledgement is lost.
      }
      await expect(
        fixture.adapter.cancel(handle, {
          idempotencyKey: 'unconfirmed-native-cancel',
          requestedAt: new Date().toISOString(),
        })
      ).rejects.toThrow('PI_PROCESS_STOP_UNCONFIRMED')
      expect(nativeChildAlive(await fixture.nativePid())).toBe(false)
      await expect(fixture.adapter.status(handle)).rejects.toThrow('PI_PROCESS_STOP_UNCONFIRMED')
      await expect(fixture.adapter.cleanup(handle)).rejects.toThrow('PI_PROCESS_STOP_UNCONFIRMED')
      expect((await stat(join(fixture.directory, 'executions', attemptId))).isDirectory()).toBe(
        true
      )
      await expect(
        access(join(fixture.directory, 'executions', 'terminal-results', `${attemptId}.json`))
      ).rejects.toThrow()
      ProcessRpcLink.prototype.stop = originalStop
      await expect(
        fixture.recreate().start({
          attemptId,
          idempotencyKey: 'unconfirmed-native-stop',
          configuration: translateExecutionPlanToManagedPi(fixture.plan, '1.2.0'),
        })
      ).rejects.toThrow('PI_START_RECONCILIATION_REQUIRED')
      expect(nativeChildAlive(await fixture.nativePid())).toBe(false)
    } finally {
      ProcessRpcLink.prototype.stop = originalStop
      if (handle) await fixture.adapter.cleanup(handle).catch(() => undefined)
      await fixture.cleanup()
    }
  })

  for (const outcome of ['completed', 'cancelled']) {
    test(`reaps the ${outcome} terminal native child before separate cleanup`, async () => {
      const fixture = await processAdapterFixture(
        outcome === 'completed' ? 'normal' : 'cancel-with-stats',
        { captureProcess: true, durationMs: 500 }
      )
      let handle
      try {
        handle = await fixture.adapter.start({
          attemptId: 'att_01JD0000000000000000000101',
          idempotencyKey: `terminal-native:${outcome}`,
          executionPlan: fixture.plan,
        })
        if (outcome === 'cancelled') {
          await fixture.adapter.cancel(handle, {
            idempotencyKey: 'terminal-native:cancel',
            requestedAt: new Date().toISOString(),
          })
        }
        const status = await waitForNativeTerminal(fixture.adapter, handle)
        expect(status.state).toBe(outcome)
        expect(nativeChildAlive(await fixture.nativePid())).toBe(false)
        // A stale duration timer must not replace a committed terminal outcome.
        await delay(600)
        expect((await fixture.adapter.status(handle)).state).toBe(outcome)
        expect((await fixture.recreate().reconcile(handle)).state).toBe(
          outcome === 'completed' ? 'succeeded' : 'cancelled'
        )
      } finally {
        if (handle) await fixture.adapter.cleanup(handle).catch(() => undefined)
        await fixture.cleanup()
      }
    })
  }

  for (const mode of ['cancel-with-stats', 'deadline-stubborn-no-stats']) {
    test(`enforces compiled duration and recovers its terminal receipt: ${mode}`, async () => {
      const fixture = await processAdapterFixture(mode, {
        captureProcess: true,
        durationMs: 500,
      })
      let handle
      try {
        handle = await fixture.adapter.start({
          attemptId: 'att_01JD0000000000000000000102',
          idempotencyKey: `compiled-duration:${mode}`,
          executionPlan: fixture.plan,
        })
        const status = await waitForNativeTerminal(fixture.adapter, handle, 4_000)
        expect(status).toMatchObject({
          state: 'timed_out',
          error: { code: 'PI_EXECUTION_TIMED_OUT', retryable: false },
        })
        expect(nativeChildAlive(await fixture.nativePid())).toBe(false)
        if (mode === 'cancel-with-stats') expectTerminalUsage(status, 23, 6)
        else expect(status).not.toHaveProperty('terminalUsage')
        const recovered = await fixture.recreate().reconcile(handle)
        expect(recovered).toMatchObject({ state: 'timed_out' })
        if (mode === 'cancel-with-stats') expectTerminalUsage(recovered, 23, 6)
        else expect(recovered).not.toHaveProperty('terminalUsage')
      } finally {
        if (handle) await fixture.adapter.cleanup(handle).catch(() => undefined)
        await fixture.cleanup()
      }
    })
  }
})

function nativeChildAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function waitForNativeTerminal(adapter, handle, maximumMs = 2_000) {
  const deadline = performance.now() + maximumMs
  while (performance.now() < deadline) {
    const status = await adapter.status(handle)
    if (['completed', 'cancelled', 'failed', 'timed_out'].includes(status.state)) return status
    await delay(10)
  }
  throw new Error('NATIVE_TERMINAL_OBSERVATION_TIMEOUT')
}

async function processAdapterFixture(mode, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-pi-rpc-case-'))
  const executablePath = join(directory, 'pi-fixture.mjs')
  await writeManagedPiRpcFixture(executablePath)
  const processReceiptPath = options.captureProcess ? join(directory, 'processes.jsonl') : undefined
  if (processReceiptPath) {
    await writeFile(
      join(directory, 'process-owner.json'),
      JSON.stringify({ owner: 'native-process-lifecycle-test', cwd: directory, pid: null })
    )
  }
  const statsResponsePath = options.captureStatsResponse
    ? join(directory, 'stats-response.json')
    : options.statsResponsePath
  const clientOptions = {
    executablePath,
    dataDirectory: join(directory, 'executions'),
    ...(options.rpcTimeoutMs === undefined ? {} : { rpcTimeoutMs: options.rpcTimeoutMs }),
    environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      MOCK_MODE: mode,
      ...(processReceiptPath === undefined
        ? {}
        : { MOCK_PROCESS_RECEIPT_PATH: processReceiptPath }),
      ...(statsResponsePath === undefined ? {} : { MOCK_STATS_RESPONSE_PATH: statsResponsePath }),
    },
    inputResolver: {
      resolve: async () => ({
        systemPrompt: 'immutable system instruction',
        prompt: 'bounded task context',
        provider: 'fixture-provider',
        model: 'fixture-model',
      }),
    },
  }
  const client = new ManagedPiProcessClient(clientOptions)
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
  let plan = createExecutionPlanTestFixture({
    profileCapabilityRequirements: ['stream.output'],
    skillRequiredCapabilities: [],
  })
  if (options.durationMs !== undefined) {
    const inputs = createExecutionPlanTestFixtureInputs({
      profileCapabilityRequirements: ['stream.output'],
      skillRequiredCapabilities: [],
    })
    inputs.profile.definition.executionConstraints.limits.duration.maximumMs = options.durationMs
    plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
  }
  return {
    adapter,
    recreate: () => new ManagedPiProcessClient(clientOptions),
    directory,
    statsResponsePath,
    plan,
    nativePid: async () => {
      const records = (await readFile(processReceiptPath, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
      const native = records.filter(({ args }) => args.includes('rpc'))
      expect(native).toHaveLength(1)
      return native[0].pid
    },
    cleanup: async () => {
      if (processReceiptPath) {
        const records = await readFile(processReceiptPath, 'utf8').catch(() => '')
        for (const line of records.trim().split('\n').filter(Boolean)) {
          const { pid } = JSON.parse(line)
          const deadline = performance.now() + 1_000
          while (nativeChildAlive(pid) && performance.now() < deadline) await delay(10)
          expect(nativeChildAlive(pid)).toBe(false)
        }
        const ledger = process.env.M11_PROCESS_LEDGER_PATH
        if (ledger && process.env.M11_RESOURCE_OWNER && dirname(ledger) === process.env.TMPDIR) {
          await appendFile(ledger, records)
        }
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function captureProcessRpcLinkRequest(commandType, { after }) {
  const originalRequest = ProcessRpcLink.prototype.request
  let capturedLink
  let precedingLink
  const capturingRequest = function (request, options) {
    if (request?.type === after) precedingLink = this
    if (capturedLink === undefined && request?.type === commandType && this === precedingLink) {
      capturedLink = this
    }
    return originalRequest.call(this, request, options)
  }
  ProcessRpcLink.prototype.request = capturingRequest

  return {
    get captured() {
      return capturedLink !== undefined
    },
    request(request, options) {
      if (capturedLink === undefined) throw new Error('PI_RPC_TEST_LINK_NOT_CAPTURED')
      return originalRequest.call(capturedLink, request, options)
    },
    restore() {
      if (ProcessRpcLink.prototype.request === capturingRequest) {
        ProcessRpcLink.prototype.request = originalRequest
      }
    },
  }
}

function expectTerminalUsage(status, inputTokens, outputTokens) {
  expect(status.terminalUsage).toMatchObject({ inputTokens, outputTokens })
  expect(Number.isSafeInteger(status.terminalUsage.durationMs)).toBe(true)
  expect(status.terminalUsage.durationMs).toBeGreaterThanOrEqual(0)
}

describe('ManagedPiProcessClient spawn policy (CP-RNODE-025)', () => {
  test('a policy-pinned executable rejects symlinked escapes before any spawn', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'managed-pi-policy-'))
    try {
      await symlink('/bin/ls', join(directory, 'evil-pi'))
      const client = new ManagedPiProcessClient({
        executablePath: join(directory, 'evil-pi'),
        dataDirectory: join(directory, 'data'),
        inputResolver: { resolve: async () => undefined },
        spawnPolicy: { allowedExecutables: ['/bin/echo'] },
      })
      await expect(client.inspect()).rejects.toMatchObject({
        code: 'PROCESS_LAUNCH_POLICY_VIOLATION',
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a pinned but non-pi executable passes the guard and reports unavailable cleanly', async () => {
    const client = new ManagedPiProcessClient({
      executablePath: '/bin/echo',
      dataDirectory: '/tmp/control-plane-missing-pi-policy',
      inputResolver: { resolve: async () => undefined },
      spawnPolicy: { allowedExecutables: ['/bin/echo'] },
    })
    expect(await client.inspect()).toMatchObject({
      health: 'unavailable',
      runtimeVersion: '0.0.0',
    })
    const inspection = await client.inspect()
    expect(inspection.limitations?.[0]).toStartWith('PI_RUNTIME_UNAVAILABLE:')
  })
})
