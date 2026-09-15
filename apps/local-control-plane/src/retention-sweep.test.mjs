import { describe, expect, test } from 'bun:test'
import { RetentionSweep } from './retention-sweep.ts'

describe('retention sweep', () => {
  test('runs non-overlapping passes and stops cleanly', async () => {
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
