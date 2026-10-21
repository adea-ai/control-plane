import { spawn, spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

// M13 #405 startup/RSS budget probe: boots a built app, measures cold-start
// time to /ready and the main-process peak RSS at idle, and compares both
// against budgets.json. Reproducible anywhere the app is built; not wired
// into CI by default (developer hosts are too contended for a hard gate).
//
// The probe FAILS CLOSED. It refuses to report a measurement it does not
// have:
//   - a port that is already in use is an unrelated listener, so the probe
//     refuses to start rather than measuring somebody else's readiness;
//   - readiness is only accepted once the listener on the port is proved to
//     belong to the launched child (or a descendant of it);
//   - a child that exits early, a missing PID or a failed spawn fails the
//     probe instead of waiting out the deadline;
//   - a malformed, empty or unsuccessful `ps` sample is refused, and a run with
//     no valid RSS sample is a failure, not a zero-megabyte pass;
//   - the cleanup awaits the OWNED child's exit, and only the child this probe
//     spawned is ever signalled.
//
// usage: bun scripts/check-startup-budget.mjs [appName] [port]
//   appName defaults to local-control-plane; port defaults to 3917.

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

/** How long the probe waits for the owned child to become ready. */
export const READY_POLL_INTERVAL_MS = 100
/** How long the probe waits for the owned child to exit after a signal. */
export const CLEANUP_GRACE_MS = 5_000

/**
 * Parses one `ps -o rss=` sample.
 *
 * A sample is valid only when the command succeeded and printed a positive
 * whole number of kilobytes. An unsuccessful, empty, malformed or zero
 * sample is REFUSED: it is evidence of a broken measurement, not evidence of
 * a small process.
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
    return { owned: false, reason: 'the listener PID could not be determined' }
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
 * Every sample must be valid: one refused sample fails the measurement
 * rather than being dropped, and a run with no valid sample is a failure —
 * never a zero-megabyte pass.
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

function psRss(pid) {
  return spawnSync('ps', ['-o', 'rss=', '-p', String(pid)])
}

function psParent(pid) {
  const result = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)])
  if (result.status !== 0) return undefined
  const text = String(result.stdout ?? '').trim()
  if (!/^\d+$/u.test(text)) return undefined
  return Number.parseInt(text, 10)
}

function readListenerPids(port) {
  const result = spawnSync('lsof', ['-nP', '-iTCP:' + String(port), '-sTCP:LISTEN', '-F', 'p'], {
    encoding: 'utf8',
  })
  if (result.status !== 0) return []
  return String(result.stdout ?? '')
    .split('\n')
    .filter((line) => line.startsWith('p'))
    .map((line) => Number.parseInt(line.slice(1).trim(), 10))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

/**
 * Runs the probe.
 *
 * Every dependency is injectable so the negative paths are deterministic and
 * no process is ever launched by the test suite.
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

  const fail = (reason) => {
    if (typeof onFailure === 'function') onFailure(reason)
    return { ok: false, reason }
  }

  // An unrelated listener on the port is refused before anything is started:
  // its readiness would otherwise be measured as the application's own.
  const before = listenerPids()
  if (before.length > 0)
    return fail(
      `the port is already in use by ${before.join(', ')}; refusing to measure an unrelated listener`
    )

  const child = spawnChild()
  if (child === undefined || child === null) return fail('the application could not be launched')
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0)
    return fail('the launched application has no PID')

  const startedAt = now()
  let readySeconds
  for (;;) {
    await sleep(READY_POLL_INTERVAL_MS)
    const ready = await probeReady()
    if (ready.ok) {
      const listeners = listenerPids()
      const classification = classifyListener({
        listenerPid: listeners[0],
        childPid: child.pid,
        parentOf,
      })
      if (!classification.owned)
        return fail(
          `the readiness came from a listener that is not the launched child: ${classification.reason}`
        )
      readySeconds = Math.round(((now() - startedAt) / 1000) * 10) / 10
      break
    }
    if (child.hasExited()) return fail('the launched application exited before it became ready')
    if (now() - startedAt > readyTimeoutMs)
      return fail('the launched application never became ready')
  }

  const samples = []
  for (let sample = 0; sample < 5; sample += 1) {
    samples.push(parseRssSample(sampleRss(child.pid)))
    await sleep(200)
  }
  const rss = assessRssSamples(samples)
  if (!rss.ok) return fail(rss.reason)

  // The cleanup signals ONLY the child this probe spawned, and waits for it.
  await child.stop()

  return { ok: true, readySeconds, peakRssMb: rss.peakMb }
}

if (import.meta.main) {
  const appName = process.argv[2] ?? 'local-control-plane'
  const port = Number(process.argv[3] ?? 3917)
  const budgets = JSON.parse(await readFile(new URL('../budgets.json', import.meta.url), 'utf8'))

  const readyCeilingSeconds = budgets.startup?.localAllInOneReadySecondsCeiling
  const rssCeilingMb = budgets.rss?.localAllInOnePeakMbCeiling
  if (!Number.isFinite(readyCeilingSeconds) || !Number.isFinite(rssCeilingMb)) {
    console.error('budgets.json is missing startup/rss ceilings')
    process.exit(2)
  }

  const entrypoint = fileURLToPath(new URL(`../apps/${appName}/dist/start.js`, import.meta.url))
  let child
  const spawnChild = () => {
    child = spawn(process.execPath, [entrypoint], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        APP_ENV: 'development',
        CONTROL_PLANE_BIND_HOST: '127.0.0.1',
        ...(process.env.DATABASE_URL === undefined
          ? { CONTROL_PLANE_DEPLOYMENT_PROFILE: 'local' }
          : {}),
        PORT: String(port),
        LOCAL_CONTROL_PLANE_PORT: String(port),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    return {
      pid: child.pid,
      hasExited: () => child.exitCode !== null || child.signalCode !== null,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill('SIGTERM')
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            resolve()
          }, CLEANUP_GRACE_MS)
          child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      },
    }
  }

  const outcome = await runStartupBudgetProbe({
    spawnChild,
    probeReady: async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/ready`, {
          signal: AbortSignal.timeout(900),
        })
        return { ok: response.ok }
      } catch {
        return { ok: false }
      }
    },
    listenerPids: () => readListenerPids(port),
    parentOf: psParent,
    sampleRss: psRss,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    readyTimeoutMs: readyCeilingSeconds * 2_000,
    cleanupGraceMs: CLEANUP_GRACE_MS,
    onFailure: (reason) => console.error(`BUDGET EXCEEDED / FAILED: ${reason}`),
  })

  if (!outcome.ok) process.exit(1)

  const results = [
    {
      check: 'startup-ready-seconds',
      measured: outcome.readySeconds,
      ceiling: readyCeilingSeconds,
      ok: outcome.readySeconds <= readyCeilingSeconds,
    },
    {
      check: 'idle-peak-rss-mb',
      measured: outcome.peakRssMb,
      ceiling: rssCeilingMb,
      ok: outcome.peakRssMb <= rssCeilingMb,
    },
  ]
  let failed = false
  for (const result of results) {
    console.log(`${result.ok ? 'OK' : 'BUDGET EXCEEDED'}: ${JSON.stringify(result)}`)
    if (!result.ok) failed = true
  }
  process.exit(failed ? 1 : 0)
}
