// Test-owned pinned process handles for the self-hosted simple SIGKILL proof (M17.02.2, #1025).
//
// The proof reaps the orphaned Restate launcher and native server by hand before restart. A pid
// alone is not an identity: between "this pid still matches the record" and `kill(pid)`, the
// process can exit and the pid can be reissued to an unrelated process. This module closes that
// window with a Linux pidfd. `pidfd_open` pins the process that holds the pid at that instant; the
// recorded identity (pid, start time, command) is then verified against that pinned process, and
// every later signal and liveness check goes through the descriptor. A descriptor never follows a
// reissued pid: once its process is gone, `pidfd_send_signal` reports ESRCH.
//
// Fail closed: where pidfds are unavailable (non-Linux, old kernels, a blocked syscall) pinning
// throws PINNED_PROCESS_UNSUPPORTED. It never falls back to signalling a bare pid.
//
// Parent-only helper. It uses `bun:ffi`, so it must not be imported by the composition child that
// `self-hosted-simple-sigkill.mjs` runs under Node.

import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { identityOfPid } from './self-hosted-simple-sigkill.mjs'

// `pidfd_open` and `pidfd_send_signal` share these numbers on every architecture that has them.
const SYS_PIDFD_SEND_SIGNAL = 424n
const SYS_PIDFD_OPEN = 434n
const SIGNALS = { SIGTERM: 15, SIGKILL: 9 }
const POLLIN = 1
const ESRCH = 3

function unsupported(reason, cause) {
  return new Error(`PINNED_PROCESS_UNSUPPORTED: ${reason}`, { cause })
}

/** The syscall layer. Injected in unit tests; the real one calls libc through `bun:ffi`. */
export async function createPidfdBackend({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== 'linux') throw unsupported(`platform ${platform} has no pidfd`)
  if (arch !== 'x64' && arch !== 'arm64') throw unsupported(`architecture ${arch} is not mapped`)
  let ffi
  let libc
  try {
    ffi = await import('bun:ffi')
    const { dlopen, FFIType } = ffi
    libc = dlopen('libc.so.6', {
      syscall: {
        args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64],
        returns: FFIType.i64,
      },
      // oxlint-disable-next-line no-underscore-dangle -- the libc symbol's own name
      __errno_location: { args: [], returns: FFIType.ptr },
      poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    }).symbols
  } catch (error) {
    throw unsupported('libc is not reachable through bun:ffi', error)
  }
  const errno = () => ffi.read.i32(libc['__errno_location']())
  const call = (number, a, b = 0n) => {
    const result = Number(libc.syscall(number, BigInt(a), BigInt(b), 0n, 0n))
    return result < 0 ? { error: errno() } : { value: result }
  }
  return {
    /** The descriptor pinning `pid`, or undefined when no such process exists. */
    open(pid) {
      const { value, error } = call(SYS_PIDFD_OPEN, pid)
      if (error === ESRCH) return undefined
      if (error !== undefined) throw unsupported(`pidfd_open failed with errno ${error}`)
      return value
    },
    /** True when the signal was delivered to the pinned process, false when it is gone. */
    send(fd, signalNumber) {
      const { error } = call(SYS_PIDFD_SEND_SIGNAL, fd, signalNumber)
      if (error === ESRCH) return false
      if (error !== undefined) throw new Error(`PINNED_PROCESS_SIGNAL_FAILED: errno ${error}`)
      return true
    },
    /** A pidfd becomes readable once its process has terminated. */
    exited(fd) {
      const poll = new DataView(new ArrayBuffer(8))
      poll.setInt32(0, fd, true)
      poll.setInt16(4, POLLIN, true)
      const ready = libc.poll(ffi.ptr(poll.buffer), 1n, 0)
      if (ready < 0) throw new Error(`PINNED_PROCESS_POLL_FAILED: errno ${errno()}`)
      return ready > 0
    },
    close(fd) {
      libc.close(fd)
    },
  }
}

/** `ps` identity plus the kernel start time in clock ticks, which `ps` rounds to whole seconds. */
export async function readProcessIdentity(pid) {
  const row = await identityOfPid(pid)
  if (row === undefined) return undefined
  let startTicks
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    // The command name is parenthesised and may contain spaces; start time is field 22.
    startTicks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return undefined
  }
  return { ...row, startTicks }
}

/** Whether `actual` is the process `expected` describes. `ppid` is excluded: orphans are reparented. */
export function sameProcess(actual, expected) {
  return (
    actual.pid === expected.pid &&
    actual.started === expected.started &&
    actual.command === expected.command &&
    (expected.startTicks === undefined ||
      actual.startTicks === undefined ||
      actual.startTicks === expected.startTicks)
  )
}

/** A process pinned by descriptor. All signalling and liveness go through the descriptor. */
class PinnedProcess {
  #backend
  #fd
  constructor(identity, fd, backend) {
    this.identity = identity
    this.#fd = fd
    this.#backend = backend
  }

  get exited() {
    return this.#fd === undefined || this.#backend.exited(this.#fd)
  }

  /** Delivers one signal to the pinned process. Returns false when that process is already gone. */
  signal(name) {
    if (this.#fd === undefined) return false
    return this.#backend.send(this.#fd, SIGNALS[name])
  }

  /** SIGTERM, then SIGKILL only if the process outlives the grace period. Resolves true once the
   *  pinned process is confirmed gone, false when it is not. A false result keeps the handle open
   *  and the identity intact, so the same process can be retried. */
  async terminate({ graceMs = 30_000, forceMs = 10_000, pollMs = 50 } = {}) {
    for (const [name, budget] of [
      ['SIGTERM', graceMs],
      ['SIGKILL', forceMs],
    ]) {
      if (this.exited) return true
      this.signal(name)
      const deadline = Date.now() + budget
      while (Date.now() < deadline) {
        if (this.exited) return true
        await delay(pollMs)
      }
    }
    return this.exited
  }

  /** Releases the descriptor. Only called once the process is confirmed gone or at disposal. */
  close() {
    if (this.#fd === undefined) return
    this.#backend.close(this.#fd)
    this.#fd = undefined
  }
}

/**
 * Pins the process now holding `expected.pid` and verifies it is the recorded process. The
 * descriptor is opened first and the identity read second, so a pid reissued before the open shows
 * up as a mismatch, and a process that exited in between shows up as already exited. A mismatch
 * closes the descriptor and signals nothing.
 */
export async function pinProcess(expected, { backend, readIdentity = readProcessIdentity } = {}) {
  const pinning = backend ?? (await createPidfdBackend())
  const fd = pinning.open(expected.pid)
  if (fd === undefined) throw new Error('PINNED_PROCESS_IDENTITY_MISMATCH: no such process')
  try {
    const actual = await readIdentity(expected.pid)
    if (actual === undefined || !sameProcess(actual, expected) || pinning.exited(fd)) {
      throw new Error('PINNED_PROCESS_IDENTITY_MISMATCH: pid is not the recorded process')
    }
    return new PinnedProcess({ ...expected, ...actual }, fd, pinning)
  } catch (error) {
    pinning.close(fd)
    throw error
  }
}

/** Records and pins the process at `pid`, whose command must include `commandIncludes`. */
export async function pinOwnedProcess(pid, commandIncludes, options = {}) {
  const row = await (options.readIdentity ?? readProcessIdentity)(pid)
  if (row === undefined || !row.command.includes(commandIncludes)) {
    throw new Error('OWNED_PROCESS_IDENTITY_MISMATCH')
  }
  return pinProcess(row, options)
}
