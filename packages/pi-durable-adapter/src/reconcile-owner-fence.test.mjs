import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiDurableRuntimeAdapter } from './adapter.ts'
import { fixture } from './adapter.fixture.mjs'

// Reconciliation must never fence a process that still owns the journal record. A reader that
// sees no retained physical-send hold cannot tell that a live owner has not reserved yet, so the
// ownership check has to precede both the hold observation and the epoch claim.

function startIdleProcess() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}

async function deadProcessId() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('exit', resolve))
  return child.pid
}

/** Persists a non-terminal record through the public adapter, then reopens it with no live runs. */
async function persistedUnknownRecord(options, request) {
  const first = new PiDurableRuntimeAdapter({
    ...options,
    engineFactory: async () => ({
      run: async () => {
        throw new Error('interrupted')
      },
      close: async () => {},
      cancel: async () => {},
    }),
  })
  const handle = await first.start(request)
  await first.drain()
  expect((await first.status(handle)).state).toBe('unknown')
  await first.close()
  return handle
}

function ownedBy(journal, handleId, ownerPid) {
  const record = journal.get(handleId)
  const epoch = record.epoch + 1
  journal.database.prepare('UPDATE pi_admissions SET body = ? WHERE handle_id = ?').run(
    JSON.stringify({
      ...record,
      epoch,
      detail: { ...record.detail, ownerPid, ownerEpoch: epoch },
    }),
    handleId
  )
}

test('reconcile does not fence a live owner whose retained send hold is not yet visible', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-live-owner-'))
  const owner = startIdleProcess()
  try {
    const { options, request } = fixture(directory)
    const handle = await persistedUnknownRecord(options, request)
    const decisions = []
    // The absent hold is the stale observation: the live owner has not reserved yet.
    const reopened = new PiDurableRuntimeAdapter({
      ...options,
      reconcileInference: async () => {
        decisions.push(reopened.journal.get(handle.handleId).epoch)
        return 'safe_to_resume'
      },
    })
    ownedBy(reopened.journal, handle.handleId, owner.pid)
    const before = reopened.journal.get(handle.handleId)
    const eventsBefore = reopened.journal.events(handle.handleId, 0).length

    const status = await reopened.reconcile(handle)

    const after = reopened.journal.get(handle.handleId)
    expect(after.epoch).toBe(before.epoch)
    expect(after.detail.ownerPid).toBe(owner.pid)
    expect(after.state).toBe('unknown')
    expect(status.state).toBe('unknown')
    expect(reopened.journal.events(handle.handleId, 0).length).toBe(eventsBefore)
    expect(decisions.length).toBeLessThanOrEqual(1)
    await reopened.close()
  } finally {
    owner.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reconcile confirms a safe verdict under the claimed epoch of a dead owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-dead-owner-'))
  try {
    const { options, request } = fixture(directory)
    const handle = await persistedUnknownRecord(options, request)
    const decisions = []
    const reopened = new PiDurableRuntimeAdapter({
      ...options,
      reconcileInference: async () => {
        decisions.push(reopened.journal.get(handle.handleId).epoch)
        // The first read may say safe; only the read under the claimed epoch decides a resume.
        return decisions.length === 1 ? 'safe_to_resume' : 'unresolved'
      },
    })
    ownedBy(reopened.journal, handle.handleId, await deadProcessId())
    const before = reopened.journal.get(handle.handleId)

    const status = await reopened.reconcile(handle)

    expect(decisions).toEqual([before.epoch, before.epoch + 1])
    expect(reopened.journal.get(handle.handleId).epoch).toBe(before.epoch + 1)
    expect(status.state).toBe('unknown')
    await reopened.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
