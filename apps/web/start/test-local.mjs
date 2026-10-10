import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { createServer } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createLoopbackCertificate } from './loopback-tls.mjs'
import { writeLocalWorkerConfig } from './local-worker-config.mjs'
import { captureCommand, runWithPullBackoff } from '../../../scripts/docker-pull-backoff.mjs'

const start = fileURLToPath(new URL('.', import.meta.url))
const web = resolve(start, '..')
const root = resolve(web, '../..')
if (process.platform === 'win32') throw new Error('Local Worker checks require macOS or Linux')
await mkdir(resolve(start, '.checks'), { recursive: true })
const evidence = await mkdtemp(resolve(start, '.checks/local-'))
const tls = createLoopbackCertificate(evidence)
const project = `adea-start-check-${process.pid}`
const workers = []
// Do not inherit production service credentials or database URLs into test processes.
const environment = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'CI', 'PLAYWRIGHT_BROWSERS_PATH']
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]])
)
Object.assign(environment, { WRANGLER_SEND_METRICS: 'false' })
let databaseStarted = false
const ports = new Set()
async function availablePort() {
  while (true) {
    const server = createServer()
    await new Promise((ok, fail) => {
      server.once('error', fail)
      server.listen(0, '127.0.0.1', ok)
    })
    const port = server.address().port
    await new Promise((ok, fail) => server.close((error) => (error ? fail(error) : ok())))
    if (!ports.has(port)) {
      ports.add(port)
      return port
    }
  }
}
function run(command, args, cwd = root, env = environment) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
    child.once('error', fail)
    child.once('exit', (code) =>
      code === 0 ? ok() : fail(new Error(`${command} ${args.join(' ')} exited ${code}`))
    )
  })
}
// The compose file pins postgres by digest, but the pull still goes to a shared
// registry that rate-limits anonymous pulls from hosted runners. The attempt is
// asynchronous so the worker and cleanup process handling keeps running while compose
// waits. Each attempt's output is echoed once it settles, so a rate-limited attempt
// stays visible in the log.
async function composeUpPostgres() {
  const args = [
    'compose',
    '-p',
    project,
    '-f',
    'compose.yml',
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '60',
    'postgres',
  ]
  const result = await runWithPullBackoff(async () => {
    const attempt = await captureCommand('docker', args, { cwd: root, env: databaseEnvironment })
    if (attempt.stdout) process.stdout.write(attempt.stdout)
    if (attempt.stderr) process.stderr.write(attempt.stderr)
    return attempt
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} exited ${String(result.status)}`)
  }
}
function startWorker(config, port, inspector, secure = false) {
  const log = createWriteStream(resolve(evidence, `worker-${port}.log`))
  const args = [
    'x',
    'wrangler',
    'dev',
    '--local',
    '--config',
    config,
    '--port',
    String(port),
    '--inspector-port',
    String(inspector),
    '--persist-to',
    resolve(evidence, `state-${port}`),
  ]
  if (secure)
    args.push(
      '--local-protocol',
      'https',
      '--https-cert-path',
      tls.certPath,
      '--https-key-path',
      tls.keyPath
    )
  const child = spawn('bun', args, {
    cwd: web,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.on('error', (error) => log.write(String(error)))
  workers.push(child)
  return child
}
function localHttps(url, method = 'GET') {
  // This helper is only called with the loopback URLs allocated by this
  // process, and only trusts the certificate minted for this run.
  assert.equal(new URL(url).hostname, '127.0.0.1')
  return new Promise((ok, fail) => {
    const request = httpsRequest(url, { method, ca: tls.certificate }, (response) => {
      response.resume()
      response.once('end', () => ok({ status: response.statusCode, headers: response.headers }))
    })
    request.setTimeout(10_000, () => request.destroy(new Error('Local request timed out')))
    request.once('error', fail)
    request.end()
  })
}
async function waitFor(probe, label) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      if (await probe()) return
    } catch {}
    await delay(250)
  }
  throw new Error(`${label} did not become ready; inspect ${evidence}`)
}
function stopWorker(child) {
  if (!child.pid || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
const [databasePort, hostPort, inspector] = await Promise.all(
  Array.from({ length: 3 }, availablePort)
)
const baseURL = `https://127.0.0.1:${hostPort}`
const generatedPath = resolve(web, 'dist/server/wrangler.json')
const built = JSON.parse(await readFile(generatedPath, 'utf8'))
const compatibility = {
  compatibility_date: '2026-08-01',
  compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
}
const databaseUrl = (role) =>
  `postgresql://${role}:${role}@127.0.0.1:${databasePort}/agent_hq?sslmode=disable`
const databaseEnvironment = {
  ...environment,
  DATABASE_URL: databaseUrl('agent_hq_local_app'),
  DATABASE_URL_UNPOOLED: databaseUrl('agent_hq_local_app'),
  DATABASE_MIGRATION_URL: databaseUrl('agent_hq_local_migration'),
  ADEA_POSTGRES_PORT: String(databasePort),
}
const host = {
  ...compatibility,
  name: `${project}-host`,
  main: resolve(dirname(generatedPath), built.main),
  rules: built.rules,
  no_bundle: true,
  assets: { ...built.assets, directory: resolve(dirname(generatedPath), built.assets.directory) },
  hyperdrive: [
    {
      binding: 'HYPERDRIVE',
      id: 'local',
      localConnectionString: databaseUrl('agent_hq_local_app'),
    },
  ],
  vars: {
    DATABASE_URL: databaseEnvironment.DATABASE_URL,
    AUTH_TRUSTED_ORIGINS: baseURL,
  },
}
const hostConfig = resolve(evidence, 'host.json')
await writeLocalWorkerConfig(hostConfig, host)
try {
  databaseStarted = true
  await composeUpPostgres()
  await run('bun', ['run', '--cwd', 'packages/db', 'db:verify'], root, databaseEnvironment)
  startWorker(hostConfig, hostPort, inspector, true)
  const entryStatus = async () => (await localHttps(`${baseURL}/api/web-entry`)).status
  await waitFor(async () => (await localHttps(baseURL)).status === 200, 'Start host')
  assert.equal(await entryStatus(), 200, 'entry gate endpoint serves the policy')
  await run('bun', ['run', 'start:e2e'], web, {
    ...environment,
    ADEA_START_PREVIEW_URL: baseURL,
    ADEA_START_ISOLATED_TEST_TARGET: '1',
  })
  // Exercise the actual entry policy after enabling the account allowlist.
  host.vars.ADEA_ALLOWED_EMAILS = 'allowed@example.test'
  await writeLocalWorkerConfig(hostConfig, host)
  await waitFor(async () => (await entryStatus()) === 401, 'Restricted entry gate')
  const restricted = await localHttps(baseURL)
  assert.equal(restricted.status, 307)
  // A signed-out visitor is sent to sign-in with the requested destination
  // preserved, so a deep link survives authenticating.
  const signInRedirect = new URL(restricted.headers.location, baseURL)
  assert.equal(signInRedirect.pathname, '/auth/sign-in')
  assert.equal(signInRedirect.searchParams.get('returnTo'), '/')
  const deepLink = await localHttps(`${baseURL}/?view=chat&scene=home`)
  assert.equal(deepLink.status, 307)
  const deepRedirect = new URL(deepLink.headers.location, baseURL)
  assert.equal(deepRedirect.pathname, '/auth/sign-in')
  assert.equal(deepRedirect.searchParams.get('returnTo'), '/?view=chat&scene=home')
  assert.equal((await localHttps(`${baseURL}/api/workspaces/bootstrap`, 'POST')).status, 401)
  delete host.vars.ADEA_ALLOWED_EMAILS
  await writeLocalWorkerConfig(hostConfig, host)
  await waitFor(async () => (await entryStatus()) === 200, 'Restored guest gate')
  const report = {
    browserSuite: 'passed',
    restrictedEntry: 'passed',
    restrictedGuestApi: 'passed',
    node: process.version,
  }
  await writeFile(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ ...report, evidence }))
} finally {
  for (const worker of workers) stopWorker(worker)
  await delay(500)
  if (databaseStarted) {
    // This project and volume were created by this process, never the user's dev database.
    await run(
      'docker',
      ['compose', '-p', project, '-f', 'compose.yml', 'down', '--volumes'],
      root,
      databaseEnvironment
    )
  }
}
