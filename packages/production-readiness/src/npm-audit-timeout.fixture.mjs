// Local fixtures for the audit-attempt timeout regressions.
//
// A fixture owns exactly the processes it starts: the child, and the
// grandchild that child starts. Their identities are recovered by the fixture
// itself - from the child's own pid and from the receipt the child publishes -
// never from a value that a success-path assertion produced. A failing
// assertion therefore cannot leave a process behind.
//
// Every process is reaped with a bounded escalation, and only after its
// identity is verified against this fixture's nonce, so an unrelated process
// can never be targeted. No broad process matching is used anywhere here. The
// receipt that names the grandchild is removed only after the reaping.

import { execFileSync, spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Grace window between the SIGTERM and the SIGKILL of an owned process. */
export const REAP_GRACE_MS = 250

/** Upper bound on the whole reap of one owned process. */
export const REAP_TIMEOUT_MS = 5_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A bounded blocking wait, used only while the fixture publishes its receipt. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** The receipt the child published, read without waiting when it is there. */
function readReceiptFile(receiptPath) {
  if (!existsSync(receiptPath)) return undefined
  try {
    return JSON.parse(readFileSync(receiptPath, 'utf8'))
  } catch {
    return undefined
  }
}

/** The process state, or undefined when the process is gone. */
export function processState(pid) {
  try {
    const output = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
    return output.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the process is running. A reaped-but-not-yet-collected process (a
 * zombie) is not alive: it holds no resources and its identity is spent.
 */
export function isProcessAlive(pid) {
  const state = processState(pid)
  if (state === undefined) return false
  return !state.startsWith('Z')
}

/** The command line of the process, or undefined when it is gone. */
export function processCommandLine(pid) {
  try {
    const output = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
    return output.trim() || undefined
  } catch {
    return undefined
  }
}

/** Whether the process is the one this fixture owns. */
export function isOwnedProcess(pid, nonce) {
  const command = processCommandLine(pid)
  return command !== undefined && command.includes(nonce)
}

/**
 * Reap one owned process with a bounded escalation: SIGTERM, then SIGKILL
 * after the grace window, then a bounded wait for it to be gone.
 *
 * The process is only signalled when its own command line carries the
 * fixture's nonce, so an unrelated process can never be targeted.
 *
 * @returns {Promise<'already-gone' | 'not-ours' | 'reaped' | 'still-alive'>}
 */
export async function reapOwnedProcess(pid, nonce, options = {}) {
  const graceMs = options.graceMs ?? REAP_GRACE_MS
  const timeoutMs = options.timeoutMs ?? REAP_TIMEOUT_MS
  const pollMs = options.pollMs ?? 25
  if (!isProcessAlive(pid)) return 'already-gone'
  if (!isOwnedProcess(pid, nonce)) return 'not-ours'
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return 'already-gone'
  }
  const deadline = Date.now() + timeoutMs
  const escalateAt = Date.now() + graceMs
  let escalated = false
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return 'reaped'
    if (!escalated && Date.now() >= escalateAt) {
      escalated = true
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        return 'already-gone'
      }
    }
    await sleep(pollMs)
  }
  return isProcessAlive(pid) ? 'still-alive' : 'reaped'
}

/**
 * Prepare an owned timeout fixture.
 *
 * The fixture owns one child and the grandchild that child starts. The child
 * is started through the fixture's own spawn injection, so the helper and the
 * fixture always share the same child, and the child's pid is recorded when
 * it starts rather than when an assertion happens to read it.
 *
 * @param {object} [options]
 * @param {boolean} [options.holdsPipe] let the grandchild inherit the child's pipes, so they
 *   stay open after the child is gone
 * @param {boolean} [options.exitsOnTerm] let the child exit when it is asked to
 * @returns {object} the fixture
 */
