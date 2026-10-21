import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJsonStringify } from '@control-plane/contracts'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { reconcilePiCancellationHistory } from './cancellation-history.ts'
import { SqliteDurableJournal } from './journal.ts'
import {
  createMemoryCommittedCancellationAuthority,
  createSqliteCommittedCancellationAuthority,
} from './cancellation-authority.test-fixture.mjs'
import { fixture } from './adapter.fixture.mjs'

const at = '2026-10-08T00:00:00.000Z'
const deadlineAt = '2027-01-01T00:00:00.000Z'

function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')}`
}

async function prepareCase(directory) {
  const authority = createSqliteCommittedCancellationAuthority(
    join(directory, 'cancellation-owner.sqlite'),
    { now: () => at }
  )
  let aborts = 0
  let runs = 0
  const setup = fixture(directory, {
    now: () => at,
  })
  const engineFactory = setup.options.engineFactory
  setup.options.engineFactory = async (...args) => {
    const engine = await engineFactory(...args)
    return {
      ...engine,
      run: async (...runArgs) => {
        runs += 1
        return engine.run(...runArgs)
      },
      cancel: async (...cancelArgs) => {
        aborts += 1
        return engine.cancel(...cancelArgs)
      },
    }
  }
  const adapter = new PiDurableRuntimeAdapter(setup.options)
  const handle = await adapter.start(setup.request)
  await adapter.drain()
  const completed = adapter.journal.get(handle.handleId)
  const stored = completed.admission
  const admissionDigest = digest(stored)
  adapter.journal.update(handle.handleId, completed.epoch, {
    state: 'running',
    detail: {
      ...completed.detail,
      result: undefined,
      error: undefined,
      engineRunStarted: true,
      activeInference: undefined,
      inferencePending: true,
    },
  })
  authority.register({
    handleId: handle.handleId,
    executionId: setup.request.executionId,
    attemptId: setup.request.attemptId,
    workspaceId: setup.request.attemptBudget.workspaceId,
    admissionDigest,
    productRevision: stored.admission.authority.revision,
    expiresAt: stored.admission.authority.expiresAt,
    deadlineAt,
  })
  return {
    adapter,
    authority,
    handle,
    request: { idempotencyKey: 'cancel:committed', requestedAt: at },
    completedResult: completed.detail.result,
    aborts: () => aborts,
    runs: () => runs,
    setup,
  }
}

