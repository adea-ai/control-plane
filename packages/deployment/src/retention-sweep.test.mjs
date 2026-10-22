import { describe, expect, spyOn, test } from 'bun:test'
import { RetentionSweep } from './retention-sweep.ts'

function emptySummary(classId, now) {
  return {
    classId,
    assessedAt: now.toISOString(),
    scanned: 0,
    truncated: false,
    eligible: 0,
    retainedByReason: {},
  }
}

/**
 * Fake assessment source that records the class of every read, in order, and
 * signals `onPass` once the second class of a pass has been read.
 */
function gatedAssessments(calls, onPass) {
  return {
    assessCommandInbox: async (now) => {
      calls.push('command-inbox')
      return emptySummary('command-inbox', now)
    },
    assessExecutionEvents: async (now) => {
      calls.push('execution-events')
      onPass?.()
      return emptySummary('execution-events', now)
    },
  }
}

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
    try {
      sweep.start()
      await sweep.close()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).toBe(0)
    } finally {
      // A failing assertion must not leave the scheduler's timer running.
      await sweep.close()
    }
  })

  test('start arms the first pass only after one interval; each pass reads one assessment per class', async () => {
    const calls = []
    let firstPass
    const passed = new Promise((resolve) => {
      firstPass = resolve
    })
    const sweep = new RetentionSweep({
      ...gatedAssessments(calls, firstPass),
      intervalMs: 40,
    })
    const startedAt = Date.now()
    try {
      sweep.start()
      // Startup arms a timer only: no assessment read happens synchronously.
      expect(calls).toEqual([])
      await passed
      expect(calls).toEqual(['command-inbox', 'execution-events'])
      // The first read waited a full interval, so this is not an immediate startup pass.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40)
    } finally {
      // A failing assertion must not leave the scheduler's timer running.
      await sweep.close()
    }
  })

  test('a restart has no catch-up: a fresh start arms a full interval and replays nothing', async () => {
    const calls = []
    const pendingPasses = []
    const nextPass = () =>
      new Promise((resolve) => {
        pendingPasses.push(resolve)
      })
    const create = () =>
      new RetentionSweep({
        ...gatedAssessments(calls, () => pendingPasses.shift()?.()),
        intervalMs: 40,
      })

    const first = create()
    const second = create()
    try {
      const firstPass = nextPass()
      first.start()
      await firstPass
      expect(calls).toEqual(['command-inbox', 'execution-events'])
      await first.close()

      // The schedule is in-memory and per-process: the replacement instance does
      // not replay the interval that elapsed while the previous one was stopped.
      const restartedAt = Date.now()
      const secondPass = nextPass()
      second.start()
      expect(calls).toEqual(['command-inbox', 'execution-events'])
      await secondPass
      expect(Date.now() - restartedAt).toBeGreaterThanOrEqual(40)
      expect(calls).toEqual([
        'command-inbox',
        'execution-events',
        'command-inbox',
        'execution-events',
      ])
    } finally {
      // A failing assertion must not leave either scheduler's timer running.
      await first.close()
      await second.close()
    }
  })

  test('a closed scheduler is not re-armed: start throws RETENTION_SWEEP_CLOSED', async () => {
    const calls = []
    const sweep = new RetentionSweep({
      ...gatedAssessments(calls, () => {}),
      intervalMs: 40,
    })
    try {
      sweep.start()
      await sweep.close()
      // Re-arming requires a new instance, which a process restart provides:
      // calling start() again on the closed instance throws instead of arming.
      expect(() => sweep.start()).toThrow('RETENTION_SWEEP_CLOSED')
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(calls).toEqual([])
    } finally {
      await sweep.close()
    }
  })

  test('each pass samples the clock once and assesses every class against that instant', async () => {
    const instants = []
    const sweep = new RetentionSweep({
      assessCommandInbox: async (now) => {
        instants.push(now)
        return emptySummary('command-inbox', now)
      },
      assessExecutionEvents: async (now) => {
        instants.push(now)
        return emptySummary('execution-events', now)
      },
      intervalMs: 40,
    })
    const report = await sweep.run()
    // One instant per pass: every class is assessed against the same deadline
    // boundary, so a pass cannot straddle two clock readings. The proof is the
    // identity of the sampled Date, not its millisecond value: two distinct
    // samples taken within the same millisecond share a millisecond value, so
    // comparing milliseconds could not tell them apart.
    expect(instants).toHaveLength(2)
    expect(instants[0]).toBeInstanceOf(Date)
    expect(instants[0]).toBe(instants[1])
    expect(report.at).toBe(instants[0].toISOString())
    expect(report.assessment.commandInbox.assessedAt).toBe(instants[0].toISOString())
    expect(report.assessment.executionEvents.assessedAt).toBe(instants[0].toISOString())
    await sweep.close()
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
