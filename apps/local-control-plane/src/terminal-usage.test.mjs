import { test, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DirectRuntimeActivityPort } from './direct-runtime-activities.ts'

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
