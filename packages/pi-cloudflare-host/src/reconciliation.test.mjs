import { expect, test } from 'bun:test'
import { CloudflareOwnerJournal } from './owner.ts'
import { CloudflarePiHost } from './host.ts'
import { fixture, pins, request, task, result } from './test-fixtures.mjs'

async function interrupted(f, reader) {
  await f.host.accept(request, 42)
  f.journal.transition(request.attemptId, 'accepted', 'running')
  const journal = new CloudflareOwnerJournal(f.storage, pins)
  const host = new CloudflarePiHost(journal, pins, f.authority, f.openEngine, reader)
  return { journal, host }
}
function receipt(epoch, extra = {}) {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      receiptRef: 'ledger:settled-one',
      task,
      owner: pins,
      recoveryEpoch: epoch,
      disposition: 'completed',
      result,
      ...extra,
    })
  )
}

test('absent or pending trusted settlement keeps ambiguity and never opens the engine', async () => {
  const f = fixture()
  try {
    const { host } = await interrupted(f)
    await expect(host.reconcile(request.attemptId)).rejects.toThrow(
      'CLOUDFLARE_RECONCILIATION_UNAVAILABLE'
    )
    const pending = new CloudflarePiHost(
      new CloudflareOwnerJournal(f.storage, pins),
      pins,
      f.authority,
      f.openEngine,
      { readSettlement: async () => undefined }
    )
    expect((await pending.reconcile(request.attemptId)).state).toBe('reconciliation_required')
    expect((await pending.wake(request.attemptId)).state).toBe('reconciliation_required')
    expect(f.counts().opens).toBe(0)
    expect(f.db.query('SELECT * FROM cp_pi_settlements').all()).toEqual([])
  } finally {
    f.db.close()
  }
})

