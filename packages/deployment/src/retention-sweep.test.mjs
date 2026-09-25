import { describe, expect, spyOn, test } from 'bun:test'
import { RetentionSweep } from './retention-sweep.ts'

describe('retention sweep', () => {
  test('reports a fixed diagnostic by default without exposing storage errors', async () => {
    let reported
    const report = new Promise((resolve) => {
      reported = resolve
    })
    const diagnostic = spyOn(console, 'error').mockImplementation(() => {
      reported()
    })
    const sweep = new RetentionSweep({
      commandInbox: {
        deleteExpiredInbox: async () => {
          throw new Error('private storage details')
        },
      },
      executionEvents: { deleteExpiredEvents: async () => 0 },
      intervalMs: 5,
    })
    try {
      sweep.start()
      await report
      await sweep.close()
      expect(diagnostic).toHaveBeenCalledWith('RETENTION_SWEEP_FAILED')
      expect(diagnostic).toHaveBeenCalledTimes(1)
    } finally {
      await sweep.close()
      diagnostic.mockRestore()
    }
  })
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

  test('a fail-closed refusal blocks one class without stopping the pass', async () => {
    const reports = []
    let eventSweeps = 0
    const sweep = new RetentionSweep({
      commandInbox: {
        deleteExpiredInbox: async () => {
          throw new Error('COMMAND_RETENTION_ELIGIBILITY_REQUIRED')
        },
      },
      executionEvents: {
        deleteExpiredEvents: async () => {
          eventSweeps += 1
          return 0
        },
      },
      assessCommandInbox: async (now) => ({
        classId: 'command-inbox',
        assessedAt: now.toISOString(),
        scanned: 3,
        truncated: false,
        eligible: 1,
        retainedByReason: { rejection_key_absent: 1, hold_recorded: 1 },
      }),
      assessExecutionEvents: async (now) => ({
        classId: 'execution-events',
        assessedAt: now.toISOString(),
        scanned: 1,
        truncated: false,
        eligible: 0,
        retainedByReason: { unsettled_publication: 1 },
      }),
      intervalMs: 3_600_000,
      onReport: (report) => reports.push(report),
    })

    expect(await sweep.run()).toEqual({ inbox: 0, events: 0 })
    expect(eventSweeps).toBe(1)
    expect(reports).toHaveLength(1)
    expect(reports[0].blocked).toEqual(['COMMAND_RETENTION_ELIGIBILITY_REQUIRED'])
    expect(reports[0].assessment.commandInbox).toEqual({
      classId: 'command-inbox',
      assessedAt: reports[0].at,
      scanned: 3,
      truncated: false,
      eligible: 1,
      retainedByReason: { rejection_key_absent: 1, hold_recorded: 1 },
    })
    expect(reports[0].assessment.executionEvents).toEqual({
      classId: 'execution-events',
      assessedAt: reports[0].at,
      scanned: 1,
      truncated: false,
      eligible: 0,
      retainedByReason: { unsettled_publication: 1 },
    })
  })

  test('a storage failure still surfaces through the error reporter', async () => {
    let errors = 0
    const sweep = new RetentionSweep({
      commandInbox: {
        deleteExpiredInbox: async () => {
          throw new Error('storage failure')
        },
      },
      executionEvents: { deleteExpiredEvents: async () => 0 },
      intervalMs: 3_600_000,
      onError: () => {
        errors += 1
      },
    })
    await expect(sweep.run()).rejects.toThrow('storage failure')
    expect(errors).toBe(0)
  })

  test('a pass without assessment ports still reports counts', async () => {
    const reports = []
    const sweep = new RetentionSweep({
      commandInbox: { deleteExpiredInbox: async () => 2 },
      executionEvents: { deleteExpiredEvents: async () => 1 },
      intervalMs: 3_600_000,
      onReport: (report) => reports.push(report),
    })
    expect(await sweep.run()).toEqual({ inbox: 2, events: 1 })
    expect(reports[0].assessment).toEqual({})
    expect(reports[0].blocked).toEqual([])
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
