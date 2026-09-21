import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

// M13 #405 startup/RSS budget probe: boots a built app, measures cold-start
// time to /ready and the main-process peak RSS at idle, and compares both
// against budgets.json. Reproducible anywhere the app is built; not wired
// into CI by default (developer hosts are too contended for a hard gate).
//
// usage: bun scripts/check-startup-budget.mjs [appName] [port]
//   appName defaults to local-control-plane; port defaults to 3917.

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
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
const child = spawn(process.execPath, [entrypoint], {
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

const startedAt = Date.now()
let readySeconds
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  try {
    const response = await fetch(`http://127.0.0.1:${port}/ready`, {
      signal: AbortSignal.timeout(900),
    })
    if (response.ok) {
      readySeconds = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10
      break
    }
  } catch {
    // not ready yet
  }
  if (child.exitCode !== null || Date.now() - startedAt > readyCeilingSeconds * 2_000) {
    console.error(`BUDGET EXCEEDED / FAILED: ${appName} never became ready`)
    child.kill('SIGKILL')
    process.exit(1)
  }
}

// Sample RSS a few times at idle; the max is the "peak at idle" figure.
let peakRssMb = 0
for (let sample = 0; sample < 5; sample += 1) {
  const result = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(child.pid)])
  const rssKb = Number.parseInt(result.stdout.toString().trim(), 10)
  if (Number.isFinite(rssKb) && rssKb / 1024 > peakRssMb)
    peakRssMb = Math.round((rssKb / 1024) * 10) / 10
  await new Promise((resolve) => setTimeout(resolve, 200))
}

child.kill('SIGTERM')

const results = [
  {
    check: 'startup-ready-seconds',
    measured: readySeconds,
    ceiling: readyCeilingSeconds,
    ok: readySeconds <= readyCeilingSeconds,
  },
  {
    check: 'idle-peak-rss-mb',
    measured: peakRssMb,
    ceiling: rssCeilingMb,
    ok: peakRssMb <= rssCeilingMb,
  },
]
let failed = false
for (const result of results) {
  console.log(`${result.ok ? 'OK' : 'BUDGET EXCEEDED'}: ${JSON.stringify(result)}`)
  if (!result.ok) failed = true
}
process.exit(failed ? 1 : 0)
