// M13 #405 startup/RSS budget probe: the measurement rules and the child
// lifecycle, kept package-local so the repository script can drive them and
// the package's tests can exercise them without crossing a workspace
// boundary.
//
// The probe FAILS CLOSED, and it OWNS the child's whole lifecycle:
//   - a port that is already in use is an unrelated listener, so the probe
//     refuses to start rather than measuring somebody else's readiness;
//   - readiness is only accepted once the listener on the port is proved to
//     belong to the launched child (or a descendant of it);
//   - the readiness OBSERVATION is timestamped before that validation, and
//     reported only once the validation passes, so a slow inspection never
//     inflates the measured time-to-ready;
//   - a child that exits early, a missing PID, a failed spawn or a thrown
//     dependency fails the probe;
//   - the ownership inspection is a BOUNDED subprocess: a stalled `lsof` or
//     `ps` is abandoned and fails closed, so it can never hold the probe
//     open and keep the owned child alive past the deadlines;
//   - a malformed, empty or unsuccessful `ps` sample is refused, and a run with
//     no valid RSS sample is a failure, not a zero-megabyte pass;
//   - every path AFTER the spawn cleans the OWNED child up, in a `finally`,
//     and the cleanup result is reported next to the primary failure;
//   - the cleanup waits for the child's ACTUAL termination, and a child that
//     does not terminate is an explicit cleanup failure.
//
// The repository entry point is scripts/check-startup-budget.mjs.

import { spawnSync } from 'node:child_process'

/** How long the probe waits for the owned child to become ready. */
export const READY_POLL_INTERVAL_MS = 100
/** How long the probe waits for the owned child to exit after a signal. */
export const CLEANUP_GRACE_MS = 5_000
/**
 * How long an ownership-inspection command may run before it is abandoned.
 *
 * The inspection is a subprocess (`lsof`, `ps`), and a stalled one must not
 * hold the probe open: the probe owns the child's lifecycle, so a command that
 * never returns would keep the owned child alive past every deadline. These
 * owned inspection subprocesses are killed with SIGKILL on timeout, because
 * SIGTERM can be ignored and leave spawnSync waiting past its bound. The
 * bound is short enough that the inspection, the child's termination and the
 * cleanup grace still fit inside the probe's own budgets, and a command that
 * hits it FAILS CLOSED — an inspection that cannot be made is an inability to
 * prove ownership, never an empty listener set.
 */
export const INSPECTION_TIMEOUT_MS = 2_000

/**
 * Parses one `ps -o rss=` sample.
 *
 * A sample is valid only when the command succeeded and printed a positive
 * whole number of kilobytes. An unsuccessful, empty, malformed or zero sample
 * is REFUSED: it is evidence of a broken measurement, not evidence of a small
 * process.
 */
export function parseRssSample(result) {
  if (result === undefined || result === null) return { ok: false, reason: 'no sample was taken' }
  if (result.error !== undefined && result.error !== null && result.error.code === 'ETIMEDOUT')
    return { ok: false, reason: 'the RSS sample command timed out' }
  if (result.status !== 0)
    return {
      ok: false,
      reason: `the RSS sample command failed with status ${String(result.status)}`,
    }
  const text = String(result.stdout ?? '').trim()
  if (text === '') return { ok: false, reason: 'the RSS sample command produced no output' }
  if (!/^\d+$/u.test(text)) return { ok: false, reason: `the RSS sample was malformed: ${text}` }
  const kb = Number.parseInt(text, 10)
  if (!Number.isSafeInteger(kb) || kb <= 0)
    return { ok: false, reason: `the RSS sample was not a positive value: ${text}` }
  return { ok: true, kb }
}

/**
 * Decides whether the listener on the port belongs to the launched child.
 *
 * `parentOf` is injected so the ownership walk is deterministic in tests.
 */
export function classifyListener({ listenerPid, childPid, parentOf }) {
  if (!Number.isSafeInteger(listenerPid) || listenerPid <= 0)
    return { owned: false, reason: 'the listener could not be attributed to a PID' }
  if (!Number.isSafeInteger(childPid) || childPid <= 0)
    return { owned: false, reason: 'the launched child has no PID' }
  if (listenerPid === childPid) return { owned: true, reason: 'the listener is the launched child' }
  let current = listenerPid
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = parentOf(current)
    if (!Number.isSafeInteger(parent) || parent <= 0)
      return { owned: false, reason: 'the listener is not the launched child' }
    if (parent === childPid)
      return { owned: true, reason: 'the listener is a descendant of the launched child' }
    if (parent === current)
      return { owned: false, reason: 'the listener is not the launched child' }
    current = parent
  }
  return { owned: false, reason: 'the listener is not the launched child' }
}

