import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { SqlitePersistenceProvider } from '@control-plane/sqlite-persistence'
import { WorkflowJobStore } from './embedded-job-store.ts'

const now = '2026-09-18T12:00:00.000Z'
const later = '2026-09-18T12:00:05.000Z'
const afterOriginalLease = '2026-09-18T12:01:02.000Z'
const afterLease = '2026-09-18T12:01:30.000Z'
const owner = 'embedded-runtime-unit'
const owner2 = 'embedded-runtime-unit-2'

const input = {
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workflowId: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  deadlineAt: '2026-09-18T13:00:00.000Z',
  executionPlan: { planId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV', steps: [] },
}

const response = {
  interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  responseId: 'rsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  action: 'approve',
}

const outcome = {
  executionId: input.executionId,
  attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  status: 'completed',
}

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-job-store-'))
  const path = join(directory, 'queue.sqlite')
  let provider = await open()
  async function open() {
    const next = new SqlitePersistenceProvider({ path })
    await next.migrate()
    return next
  }
  try {
    await run({
      store: () => new WorkflowJobStore(provider),
      reopen: async () => {
        provider.close({ checkpoint: true })
        provider = await open()
      },
      close: async () => {
        provider.close({ checkpoint: true })
      },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('WorkflowJobStore', () => {
  test('enqueues idempotently per workflow key and preserves the original input', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      const first = await queue.enqueue({
        workflowKey: input.executionId,
        input,
        maximumAttempts: 3,
        at: now,
      })
      expect(first.outcome).toBe('created')
      expect(first.record.status).toBe('queued')
      expect(first.record.attempt).toBe(0)
      expect(first.record.lease).toBeUndefined()

      const replay = await queue.enqueue({
        workflowKey: input.executionId,
        input: { ...input, deadlineAt: '2026-09-18T14:00:00.000Z' },
        at: later,
      })
      expect(replay.outcome).toBe('duplicate')
      expect(replay.record.input).toEqual(input)
      expect(replay.record.createdAt).toBe(now)

      expect(await queue.get(input.executionId)).toEqual(first.record)
    })
  })

  test('claims only due jobs, stamps a single-use lease, and counts the attempt', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      const due = await queue.enqueue({ workflowKey: 'exe_due', input, at: now })
      await queue.enqueue({ workflowKey: 'exe_future', input, at: now, runAt: later })

      const claimed = await queue.claimDue({ owner, leaseMs: 60_000, now, limit: 10 })
      expect(claimed.map((record) => record.workflowKey)).toEqual([due.record.workflowKey])
      expect(claimed[0].status).toBe('running')
      expect(claimed[0].attempt).toBe(1)
      expect(claimed[0].lease.owner).toBe(owner)
      expect(claimed[0].lease.token).toHaveLength(36)

      // An unexpired lease blocks a competing claim.
      const competitor = await queue.claimDue({ owner: owner2, leaseMs: 60_000, now, limit: 10 })
      expect(competitor).toEqual([])

      // The future job becomes due later and is claimable then.
      const eventual = await queue.claimDue({
        owner: owner2,
        leaseMs: 60_000,
        now: later,
        limit: 10,
      })
      expect(eventual.map((record) => record.workflowKey)).toEqual(['exe_future'])
    })
  })

  test('reclaims jobs whose lease expired and does not resurrect terminal jobs', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      await queue.enqueue({ workflowKey: 'exe_lost', input, at: now })
      const [claimed] = await queue.claimDue({ owner, leaseMs: 60_000, now, limit: 1 })

      // Before expiry: nothing to claim. After expiry: a new owner may reclaim.
      expect(await queue.claimDue({ owner: owner2, leaseMs: 60_000, now, limit: 10 })).toEqual([])
      const reclaimed = await queue.claimDue({
        owner: owner2,
        leaseMs: 60_000,
        now: afterLease,
        limit: 10,
      })
      expect(reclaimed.map((record) => record.workflowKey)).toEqual(['exe_lost'])
      expect(reclaimed[0].attempt).toBe(2)
      expect(claimed.lease.token).not.toBe(reclaimed[0].lease.token)

      await queue.complete({
        workflowKey: 'exe_lost',
        owner: owner2,
        token: reclaimed[0].lease.token,
        outcome,
        at: afterLease,
      })
      expect(await queue.claimDue({ owner, leaseMs: 60_000, now: afterLease, limit: 10 })).toEqual(
        []
      )
      expect((await queue.get('exe_lost')).status).toBe('succeeded')
    })
  })

  test('completing and failing require the live claim token', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      await queue.enqueue({ workflowKey: 'exe_claim', input, at: now })
      const [claimed] = await queue.claimDue({ owner, leaseMs: 60_000, now, limit: 1 })

      await expect(
        await queue.complete({
          workflowKey: 'exe_claim',
          owner: owner2,
          token: 'stale-token',
          outcome,
          at: later,
        })
      ).toBe(false)
      expect((await queue.get('exe_claim')).status).toBe('running')

      await expect(
        await queue.complete({
          workflowKey: 'exe_claim',
          owner,
          token: claimed.lease.token,
          outcome,
          at: later,
        })
      ).toBe(true)
      const finished = await queue.get('exe_claim')
      expect(finished.status).toBe('succeeded')
      expect(finished.outcome).toEqual(outcome)
      expect(finished.lease).toBeUndefined()
    })
  })

  test('a waiting job can still complete: the runner keeps its lease while parked', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      await queue.enqueue({ workflowKey: 'exe_wait_done', input, at: now })
      const [claimed] = await queue.claimDue({ owner, leaseMs: 60_000, now, limit: 1 })
      await queue.markWaiting({
        workflowKey: 'exe_wait_done',
        owner,
        token: claimed.lease.token,
        at: now,
      })
      await expect(
        await queue.complete({
          workflowKey: 'exe_wait_done',
          owner,
          token: claimed.lease.token,
          outcome,
          at: later,
        })
      ).toBe(true)
      expect((await queue.get('exe_wait_done')).status).toBe('succeeded')
    })
  })

  test('failure schedules a retry while attempts remain and then terminates the job', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      await queue.enqueue({ workflowKey: 'exe_flaky', input, maximumAttempts: 2, at: now })

      const [first] = await queue.claimDue({ owner, leaseMs: 60_000, now, limit: 1 })
      expect(
        await queue.fail({
          workflowKey: 'exe_flaky',
          owner,
          token: first.lease.token,
          error: 'RUNTIME_EXPLODED',
          retryAt: now,
          at: now,
        })
      ).toBe(true)
      const retried = await queue.get('exe_flaky')
      expect(retried.status).toBe('failed')
      expect(retried.lastError.message).toBe('RUNTIME_EXPLODED')
      expect(retried.lease).toBeUndefined()

      const [second] = await queue.claimDue({ owner, leaseMs: 60_000, now, limit: 1 })
      expect(second.attempt).toBe(2)
      expect(
        await queue.fail({
          workflowKey: 'exe_flaky',
          owner,
          token: second.lease.token,
          error: 'RUNTIME_EXPLODED',
          at: now,
        })
      ).toBe(true)
      const terminal = await queue.get('exe_flaky')
      expect(terminal.status).toBe('failed')
      expect(await queue.claimDue({ owner, leaseMs: 60_000, now: afterLease, limit: 10 })).toEqual(
        []
      )
    })
  })

  test('marks running jobs waiting and reclaims waiting jobs only after lease expiry', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      await queue.enqueue({ workflowKey: 'exe_wait', input, at: now })
      const [claimed] = await queue.claimDue({ owner, leaseMs: 60_000, now, limit: 1 })
      expect(
        await queue.markWaiting({
          workflowKey: 'exe_wait',
          owner,
          token: claimed.lease.token,
          at: now,
        })
      ).toBe(true)
      expect((await queue.get('exe_wait')).status).toBe('waiting')
      // The waiter holds its lease: no re-claim while the runner is alive.
      expect(await queue.claimDue({ owner: owner2, leaseMs: 60_000, now, limit: 10 })).toEqual([])
      const recovered = await queue.claimDue({
        owner: owner2,
        leaseMs: 60_000,
        now: afterLease,
        limit: 10,
      })
      expect(recovered.map((record) => record.workflowKey)).toEqual(['exe_wait'])
    })
  })

  test('renews leases only for the token holder', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      await queue.enqueue({ workflowKey: 'exe_renew', input, at: now })
      const [claimed] = await queue.claimDue({ owner, leaseMs: 60_000, now, limit: 1 })
      expect(
        await queue.renewLease({
          workflowKey: 'exe_renew',
          owner: owner2,
          token: claimed.lease.token,
          leaseMs: 60_000,
          now: later,
        })
      ).toBe(false)
      expect(
        await queue.renewLease({
          workflowKey: 'exe_renew',
          owner,
          token: claimed.lease.token,
          leaseMs: 60_000,
          now: later,
        })
      ).toBe(true)
      // Original expiry was 12:01:00; the renewal at 12:00:05 extends to 12:01:05,
      // so the job is not claimable between the two and is claimable after both.
      expect(
        await queue.claimDue({ owner: owner2, leaseMs: 60_000, now: afterOriginalLease, limit: 10 })
      ).toEqual([])
      const lapsed = await queue.claimDue({
        owner: owner2,
        leaseMs: 60_000,
        now: afterLease,
        limit: 10,
      })
      expect(lapsed.map((record) => record.workflowKey)).toEqual(['exe_renew'])
    })
  })

  test('stores interaction responses first-wins per interaction id', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      expect(await queue.getInteractionResponse('exe_wait', response.interactionId)).toBeUndefined()
      const first = await queue.saveInteractionResponse({
        workflowKey: 'exe_wait',
        response,
        at: now,
      })
      expect(first.outcome).toBe('created')
      const replay = await queue.saveInteractionResponse({
        workflowKey: 'exe_wait',
        response: { ...response, action: 'deny' },
        at: later,
      })
      expect(replay.outcome).toBe('duplicate')
      expect(await queue.getInteractionResponse('exe_wait', response.interactionId)).toEqual(
        response
      )
      const other = {
        interactionId: 'int_01ARZ3NDEKTSV4RRFFQ69G5FBV',
        responseId: 'rsp_01ARZ3NDEKTSV4RRFFQ69G5FBV',
        action: 'deny',
      }
      await queue.saveInteractionResponse({ workflowKey: 'exe_wait', response: other, at: later })
      expect(await queue.getInteractionResponse('exe_wait', other.interactionId)).toEqual(other)
      expect(
        await queue.getInteractionResponse('exe_other', response.interactionId)
      ).toBeUndefined()
    })
  })

  test('rejects malformed interaction responses', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      await expect(
        queue.saveInteractionResponse({
          workflowKey: 'exe_wait',
          response: { ...response, action: 'input' },
          at: now,
        })
      ).rejects.toThrow('INTERACTION_SIGNAL_VALUE_INVALID')
      await expect(
        queue.saveInteractionResponse({
          workflowKey: 'exe_wait',
          response: { interactionId: '', responseId: 'rsp_x', action: 'deny' },
          at: now,
        })
      ).rejects.toThrow()
    })
  })

  test('records cancellation intent idempotently before or after the job exists', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      const commandId = 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV'
      expect(await queue.getCancellation('exe_cancel')).toBeUndefined()
      const first = await queue.requestCancellation({
        workflowKey: 'exe_cancel',
        commandId,
        at: now,
      })
      expect(first.outcome).toBe('created')
      const replay = await queue.requestCancellation({
        workflowKey: 'exe_cancel',
        commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FBV',
        at: later,
      })
      expect(replay.outcome).toBe('duplicate')
      expect(await queue.getCancellation('exe_cancel')).toEqual({ commandId, requestedAt: now })

      await queue.enqueue({ workflowKey: 'exe_cancel', input, at: later })
      const claimed = await queue.claimDue({ owner, leaseMs: 60_000, now: later, limit: 1 })
      expect(claimed).not.toEqual([])
    })
  })

  test('queue state survives a close/reopen cycle', async () => {
    await withStore(async ({ store, reopen }) => {
      const before = store()
      await before.enqueue({ workflowKey: 'exe_durable', input, at: now })
      await before.saveInteractionResponse({ workflowKey: 'exe_durable', response, at: now })
      await before.requestCancellation({
        workflowKey: 'exe_durable',
        commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        at: now,
      })
      await reopen()

      const after = store()
      expect((await after.get('exe_durable')).status).toBe('queued')
      expect(await after.getInteractionResponse('exe_durable', response.interactionId)).toEqual(
        response
      )
      expect(await after.getCancellation('exe_durable')).toEqual({
        commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
        requestedAt: now,
      })
    })
  })

  test('rejects enqueue input that is not JSON-encodable', async () => {
    await withStore(async ({ store }) => {
      const queue = store()
      const cyclic = {}
      cyclic.self = cyclic
      await expect(
        queue.enqueue({ workflowKey: 'exe_bad', input: cyclic, at: now })
      ).rejects.toThrow()
      await expect(
        queue.enqueue({ workflowKey: 'exe_bad', input: { executionId: 42 }, at: now })
      ).resolves.toBeDefined()
    })
  })
})
