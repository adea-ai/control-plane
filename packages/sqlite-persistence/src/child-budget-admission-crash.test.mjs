// The SQLite child-budget admission under an operating-system crash (#187).
//
// A thrown exception is not crash coverage: the transaction unwinds in the same
// process. These tests kill an owned subprocess with SIGKILL while the child
// allocation is parked on a deterministic barrier, so the store has to recover
// from the crash of a whole process.
//
// The crash half lives in `child-budget-admission-crash.fixture.mjs`, which
// reuses the shared child-allocation fixture and wraps the provider's
// `transaction` method so the crash lands exactly on the commit seam. No
// production source is edited, and the shared fixture is used as it is.
//
// Two crash points are proved:
//
//   - before the enclosing commit, every staged allocation write is gone, the
//     parent baseline is unchanged, and the request can be replayed once and
//     only once;
//   - after the commit and before the acknowledgement, exactly one allocation
//     and one funding survive.
//
// The owned child and the disposable state it writes into have a bounded
// lifetime: every failure path - a spawn error, an early exit, a malformed
// message, a barrier that never arrives - terminates and reaps that one child
// and removes the state root, and the tests' cleanup runs under `finally`, so
// a timeout cannot leave either behind.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

import { SqliteDelegationRepository } from './delegation-repository.ts'
import { SqliteExecutionRepository } from './repositories.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteDurableUsageStore } from './usage-store.ts'
import { ids } from './child-allocation-fixture.mjs'

const CRASH_FIXTURE = join(import.meta.dirname, 'child-budget-admission-crash.fixture.mjs')
// The waits are bounded and shorter than the test timeout, so a hang surfaces as
// a bounded rejection instead of a silently lengthened test.
const BARRIER_WAIT_MS = 60_000
const EXIT_WAIT_MS = 10_000
const TEST_TIMEOUT_MS = 120_000

/**
 * The state root the test owns. The child writes its disposable state inside
 * it, so the root is always known and can always be removed, even when the
 * child fails before it reports anything.
 */
async function createStateRoot() {
  return await mkdtemp(join(tmpdir(), 'cp187-child-budget-crash-'))
}

/**
 * Start the owned subprocess and wait until it reports the barrier it parks on.
 *
 * The function is exception-safe before it returns a handle: when the child
 * cannot be started, errors, exits early, reports a malformed message or never
 * reaches the barrier, the owned child is terminated and reaped and the state
 * root is removed before the failure is re-thrown.
 */
async function startCrashingAdmission({
  barrierWaitMs = BARRIER_WAIT_MS,
  crashPoint,
  executable = process.execPath,
  fault,
  stateRoot,
}) {
  let child
  try {
    child = spawn(executable, [CRASH_FIXTURE, crashPoint], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // The child's disposable state lands inside the root the test owns.
      env: { ...process.env, ...(fault ? { CRASH_FIXTURE_FAULT: fault } : {}), TMPDIR: stateRoot },
    })
  } catch (error) {
    await rm(stateRoot, { recursive: true, force: true })
    throw new Error(`the crashing admission could not be started: ${error}`, { cause: error })
  }
  const handle = { child, exit: undefined, parked: undefined, payload: undefined, stateRoot }
  const exited = new Promise((resolve) => {
    let settled = false
    const settle = (outcome) => {
      if (settled) return
      settled = true
      handle.exit = outcome
      resolve(outcome)
    }
    child.once('exit', (code, signal) => settle({ code, signal }))
    // A child that never started reports an error instead of an exit, so the
    // owned child's lifetime ends here rather than at the exit bound.
    child.once('error', (error) =>
      settle({ code: undefined, signal: undefined, spawnError: error })
    )
  })
  handle.exited = exited
  try {
    await waitForBarrier(handle, barrierWaitMs)
  } catch (error) {
    await disposeOwnedChild(handle)
    throw error
  }
  return handle
}

/** Wait for the barrier the child parks on, with a bounded wait. */
function waitForBarrier(handle, barrierWaitMs) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    let stderr = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    const timer = setTimeout(() => {
      finish(
        new Error(
          `the crashing admission did not reach its barrier within ${barrierWaitMs}ms: ${
            stderr || '(no stderr)'
          }`
        )
      )
    }, barrierWaitMs)
    childStderr(handle, (chunk) => {
      stderr += chunk
    })
    handle.child.stdout.setEncoding('utf8')
    handle.child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) {
          let message
          try {
            message = JSON.parse(line)
          } catch (error) {
            finish(
              new Error(`the crashing admission reported a malformed message: ${error}`, {
                cause: error,
              })
            )
            return
          }
          if (message.type === 'ready') handle.payload = message
          if (message.type === 'parked') {
            handle.parked = message
            finish()
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    handle.child.once('error', (error) => {
      finish(new Error(`the crashing admission failed: ${error}`, { cause: error }))
    })
    handle.exited.then((outcome) => {
      finish(
        new Error(
          `the crashing admission exited before its barrier (code ${outcome.code}, signal ${outcome.signal}): ${
            stderr || '(no stderr)'
          }`
        )
      )
    })
  })
}