/**
 * Folds the RSS samples into the peak.
 *
 * Every sample must be valid: one refused sample fails the measurement rather
 * than being dropped, and a run with no valid sample is a failure — never a
 * zero-megabyte pass.
 */
export function assessRssSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0)
    return { ok: false, reason: 'no RSS sample was taken' }
  const refused = samples.filter((sample) => !sample.ok)
  if (refused.length > 0)
    return { ok: false, reason: `an RSS sample was refused: ${refused[0].reason}` }
  const peakKb = Math.max(...samples.map((sample) => sample.kb))
  return { ok: true, peakMb: Math.round((peakKb / 1024) * 10) / 10, samples: samples.length }
}

/**
 * The host part of a listener address such as `127.0.0.1:3917` or `[::1]:3917`.
 */
export function listenerHost(address) {
  const text = String(address ?? '')
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    return end === -1 ? text : text.slice(1, end)
  }
  const index = text.lastIndexOf(':')
  return index === -1 ? text : text.slice(0, index)
}

/**
 * Whether a listener's address could be read at all.
 *
 * An address that could not be read is incomplete ownership evidence: the
 * probe cannot tell which local address that socket serves, so it refuses
 * the set rather than accepting it.
 */
export function hasReadableAddress(address) {
  const host = listenerHost(address)
  return host !== '' && host !== 'unknown'
}

/**
 * Whether a listener's address covers the address the probe talks to.
 *
 * A wildcard bind covers every address; an exact bind covers only its own.
 */
export function coversProbeAddress(address, probeAddress) {
  const host = listenerHost(address)
  if (host === '' || host === 'unknown') return false
  if (host === '*' || host === '0.0.0.0' || host === '::') return true
  return host === probeAddress
}

/**
 * Decides whether the listener set on the probed port belongs to the child.
 *
 * The probe talks to one address (`127.0.0.1`), but a port can be listened on
 * at several local addresses at once, and the listener on another address may
 * belong to an unrelated process. The set is therefore acceptable only when
 * EVERY listener on the port is the launched child or a descendant of it, at
 * least one of them covers the probed address, and every one of them has an
 * address that could be read. Anything unattributed, unreadable or ambiguous
 * fails closed: a socket whose address cannot be read is incomplete ownership
 * evidence, not evidence of ownership.
 */
export function assessListenerOwnership({
  listeners,
  childPid,
  parentOf,
  probeAddress = '127.0.0.1',
}) {
  if (!Array.isArray(listeners) || listeners.length === 0)
    return { owned: false, reason: 'no listener was found on the probed port' }
  const foreign = []
  let covering = 0
  for (const listener of listeners) {
    const classification = classifyListener({
      listenerPid: listener.pid,
      childPid,
      parentOf,
    })
    if (!classification.owned) {
      foreign.push(`${listener.pid} (${listener.address})`)
      continue
    }
    if (coversProbeAddress(listener.address, probeAddress)) covering += 1
  }
  if (foreign.length > 0)
    return {
      owned: false,
      reason: `a listener on the port is not the launched child: ${foreign.join(', ')}`,
    }
  const unreadable = listeners
    .filter((listener) => !hasReadableAddress(listener.address))
    .map((listener) => `${listener.pid} (${listener.address})`)
  if (unreadable.length > 0)
    return {
      owned: false,
      reason: `a listener's address could not be read, so its ownership cannot be established: ${unreadable.join(', ')}`,
    }
  if (covering === 0)
    return {
      owned: false,
      reason: `no listener on the probed address ${probeAddress} belongs to the launched child`,
    }
  return { owned: true, reason: 'every listener on the port belongs to the launched child' }
}

/**
 * Stops the OWNED child and reports whether it really terminated.
 *
 * Only the handle this probe spawned is ever signalled: no discovered PID is
 * ever sent a signal. The result is explicit, so a child that survives
 * SIGKILL is a failure the caller can report.
 */