async function withCase(run) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-committed-cancel-'))
  let context
  try {
    context = await prepareCase(directory)
    await run({ ...context, directory })
  } finally {
    await context?.adapter.close()
    context?.authority.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

function proposal(context, patch = {}) {
  const row = context.adapter.journal.get(context.handle.handleId)
  const turnKey = row.detail.turn?.requestId ?? `pi-turn:${row.attemptId}:initial`
  return {
    handleId: row.handleId,
    executionId: context.setup.request.executionId,
    attemptId: row.attemptId,
    workspaceId: context.setup.request.attemptBudget.workspaceId,
    idempotencyKey: context.request.idempotencyKey,
    requestedAt: at,
    requestDigest: digest(context.request),
    admissionDigest: digest(row.admission),
    targetKind: 'untracked_generation',
    turnKey,
    generation: null,
    ...patch,
  }
}
function generation(context, id = 'G1') {
  const target = proposal(context)
  return {
    schemaVersion: 'pi-inference-generation/v1',
    attemptId: target.attemptId,
    turnKey: target.turnKey,
    inferenceId: id,
    inferenceKey: `${target.turnKey}:${id}`,
  }
}
function patchRow(context, detail, state) {
  const row = context.adapter.journal.get(context.handle.handleId)
  return context.adapter.journal.update(context.handle.handleId, row.epoch, {
    ...(state ? { state } : {}),
    detail: { ...row.detail, ...detail },
  })
}
function history(context, intent) {
  return reconcilePiCancellationHistory(context.adapter.journal, intent, at)
}
function unchangedExceptHistory(before, after) {
  const { cancellationResolutions: _before, ...bd } = before.detail
  const { cancellationResolutions: _after, ...ad } = after.detail
  expect({ ...after, detail: ad }).toEqual({ ...before, detail: bd })
}

// Replacements for old #1048 committed-grant assertions. The SQLite owner below models
// request retention only; it is disconnected from ordinary cancellation and native effects.
test('retention replays immutable old keys, conflicts on digest drift and keeps new keys distinct', async () => {
  await withCase(async (c) => {
    const store = createMemoryCommittedCancellationAuthority({ now: () => at })
    const first = await store.commit(proposal(c))
    expect(await store.commit(proposal(c))).toEqual(first)
    await expect(
      store.commit({ ...proposal(c), requestDigest: `sha256:${'f'.repeat(64)}` })
    ).rejects.toThrow('CONFLICT')
    const request = { ...c.request, idempotencyKey: 'G2' }
    const next = await store.commit(proposal(c, { ...request, requestDigest: digest(request) }))
    expect(next.intentId).not.toBe(first.intentId)
    await store.acknowledge(first.intentId)
    expect(await store.pending()).toEqual([next])
    expect(c.aborts()).toBe(0)
  })
})
for (const reason of [
  'revoked actor',
  'expired authority',
  'stale execution version',
  'stale attempt version',
  'deadline changed',
]) {
  test(`${reason} denies ordinary and fenced retry with zero journal or abort effect`, async () => {
    await withCase(async (c) => {
      const before = c.adapter.journal.get(c.handle.handleId)
      if (reason === 'revoked actor')
        c.authority.updateProductFence(c.handle.handleId, { revision: 2, active: false })
      if (reason === 'expired authority')
        c.authority.updateProductFence(c.handle.handleId, { revision: 1, expiresAt: at })
      if (reason === 'stale execution version')
        c.authority.updateControlPlane(c.handle.handleId, { executionVersion: 2 })
      if (reason === 'stale attempt version')
        c.authority.updateControlPlane(c.handle.handleId, { attemptVersion: 2 })
      if (reason === 'deadline changed')
        c.authority.updateControlPlane(c.handle.handleId, { deadlineAt: at })
      // Actual SQLite retention admission rejects each changed binding. It is not a production
      // cross-store authorization proof; ordinary cancellation separately honors its current port.
      await expect(c.authority.commit(proposal(c))).rejects.toThrow('PI_LEAD_AUTHORITY_CONFLICT')
      c.setup.options.assertAuthority = async () => {
        throw new Error(reason)
      }
      await expect(c.adapter.cancel(c.handle, c.request)).rejects.toThrow()
      await expect(
        c.adapter.cancelFenced(c.handle, c.request, async () => {
          throw new Error(reason)
        })
      ).rejects.toThrow(reason)
      expect(c.adapter.journal.get(c.handle.handleId)).toEqual(before)
      expect(c.aborts()).toBe(0)
      expect(await c.authority.pending()).toEqual([])
    })
  })
}
test('revocation while the fenced authority read is pending causes zero effect', async () => {
  await withCase(async (c) => {
    let enter, release
    const entered = new Promise((r) => {
      enter = r
    })
    const gate = new Promise((r) => {
      release = r
    })
    let revoked = false
    const before = c.adapter.journal.get(c.handle.handleId)
    const cancel = c.adapter.cancelFenced(c.handle, c.request, async () => {
      enter()
      await gate
      if (revoked) throw new Error('revoked while pending')
    })
    await entered
    revoked = true
    release()
    await expect(cancel).rejects.toThrow('revoked while pending')
    expect(c.adapter.journal.get(c.handle.handleId)).toEqual(before)
    expect(c.aborts()).toBe(0)
  })
})
test('retained same key after revocation remains evidence and cannot bypass current ordinary or fenced authorization', async () => {
  await withCase(async (c) => {
    const intent = await c.authority.commit(proposal(c))
    c.authority.updateProductFence(c.handle.handleId, { revision: 2, active: false })
    expect(await c.authority.commit(proposal(c))).toEqual(intent)
    c.setup.options.assertAuthority = async () => {
      throw new Error('revoked')
    }
    const before = c.adapter.journal.get(c.handle.handleId)
    await expect(c.adapter.cancel(c.handle, c.request)).rejects.toThrow()
    await expect(
      c.adapter.cancelFenced(c.handle, c.request, async () => {
        throw new Error('revoked')
      })
    ).rejects.toThrow('revoked')
    expect(history(c, intent)).toBe('unresolved')
    expect(c.adapter.journal.get(c.handle.handleId)).toEqual(before)
    expect(c.aborts()).toBe(0)
    expect(await c.authority.pending()).toEqual([intent])
  })
})
test('lost retention response survives reopen without automatic cancellation or inference resend', async () => {
  await withCase(async (c) => {
    const p = proposal(c)
    c.authority.loseNextCommitResponse()
    await expect(c.authority.commit(p)).rejects.toThrow('OUTCOME_UNKNOWN')
    const intent = c.authority.intentForKey(c.handle.handleId, p.idempotencyKey)
    const before = c.adapter.journal.get(c.handle.handleId)
    await c.adapter.close()
    c.adapter = new PiDurableRuntimeAdapter(c.setup.options)
    try {
      expect(await c.authority.commit(p)).toEqual(intent)
      expect(history(c, intent)).toBe('unresolved')
      expect(c.adapter.journal.get(c.handle.handleId)).toEqual(before)
      expect(c.aborts()).toBe(0)
      expect(c.runs()).toBe(1)
      expect(await c.authority.pending()).toEqual([intent])
    } finally {
      await c.adapter.close()
    }
  })
})
test('ACK failure and repeated bookkeeping never repeat an abort or claim a current target succeeded', async () => {
  await withCase(async (c) => {
    const intent = await c.authority.commit(proposal(c))
    c.authority.failNextAcknowledge()
    await expect(c.authority.acknowledge(intent.intentId)).rejects.toThrow()
    const before = c.adapter.journal.get(c.handle.handleId)
    expect(history(c, intent)).toBe('unresolved')
    expect(history(c, intent)).toBe('unresolved')
    expect(c.adapter.journal.get(c.handle.handleId)).toEqual(before)
    expect(c.aborts()).toBe(0)
    expect(c.runs()).toBe(1)
    expect(await c.authority.pending()).toEqual([intent])
  })
})
for (const kind of ['active_generation', 'no_active_generation', 'untracked_generation']) {
  test(`old ${kind} target cannot adopt a newer turn or generation and history survives replay`, async () => {
    await withCase(async (c) => {
      const g1 = generation(c),
        g2 = generation(c, 'G2')
      const intent = await c.authority.commit(
        proposal(c, { targetKind: kind, generation: kind === 'active_generation' ? g1 : null })
      )
      const currentIntent = { marker: 'G2 cancellation is not replaced' }
      patchRow(c, {
        activeInference: g2,
        cancellationIntent: currentIntent,
        inferencePending: true,
      })
      const before = c.adapter.journal.get(c.handle.handleId)
      expect(history(c, intent)).toBe('superseded')
      const first = c.adapter.journal.get(c.handle.handleId)
      unchangedExceptHistory(before, first)
      const retained = first.detail.cancellationResolutions[`cancel:${intent.idempotencyKey}`]
      expect(retained.generation).toEqual(intent.generation)
      expect(retained.observedGeneration).toEqual(g2)
      expect(history(c, intent)).toBe('superseded')
      expect(c.adapter.journal.get(c.handle.handleId)).toEqual(first)
      expect(c.aborts()).toBe(0)
      expect(await c.authority.pending()).toEqual([intent])
    })
  })
}
for (const mutation of ['attempt', 'turn', 'handle', 'digest', 'generation']) {
  test(`corrupt retained ${mutation} is rejected without journal mutation`, async () => {
    await withCase(async (c) => {
      const g1 = generation(c)
      const intent = await c.authority.commit(
        proposal(c, { targetKind: 'active_generation', generation: g1 })
      )
      const corrupt = structuredClone(intent)
      if (mutation === 'attempt') corrupt.attemptId = 'att_01JABCDEF0123456789ABCDEFH'
      if (mutation === 'turn') corrupt.generation.turnKey = 'corrupt'
      if (mutation === 'handle') corrupt.handleId = 'missing-handle'
      if (mutation === 'digest') corrupt.requestDigest = `sha256:${'f'.repeat(64)}`
      if (mutation === 'generation') corrupt.generation.inferenceKey = 'wrong-key'
      const before = c.adapter.journal.get(c.handle.handleId)
      expect(() => history(c, corrupt)).toThrow()
      expect(c.adapter.journal.get(c.handle.handleId)).toEqual(before)
      expect(c.aborts()).toBe(0)
    })
  })
}
for (const terminal of [false, true]) {
  test(`same-epoch concurrent G2 ${terminal ? 'completion' : 'metadata'} is preserved by transactional historical classification`, async () => {
    await withCase(async (c) => {
      const g1 = generation(c),
        g2 = generation(c, 'G2')
      const intent = await c.authority.commit(
        proposal(c, { targetKind: 'active_generation', generation: g1 })
      )
      patchRow(c, { activeInference: g1 })
      const other = new SqliteDurableJournal(join(c.directory, 'authority.sqlite'))
      const transition = c.adapter.journal.transitionCurrent.bind(c.adapter.journal)
      let interleaved
      c.adapter.journal.transitionCurrent = (...args) => {
        other.updateCurrentMetadata(c.handle.handleId, () => ({
          value: undefined,
          detail: {
            activeInference: g2,
            cancellationIntent: { marker: 'G2' },
            g2OwnerMarker: 'live-G2',
            ...(terminal
              ? { result: c.completedResult, terminalUsage: { marker: 'settled-G2' } }
              : {}),
          },
        }))
        if (terminal) {
          const row = other.get(c.handle.handleId)
          other.update(c.handle.handleId, row.epoch, { state: 'completed' })
        }
        interleaved = other.get(c.handle.handleId)
        return transition(...args)
      }
      try {
        expect(history(c, intent)).toBe('superseded')
        unchangedExceptHistory(interleaved, c.adapter.journal.get(c.handle.handleId))
        expect(c.aborts()).toBe(0)
      } finally {
        other.close()
      }
    })
  })
}
test('history resolution persists through reopen and ACK failure without replacing G2 or aborting', async () => {
  await withCase(async (c) => {
    const intent = await c.authority.commit(proposal(c))
    patchRow(c, {
      turn: { requestId: 'later-turn' },
      activeInference: undefined,
      cancellationIntent: { marker: 'G2' },
    })
    expect(history(c, intent)).toBe('superseded')
    c.authority.failNextAcknowledge()
    await expect(c.authority.acknowledge(intent.intentId)).rejects.toThrow()
    const before = c.adapter.journal.get(c.handle.handleId)
    const second = new SqliteDurableJournal(join(c.directory, 'authority.sqlite'))
    try {
      expect(reconcilePiCancellationHistory(second, intent, at)).toBe('superseded')
      expect(second.get(c.handle.handleId)).toEqual(before)
      await c.authority.acknowledge(intent.intentId)
      await c.authority.acknowledge(intent.intentId)
      expect(await c.authority.pending()).toEqual([])
      expect(c.aborts()).toBe(0)
    } finally {
      second.close()
    }
  })
})
test('corrupt history cannot overwrite an immutable saved resolution or block a distinct valid request', async () => {
  await withCase(async (c) => {
    const intent = await c.authority.commit(proposal(c))
    patchRow(c, { turn: { requestId: 'later-turn' } })
    expect(history(c, intent)).toBe('superseded')
    const before = c.adapter.journal.get(c.handle.handleId)
    expect(() =>
      history(c, { ...intent, intentId: '00000000-0000-4000-8000-000000000001' })
    ).toThrow('HISTORY_CONFLICT')
    expect(c.adapter.journal.get(c.handle.handleId)).toEqual(before)
    const request = { ...c.request, idempotencyKey: 'new-key' }
    const valid = await c.authority.commit(
      proposal(c, { ...request, requestDigest: digest(request) })
    )
    expect(history(c, valid)).toBe('unresolved')
    expect(c.aborts()).toBe(0)
  })
})

test('a malformed handle history cannot block independent valid handle progress in the same journal', async () => {
  await withCase(async (c) => {
    const original = c.adapter.journal.get(c.handle.handleId)
    const attemptId = 'att_01JABCDEF0123456789ABCDEFH'
    const handleId = `${c.handle.handleId}:independent`
    const admission = structuredClone(original.admission)
    admission.request.attemptId = attemptId
    admission.request.attemptBudget.attemptId = attemptId
    admission.handle.attemptId = attemptId
    admission.handle.handleId = handleId
    c.adapter.journal.admit({ handleId, attemptId, startKey: 'independent', admission, at })
    const valid = {
      ...(await c.authority.commit(proposal(c))),
      handleId,
      attemptId,
      admissionDigest: digest(admission),
      turnKey: `pi-turn:${attemptId}:initial`,
    }
    const before = c.adapter.journal.get(handleId)
    expect(() => history(c, { ...valid, handleId: c.handle.handleId })).toThrow()
    expect(history(c, valid)).toBe('unresolved')
    expect(c.adapter.journal.get(handleId)).toEqual(before)
    expect(c.aborts()).toBe(0)
  })
})