function childStderr(handle, onData) {
  handle.child.stderr.setEncoding('utf8')
  handle.child.stderr.on('data', onData)
}

/** Wait for the owned child's exit, with a bounded wait. */
async function waitForExit(handle, exitWaitMs = EXIT_WAIT_MS) {
  if (handle.exit) return handle.exit
  const outcome = await Promise.race([
    handle.exited,
    new Promise((resolve) =>
      setTimeout(() => resolve({ code: undefined, signal: undefined, timedOut: true }), exitWaitMs)
    ),
  ])
  if (outcome.timedOut) {
    throw new Error(`the owned child did not exit within ${exitWaitMs}ms`)
  }
  return outcome
}

/**
 * Terminate and reap the owned child, and remove the disposable state root.
 * Only this child's pid is signalled.
 */
async function disposeOwnedChild(handle) {
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill('SIGKILL')
  }
  try {
    await waitForExit(handle)
  } catch {
    // The child is already gone or unreachable; the state root is still removed.
  }
  await rm(handle.stateRoot, { recursive: true, force: true })
}

/** Kill only the owned subprocess, with the signal an operating-system crash uses. */
async function killOwnedSubprocess(handle) {
  handle.child.kill('SIGKILL')
  const outcome = await waitForExit(handle)
  expect(outcome.signal).toBe('SIGKILL')
}

async function reopenStore(directory) {
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  await provider.migrate()
  return {
    provider,
    executions: new SqliteExecutionRepository(provider),
    delegations: new SqliteDelegationRepository(provider),
    usageStore: new SqliteDurableUsageStore(provider),
  }
}

function allocationInput(payload) {
  return {
    request: payload.request,
    receipt: payload.receipt,
    execution: payload.execution,
    attempt: payload.attempt,
    delegation: payload.delegation,
    assertCurrent: async () => undefined,
  }
}

test(
  'a crash before the enclosing commit leaves no child allocation, and the request replays exactly once',
  async () => {
    const stateRoot = await createStateRoot()
    let handle
    let reopened
    try {
      handle = await startCrashingAdmission({ crashPoint: 'before-commit', stateRoot })
      await killOwnedSubprocess(handle)
      reopened = await reopenStore(handle.payload.directory)
      const { delegations, executions, usageStore } = reopened
      const request = handle.payload.request

      // The crash really landed after the staged allocation writes: the subprocess
      // reported them inside its open transaction before it was killed.
      expect(handle.parked.point).toBe('before-commit')
      expect(handle.parked.staged).toEqual({
        attempts: 1,
        delegations: 1,
        executions: 1,
        receipts: 1,
      })

      // Every staged allocation write is gone: the child execution, the child
      // attempt, the delegation record, the admission receipt and the child
      // budget.
      expect(await executions.getExecution(request.childExecutionId)).toBeUndefined()
      expect(await executions.getAttempt(request.childAttemptId)).toBeUndefined()
      expect(await delegations.get(request.delegationId)).toBeUndefined()
      expect(await delegations.getAdmissionReceipt(request.delegationId)).toBeUndefined()
      expect(
        await usageStore.transaction(ids.workspaceId, (tx) =>
          tx.getBudget(request.childExecutionId)
        )
      ).toBeUndefined()

      // The parent baseline is unchanged: the parent's own budget still carries
      // its ceiling and no reservation for the lost child.
      const parentBudget = await usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(ids.parentExecutionId)
      )
      expect(parentBudget?.maximumMicrounits).toBe(10_000_000)
      expect(parentBudget?.maximumTokens).toBe(250_000)
      expect(parentBudget?.reservations).toEqual([])

      // The request was never acknowledged, so it replays once: the replay
      // allocates, and the identical replay after it is the duplicate.
      expect(await delegations.allocate(allocationInput(handle.payload))).toBe(true)
      const duplicate = await delegations.allocate(allocationInput(handle.payload))
      expect(duplicate).toBe(false)

      // Exactly one allocation and one funding exist after the replay.
      expect(await delegations.get(request.delegationId)).toBeDefined()
      expect(await delegations.getAdmissionReceipt(request.delegationId)).toBeDefined()
      const replayedParentBudget = await usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(ids.parentExecutionId)
      )
      expect(replayedParentBudget?.reservations).toHaveLength(1)
    } finally {
      await reopened?.provider.close()
      if (handle) await disposeOwnedChild(handle)
      await rm(stateRoot, { recursive: true, force: true })
    }
  },
  TEST_TIMEOUT_MS
)