export async function stopOwnedChild(child) {
  try {
    const result = await child.stop()
    if (result !== undefined && result !== null && result.ok === false)
      return { ok: false, reason: result.reason ?? 'the owned child did not terminate' }
    return { ok: true, reason: 'the owned child terminated' }
  } catch (error) {
    return {
      ok: false,
      reason: `the owned child could not be stopped: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Runs the probe.
 *
 * Every dependency is injected, so the negative paths are deterministic and
 * no process is ever launched by the test suite unless the case asks for it.
 */
export async function runStartupBudgetProbe(options) {
  const {
    spawnChild,
    probeReady,
    listenerPids,
    parentOf,
    sampleRss,
    sleep,
    now,
    readyTimeoutMs,
    probeAddress = '127.0.0.1',
    onFailure,
  } = options

  const failure = (reason, cleanup = { ok: true, reason: 'nothing was launched' }) => {
    if (typeof onFailure === 'function') onFailure(reason, cleanup)
    return { ok: false, reason, cleanup }
  }

  // An unrelated listener on the port is refused before anything is started:
  // its readiness would otherwise be measured as the application's own. When
  // the ownership check cannot be made at all, the probe fails closed too.
  let before
  try {
    before = listenerPids()
  } catch (error) {
    return failure(
      `the listener ownership check is unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (before.length > 0)
    return failure(
      `the port is already in use by ${before.map((listener) => listener.pid).join(', ')}; refusing to measure an unrelated listener`
    )

  let child
  try {
    child = spawnChild()
  } catch (error) {
    return failure(
      `the application could not be launched: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (child === undefined || child === null) return failure('the application could not be launched')

  // From here the child EXISTS: every exit path owns its cleanup.
  let primary = null
  let readySeconds
  let peakRssMb
  let cleanup
  try {
    const launchFailure = typeof child.spawnError === 'function' ? child.spawnError() : undefined
    if (launchFailure !== undefined && launchFailure !== null) {
      primary = `the application could not be launched: ${launchFailure.message ?? String(launchFailure)}`
    } else if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      // A failed spawn reports its error asynchronously: give the error event
      // a chance to arrive before deciding that the launch produced no PID.
      await sleep(50)
      const lateLaunchFailure =
        typeof child.spawnError === 'function' ? child.spawnError() : undefined
      primary =
        lateLaunchFailure !== undefined && lateLaunchFailure !== null
          ? `the application could not be launched: ${lateLaunchFailure.message ?? String(lateLaunchFailure)}`
          : 'the launched application has no PID'
    } else {
      const startedAt = now()
      for (;;) {
        await sleep(READY_POLL_INTERVAL_MS)
        const lateSpawnFailure =
          typeof child.spawnError === 'function' ? child.spawnError() : undefined
        if (lateSpawnFailure !== undefined && lateSpawnFailure !== null) {
          primary = `the application could not be launched: ${lateSpawnFailure.message ?? String(lateSpawnFailure)}`
          break
        }
        const ready = await probeReady()
        if (ready.ok) {
          // The READINESS OBSERVATION is timestamped BEFORE the ownership
          // inspection. The inspection validates that observation; it is not
          // part of it, so a slow inspection must not inflate the measured
          // time-to-ready. The observation is ACCEPTED only once the validation
          // passes: an unvalidated observation is never reported.
          const observedReadyAt = now()
          const listeners = listenerPids()
          const classification = assessListenerOwnership({
            listeners,
            childPid: child.pid,
            parentOf,
            probeAddress,
          })
          if (!classification.owned) {
            primary = `the readiness came from a listener that is not the launched child: ${classification.reason}`
            break
          }
          readySeconds = Math.round(((observedReadyAt - startedAt) / 1000) * 10) / 10
          break
        }
        if (child.hasExited()) {
          primary = 'the launched application exited before it became ready'
          break
        }
        if (now() - startedAt > readyTimeoutMs) {
          primary = 'the launched application never became ready'
          break
        }
      }
      if (primary === null) {
        const samples = []
        for (let sample = 0; sample < 5; sample += 1) {
          samples.push(parseRssSample(sampleRss(child.pid)))
          await sleep(200)
        }
        const rss = assessRssSamples(samples)
        if (!rss.ok) primary = rss.reason
        else peakRssMb = rss.peakMb
      }
    }
  } catch (error) {
    primary = `the probe failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    // The OWNED child is always cleaned up, on every path. The cleanup result
    // is reported next to the primary failure rather than in place of it.
    cleanup = await stopOwnedChild(child)
  }
  if (primary !== null) {
    if (typeof onFailure === 'function') onFailure(primary, cleanup)
    return { ok: false, reason: primary, cleanup }
  }
  if (!cleanup.ok) {
    const reason = `the launched application did not terminate cleanly: ${cleanup.reason}`
    if (typeof onFailure === 'function') onFailure(reason, cleanup)
    return { ok: false, reason, cleanup }
  }
  return { ok: true, readySeconds, peakRssMb, cleanup }
}

/**
 * The real RSS sample command.
 *
 * The sample is a subprocess, so it is bounded: a `ps` that stalls is
 * abandoned rather than held open, and the stalled sample is REFUSED by
 * `parseRssSample` — a sample that never came back is not a small process.
 */
export function psRss(pid, { timeoutMs = INSPECTION_TIMEOUT_MS, env } = {}) {
  return spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    ...(env === undefined ? {} : { env }),
  })
}

/**
 * The real parent-PID lookup, used by the listener ownership walk.
 *
 * The lookup is a subprocess, so it is bounded. A lookup that times out
 * FAILS CLOSED by throwing: the ownership walk cannot attribute the listener
 * without it, and an unowned listener is refused rather than assumed.
 */
export function psParent(pid, { timeoutMs = INSPECTION_TIMEOUT_MS, env } = {}) {
  const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    ...(env === undefined ? {} : { env }),
  })
  if (result.error !== undefined && result.error !== null) {
    if (result.error.code === 'ETIMEDOUT')
      throw new Error(`the ps ownership inspection timed out after ${String(timeoutMs)} ms`)
    return undefined
  }
  if (result.status !== 0) return undefined
  const text = String(result.stdout ?? '').trim()
  if (!/^\d+$/u.test(text)) return undefined
  return Number.parseInt(text, 10)
}

