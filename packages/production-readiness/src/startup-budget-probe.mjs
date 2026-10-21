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
//   - a child that exits early, a missing PID, a failed spawn or a thrown
//     dependency fails the probe;
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
 * Parses one `ps -o rss=` sample.
 *
 * A sample is valid only when the command succeeded and printed a positive
 * whole number of kilobytes. An unsuccessful, empty, malformed or zero sample
 * is REFUSED: it is evidence of a broken measurement, not evidence of a small
 * process.
 */
export function parseRssSample(result) {
  if (result === undefined || result === null) return { ok: false, reason: 'no sample was taken' }
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
      `the port is already in use by ${before.join(', ')}; refusing to measure an unrelated listener`
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
          const listeners = listenerPids()
          const classification = classifyListener({
            listenerPid: listeners[0],
            childPid: child.pid,
            parentOf,
          })
          if (!classification.owned) {
            primary = `the readiness came from a listener that is not the launched child: ${classification.reason}`
            break
          }
          readySeconds = Math.round(((now() - startedAt) / 1000) * 10) / 10
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

/** The real RSS sample command. */
export function psRss(pid) {
  return spawnSync('ps', ['-o', 'rss=', '-p', String(pid)])
}

/** The real parent-PID lookup, used by the listener ownership walk. */
export function psParent(pid) {
  const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)])
  if (result.status !== 0) return undefined
  const text = String(result.stdout ?? '').trim()
  if (!/^\d+$/u.test(text)) return undefined
  return Number.parseInt(text, 10)
}

/**
 * The real listener lookup.
 *
 * An unusable `lsof` is an inability to prove ownership, so it throws and the
 * probe fails closed rather than measuring blind.
 */
export function readListenerPids(port) {
  const result = spawnSync('lsof', ['-nP', '-iTCP:' + String(port), '-sTCP:LISTEN', '-F', 'p'], {
    encoding: 'utf8',
  })
  if (result.error !== undefined && result.error !== null)
    throw new Error(`lsof could not be executed: ${result.error.message}`)
  if (result.status !== 0) {
    // lsof exits 1 when nothing matches the filter; any other failure means
    // the ownership check cannot be made, so the probe must fail closed.
    if (result.status === 1 && String(result.stdout ?? '').trim() === '') return []
    throw new Error(`lsof failed with status ${String(result.status)}`)
  }
  return String(result.stdout ?? '')
    .split('\n')
    .filter((line) => line.startsWith('p'))
    .map((line) => Number.parseInt(line.slice(1).trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
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
