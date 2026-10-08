import { expect, test } from 'bun:test'
import { CloudflarePiRuntimeAdapter } from './adapter.ts'
import { CloudflareOwnerJournal } from './owner.ts'
import { CloudflarePiHost } from './host.ts'
import { fixture, pins, request, result, task } from './test-fixtures.mjs'
function adapter(host, now = () => 100) {
  return new CloudflarePiRuntimeAdapter(
    {
      accept: (input) => host.accept(input, now()),
      read: (id) => host.read(id),
      timedEvents: (id, cursor) => host.timedEvents(id, cursor),
      cancel: (id, input) => host.cancel(id, input),
      reconcile: (id) => host.reconcile(id),
    },
    now
  )
}
async function events(runtime, handle, options) {
  const values = []
  for await (const event of runtime.progress(handle, options)) values.push(event)
  return values
}
test('first-admission tuple and cursor timestamps survive replay/reentry without waking', async () => {
  const f = fixture()
  try {
    const runtime = adapter(f.host),
      handle = await runtime.start(request)
    expect(handle.externalSessionId).toBeUndefined()
    expect(handle.startedAt).toBe(new Date(100).toISOString())
    expect(await adapter(f.host, () => 200).start(request)).toEqual(handle)
    expect((await runtime.status(handle)).state).toBe('starting')
    const initial = await events(runtime, handle)
    expect(initial[0].occurredAt).toBe(handle.startedAt)
    await f.host.wake(request.attemptId)
    expect((await runtime.status(handle)).result).toEqual(result)
    const restarted = adapter(
      new CloudflarePiHost(
        new CloudflareOwnerJournal(f.storage, pins),
        pins,
        f.authority,
        f.openEngine
      )
    )
    expect(await restarted.start(request)).toEqual(handle)
    const retained = await events(restarted, handle)
    expect(retained[0]).toEqual(initial[0])
    expect(await events(restarted, handle, { afterSequence: initial[0].sequence })).toEqual(
      retained.slice(1)
    )
    expect(f.counts().sends).toBe(1)
  } finally {
    f.db.close()
  }
})
test('full forged handle denies status/cancel/reconcile/progress without mutation', async () => {
  const f = fixture()
  try {
    const runtime = adapter(f.host),
      handle = await runtime.start(request)
    for (const forged of [
      { ...handle, handleId: 'wrong' },
      { ...handle, startedAt: new Date(200).toISOString() },
      { ...handle, externalSessionId: 'ses_00000000000000000000000001' },
    ]) {
      await expect(runtime.status(forged)).rejects.toThrow()
      await expect(
        runtime.cancel(forged, { idempotencyKey: 'cancel', requestedAt: handle.startedAt })
      ).rejects.toThrow()
      await expect(runtime.reconcile(forged)).rejects.toThrow()
      await expect(events(runtime, forged)).rejects.toThrow()
    }
    expect(f.journal.get(request.attemptId).state).toBe('accepted')
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})
test('unknown interruption exposes neither result nor error and never resends', async () => {
  const f = fixture()
  try {
    const handle = await adapter(f.host).start(request)
    f.journal.transition(request.attemptId, 'accepted', 'running')
    const journal = new CloudflareOwnerJournal(f.storage, pins),
      runtime = adapter(new CloudflarePiHost(journal, pins, f.authority, f.openEngine))
    const status = await runtime.status(handle)
    expect(status.state).toBe('unknown')
    expect(status.error).toBeUndefined()
    expect(status.result).toBeUndefined()
    expect((await events(runtime, handle)).at(-1).data.reason).toBe(
      'CLOUDFLARE_RECONCILIATION_REQUIRED'
    )
    expect(await runtime.start(request)).toEqual(handle)
    await expect(runtime.reconcile(handle)).rejects.toThrow('CLOUDFLARE_RECONCILIATION_UNAVAILABLE')
    expect(journal.get(request.attemptId).state).toBe('reconciliation_required')
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})
test('iterator rechecks current authority after suspension and aborts', async () => {
  const f = fixture()
  try {
    const runtime = adapter(f.host),
      handle = await runtime.start(request)
    await f.host.wake(request.attemptId)
    const iterator = runtime.progress(handle)[Symbol.asyncIterator]()
    expect((await iterator.next()).value.sequence).toBe(1)
    f.revoke()
    await expect(iterator.next()).rejects.toThrow('REVOKED')
    const controller = new AbortController()
    controller.abort()
    expect(await events(runtime, handle, { signal: controller.signal })).toEqual([])
  } finally {
    f.db.close()
  }
})
test('required capability and unsupported operations fail before admission', async () => {
  const f = fixture()
  try {
    const runtime = adapter(f.host),
      requirements = [{ capability: 'execution.scope.workspace.v1', necessity: 'required' }]
    const inspection = await runtime.inspect(requirements)
    expect(inspection.capabilities).toEqual([])
    expect(inspection.capabilityEvaluation.eligible).toBe(false)
    await expect(
      runtime.start({
        ...request,
        executionPlan: { ...request.executionPlan, runtimeRequirements: requirements },
      })
    ).rejects.toThrow()
    expect(f.db.query('SELECT * FROM cp_pi_tasks').all()).toEqual([])
    for (const call of [
      () => runtime.submitInput({}, {}),
      () => runtime.submitApproval({}, {}),
      () => runtime.session({ operation: 'list' }),
      () => runtime.cleanup({}),
    ]) {
      try {
        await call()
        throw new Error('unexpected success')
      } catch (error) {
        expect(error.classification).toBe('unsupported')
        expect(error.retryable).toBe(false)
      }
    }
  } finally {
    f.db.close()
  }
})
test('actual additive migration retains historical JSON without invented handles/timing', async () => {
  const f = fixture()
  try {
    await f.host.accept(request, 42)
    const before = f.db.query('SELECT body FROM cp_pi_tasks').get().body
    f.db.exec(
      'ALTER TABLE cp_pi_tasks DROP COLUMN accepted_at; ALTER TABLE cp_pi_tasks DROP COLUMN handle_id; ALTER TABLE cp_pi_events DROP COLUMN occurred_at'
    )
    const journal = new CloudflareOwnerJournal(f.storage, pins),
      runtime = adapter(new CloudflarePiHost(journal, pins, f.authority, f.openEngine))
    await expect(runtime.start(request)).rejects.toThrow('CLOUDFLARE_HISTORICAL_HANDLE_UNAVAILABLE')
    expect(f.db.query('SELECT body FROM cp_pi_tasks').get().body).toBe(before)
    expect(journal.get(request.attemptId).acceptedAt).toBeUndefined()
    expect(() => journal.timedEvents(request.attemptId)).toThrow(
      'CLOUDFLARE_HISTORICAL_TIMING_UNAVAILABLE'
    )
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})

test('cancel replay retains exact request and emits one event; changed retry conflicts', async () => {
  const f = fixture()
  try {
    const runtime = adapter(f.host),
      handle = await runtime.start(request),
      cancel = { idempotencyKey: 'cancel', requestedAt: handle.startedAt }
    expect((await runtime.cancel(handle, cancel)).state).toBe('cancelled')
    expect((await runtime.cancel(handle, cancel)).state).toBe('cancelled')
    await expect(
      runtime.cancel(handle, { ...cancel, requestedAt: new Date(200).toISOString() })
    ).rejects.toThrow('CLOUDFLARE_CANCEL_REPLAY_CONFLICT')
    expect((await events(runtime, handle)).map((e) => e.data.state)).toEqual([
      'starting',
      'cancelled',
    ])
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})

test('caller mutation during awaited handle guard cannot redirect cancel or reconcile', async () => {
  for (const operation of ['cancel', 'reconcile']) {
    const f = fixture()
    try {
      const runtime = adapter(f.host),
        handle = await runtime.start(request)
      const secondId = 'att_00000000000000000000000002'
      f.authority.readAccepted = async (incoming) => ({ ...task, request: incoming })
      const second = {
        ...request,
        attemptId: secondId,
        idempotencyKey: 'second',
        attemptBudget: {
          ...request.attemptBudget,
          attemptId: secondId,
          reservationKey: `runtime-attempt:${secondId}`,
        },
      }
      await runtime.start(second)
      const mutable = structuredClone(handle),
        calls = []
      const port = {
        accept: (input) => f.host.accept(input, 100),
        read: async (id) => {
          const record = await f.host.read(id)
          mutable.attemptId = 'att_00000000000000000000000002'
          return record
        },
        timedEvents: (id, cursor) => f.host.timedEvents(id, cursor),
        cancel: async (id, input) => {
          calls.push(id)
          return f.host.cancel(id, input)
        },
        reconcile: async (id) => {
          calls.push(id)
          return f.host.reconcile(id)
        },
      }
      const guarded = new CloudflarePiRuntimeAdapter(port, () => 100)
      if (operation === 'cancel')
        await guarded.cancel(mutable, { idempotencyKey: 'cancel', requestedAt: handle.startedAt })
      else await guarded.reconcile(mutable)
      expect(calls).toEqual([request.attemptId])
      expect(f.journal.get(secondId).state).toBe('accepted')
      expect(f.counts().opens).toBe(0)
    } finally {
      f.db.close()
    }
  }
})

test('progress retains supplied tuple and cursor when caller mutates them during a guard', async () => {
  const f = fixture()
  try {
    const original = await adapter(f.host).start(request)
    await f.host.wake(request.attemptId)
    const mutable = { ...original },
      options = { afterSequence: 1 },
      queries = []
    const runtime = new CloudflarePiRuntimeAdapter(
      {
        accept: (input) => f.host.accept(input, 100),
        read: async (id) => {
          const record = await f.host.read(id)
          mutable.attemptId = 'att_00000000000000000000000002'
          mutable.handleId = 'forged'
          options.afterSequence = 999
          return record
        },
        timedEvents: async (id, cursor) => {
          queries.push([id, cursor])
          return f.host.timedEvents(id, cursor)
        },
        cancel: (id) => f.host.cancel(id),
        reconcile: (id) => f.host.reconcile(id),
      },
      () => 100
    )
    const retained = await events(runtime, mutable, options)
    expect(queries).toEqual([[request.attemptId, 1]])
    expect(retained.map((event) => event.sequence)).toEqual([2, 3])
    expect(retained.every((event) => event.handleId === original.handleId)).toBe(true)
  } finally {
    f.db.close()
  }
})
