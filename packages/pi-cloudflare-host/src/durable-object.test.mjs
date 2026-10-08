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
