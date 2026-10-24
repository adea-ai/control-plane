import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { SqliteDurableJournal } from './journal.ts'
import { fixture, result } from './recovery-races.fixture.mjs'

const at = '2026-10-08T00:00:00.000Z'

function deferred() {
  let resolve
  const promise = new Promise((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

function openJournals(path, count) {
  return Array.from({ length: count }, () => new SqliteDurableJournal(path))
}

function admitHandle(journal) {
  journal.admit({
    handleId: 'handle',
    attemptId: 'attempt',
    startKey: 'key',
    admission: { opaque: true },
    at,
  })
}

test('a late release from an earlier claim cannot clear a later owner in the same process', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-process-claim-'))
  const [first, second, third] = openJournals(join(directory, 'journal.sqlite'), 3)
  try {
    admitHandle(first)
    const claimA = first.claimProcess('handle')
    first.releaseProcess('handle', claimA)
    expect(first.get('handle').detail.ownerPid).toBeUndefined()

    // Another adapter in this process claims serially: the pid is the same, so only the claim's
    // own fence can tell the two owners apart.
    const claimB = second.claimProcess('handle')
    expect(claimB.ownerPid).toBe(claimA.ownerPid)
    expect(claimB.ownerEpoch).toBeGreaterThan(claimA.ownerEpoch)

    first.releaseProcess('handle', claimA)
    expect(second.get('handle').detail).toMatchObject({
      ownerPid: claimB.ownerPid,
      ownerEpoch: claimB.ownerEpoch,
      ownerClaimId: claimB.claimId,
    })
    expect(() => third.claimProcess('handle')).toThrow('PI_SESSION_OWNER_ACTIVE')

    second.releaseProcess('handle', claimB)
    expect(second.get('handle').detail.ownerPid).toBeUndefined()
    expect(third.claimProcess('handle').epoch).toBe(claimB.epoch + 1)
  } finally {
    for (const journal of [first, second, third]) journal.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a release must match the claim pid as well as its fence', () => {
  const journal = new SqliteDurableJournal(':memory:')
  admitHandle(journal)
  const claim = journal.claimProcess('handle')
  journal.releaseProcess('handle', { ...claim, ownerPid: claim.ownerPid + 1 })
  expect(journal.get('handle').detail.ownerClaimId).toBe(claim.claimId)
  journal.releaseProcess('handle', claim)
  expect(journal.get('handle').detail.ownerClaimId).toBeUndefined()
  journal.close()
})

test('a command epoch bump does not stop the claim owner from releasing', () => {
  const journal = new SqliteDurableJournal(':memory:')
  admitHandle(journal)
  const claim = journal.claimProcess('handle')
  const bumped = journal.transition(journal.get('handle'), (current) => ({
    change: { detail: { ...current.detail, operatorNote: 'cancel-requested' } },
  }))
  expect(bumped.epoch).toBe(claim.epoch + 1)
  expect(bumped.detail).toMatchObject({ ownerPid: claim.ownerPid, ownerEpoch: claim.ownerEpoch })
  expect(journal.holdsProcessClaim('handle', claim)).toBe(true)

  journal.releaseProcess('handle', claim)
  const released = journal.get('handle')
  expect(released.detail.ownerPid).toBeUndefined()
  expect(released.detail.ownerEpoch).toBeUndefined()
  expect(released.detail.ownerClaimId).toBeUndefined()
  expect(released.epoch).toBe(claim.epoch + 1)
  journal.close()
})

test('a transient release cannot be undone by a late duplicate after its epoch is reissued', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-process-claim-reissue-'))
  const [first, second, third] = openJournals(join(directory, 'journal.sqlite'), 3)
  try {
    admitHandle(first)
    const transient = first.claimProcess('handle')
    // A transient release restores the command epoch, so the next claim is issued the same number.
    first.releaseRecoveryClaim('handle', transient)
    const reissued = second.claimProcess('handle')
    expect(reissued.epoch).toBe(transient.epoch)
    expect(reissued.ownerEpoch).toBe(transient.ownerEpoch)
    expect(reissued.claimId).not.toBe(transient.claimId)

    first.releaseProcess('handle', transient)
    expect(second.get('handle').detail.ownerClaimId).toBe(reissued.claimId)
    expect(() => third.claimProcess('handle')).toThrow('PI_SESSION_OWNER_ACTIVE')
  } finally {
    for (const journal of [first, second, third]) journal.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('stored owner fields survive detail writes from snapshots that predate the claim', () => {
  const journal = new SqliteDurableJournal(':memory:')
  admitHandle(journal)
  const before = journal.get('handle')
  const claim = journal.claimProcess('handle')

  journal.update('handle', claim.epoch, { detail: { ...before.detail, observedAt: at } })
  expect(journal.get('handle').detail).toMatchObject({
    observedAt: at,
    ownerPid: claim.ownerPid,
    ownerEpoch: claim.ownerEpoch,
    ownerClaimId: claim.claimId,
  })

  const claimed = journal.get('handle')
  journal.releaseProcess('handle', claim)
  // A snapshot taken while the claim was held must not resurrect a released claim.
  journal.update('handle', claim.epoch, { detail: claimed.detail })
  expect(journal.get('handle').detail.ownerPid).toBeUndefined()
  expect(journal.get('handle').detail.ownerEpoch).toBeUndefined()
  expect(journal.get('handle').detail.ownerClaimId).toBeUndefined()
  journal.close()
})

test('an engine close failure in a handed-over recovery releases its claim exactly once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-process-claim-close-'))
  // Only the recovered run's close is armed. It waits until the caller has observed the run
  // through drain(), so the failure is never an unobserved background rejection.
  let armed = false
  const closing = deferred()
  const setup = fixture(directory, {
    engineFactory: async () => ({
      run: async () => result,
      close: async () => {
        if (!armed) return
        await closing.promise
        throw new Error('ENGINE_CLOSE_FAILED')
      },
      cancel: async () => {},
    }),
    reconcileInference: async () => 'safe_to_resume',
  })
  const seed = new PiDurableRuntimeAdapter(setup.options)
  let adapter
  try {
    const handle = await seed.start(setup.request)
    await seed.drain()
    const stored = seed.journal.get(handle.handleId)
    seed.journal.update(handle.handleId, stored.epoch, {
      state: 'running',
      detail: { inferencePending: true },
    })
    await seed.close()

    armed = true
    adapter = new PiDurableRuntimeAdapter(setup.options)
    const releases = []
    const release = adapter.journal.releaseProcess.bind(adapter.journal)
    adapter.journal.releaseProcess = (handleId, claim) => {
      releases.push(claim.claimId)
      return release(handleId, claim)
    }
    await adapter.reconcile(handle)
    const drained = adapter.drain()
    closing.resolve()
    await expect(drained).rejects.toThrow('ENGINE_CLOSE_FAILED')
    expect(releases).toHaveLength(1)
    expect(adapter.journal.get(handle.handleId).detail.ownerPid).toBeUndefined()
  } finally {
    await adapter?.close().catch(() => undefined)
    await seed.close().catch(() => undefined)
    rmSync(directory, { recursive: true, force: true })
  }
})
