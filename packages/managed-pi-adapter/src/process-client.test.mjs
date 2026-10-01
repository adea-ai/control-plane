import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'bun:test'
import { ProcessRpcLink } from '@control-plane/deployment'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DirectLocalRuntimeTransport } from '@control-plane/runtime-sdk'
import { ManagedPiAdapter, ManagedPiDriver, translateExecutionPlanToManagedPi } from './index.ts'
import { ManagedPiProcessClient } from './process-client.ts'
import { writeManagedPiRpcFixture } from './test-support/managed-pi-rpc-fixture.mjs'

describe('ManagedPiProcessClient', () => {
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

  test('bounded stats timeout preserves cancellation without zero or late mutation', async () => {
    const fixture = await processAdapterFixture('cancel-stats-after-window', {
      rpcTimeoutMs: 5_000,
      captureStatsResponse: true,
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
      await waitForFile(statsResponsePath)
      expect(rpcCapture.captured).toBe(true)
      // The same-link probe's FIFO response proves the queued stats frame was read first.
      const readBarrier = await rpcCapture.request(
        { type: 'get_state' },
        { id: 'late-stats-read-barrier', timeoutMs: 5_000 }
      )
      expect(readBarrier).toMatchObject({
        command: 'get_state',
        success: true,
        data: { isStreaming: false },
      })
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

async function processAdapterFixture(mode, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-pi-rpc-case-'))
  const executablePath = join(directory, 'pi-fixture.mjs')
  await writeManagedPiRpcFixture(executablePath)
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
  return {
    adapter,
    recreate: () => new ManagedPiProcessClient(clientOptions),
    directory,
    statsResponsePath,
    plan: createExecutionPlanTestFixture({
      profileCapabilityRequirements: ['stream.output'],
      skillRequiredCapabilities: [],
    }),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
}

async function waitForFile(path) {
  const deadline = performance.now() + 3_000
  while (performance.now() < deadline) {
    try {
      await access(path)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await delay(10)
    }
  }
  throw new Error('PI_FIXTURE_STATS_RESPONSE_NOT_OBSERVED')
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
