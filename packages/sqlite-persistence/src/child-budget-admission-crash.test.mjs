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
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

import { SqliteDelegationRepository } from './delegation-repository.ts'
import { SqliteExecutionRepository } from './repositories.ts'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteDurableUsageStore } from './usage-store.ts'
import { ids } from './child-allocation-fixture.mjs'

const CRASH_FIXTURE = join(import.meta.dirname, 'child-budget-admission-crash.fixture.mjs')
const CRASH_TIMEOUT_MS = 120_000

/**
 * Start the owned subprocess and wait until it reports the barrier it parks on.
 * The returned handle owns exactly one child process; the test kills that pid
 * and nothing else.
 */
async function startCrashingAdmission(crashPoint) {
  const child = spawn(process.execPath, [CRASH_FIXTURE, crashPoint], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  let buffer = ''
  let payload
  const parked = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`the crashing admission did not reach its barrier: ${stderr || '(no stderr)'}`)
      )
    }, CRASH_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) {
          const message = JSON.parse(line)
          if (message.type === 'ready') payload = message
          if (message.type === 'parked') {
            clearTimeout(timer)
            resolve(message)
          }
        }
        index = buffer.indexOf('\n')
      }
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(`the crashing admission exited before its barrier: ${stderr}`))
    })
  })
  if (!payload) throw new Error('the crashing admission never reported its state directory')
  return { child, exited, payload, parked }
}
/** Kill only the owned subprocess, with the signal an operating-system crash uses. */
async function killOwnedSubprocess(handle) {
  handle.child.kill('SIGKILL')
  const outcome = await handle.exited
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

test('a crash before the enclosing commit leaves no child allocation, and the request replays exactly once', async () => {
  const handle = await startCrashingAdmission('before-commit')
  let reopened
  try {
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
      await usageStore.transaction(ids.workspaceId, (tx) => tx.getBudget(request.childExecutionId))
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
    await rm(handle.payload.directory, { recursive: true, force: true })
  }
})

test('a crash after the commit and before the acknowledgement keeps exactly one allocation and one funding', async () => {
  const handle = await startCrashingAdmission('after-commit')
  let reopened
  try {
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
    await rm(handle.payload.directory, { recursive: true, force: true })
  }
})
