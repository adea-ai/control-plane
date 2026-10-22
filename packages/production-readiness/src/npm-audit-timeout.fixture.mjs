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
      return child
    },
    /**
     * The receipt the owned child published, which names the grandchild it
     * started. Recovered from the receipt itself, not from a value an
     * assertion produced.
     */
    async readReceipt(timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (existsSync(receiptPath)) {
          try {
            return JSON.parse(readFileSync(receiptPath, 'utf8'))
          } catch {
            /* the receipt is still being written */
          }
        }
        await sleep(25)
      }
      return undefined
    },
  }
}

/**
 * Reap every process this fixture owns and only then remove its receipts.
 *
 * The cleanup is independent of the success path: it works when the fixture
 * was started and the assertions never ran, and it works when an assertion
 * failed half way through.
 *
 * @returns {Promise<{ grandchild: string, ownedChild: string, receiptsRemoved: boolean }>}
 */
export async function cleanupOwnedTimeoutFixture(fixture) {
  const receipt = await fixture.readReceipt(1_000)
  const grandchildPid = receipt?.grandchildPid
  const grandchild = grandchildPid
    ? await reapOwnedProcess(grandchildPid, fixture.nonce)
    : 'not-started'
  const ownedChild = fixture.ownedPid
    ? await reapOwnedProcess(fixture.ownedPid, fixture.nonce)
    : 'not-started'
  // The grandchild's parent is gone now, so a grandchild that was still a
  // zombie is collected by init; give that a bounded moment.
  if (grandchildPid && isProcessAlive(grandchildPid)) {
    const deadline = Date.now() + REAP_TIMEOUT_MS
    while (Date.now() < deadline && isProcessAlive(grandchildPid)) {
      await sleep(25)
    }
  }
  // The receipts are removed only after the owned processes are reaped.
  if (existsSync(fixture.receiptPath)) rmSync(fixture.receiptPath, { force: true })
  rmSync(fixture.directory, { recursive: true, force: true })
  return { grandchild, ownedChild, receiptsRemoved: !existsSync(fixture.receiptPath) }
}