test('trusted exact settlement commits once, preserves replay/events and survives a new owner', async () => {
  const f = fixture()
  try {
    const { journal, host } = await interrupted(f, {
      readSettlement: async (_task, _owner, epoch) => receipt(epoch),
    })
    const before = journal.events(request.attemptId).at(-1).sequence
    const [first, replay] = await Promise.all([
      host.reconcile(request.attemptId),
      host.reconcile(request.attemptId),
    ])
    expect(first).toEqual(replay)
    expect(first.state).toBe('completed')
    expect(first.result).toEqual(result)
    expect(journal.events(request.attemptId, before).map((e) => e.state)).toEqual(['completed'])
    expect(f.db.query('SELECT * FROM cp_pi_settlements').all()).toHaveLength(1)
    const next = new CloudflarePiHost(
      new CloudflareOwnerJournal(f.storage, pins),
      pins,
      f.authority,
      f.openEngine
    )
    expect((await next.reconcile(request.attemptId)).settlement).toEqual(first.settlement)
    expect((await next.accept(request, 43)).result).toEqual(result)
    expect((await next.wake(request.attemptId)).result).toEqual(result)
    f.revoke()
    await expect(next.reconcile(request.attemptId)).rejects.toThrow('REVOKED')
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})

test('changed task, actor, scope, budget, binding, epoch, version and extra truthy authority fail closed', async () => {
  for (const change of [
    (r) => ({ ...r, schemaVersion: 2 }),
    (r) => ({ ...r, recoveryEpoch: r.recoveryEpoch - 1 }),
    (r) => ({
      ...r,
      task: { ...task, canonicalActorPrincipalId: 'user:00000000-0000-0000-0000-000000000002' },
    }),
    (r) => ({
      ...r,
      task: {
        ...task,
        request: {
          ...request,
          executionPlan: { ...request.executionPlan, contentDigest: `sha256:${'b'.repeat(64)}` },
        },
      },
    }),
    (r) => ({
      ...r,
      task: {
        ...task,
        request: { ...request, attemptBudget: { ...request.attemptBudget, maximumTokens: 99 } },
      },
    }),
    (r) => ({ ...r, owner: { ...pins, workspaceId: 'wrong-workspace' } }),
    (r) => ({ ...r, owner: { ...pins, conversationId: 'wrong-conversation' } }),
    (r) => ({ ...r, receiptRef: '' }),
    (r) => ({ ...r, authorized: true }),
    (r) => ({ ...r, disposition: 'retry' }),
    (r) => ({
      ...r,
      result: { ...result, usage: { inputTokens: -1, outputTokens: 0, durationMs: 0 } },
    }),
  ]) {
    const f = fixture()
    try {
      const { host, journal } = await interrupted(f, {
        readSettlement: async (_t, _o, epoch) => change(receipt(epoch)),
      })
      await expect(host.reconcile(request.attemptId)).rejects.toThrow()
      expect(journal.get(request.attemptId).state).toBe('reconciliation_required')
      expect(journal.events(request.attemptId)).toHaveLength(3)
      expect(f.db.query('SELECT * FROM cp_pi_settlements').all()).toEqual([])
      expect(f.counts().opens).toBe(0)
    } finally {
      f.db.close()
    }
  }
})

test('revocation or owner replacement during ledger await fences settlement', async () => {
  for (const replaceOwner of [false, true]) {
    const f = fixture()
    try {
      const { host } = await interrupted(f, {
        readSettlement: async (_t, _o, epoch) => {
          if (replaceOwner) {
            const replacement = new CloudflareOwnerJournal(f.storage, pins)
            expect(replacement.epoch).toBeGreaterThan(epoch)
          } else f.revoke()
          return receipt(epoch)
        },
      })
      await expect(host.reconcile(request.attemptId)).rejects.toThrow(
        replaceOwner ? 'CLOUDFLARE_OWNER_STALE' : 'REVOKED'
      )
      expect(f.db.query('SELECT * FROM cp_pi_settlements').all()).toEqual([])
      expect(f.counts().opens).toBe(0)
    } finally {
      f.db.close()
    }
  }
})

test('cancellation settlement retains exact observed usage, rejecting erasure and fabricated completion', async () => {
  const f = fixture()
  try {
    await f.host.accept(request, 42)
    f.journal.transition(request.attemptId, 'accepted', 'running')
    f.journal.observeResult(request.attemptId, result)
    f.journal.transition(request.attemptId, 'running', 'cancelling')
    const journal = new CloudflareOwnerJournal(f.storage, pins)
    let settlement = receipt(journal.epoch, {
      disposition: 'cancelled',
      result: undefined,
      terminalUsage: { inputTokens: 0, outputTokens: 0, durationMs: 0 },
    })
    const host = new CloudflarePiHost(journal, pins, f.authority, f.openEngine, {
      readSettlement: async () => settlement,
    })
    await expect(host.reconcile(request.attemptId)).rejects.toThrow(
      'CLOUDFLARE_SETTLEMENT_USAGE_CONFLICT'
    )
    settlement = receipt(journal.epoch, {
      disposition: 'cancelled',
      result: undefined,
      terminalUsage: result.usage,
    })
    const settled = await host.reconcile(request.attemptId)
    expect(settled.state).toBe('cancelled')
    expect(settled.result).toBeUndefined()
    expect(settled.observedResult).toEqual(result)
    expect(settled.settlement.terminalUsage).toEqual(result.usage)
    expect((await host.wake(request.attemptId)).state).toBe('cancelled')
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})

test('conflicting receipt replay and receipt reuse roll back outcome and event atomically', async () => {
  const f = fixture()
  try {
    const { journal, host } = await interrupted(f, {
      readSettlement: async (_t, _o, epoch) => receipt(epoch),
    })
    await host.reconcile(request.attemptId)
    expect(() =>
      journal.settle(
        request.attemptId,
        receipt(journal.epoch, { result: { ...result, output: 'changed' } })
      )
    ).toThrow('CLOUDFLARE_SETTLEMENT_REPLAY_CONFLICT')
    const second = {
      ...task,
      request: {
        ...request,
        attemptId: 'att_00000000000000000000000002',
        idempotencyKey: 'second',
      },
    }
    journal.admit(second, 43)
    journal.transition(second.request.attemptId, 'accepted', 'running')
    journal.transition(second.request.attemptId, 'running', 'reconciliation_required')
    expect(() =>
      journal.settle(second.request.attemptId, receipt(journal.epoch, { task: second }))
    ).toThrow()
    expect(journal.get(second.request.attemptId).state).toBe('reconciliation_required')
    expect(journal.events(second.request.attemptId)).toHaveLength(3)
    expect(f.db.query('SELECT * FROM cp_pi_settlements').all()).toHaveLength(1)
  } finally {
    f.db.close()
  }
})

test('an authorized attempt cannot settle a revoked sibling through a misrouted exact receipt', async () => {
  const f = fixture()
  try {
    const { journal } = await interrupted(f)
    const siblingRequest = {
      ...request,
      attemptId: 'att_00000000000000000000000002',
      idempotencyKey: 'sibling-start',
      attemptBudget: {
        ...request.attemptBudget,
        attemptId: 'att_00000000000000000000000002',
        reservationKey: 'runtime-attempt:att_00000000000000000000000002',
      },
    }
    const sibling = {
      ...task,
      canonicalActorPrincipalId: 'user:00000000-0000-0000-0000-000000000002',
      request: siblingRequest,
    }
    journal.admit(sibling, 43)
    journal.transition(siblingRequest.attemptId, 'accepted', 'running')
    journal.transition(siblingRequest.attemptId, 'running', 'reconciliation_required')
    const before = f.db.query('SELECT * FROM cp_pi_tasks ORDER BY attempt_id').all()
    const beforeEvents = f.db.query('SELECT * FROM cp_pi_events ORDER BY sequence').all()
    const checked = []
    const currentAuthority = f.authority.assertCurrent
    f.authority.assertCurrent = async (accepted, owner, boundary) => {
      checked.push(accepted.request.attemptId)
      if (accepted.request.attemptId === siblingRequest.attemptId)
        throw new Error('SIBLING_REVOKED')
      await currentAuthority(accepted, owner, boundary)
    }
    const host = new CloudflarePiHost(journal, pins, f.authority, f.openEngine, {
      readSettlement: async () => receipt(journal.epoch, { task: sibling }),
    })
    await expect(host.reconcile(request.attemptId)).rejects.toThrow(
      'CLOUDFLARE_SETTLEMENT_IDENTITY_DENIED'
    )
    expect(checked.every((attemptId) => attemptId === request.attemptId)).toBe(true)
    expect(f.db.query('SELECT * FROM cp_pi_tasks ORDER BY attempt_id').all()).toEqual(before)
    expect(f.db.query('SELECT * FROM cp_pi_events ORDER BY sequence').all()).toEqual(beforeEvents)
    expect(f.db.query('SELECT * FROM cp_pi_settlements').all()).toEqual([])
    expect(f.counts().opens).toBe(0)
  } finally {
    f.db.close()
  }
})