/**
 * The real listener lookup.
 *
 * It returns one entry per listening socket — `{ pid, address }` — because a
 * port can be listened on at several local addresses at once, and the
 * ownership decision needs every one of them.
 *
 * The lookup is a subprocess, so it is bounded: an `lsof` that stalls is
 * abandoned and the inspection FAILS CLOSED. An unusable `lsof` is an
 * inability to prove ownership, so it throws and the probe fails closed rather
 * than measuring blind.
 */
export function readListenerPids(port, { timeoutMs = INSPECTION_TIMEOUT_MS, env } = {}) {
  const result = spawnSync('lsof', ['-nP', '-iTCP:' + String(port), '-sTCP:LISTEN', '-F', 'pn'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    ...(env === undefined ? {} : { env }),
  })
  if (result.error !== undefined && result.error !== null) {
    if (result.error.code === 'ETIMEDOUT')
      throw new Error(`the lsof ownership inspection timed out after ${String(timeoutMs)} ms`)
    throw new Error(`lsof could not be executed: ${result.error.message}`)
  }
  if (result.status !== 0) {
    // lsof exits 1 when nothing matches the filter; any other failure means
    // the ownership check cannot be made, so the probe must fail closed.
    if (result.status === 1 && String(result.stdout ?? '').trim() === '') return []
    throw new Error(`lsof failed with status ${String(result.status)}`)
  }
  const addressesByPid = new Map()
  let currentPid = null
  for (const line of String(result.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number.parseInt(line.slice(1).trim(), 10)
      currentPid = Number.isSafeInteger(pid) && pid > 0 ? pid : null
      if (currentPid !== null && !addressesByPid.has(currentPid)) addressesByPid.set(currentPid, [])
    } else if (line.startsWith('n') && currentPid !== null) {
      addressesByPid.get(currentPid).push(line.slice(1).trim())
    }
  }
  const listeners = []
  for (const [pid, addresses] of addressesByPid) {
    if (addresses.length === 0) {
      // A listener whose address could not be read is reported, never dropped:
      // the ownership check refuses the set rather than ignoring it.
      listeners.push({ pid, address: 'unknown' })
      continue
    }
    for (const address of addresses) listeners.push({ pid, address })
  }
  return listeners
}

/**
 * Wraps a spawned process in the OWNED child handle the probe contracts for.
 *
 * This is the production handle: the repository entry point and the tests
 * both use it, so the lifecycle the tests exercise cannot drift from the
 * lifecycle the probe ships. The handle reports the asynchronous spawn
 * error, knows whether the child has exited, and stops the child with a
 * bounded, awaited teardown that verifies the ACTUAL termination.
 */
export function createOwnedChildHandle(proc, { graceMs = CLEANUP_GRACE_MS } = {}) {
  let spawnError
  proc.on('error', (error) => {
    spawnError = error
  })
  let exited = false
  proc.once('exit', () => {
    exited = true
  })
  return {
    pid: proc.pid,
    spawnError: () => spawnError,
    hasExited: () => exited || proc.exitCode !== null || proc.signalCode !== null,
    stop: async () => {
      // A spawn that never produced a process has nothing to terminate.
      if (spawnError !== undefined || proc.pid === undefined)
        return { ok: true, reason: 'the application never started' }
      if (exited || proc.exitCode !== null || proc.signalCode !== null)
        return { ok: true, reason: 'the owned child had already exited' }
      try {
        proc.kill('SIGTERM')
      } catch {
        // The child is already gone: the exit is awaited below.
      }
      if (await waitForExit(proc, graceMs))
        return { ok: true, reason: 'the owned child exited after SIGTERM' }
      try {
        proc.kill('SIGKILL')
      } catch {
        // The child is already gone: the exit is awaited below.
      }
      if (await waitForExit(proc, graceMs))
        return { ok: true, reason: 'the owned child exited after SIGKILL' }
      return { ok: false, reason: 'the owned child did not exit after SIGKILL' }
    },
  }
}

/** Waits for a process to actually exit, bounded. */
export function waitForExit(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      proc.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    proc.once('exit', onExit)
  })
}
