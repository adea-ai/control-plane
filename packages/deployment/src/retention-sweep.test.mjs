import { describe, expect, spyOn, test } from 'bun:test'
import { RetentionSweep } from './retention-sweep.ts'

function assessments({ inboxEligible = 0, eventEligible = 0, delayInbox } = {}) {
  return {
    assessCommandInbox: async (now) => {
      await delayInbox?.()
      return {
        classId: 'command-inbox',
        assessedAt: now.toISOString(),
        scanned: inboxEligible,
        truncated: false,
        eligible: inboxEligible,
        retainedByReason: {},
      }
    },
    assessExecutionEvents: async (now) => ({
      classId: 'execution-events',
      assessedAt: now.toISOString(),
      scanned: eventEligible,
      truncated: false,
      eligible: eventEligible,
      retainedByReason: {},
    }),
  }
}

describe('retention sweep', () => {
  test('scheduled and manual passes only assess and report; deletion-capable extras are ignored', async () => {
    const reports = []
    let inboxDeletes = 0
    let eventDeletes = 0
    const sweep = new RetentionSweep({
      ...assessments({ inboxEligible: 2, eventEligible: 1 }),
      // Deliberately pass obsolete deletion-capable properties at runtime. The
      // scheduler must not read or invoke them, even if a backend has them.
      commandInbox: {
        deleteExpiredInbox: async () => {
          inboxDeletes += 1
          return 1
        },
      },
      executionEvents: {
        deleteExpiredEvents: async () => {
          eventDeletes += 1
          return 1
        },
      },
      intervalMs: 3_600_000,
      onReport: (report) => reports.push(report),
    })

    const report = await sweep.run()
    expect(report).toEqual(reports[0])
    expect(report.at).toBe(report.assessment.commandInbox.assessedAt)
    expect(report.at).toBe(report.assessment.executionEvents.assessedAt)
    expect(report.assessment.commandInbox.eligible).toBe(2)
    expect(report.assessment.executionEvents.eligible).toBe(1)
    expect(inboxDeletes).toBe(0)
    expect(eventDeletes).toBe(0)
    await sweep.close()
  })

  test('scheduled slow assessments do not overlap and close drains the current pass', async () => {
    let release
    const blocked = new Promise((resolve) => {
      release = resolve
    })
    let started
    const firstPass = new Promise((resolve) => {
      started = resolve
    })
    let assessmentsRun = 0
    const sweep = new RetentionSweep({
      ...assessments({
        delayInbox: async () => {
          assessmentsRun += 1
          started()
          await blocked
        },
      }),
      intervalMs: 5,
    })
    try {
      sweep.start()
      await firstPass
      expect(() => sweep.start()).toThrow('RETENTION_SWEEP_ALREADY_STARTED')
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(assessmentsRun).toBe(1)
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
      expect(assessmentsRun).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(assessmentsRun).toBe(1)
      expect(() => sweep.start()).toThrow('RETENTION_SWEEP_CLOSED')
    } finally {
      release()
      await sweep.close()
    }
  })

  test('close before the first tick cancels all scheduled assessments', async () => {
    let calls = 0
    const sweep = new RetentionSweep({
      assessCommandInbox: async () => {
        calls += 1
        return assessments().assessCommandInbox(new Date())
      },
      assessExecutionEvents: async () => ({
        classId: 'execution-events',
        assessedAt: new Date().toISOString(),
        scanned: 0,
        truncated: false,
        eligible: 0,
        retainedByReason: {},
      }),
      intervalMs: 5,
    })
    sweep.start()
    await sweep.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toBe(0)
  })

  test('assessment failures surface through a fixed diagnostic without storage details', async () => {
    let reported
    const report = new Promise((resolve) => {
      reported = resolve
    })
    const diagnostic = spyOn(console, 'error').mockImplementation(() => {
      reported()
    })
    const sweep = new RetentionSweep({
      ...assessments(),
      assessCommandInbox: async () => {
        throw new Error('private storage details')
      },
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

  test('a failed scheduled assessment and throwing error reporter do not stop later passes', async () => {
    let attempts = 0
    let errors = 0
    let resolveRecovery
    const recovery = new Promise((resolve) => {
      resolveRecovery = resolve
    })
    const sweep = new RetentionSweep({
      ...assessments(),
      assessCommandInbox: async (now) => {
        attempts += 1
        if (attempts === 1) throw new Error('private storage details')
        return assessments().assessCommandInbox(now)
      },
      intervalMs: 5,
      onError: () => {
        errors += 1
        throw new Error('reporter failure')
      },
      onReport: () => resolveRecovery(),
    })
    // Resolve from the second assessment only, after the first pass has failed
    // and its error callback has itself thrown.
    let timeout
    try {
      sweep.start()
      await Promise.race([
        recovery,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('RECOVERY_TIMEOUT')), 1000)
        }),
      ])
      expect(attempts).toBe(2)
      expect(errors).toBe(1)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      await sweep.close()
    }
  })

  test('a read-only pass reports assessments to its callback', async () => {
    const reports = []
    const sweep = new RetentionSweep({
      ...assessments({ inboxEligible: 3 }),
      intervalMs: 3_600_000,
      onReport: (report) => reports.push(report),
    })
    expect((await sweep.run()).assessment.commandInbox.eligible).toBe(3)
    expect(reports).toHaveLength(1)
    expect(reports[0].assessment.executionEvents.eligible).toBe(0)
    await sweep.close()
  })

  test('rejects an invalid sweep interval at construction', () => {
    expect(
      () =>
        new RetentionSweep({
          ...assessments(),
          intervalMs: 0,
        })
    ).toThrow('RETENTION_SWEEP_INVALID_INTERVAL')
  })
})
