import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

// M13 #405 startup/RSS budget probe: boots a built app, measures cold-start
// time to /ready and the main-process peak RSS at idle, and compares both
// against budgets.json. Reproducible anywhere the app is built; not wired
// into CI by default (developer hosts are too contended for a hard gate).
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
// The measurement rules live in the production-readiness package so the
// package's tests can exercise them without crossing a workspace boundary;
// this file is the repository entry point.
//
// usage: bun scripts/check-startup-budget.mjs [appName] [port]
//   appName defaults to local-control-plane; port defaults to 3917.

import {
  createOwnedChildHandle,
  psParent,
  psRss,
  readListenerPids,
  runStartupBudgetProbe,
} from '../packages/production-readiness/src/startup-budget-probe.mjs'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

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
  const spawnChild = () => {
    const proc = spawn(process.execPath, [entrypoint], {
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
    // The PRODUCTION owned-child handle: the same contract the package's
    // tests exercise, so the entry point and the tests cannot diverge.
    return createOwnedChildHandle(proc)
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
    // The readiness probe talks to the IPv4 loopback, so the ownership check
    // is made about that address.
    probeAddress: '127.0.0.1',
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    readyTimeoutMs: readyCeilingSeconds * 2_000,
    onFailure: (reason, cleanup) => {
      console.error(`BUDGET EXCEEDED / FAILED: ${reason}`)
      if (cleanup !== undefined && cleanup.ok === false)
        console.error(`CLEANUP FAILED: ${cleanup.reason}`)
    },
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
