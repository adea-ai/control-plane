import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { FilesystemObjectStore } from '@control-plane/object-store'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { DirectRuntimeActivityPort } from './direct-runtime-activities.ts'

test.each(['start-ack', 'result', 'legacy-result'])(
  'does not redispatch after losing the %s and reopening SQLite',
  async (lostBoundary) => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-dispatch-recovery-'))
    let persistence = new SqlitePersistenceProvider({
      path: join(directory, 'state.sqlite'),
      profile: 'local',
    })
    const objectStore = new FilesystemObjectStore({
      rootDirectory: join(directory, 'artifacts'),
      maxObjectBytes: 1024,
    })
    let starts = 0
    const runtime = {
      transportKind: 'direct-local',
      async start() {
        starts += 1
        // The external runtime accepted work, but no handle/ACK reached the daemon.
        if (lostBoundary === 'start-ack') throw new Error('LOST_RUNTIME_RESPONSE')
        return {
          handleId: 'native:one',
          attemptId: 'att_01JABCDEF0123456789ABCDEFG',
          startedAt: '2026-09-08T00:00:00.000Z',
        }
      },
      async *progress() {
        yield { type: 'status', data: { state: 'running' } }
        throw new Error('LOST_RUNTIME_RESPONSE')
      },
    }
    const input = {
      executionId: 'exe_01JABCDEF0123456789ABCDEFG',
      attemptId: 'att_01JABCDEF0123456789ABCDEFG',
      executionPlan: createExecutionPlanTestFixture(),
      effectKey: 'recovery:dispatch:one',
    }
    try {
      await persistence.migrate()
      const first = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
      await expect(first.dispatch(input)).rejects.toThrow('LOST_RUNTIME_RESPONSE')
      if (lostBoundary === 'legacy-result') {
        // Older versions saved handles but did not persist dispatch intents.
        const intentId = `r-${createHash('sha256').update(`dispatch-intent:${input.effectKey}`).digest('hex')}`
        await persistence.transaction((transaction) =>
          transaction.delete('workflow-effects', intentId)
        )
      }
      await persistence.close()
      persistence = new SqlitePersistenceProvider({
        path: join(directory, 'state.sqlite'),
        profile: 'local',
      })
      await persistence.migrate()
      const recovered = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
      expect(await recovered.dispatch(input)).toEqual({
        outcome: 'failed',
        failureCode: 'LOCAL_RUNTIME_DISPATCH_AMBIGUOUS',
        retryable: false,
      })
      expect(starts).toBe(1)
      expect(await recovered.dispatch(input)).toMatchObject({
        failureCode: 'LOCAL_RUNTIME_DISPATCH_AMBIGUOUS',
        retryable: false,
      })
      expect(starts).toBe(1)
    } finally {
      await persistence.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('coalesces concurrent local dispatches and replays a completed durable outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-dispatch-concurrent-'))
  const persistence = new SqlitePersistenceProvider({
    path: join(directory, 'state.sqlite'),
    profile: 'local',
  })
  const objectStore = new FilesystemObjectStore({
    rootDirectory: join(directory, 'artifacts'),
    maxObjectBytes: 1024,
  })
  const started = Promise.withResolvers()
  const proceed = Promise.withResolvers()
  let starts = 0
  const handle = {
    handleId: 'native:one',
    attemptId: 'att_01JABCDEF0123456789ABCDEFG',
    startedAt: '2026-09-08T00:00:00.000Z',
  }
  const runtime = {
    transportKind: 'direct-local',
    async start() {
      starts += 1
      started.resolve()
      await proceed.promise
      return handle
    },
    async *progress() {},
    async status() {
      return {
        handle,
        state: 'completed',
        observedAt: handle.startedAt,
        result: {
          outcome: 'completed',
          output: { ok: true },
          usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
          artifacts: [],
        },
      }
    },
  }
  const input = {
    executionId: 'exe_01JABCDEF0123456789ABCDEFG',
    attemptId: handle.attemptId,
    executionPlan: createExecutionPlanTestFixture(),
    effectKey: 'concurrent:dispatch',
  }
  try {
    await persistence.migrate()
    const activities = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
    const first = activities.dispatch(input)
    const duplicate = activities.dispatch(input)
    await started.promise
    expect(starts).toBe(1)
    proceed.resolve()
    const results = await Promise.all([first, duplicate])
    expect(results[0]).toEqual(results[1])
    expect(results[0].outcome).toBe('completed')
    const reopened = new DirectRuntimeActivityPort(persistence, objectStore, runtime)
    expect(await reopened.dispatch(input)).toEqual(results[0])
    expect(starts).toBe(1)
  } finally {
    proceed.resolve()
    await persistence.close()
    await rm(directory, { recursive: true, force: true })
  }
})
