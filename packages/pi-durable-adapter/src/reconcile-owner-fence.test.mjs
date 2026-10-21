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
  let reopened
  try {
    const { options, request } = fixture(directory)
    const handle = await persistedUnknownRecord(options, request)
    const decisions = []
    // The absent hold is the stale observation: the live owner has not reserved yet.
    reopened = new PiDurableRuntimeAdapter({
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
  } finally {
    // Close the reopened adapter even when an assertion above failed, and
    // await only the child this test owns so its handle cannot leak into the
    // next test after a failed assertion.
    await reopened?.close()
    owner.kill('SIGKILL')
    await new Promise((resolve) => owner.once('exit', resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reconcile confirms a safe verdict under the claimed epoch of a dead owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-dead-owner-'))
  let reopened
  try {
    const { options, request } = fixture(directory)
    const handle = await persistedUnknownRecord(options, request)
    const decisions = []
    reopened = new PiDurableRuntimeAdapter({
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
  } finally {
    // Close the reopened adapter even when an assertion above failed. This
    // test owns no lingering child (deadProcessId already reaps its own).
    await reopened?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reconnect revocation after a safe observation cannot claim or resend retained work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-revoked-grant-'))
  let reopened
  try {
    const { options, request } = fixture(directory)
    const handle = await persistedUnknownRecord(options, request)
    let active = true
    let observations = 0
    let sends = 0
    reopened = new PiDurableRuntimeAdapter({
      ...options,
      assertAuthority: async () => {
        if (!active) throw new Error('CURRENT_GRANT_REVOKED')
      },
      reconcileInference: async () => {
        observations++
        active = false
        return 'safe_to_resume'
      },
      engineFactory: async () => ({
        run: async () => {
          sends++
          throw new Error('unexpected resend')
        },
        close: async () => {},
        cancel: async () => {},
      }),
    })
    const before = reopened.journal.get(handle.handleId)
    await expect(reopened.reconcile(handle)).rejects.toThrow('PI_AUTHORITY_REJECTED')
    expect(observations).toBe(1)
    expect(sends).toBe(0)
    const after = reopened.journal.get(handle.handleId)
    expect(after.epoch).toBe(before.epoch)
    expect(after.state).toBe('unknown')
  } finally {
    await reopened?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a retained pre-run marker resumes without an external no-send guess', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-pre-run-'))
  const { options, request } = fixture(directory)
  const first = new PiDurableRuntimeAdapter({
    ...options,
    engineFactory: async () => {
      throw new Error('engine construction stopped before run')
    },
  })
  let recovered
  try {
    const handle = await first.start(request)
    await first.drain()
    const retained = first.journal.get(handle.handleId)
    expect(retained.state).toBe('unknown')
    expect(retained.detail.engineRunStarted).toBe(false)
    expect(retained.detail.activeInference).toBeUndefined()
    await first.close()

    let externalVerdicts = 0
    let runs = 0
    recovered = new PiDurableRuntimeAdapter({
      ...options,
      reconcileInference: async () => {
        externalVerdicts++
        return 'unresolved'
      },
      engineFactory: async (input) => {
        const engine = await options.engineFactory(input)
        return {
          ...engine,
          run: async (runRequest) => {
            runs++
            return engine.run(runRequest)
          },
        }
      },
    })
    await recovered.reconcile(handle)
    await recovered.drain()
    expect((await recovered.status(handle)).state).toBe('completed')
    expect({ externalVerdicts, runs }).toEqual({ externalVerdicts: 0, runs: 1 })
  } finally {
    await recovered?.close()
    await first.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})

test('legacy or generation-bearing pre-run shapes stay unknown without trusted external evidence', async () => {
  for (const change of [
    { inferenceTrackingVersion: undefined },
    { resumeGenerationKey: 'pi-turn:retained:pi-generation:1' },
  ]) {
    const directory = mkdtempSync(join(tmpdir(), 'pi-reconcile-untrusted-pre-run-'))
    const { options, request } = fixture(directory)
    const first = new PiDurableRuntimeAdapter({
      ...options,
      engineFactory: async () => {
        throw new Error('engine construction stopped before run')
      },
    })
    let recovered
    try {
      const handle = await first.start(request)
      await first.drain()
      const row = first.journal.get(handle.handleId)
      first.journal.update(handle.handleId, row.epoch, {
        detail: { ...row.detail, ...change },
      })
      await first.close()
      let observations = 0
      recovered = new PiDurableRuntimeAdapter({
        ...options,
        reconcileInference: async () => {
          observations++
          return 'unresolved'
        },
      })
      expect((await recovered.reconcile(handle)).state).toBe('unknown')
      expect(observations).toBe(1)
    } finally {
      await recovered?.close()
      await first.close().catch(() => {})
      rmSync(directory, { recursive: true, force: true })
    }
  }
})
