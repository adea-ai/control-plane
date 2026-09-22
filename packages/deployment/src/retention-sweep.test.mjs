import { describe, expect, test } from 'bun:test'
import { RetentionSweep } from './retention-sweep.ts'

describe('retention sweep', () => {
  test('scheduled slow passes do not overlap and close drains the current pass', async () => {
    let release
    const blocked = new Promise((resolve) => {
      release = resolve
    })
    let started
    const firstPass = new Promise((resolve) => {
      started = resolve
    })
    let calls = 0
    let events = 0
    const sweep = new RetentionSweep({
      commandInbox: {
        deleteExpiredInbox: async () => {
          calls += 1
          started()
          await blocked
          return 0
        },
      },
      executionEvents: {
        deleteExpiredEvents: async () => {
          events += 1
          return 0
        },
      },
      intervalMs: 5,
    })
    try {
      sweep.start()
      await firstPass
      expect(() => sweep.start()).toThrow('RETENTION_SWEEP_ALREADY_STARTED')
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(calls).toBe(1)
      const closing = sweep.close()
      expect(sweep.close()).toBe(closing)
      let drained = false
      void Promise.resolve(closing).then(() => {
        drained = true
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(drained).toBe(false)
      release()
      await closing
      expect(events).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).toBe(1)
      expect(() => sweep.start()).toThrow('RETENTION_SWEEP_CLOSED')
    } finally {
      release()
      await sweep.close()
    }
  })
  test('close before the first tick cancels all scheduled work', async () => {
    let calls = 0
    const sweep = new RetentionSweep({
      commandInbox: {
        deleteExpiredInbox: async () => {
          calls += 1
          return 0
        },
      },
      executionEvents: { deleteExpiredEvents: async () => 0 },
      intervalMs: 5,
    })
    sweep.start()
    await sweep.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBe(0)
  })

  test('failed passes and throwing reporters do not stop subsequent passes', async () => {
    let calls = 0
    let errors = 0
    let recovered
    const recovery = new Promise((resolve) => {
      recovered = resolve
    })
    const sweep = new RetentionSweep({
      commandInbox: {
        deleteExpiredInbox: async () => {
          calls += 1
          if (calls === 1) throw new Error('storage failure')
          return 0
        },
      },
      executionEvents: {
        deleteExpiredEvents: async () => {
          recovered()
          return 0
        },
      },
      intervalMs: 5,
      onError: () => {
        errors += 1
        throw new Error('reporter failure')
      },
    })
    try {
      sweep.start()
      await recovery
      expect(calls).toBe(2)
      expect(errors).toBe(1)
    } finally {
      await sweep.close()
    }
  })

  test('supports explicit manual passes independently of the scheduler', async () => {
    let inboxSweeps = 0
    const sweep = new RetentionSweep({
      commandInbox: {
        deleteExpiredInbox: async () => {
          inboxSweeps += 1
          return inboxSweeps
        },
      },
      executionEvents: {
        deleteExpiredEvents: async () => 0,
      },
      intervalMs: 3_600_000,
    })
    expect(await sweep.run()).toEqual({ inbox: 1, events: 0 })
    expect(await sweep.run()).toEqual({ inbox: 2, events: 0 })
    sweep.close()
    expect(await sweep.run()).toEqual({ inbox: 3, events: 0 })
  })

  test('rejects an invalid sweep interval at construction', () => {
    expect(
      () =>
        new RetentionSweep({
          commandInbox: { deleteExpiredInbox: async () => 0 },
          executionEvents: { deleteExpiredEvents: async () => 0 },
          intervalMs: 0,
        })
    ).toThrow('RETENTION_SWEEP_INVALID_INTERVAL')
  })
})