test(
  'a crash after the commit and before the acknowledgement keeps exactly one allocation and one funding',
  async () => {
    const stateRoot = await createStateRoot()
    let handle
    let reopened
    try {
      handle = await startCrashingAdmission({ crashPoint: 'after-commit', stateRoot })
      await killOwnedSubprocess(handle)
      reopened = await reopenStore(handle.payload.directory)
      const { delegations, executions, usageStore } = reopened
      const request = handle.payload.request

      // The crash really landed after the commit: the subprocess reported the
      // committed rows before it was killed.
      expect(handle.parked.point).toBe('after-commit')
      expect(handle.parked.committed).toEqual({
        attempts: 1,
        delegations: 1,
        executions: 1,
        receipts: 1,
      })

      // The committed allocation survived the crash of the whole process.
      const retained = await delegations.get(request.delegationId)
      expect(retained?.childExecutionId).toBe(request.childExecutionId)
      expect(await executions.getExecution(request.childExecutionId)).toBeDefined()
      expect(await executions.getAttempt(request.childAttemptId)).toBeDefined()
      expect(await delegations.getAdmissionReceipt(request.delegationId)).toBeDefined()

      // Exactly one funding: the child's budget exists once and the parent
      // carries exactly one reservation for it.
      const childBudget = await usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(request.childExecutionId)
      )
      expect(childBudget?.parentExecutionId).toBe(ids.parentExecutionId)
      const parentBudget = await usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(ids.parentExecutionId)
      )
      expect(parentBudget?.reservations).toHaveLength(1)

      // The acknowledged allocation is not duplicated by a replay.
      expect(await delegations.allocate(allocationInput(handle.payload))).toBe(false)
      expect(await delegations.get(request.delegationId)).toEqual(retained)
      const afterDuplicate = await usageStore.transaction(ids.workspaceId, (tx) =>
        tx.getBudget(ids.parentExecutionId)
      )
      expect(afterDuplicate?.reservations).toHaveLength(1)
    } finally {
      await reopened?.provider.close()
      if (handle) await disposeOwnedChild(handle)
      await rm(stateRoot, { recursive: true, force: true })
    }
  },
  TEST_TIMEOUT_MS
)

test(
  'a failure before the barrier ends the owned child and removes its disposable state',
  async () => {
    const stateRoot = await createStateRoot()
    try {
      // The child reports its state and then fails before it parks, so the owned
      // child is gone while the disposable state it created still exists.
      await expect(
        startCrashingAdmission({ crashPoint: 'before-commit', fault: 'exit', stateRoot })
      ).rejects.toThrow(/exited before its barrier/)
      // The child was reaped and the disposable state was removed.
      expect(existsSync(stateRoot)).toBe(false)
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  },
  TEST_TIMEOUT_MS
)

test(
  'a malformed message before the barrier ends the owned child and removes its disposable state',
  async () => {
    const stateRoot = await createStateRoot()
    try {
      await expect(
        startCrashingAdmission({ crashPoint: 'before-commit', fault: 'malformed', stateRoot })
      ).rejects.toThrow(/malformed message/)
      expect(existsSync(stateRoot)).toBe(false)
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  },
  TEST_TIMEOUT_MS
)

test(
  'a child that cannot be started ends without leaving disposable state',
  async () => {
    const stateRoot = await createStateRoot()
    try {
      await expect(
        startCrashingAdmission({
          crashPoint: 'before-commit',
          executable: join(stateRoot, 'no-such-executable'),
          stateRoot,
        })
      ).rejects.toThrow(/could not be started|failed/)
      expect(existsSync(stateRoot)).toBe(false)
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  },
  TEST_TIMEOUT_MS
)

test(
  'a barrier that never arrives ends the owned child and removes its disposable state',
  async () => {
    const stateRoot = await createStateRoot()
    try {
      // The wait is bounded, so the failure is reported instead of hanging the test.
      await expect(
        startCrashingAdmission({
          barrierWaitMs: 2_000,
          crashPoint: 'before-commit',
          fault: 'hang',
          stateRoot,
        })
      ).rejects.toThrow(/did not reach its barrier/)
      expect(existsSync(stateRoot)).toBe(false)
    } finally {
      await rm(stateRoot, { recursive: true, force: true })
    }
  },
  TEST_TIMEOUT_MS
)
