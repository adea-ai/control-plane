import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DirectRuntimeActivityPort } from './direct-runtime-activities.ts'

test.each([
  ['cancelled', 'valid'],
  ['completed', 'valid'],
  ['failed', 'valid'],
  ['cancelled', 'handleId'],
  ['cancelled', 'attemptId'],
  ['cancelled', 'startedAt'],
  ['cancelled', 'nonterminal'],
])(
  'queued Local cancellation preserves the confirmed terminal winner and usage: %s / %s',
  async (state, observation) => {
    const directory = await mkdtemp(join(tmpdir(), 'm11-local-queued-cancel-'))
    const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
    const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
    const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
    const handle = {
      handleId: 'native:queued-cancel',
      attemptId,
      startedAt: '2026-09-27T00:00:00.000Z',
    }
    const usage = { inputTokens: 11, outputTokens: 3, durationMs: 20 }
    const status = {
      handle,
      state,
      observedAt: handle.startedAt,
      ...(state === 'completed'
        ? { result: { outcome: 'completed', output: 'done', usage, artifacts: [] } }
        : { terminalUsage: usage }),
      ...(state === 'failed'
        ? {
            error: {
              code: 'RUNTIME_FAILED',
              classification: 'runtime',
              message: 'Fixture failure',
              retryable: false,
            },
          }
        : {}),
    }
    let observedStatus = status
    if (observation === 'nonterminal') {
      observedStatus = { handle, state: 'running', observedAt: handle.startedAt }
    } else if (observation !== 'valid') {
      observedStatus = {
        ...status,
        handle: {
          ...handle,
          [observation]:
            observation === 'attemptId'
              ? 'att_01JABCDEF0123456789ABCDEFH'
              : observation === 'startedAt'
                ? '2026-09-27T00:00:01.000Z'
                : 'native:other',
        },
      }
    }
    let starts = 0
    let cancels = 0
    let publishes = 0
    const runtime = {
      transportKind: 'direct-local',
      start: async () => {
        starts++
        return handle
      },
      cancel: async () => {
        cancels++
        return status
      },
      status: async () => observedStatus,
      reconcile: async () => status,
      async *progress() {},
    }
    const objectStore = {
      put: async () => {
        publishes++
      },
    }
    const input = {
      executionId,
      attemptId,
      effectKey: 'queued-cancel:dispatch',
      executionPlan: createExecutionPlanTestFixture(),
    }
    try {
      await persistence.migrate()
      let activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
      await activities.cancel({
        ...input,
        effectKey: 'queued-cancel:cancel',
        reason: 'user_request',
      })
      if (observation !== 'valid') {
        await expect(activities.dispatch(input)).rejects.toThrow(
          observation === 'nonterminal'
            ? 'RUNTIME_CANCEL_UNCONFIRMED'
            : 'RUNTIME_CANCEL_HANDLE_MISMATCH'
        )
        expect(publishes).toBe(0)
        observedStatus = status
      }
      const first = await activities.dispatch(input)
      expect(first).toMatchObject({ outcome: state, terminalUsage: usage })
      persistence.close({ checkpoint: true })
      await persistence.migrate()
      activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
      expect(await activities.dispatch(input)).toEqual(first)
      expect(starts).toBe(1)
      expect(cancels).toBe(1)
      expect(publishes).toBe(state === 'completed' ? 1 : 0)
      const key = `r-${createHash('sha256').update(`${executionId}:${attemptId}`).digest('hex')}`
      expect(
        (await persistence.transaction((tx) => tx.get('runtime-terminal-usage', key))).value
      ).toMatchObject({ state, usage })
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test.each(['failed', 'timed_out', 'cancelled'])(
  'Local %s outcome preserves externally funded terminal evidence without erasing provider cost',
  async (state) => {
    const directory = await mkdtemp(join(tmpdir(), 'm11-local-reported-usage-'))
    const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
    const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
    const handle = {
      handleId: `native:measured-${state}`,
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      startedAt: '2026-09-27T00:00:00.000Z',
    }
    const usage = {
      inputTokens: 11,
      outputTokens: 3,
      durationMs: 20,
      cost: { amount: '1.00', currency: 'USD' },
      accounting: {
        schemaVersion: 1,
        sourceId: 'measured-provider:external-terminal',
        fundingSource: 'external_subscription',
        currency: 'USD',
        chargedMicrounits: 0,
        costExact: true,
      },
    }
    let starts = 0
    const runtime = {
      transportKind: 'direct-local',
      start: async () => {
        starts += 1
        return handle
      },
      async *progress() {},
      status: async () => ({
        handle,
        state,
        observedAt: handle.startedAt,
        terminalUsage: usage,
        ...(state === 'cancelled'
          ? {}
          : {
              error: {
                code: 'RUNTIME_FAILED',
                classification: 'runtime',
                message: 'Fixture terminal failure',
                retryable: false,
              },
            }),
      }),
    }
    const objectStore = {
      put: async () => {
        throw new Error('UNSUCCESSFUL_RESULT_MUST_NOT_PUBLISH')
      },
    }
    const input = {
      executionId,
      attemptId: handle.attemptId,
      effectKey: `measured-${state}:dispatch`,
      executionPlan: createExecutionPlanTestFixture(),
    }
    try {
      await persistence.migrate()
      let activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
      const first = await activities.dispatch(input)
      expect(first).toMatchObject({
        outcome: state === 'cancelled' ? 'cancelled' : 'failed',
        terminalUsage: usage,
      })
      persistence.close({ checkpoint: true })
      await persistence.migrate()
      activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
      expect(await activities.dispatch(input)).toEqual(first)
      expect(starts).toBe(1)
      const key = `r-${createHash('sha256').update(`${executionId}:${handle.attemptId}`).digest('hex')}`
      const receipt = await persistence.transaction((tx) => tx.get('runtime-terminal-usage', key))
      expect(receipt.value.usage).toEqual(usage)
      expect(receipt.value.state).toBe(state)
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test.each(['normal', 'lost-result'])(
  'completed usage is durable before artifact publication and replay: %s',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'local-completed-usage-'))
    const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
    const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
    const handle = {
      handleId: 'native:completed-usage',
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      startedAt: '2026-09-08T00:00:00.000Z',
    }
    const usage = {
      inputTokens: 11,
      outputTokens: 3,
      durationMs: 20,
      cost: { amount: '0.002', currency: 'USD' },
      accounting: {
        schemaVersion: 1,
        sourceId: 'measured-provider:completed-usage',
        fundingSource: 'hq_managed',
        currency: 'USD',
        chargedMicrounits: 2000,
        costExact: true,
      },
    }
    const status = () => ({
      handle,
      state: 'completed',
      observedAt: handle.startedAt,
      result: { outcome: 'completed', output: 'done', usage, artifacts: [] },
    })
    const key = `r-${createHash('sha256').update(`${executionId}:${handle.attemptId}`).digest('hex')}`
    const receipt = () => persistence.transaction((tx) => tx.get('runtime-terminal-usage', key))
    let starts = 0
    let publishes = 0
    let loseResult = mode === 'lost-result'
    const runtime = {
      transportKind: 'direct-local',
      start: async () => {
        starts++
        return handle
      },
      async *progress() {},
      status: async () => status(),
      reconcile: async () => status(),
      cleanup: async () => {
        expect((await receipt()).value.usage).toEqual(usage)
      },
    }
    const objectStore = {
      put: async () => {
        expect((await receipt())?.value.usage).toEqual(usage)
        publishes++
        if (loseResult) {
          loseResult = false
          throw new Error('LOST_RESULT_PUBLICATION')
        }
      },
    }
    const input = {
      executionId,
      attemptId: handle.attemptId,
      effectKey: 'completed-usage:dispatch',
      executionPlan: createExecutionPlanTestFixture(),
    }
    try {
      await persistence.migrate()
      let activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
      if (mode === 'lost-result') {
        await expect(activities.dispatch(input)).rejects.toThrow('LOST_RESULT_PUBLICATION')
        expect((await receipt()).value.usage).toEqual(usage)
        persistence.close()
        await persistence.migrate()
        activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
        usage.inputTokens = 12
        await expect(activities.dispatch(input)).rejects.toThrow('RUNTIME_TERMINAL_USAGE_CONFLICT')
        expect((await receipt()).value.usage.inputTokens).toBe(11)
        expect(publishes).toBe(1)
        usage.inputTokens = 11
      }
      expect(await activities.dispatch(input)).toMatchObject({
        outcome: 'completed',
        terminalUsage: usage,
      })
      await activities.cleanup({ ...input, effectKey: 'completed-usage:cleanup' })
      persistence.close()
      await persistence.migrate()
      activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
      expect(await activities.dispatch(input)).toMatchObject({
        outcome: 'completed',
        terminalUsage: usage,
      })
      expect(starts).toBe(1)
      expect(publishes).toBe(mode === 'lost-result' ? 2 : 1)
      expect((await receipt()).value).toMatchObject({
        schemaVersion: 1,
        executionId,
        attemptId: handle.attemptId,
        handle,
        state: 'completed',
        usage,
      })
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test.each(['normal', 'lost-effect'])(
  'cancelled usage is durable before cleanup and replay: %s',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'local-terminal-usage-'))
    const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
    const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
    const handle = {
      handleId: 'native:usage',
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      startedAt: '2026-09-08T00:00:00.000Z',
    }
    const usage = { inputTokens: 11, outputTokens: 3, durationMs: 20 }
    const key = `r-${createHash('sha256').update(`${executionId}:${handle.attemptId}`).digest('hex')}`
    const receipt = () => persistence.transaction((tx) => tx.get('runtime-terminal-usage', key))
    let cancels = 0
    const cancellationKeys = []
    const runtime = {
      transportKind: 'direct-local',
      start: async () => handle,
      async *progress() {
        yield { type: 'status', data: { state: 'running' } }
        throw new Error('LOST_OBSERVATION')
      },
      cancel: async (_handle, request) => {
        cancels++
        cancellationKeys.push(request.idempotencyKey)
        return { handle, state: 'cancelled', observedAt: handle.startedAt, terminalUsage: usage }
      },
      cleanup: async () => {
        expect((await receipt()).value.usage).toEqual(usage)
      },
    }
    const input = {
      executionId,
      attemptId: handle.attemptId,
      effectKey: 'usage:cancel',
      reason: 'user_request',
    }
    try {
      await persistence.migrate()
      let loseEffect = mode === 'lost-effect'
      const effectId = `r-${createHash('sha256').update(input.effectKey).digest('hex')}`
      const interrupted = {
        transaction: (operation) =>
          persistence.transaction((tx) =>
            operation(
              new Proxy(tx, {
                get(target, property) {
                  if (property === 'put')
                    return async (record) => {
                      if (
                        loseEffect &&
                        record.namespace === 'workflow-effects' &&
                        record.id === effectId
                      ) {
                        loseEffect = false
                        throw new Error('LOST_CANCEL_EFFECT_COMMIT')
                      }
                      return target.put(record)
                    }
                  const value = Reflect.get(target, property)
                  return typeof value === 'function' ? value.bind(target) : value
                },
              })
            )
          ),
      }
      let activities = new DirectRuntimeActivityPort(interrupted, {}, runtime)
      await expect(
        activities.dispatch({
          ...input,
          effectKey: 'usage:dispatch',
          executionPlan: createExecutionPlanTestFixture(),
        })
      ).rejects.toThrow('LOST_OBSERVATION')
      if (mode === 'lost-effect') {
        await expect(activities.cancel(input)).rejects.toThrow('LOST_CANCEL_EFFECT_COMMIT')
        expect((await receipt()).value.usage.inputTokens).toBe(11)
        persistence.close()
        await persistence.migrate()
        activities = new DirectRuntimeActivityPort(persistence, {}, runtime)
        usage.inputTokens = 12
        await expect(activities.cancel(input)).rejects.toThrow('RUNTIME_TERMINAL_USAGE_CONFLICT')
        expect((await receipt()).value.usage.inputTokens).toBe(11)
        usage.inputTokens = 11
      }
      await activities.cancel(input)
      await activities.cleanup({ ...input, effectKey: 'usage:cleanup' })
      persistence.close()
      await persistence.migrate()
      activities = new DirectRuntimeActivityPort(persistence, {}, runtime)
      await activities.cancel(input)
      expect(cancels).toBe(mode === 'lost-effect' ? 3 : 1)
      expect(new Set(cancellationKeys)).toEqual(new Set([input.effectKey]))
      expect((await receipt()).value).toMatchObject({
        executionId,
        attemptId: handle.attemptId,
        state: 'cancelled',
        usage,
      })
    } finally {
      persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
