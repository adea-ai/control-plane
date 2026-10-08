import { createRegistry } from '@earendil-works/pi-durable'
import { expect, test } from 'bun:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { CloudflarePiDurableOwner } from './durable-object.ts'
import { fixture, pins, request, task } from './test-fixtures.mjs'

function reopen(f) {
  return new CloudflarePiDurableOwner(
    { storage: f.storage, blockConcurrencyWhile: (fn) => fn() },
    {
      context: BACKGROUND_CONTEXT,
      pins,
      authority: f.authority,
      now: () => 42,
      nativeTaskCatalog: {
        schemaVersion: 1,
        configurationDigest: pins.configurationDigest,
        registry: createRegistry().snapshot(),
        migrations: [],
      },
      openEngine: f.openEngine,
    }
  )
}

test('constructor reentry repairs durable wake intent before serving retained admission', async () => {
  const f = fixture()
  try {
    f.storage.setAlarm = async () => {
      throw new Error('alarm unavailable')
    }
    await expect(f.host.accept(request, 42)).rejects.toThrow('alarm unavailable')
    const alarms = []
    f.storage.setAlarm = async (dueAt) => {
      alarms.push(dueAt)
    }
    const owner = reopen(f)
    expect((await owner.read(request.attemptId)).state).toBe('accepted')
    expect(alarms).toEqual([42])
    await owner.alarm()
    expect((await owner.read(request.attemptId)).state).toBe('completed')
    expect(f.db.query('SELECT * FROM cp_pi_wake').all()).toEqual([])
  } finally {
    f.db.close()
  }
})

test('a revoked first task cannot starve valid later work in an alarm batch', async () => {
  const f = fixture()
  try {
    f.authority.readAccepted = async (incoming) => ({ ...task, request: incoming })
    const second = {
      ...request,
      attemptId: 'att_00000000000000000000000002',
      idempotencyKey: 'second',
      attemptBudget: {
        ...request.attemptBudget,
        attemptId: 'att_00000000000000000000000002',
        reservationKey: 'runtime-attempt:att_00000000000000000000000002',
      },
    }
    await f.host.accept(request, 42)
    await f.host.accept(second, 42)
    const assertCurrent = f.authority.assertCurrent
    f.authority.assertCurrent = async (...args) => {
      if (args[0].request.attemptId === request.attemptId) throw new Error('REVOKED')
      await assertCurrent(...args)
    }
    const owner = reopen(f)
    await expect(owner.alarm()).rejects.toThrow('CLOUDFLARE_WAKE_BATCH_INCOMPLETE')
    expect((await owner.read(second.attemptId)).state).toBe('completed')
    expect(
      f.db.query('SELECT state FROM cp_pi_tasks WHERE attempt_id = ?').get(request.attemptId).state
    ).toBe('accepted')
    expect(f.counts().opens).toBe(1)
    expect(f.db.query('SELECT due_at FROM cp_pi_wake').get().due_at).toBe(30042)
  } finally {
    f.db.close()
  }
})

test('public facade composes actual durable owner alarm/storage lifecycle with retained handles', async () => {
  const f = fixture()
  try {
    const owner = reopen(f),
      runtime = owner.runtimeAdapter()
    const handle = await runtime.start(request)
    expect((await runtime.status(handle)).state).toBe('starting')
    expect(f.counts().opens).toBe(0)
    await owner.alarm()
    expect((await runtime.status(handle)).state).toBe('completed')
    const values = []
    for await (const event of runtime.progress(handle)) values.push(event)
    expect(values.map((event) => event.data.state)).toEqual(['starting', 'running', 'completed'])
    expect(values.every((event) => event.occurredAt === handle.startedAt)).toBe(true)
    const restarted = reopen(f).runtimeAdapter()
    expect(await restarted.start(request)).toEqual(handle)
    expect((await restarted.status(handle)).state).toBe('completed')
    expect(f.counts().sends).toBe(1)
  } finally {
    f.db.close()
  }
})

import { openCloudflarePiStorage } from './storage.ts'

test('missing catalog and unknown native definitions deny before engine without changing native records', async () => {
  for (const mode of ['missing-catalog', 'unknown-definition']) {
    const f = fixture()
    try {
      await f.host.accept(request, 42)
      const storage = await openCloudflarePiStorage(f.storage)
      const conversationId = await storage.mintId(),
        nativeTaskId = await storage.mintId()
      await storage.commit(
        [
          { type: 'conversation', value: { id: conversationId } },
          {
            type: 'task',
            value: {
              id: nativeTaskId,
              conversationId,
              kind: 'uninstalled-probe',
              version: 9,
              input: { opaque: 'retained' },
              background: false,
              abortRequested: false,
              state: { status: 'pending', checkpoint: { phase: 'retained' } },
            },
          },
        ],
        BACKGROUND_CONTEXT
      )
      const before = await storage.scanTasks({}, 64, undefined, BACKGROUND_CONTEXT)
      await storage.close(BACKGROUND_CONTEXT)
      const owner = new CloudflarePiDurableOwner(
        { storage: f.storage, blockConcurrencyWhile: (fn) => fn() },
        {
          context: BACKGROUND_CONTEXT,
          pins,
          authority: f.authority,
          now: () => 42,
          openEngine: f.openEngine,
          ...(mode === 'unknown-definition'
            ? {
                nativeTaskCatalog: {
                  schemaVersion: 1,
                  configurationDigest: pins.configurationDigest,
                  registry: createRegistry().snapshot(),
                  migrations: [],
                },
              }
            : {}),
        }
      )
      let failure
      try {
        await owner.alarm()
      } catch (error) {
        failure = error
      }
      expect(failure.message).toBe('CLOUDFLARE_WAKE_BATCH_INCOMPLETE')
      expect(failure.errors[0].code).toBe(
        mode === 'missing-catalog'
          ? 'CLOUDFLARE_TASK_CATALOG_UNAVAILABLE'
          : 'CLOUDFLARE_TASK_DEFINITION_MISSING'
      )
      expect(failure.errors[0].retryable).toBe(false)
      expect(f.counts().opens).toBe(0)
      expect(f.counts().sends).toBe(0)
      const reopened = await openCloudflarePiStorage(f.storage)
      try {
        expect(await reopened.scanTasks({}, 64, undefined, BACKGROUND_CONTEXT)).toEqual(before)
      } finally {
        await reopened.close(BACKGROUND_CONTEXT)
      }
      expect((await owner.read(request.attemptId)).state).toBe('reconciliation_required')
    } finally {
      f.db.close()
    }
  }
})