export function startOwnedTimeoutFixture(options = {}) {
  const holdsPipe = options.holdsPipe ?? false
  const exitsOnTerm = options.exitsOnTerm ?? false
  const directory = mkdtempSync(join(tmpdir(), 'npm-audit-owned-'))
  const nonce = randomUUID()
  const receiptPath = join(directory, 'grandchild.json')
  const signalLogPath = join(directory, 'signals.log')
  const scriptPath = join(directory, `owned-child-${nonce}.mjs`)
  // The grandchild either holds the child's pipes open (so they outlive the
  // child) or is fully detached from them.
  const grandchildStdout = holdsPipe ? ['inherit', 'inherit'] : ['ignore', 'ignore']
  writeFileSync(
    scriptPath,
    `import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
const nonce = ${JSON.stringify(nonce)}
process.on('SIGTERM', () => {
  appendFileSync(${JSON.stringify(signalLogPath)}, 'TERM\\n')
  ${exitsOnTerm ? 'process.exit(0)' : ''}
})
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', nonce], {
  stdio: ${JSON.stringify(['ignore', ...grandchildStdout])},
})
writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ grandchildPid: grandchild.pid, nonce }))
setInterval(() => {}, 1000)
`
  )
  let ownedPid
  let receipt
  return {
    nonce,
    receiptPath,
    signalLogPath,
    directory,
    scriptPath,
    get ownedPid() {
      return ownedPid
    },
    /**
     * The spawn injection for the audit helper. It records the owned child as
     * it starts, so the identity never depends on a later assertion.
     */
    spawn(command, args, spawnOptions) {
      const child = spawnProcess(process.execPath, [scriptPath], {
        ...spawnOptions,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      ownedPid = child.pid
      // The receipt is published by the child as it starts. Waiting for it here
      // makes the grandchild's identity deterministic for the caller and for
      // the cleanup, and it happens before the helper's budget starts.
      const deadline = Date.now() + 5_000
      let published = readReceiptFile(receiptPath)
      while (published === undefined && Date.now() < deadline) {
        sleepSync(25)
        published = readReceiptFile(receiptPath)
      }
      receipt = published
      return child
    },
    /**
     * The receipt the owned child published, which names the grandchild it
     * started. Recovered from the receipt itself, not from a value an
     * assertion produced.
     */
    async readReceipt(timeoutMs = 5_000) {
      if (receipt !== undefined) return receipt
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const published = readReceiptFile(receiptPath)
        if (published !== undefined) {
          receipt = published
          return receipt
        }
        await sleep(25)
      }
      return undefined
    },
  }
}

/**
 * Dispose of a fixture independently of any assertion that ran before it.
 *
 * This is the cleanup a caller runs in a `finally`, so a failing assertion can
 * never leave a test-owned process behind. It works from the retained identity
 * of the grandchild as well as from the receipt file, so it still reaches the
 * process when the receipt is gone. It fails closed like the cleanup itself:
 * when the reaping cannot be confirmed, the receipt and the directory are
 * kept, because they name the process that is still running.
 *
 * @param {object} fixture the fixture to dispose of
 * @param {object} [retainedReceipt] the receipt the caller recorded before it
 *   removed or lost it
 * @returns {Promise<{ success: boolean, grandchild: string, ownedChild: string, problems: string[], receiptPresent: boolean, directoryPreserved: boolean }>}
 */
export async function disposeOwnedTimeoutFixture(fixture, retainedReceipt = undefined) {
  const receipt = retainedReceipt ?? readReceiptFile(fixture.receiptPath)
  const problems = []
  const grandchildPid = receipt?.grandchildPid
  const startedSomething = fixture.ownedPid !== undefined || receipt !== undefined
  let grandchild = 'not-started'
  if (typeof grandchildPid === 'number') {
    grandchild = await reapOwnedProcess(grandchildPid, fixture.nonce)
    if (grandchild !== 'reaped' && grandchild !== 'already-gone') {
      problems.push(`grandchild-${grandchild}`)
    }
  } else if (startedSomething) {
    // A process was started but its identity is gone, so nothing can be
    // signalled and the cleanup cannot claim that nothing is running.
    problems.push('grandchild-identity-unknown')
  }
  let ownedChild = 'not-started'
  if (fixture.ownedPid) {
    ownedChild = await reapOwnedProcess(fixture.ownedPid, fixture.nonce)
    if (ownedChild !== 'reaped' && ownedChild !== 'already-gone') {
      problems.push(`owned-child-${ownedChild}`)
    }
  }
  const confirmed = problems.length === 0
  if (confirmed) {
    // The artifacts are removed only when every owned process was confirmed
    // gone. This deletes the fixture's own receipt and directory and nothing
    // else.
    if (existsSync(fixture.receiptPath)) rmSync(fixture.receiptPath, { force: true })
    rmSync(fixture.directory, { recursive: true, force: true })
  }
  return {
    success: confirmed,
    grandchild,
    ownedChild,
    problems,
    receiptPresent: existsSync(fixture.receiptPath),
    directoryPreserved: existsSync(fixture.directory),
  }
}

/**
 * Reap every process this fixture owns and only then remove its receipts.
 *
 * The cleanup is independent of the success path: it works when the fixture
 * was started and the assertions never ran, and it works when an assertion
 * failed half way through.
 *
 * It also fails closed. When the reap of an owned process cannot be confirmed,
 * or when the receipt that names the grandchild is missing, the cleanup does
 * not claim success: it reports the failure and keeps the receipt and the
 * directory, because the receipt is the only record of which process still
 * has to be reaped and deleting it would leave that process unrecoverable.
 *
 * @param {object} fixture the fixture to clean up
 * @param {object} [options]
 * @param {(pid: number, nonce: string) => Promise<string>} [options.reap] the reap to use
 * @param {(timeoutMs: number) => Promise<object | undefined>} [options.readReceipt] the receipt reader
 * @returns {Promise<{ success: boolean, grandchild: string, ownedChild: string, problems: string[], receiptPresent: boolean, directoryPreserved: boolean }>}
 */
export async function cleanupOwnedTimeoutFixture(fixture, options = {}) {
  const reap = options.reap ?? reapOwnedProcess
  // The receipt is read from the file the child published: that file is the
  // durable record of which process still has to be reaped, so a deleted
  // receipt must read as missing rather than as a cached identity.
  const readReceipt = options.readReceipt ?? (async () => readReceiptFile(fixture.receiptPath))
  const problems = []
  const receipt = await readReceipt(1_000)
  let grandchild = 'not-started'
  if (receipt === undefined) {
    // A missing receipt is not proof that no grandchild was started: the
    // identity of a running process would be lost with it.
    problems.push('receipt-missing')
    grandchild = 'unknown'
  } else if (typeof receipt.grandchildPid !== 'number') {
    problems.push('receipt-without-grandchild')
    grandchild = 'unknown'
  } else {
    grandchild = await reap(receipt.grandchildPid, fixture.nonce)
    if (grandchild !== 'reaped' && grandchild !== 'already-gone') {
      problems.push(`grandchild-${grandchild}`)
    }
  }
  let ownedChild = 'not-started'
  if (fixture.ownedPid) {
    ownedChild = await reap(fixture.ownedPid, fixture.nonce)
    if (ownedChild !== 'reaped' && ownedChild !== 'already-gone') {
      problems.push(`owned-child-${ownedChild}`)
    }
  }
  // The grandchild's parent is gone now, so a grandchild that was killed but
  // not yet collected is collected by init; give that a bounded moment. This
  // only applies to a confirmed kill: an unconfirmed reap is reported, not
  // waited on.
  if (grandchild === 'reaped' && receipt?.grandchildPid && isProcessAlive(receipt.grandchildPid)) {
    const deadline = Date.now() + REAP_TIMEOUT_MS
    while (Date.now() < deadline && isProcessAlive(receipt.grandchildPid)) {
      await sleep(25)
    }
  }
  const uncertain = problems.length > 0
  // The receipts are removed only when every owned process was confirmed gone.
  if (!uncertain) {
    if (existsSync(fixture.receiptPath)) rmSync(fixture.receiptPath, { force: true })
    rmSync(fixture.directory, { recursive: true, force: true })
  }
  return {
    success: !uncertain,
    grandchild,
    ownedChild,
    problems,
    // What survives the cleanup: the receipt and the directory are kept
    // whenever the reaping could not be confirmed.
    receiptPresent: existsSync(fixture.receiptPath),
    directoryPreserved: existsSync(fixture.directory),
  }
}
