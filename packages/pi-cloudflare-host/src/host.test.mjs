import { expect, test } from 'bun:test'
import { CloudflareOwnerJournal } from './owner.ts'
import { CloudflarePiHost } from './host.ts'
import { fixture, pins, request, task, result } from './test-fixtures.mjs'

test('current canonical admission denies before journal/alarm/engine effects', async () => {
  const f = fixture()
  try {
    f.revoke()
    await expect(f.host.accept(request, 42)).rejects.toThrow('REVOKED')
    expect(f.db.query('SELECT * FROM cp_pi_tasks').all()).toEqual([])
    expect(f.counts()).toEqual({ opens: 0, sends: 0, closes: 0 })
  } finally {
    f.db.close()
  }
})

test('concurrent duplicate admission and wake retain one outcome and one physical fixture send', async () => {
  const f = fixture()
  try {
    await Promise.all([f.host.accept(request, 42), f.host.accept(request, 42)])
    await Promise.all([f.host.wake(request.attemptId), f.host.wake(request.attemptId)])
    expect((await f.host.read(request.attemptId)).result).toEqual(result)
    expect(f.counts()).toEqual({ opens: 1, sends: 1, closes: 1 })
    const reopened = new CloudflarePiHost(
      new CloudflareOwnerJournal(f.storage, pins),
      pins,
      f.authority,
      f.openEngine
    )
    expect((await reopened.wake(request.attemptId)).result).toEqual(result)
    expect(f.counts().sends).toBe(1)
  } finally {
    f.db.close()
  }
})

test('revocation after acceptance blocks wake and reads without engine creation', async () => {
  const f = fixture()
  try {
    await f.host.accept(request, 42)
    f.revoke()
    await expect(f.host.wake(request.attemptId)).rejects.toThrow('REVOKED')
    await expect(f.host.read(request.attemptId)).rejects.toThrow('REVOKED')
    expect(f.counts().opens).toBe(0)
    expect(f.journal.get(request.attemptId).state).toBe('accepted')
  } finally {
    f.db.close()
  }
})

test('missing budget, transport actor substitution and changed canonical plan fail closed', async () => {
  for (const change of [
    (accepted) => ({ ...accepted, canonicalActorPrincipalId: 'transport-service' }),
    (accepted) => ({ ...accepted, request: { ...accepted.request, attemptBudget: undefined } }),
    (accepted) => ({ ...accepted, request: { ...accepted.request, idempotencyKey: 'changed' } }),
  ]) {
    const f = fixture()
    try {
      f.authority.readAccepted = async () => change(structuredClone(task))
      await expect(f.host.accept(request, 42)).rejects.toThrow()
      expect(f.db.query('SELECT * FROM cp_pi_tasks').all()).toEqual([])
      expect(f.counts().opens).toBe(0)
    } finally {
      f.db.close()
    }
  }
})

test('eviction fences an old async invocation and does not replay an ambiguous send', async () => {
  const f = fixture()
  let resume
  const paused = new Promise((resolve) => {
    resume = resolve
  })
  try {
    f.setRun(async (accepted, beforeEffect) => {
      await paused
      await beforeEffect()
      return result
    })
    await f.host.accept(request, 42)
    const running = f.host.wake(request.attemptId)
    // Wait only for our fixture engine entry; this is not a workerd eviction test.
    while (f.counts().opens === 0) await Promise.resolve()
    const next = new CloudflarePiHost(
      new CloudflareOwnerJournal(f.storage, pins),
      pins,
      f.authority,
      f.openEngine
    )
    resume()
    await expect(running).rejects.toThrow('CLOUDFLARE_OWNER_STALE')
    expect((await next.wake(request.attemptId)).state).toBe('reconciliation_required')
    expect(f.counts().sends).toBe(0)
  } finally {
    f.db.close()
  }
})

test('cancel fences the next physical effect and preserves unresolved cancellation on wake', async () => {
  const f = fixture()
  let resume
  const paused = new Promise((resolve) => {
    resume = resolve
  })
  try {
    f.setRun(async (accepted, beforeEffect) => {
      await paused
      await beforeEffect()
      return result
    })
    await f.host.accept(request, 42)
    const running = f.host.wake(request.attemptId)
    while (f.counts().opens === 0) await Promise.resolve()
    await f.host.cancel(request.attemptId)
    resume()
    await expect(running).rejects.toThrow('CLOUDFLARE_EFFECT_STATE_DENIED')
    expect((await f.host.wake(request.attemptId)).state).toBe('cancelling')
    expect(f.counts().sends).toBe(0)
  } finally {
    f.db.close()
  }
})

test('host and journal cannot disagree about conversation/Agent binding', () => {
  const f = fixture()
  try {
    expect(
      () =>
        new CloudflarePiHost(
          f.journal,
          { ...pins, conversationId: 'another-conversation' },
          f.authority,
          f.openEngine
        )
    ).toThrow('CLOUDFLARE_OWNER_PIN_CONFLICT')
  } finally {
    f.db.close()
  }
})

test('late result after a physical send and cancellation retains usage without claiming settlement', async () => {
  const f = fixture()
  let resume
  const paused = new Promise((resolve) => {
    resume = resolve
  })
  let sent = false
  try {
    f.setRun(async (accepted, beforeEffect) => {
      await beforeEffect()
      sent = true
      await paused
      return result
    })
    await f.host.accept(request, 42)
    const running = f.host.wake(request.attemptId)
    while (!sent) await Promise.resolve()
    expect((await f.host.cancel(request.attemptId)).state).toBe('cancelling')
    resume()
    expect((await running).state).toBe('cancelling')
    const retained = await f.host.read(request.attemptId)
    expect(retained.observedResult).toEqual(result)
    expect(retained.result).toBeUndefined()
    const reopened = new CloudflarePiHost(
      new CloudflareOwnerJournal(f.storage, pins),
      pins,
      f.authority,
      f.openEngine
    )
    expect((await reopened.wake(request.attemptId)).observedResult).toEqual(result)
  } finally {
    f.db.close()
  }
})

test('unknown plan version denies before task persistence or engine creation', async () => {
  const f = fixture()
  try {
    const future = { ...request, executionPlan: { ...request.executionPlan, schemaVersion: 99 } }
    f.authority.readAccepted = async () => ({ ...task, request: future })
    await expect(f.host.accept(future, 42)).rejects.toThrow(
      'CLOUDFLARE_CANONICAL_ADMISSION_MISMATCH'
    )
    expect(f.db.query('SELECT * FROM cp_pi_tasks').all()).toEqual([])
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})

test('one harness owner runs at a time for concurrent attempts in the same context', async () => {
  const f = fixture()
  try {
    f.authority.readAccepted = async (incoming) => ({ ...task, request: incoming })
    const second = {
      ...request,
      attemptId: 'att_00000000000000000000000002',
      idempotencyKey: 'start-two',
      attemptBudget: {
        ...request.attemptBudget,
        attemptId: 'att_00000000000000000000000002',
        reservationKey: 'runtime-attempt:att_00000000000000000000000002',
      },
    }
    await f.host.accept(request, 42)
    await f.host.accept(second, 42)
    let active = 0,
      peak = 0
    f.setRun(async (accepted, beforeEffect) => {
      await beforeEffect()
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      return result
    })
    await Promise.all([f.host.wake(request.attemptId), f.host.wake(second.attemptId)])
    expect(peak).toBe(1)
    expect(f.counts().opens).toBe(2)
  } finally {
    f.db.close()
  }
})
