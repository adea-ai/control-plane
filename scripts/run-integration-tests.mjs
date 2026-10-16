import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { postgresImageVariable } from './docker-pull-backoff.mjs'
import { pullPostgresImage } from './pull-postgres-image.mjs'
import {
  INTEGRATION_SHARD_IDS,
  integrationFileArguments,
  parseIntegrationShard,
  selectIntegrationShard,
} from './integration-shards.mjs'

// Keep the documented production-like command visible to repository policy tests.
const COMPOSE_COMMAND = 'docker compose'

// `--shard=<n>` (or INTEGRATION_SHARD) runs one explicit slice of the suite.
// The local PR lane runs all three inventory-checked slices concurrently
// against one runner-owned disposable PostgreSQL service. Trusted-main Neon
// verification does not invoke this full portable integration suite.
const integrationShard = parseIntegrationShard(
  process.argv.find((argument) => argument.startsWith('--shard='))?.slice('--shard='.length) ??
    process.env.INTEGRATION_SHARD
)
if (integrationShard !== null) {
  console.log(`Running integration shard ${integrationShard} of the partitioned suite.`)
}

const CHILD_COMMAND_TIMEOUT_MS = 90_000

// Runner-owned children stay in the runner's own process group. They are
// recorded here so an interruption signals only them, and they also share the
// runner's group so a supervising group termination reaps them rather than
// leaving orphans. The runner never looks up or kills processes by name.
const activeChildren = new Set()

function trackRunnerChild(child) {
  activeChildren.add(child)
  const release = () => activeChildren.delete(child)
  child.once('close', release)
  child.once('error', release)
  return child
}

function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function terminateActiveChildren() {
  // process.kill is synchronous and releases children only on a later event-loop
  // turn, so the live set is safe to iterate here.
  for (const child of activeChildren) terminateChild(child)
}

function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    // A first signal stops the run from starting new work. Only the shared
    // cleanup passes allowInterrupted, so it can still release owned resources.
    // The check and the synchronous spawn share one event-loop turn, so no
    // child can slip in between the guard and being tracked for reaping.
    if (interruptedSignal !== null && options.allowInterrupted !== true) {
      reject(new Error(`${command} not started: integration run interrupted`))
      return
    }
    const child = trackRunnerChild(
      spawn(command, arguments_, {
        cwd: options.cwd ?? process.cwd(),
        env: options.environment ?? runnerEnvironment,
        stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      })
    )
    let stdout = ''
    let stderr = ''
    if (options.capture) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
    }
    const timeout = options.timeout ?? (command === 'docker' ? CHILD_COMMAND_TIMEOUT_MS : undefined)
    const timer =
      timeout === undefined ? undefined : setTimeout(() => terminateChild(child), timeout)
    timer?.unref()
    let settled = false
    const settle = (complete, value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      complete(value)
    }
    child.once('error', (error) => settle(reject, error))
    child.once('close', (status) => {
      if (status === 0) {
        settle(resolve, stdout)
        return
      }
      if (options.capture && stderr) process.stderr.write(stderr)
      settle(reject, new Error(`${command} exited with status ${String(status)}`))
    })
  })
}

// Retry only the digest-pinned image pull. Container startup and health checks
// run once, so a startup failure cannot be hidden by repeating `compose up`.
async function composeUpPostgres() {
  if (interruptedSignal !== null) throw new Error('Integration startup interrupted')
  const { image } = await pullPostgresImage({ environment: runnerEnvironment })
  // A rate-limited registry falls over to the same digest elsewhere; compose then has to
  // start the image that is now present locally, here and in every later compose command.
  if (image !== undefined) runnerEnvironment[postgresImageVariable] = image
  if (interruptedSignal !== null) throw new Error('Integration startup interrupted')
  await run('docker', ['compose', 'up', '-d', '--wait', 'postgres'], {
    environment: runnerEnvironment,
  })
}

const MAX_OUTPUT_TAIL_BYTES = 16 * 1024

function appendBoundedOutputTail(current, chunk, maxBytes = MAX_OUTPUT_TAIL_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError('Output tail byte limit must be a non-negative safe integer')
  }
  const combined = Buffer.concat([Buffer.from(current), Buffer.from(chunk)])
  if (combined.length <= maxBytes) return combined.toString('utf8')

  let start = combined.length - maxBytes
  while (start < combined.length && (combined[start] & 0xc0) === 0x80) start += 1
  return combined.subarray(start).toString('utf8')
}

function runStreaming(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    if (interruptedSignal !== null && options.allowInterrupted !== true) {
      reject(new Error(`${command} not started: integration run interrupted`))
      return
    }
    const child = trackRunnerChild(
      spawn(command, arguments_, {
        cwd: options.cwd ?? process.cwd(),
        env: options.environment ?? runnerEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    )
    let stdoutTail = ''
    let stderrTail = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutTail = appendBoundedOutputTail(stdoutTail, chunk)
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrTail = appendBoundedOutputTail(stderrTail, chunk)
      process.stderr.write(chunk)
    })
    child.once('error', reject)
    child.once('close', (status, signal) => resolve({ status, signal, stdoutTail, stderrTail }))
  })
}

function formatStreamingFailure(result) {
  const tails = []
  if (result.stdoutTail)
    tails.push(`stdout tail (max ${MAX_OUTPUT_TAIL_BYTES} bytes):\n${result.stdoutTail}`)
  if (result.stderrTail)
    tails.push(`stderr tail (max ${MAX_OUTPUT_TAIL_BYTES} bytes):\n${result.stderrTail}`)
  return tails.length === 0 ? '' : `\nBounded output diagnostics:\n${tails.join('\n')}`
}

async function runIntegrationFileStreaming(testArguments, options) {
  const result = await runStreaming('bun', testArguments, options)
  if (result.status === 0) return
  throw new Error(
    `bun test exited with status ${String(result.status)}${formatStreamingFailure(result)}`
  )
}

async function runIntegrationShardStreaming(shard, integrationEnvironment, remoteDatabase) {
  const perTestTimeoutMs = remoteDatabase ? '120000' : '30000'
  for (const group of selectIntegrationShard(shard)) {
    for (const file of group.files) {
      const testArguments = integrationFileArguments(group, file, perTestTimeoutMs)
      await runIntegrationFileStreaming(testArguments, {
        cwd: group.package,
        environment: integrationEnvironment,
      })
    }
  }
}

async function runLocalIntegrationShards(integrationEnvironment) {
  const results = await Promise.allSettled(
    INTEGRATION_SHARD_IDS.map(async (shard) => {
      console.log(`Local PostgreSQL integration shard ${shard} starting.`)
      await runIntegrationShardStreaming(shard, integrationEnvironment, false)
    })
  )
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [
          new Error(`Local PostgreSQL integration shard ${INTEGRATION_SHARD_IDS[index]} failed`, {
            cause: result.reason,
          }),
        ]
      : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more local PostgreSQL integration shards failed')
  }
}

async function waitForPostgres(isInterrupted = () => false) {
  const deadline = Date.now() + 30_000
  const readinessCommand = [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '--username',
    'control_plane_admin',
    '--dbname',
    'postgres',
    '--tuples-only',
    '--no-align',
    '--command',
    'SELECT 1',
  ]

  while (Date.now() < deadline) {
    if (isInterrupted()) throw new Error('PostgreSQL readiness probe interrupted')
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const result = spawnSync('docker', readinessCommand, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
      env: runnerEnvironment,
      timeout: Math.min(5000, remaining),
    })
    if (result.error) {
      // A signal delivered while spawnSync held the event loop cannot run until
      // the loop regains control; yield one macrotask so a pending interruption
      // is observed instead of surfacing as a probe timeout.
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (isInterrupted()) throw new Error('PostgreSQL readiness probe interrupted')
      throw result.error
    }
    if (result.status === 0 && result.stdout.trim() === '1') {
      console.log('PostgreSQL database system is accepting SQL connections')
      return
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(500, Math.max(0, deadline - Date.now())))
    )
  }

  throw new Error('PostgreSQL did not accept SQL connections within 30 seconds')
}

// A remote target (Neon preview branch or similar) replaces the local Docker
// Postgres lane entirely: no container to boot or probe, and the
// Docker-lifecycle drills below do not apply to it. Loopback URLs still take
// the local lane: the recovery matrix drives its own Postgres on an
// ephemeral loopback port and passes those URLs down, so presence alone
// cannot distinguish remote from local.
function databaseHostname(value) {
  try {
    return new URL(value).hostname
  } catch {
    return ''
  }
}
function isLoopbackHostname(hostname) {
  return (
    hostname === '' ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}
const remoteDatabase = [process.env.DATABASE_URL, process.env.DATABASE_MIGRATION_URL]
  .filter((value) => value !== undefined)
  .some((value) => !isLoopbackHostname(databaseHostname(value)))

// Resolve and validate the remote lane before any Docker query. Remote CI and
// developer runs must work with no local engine installed or running.
if (remoteDatabase && !process.env.DATABASE_ADMIN_URL) {
  throw new Error(
    'Remote integration requires an explicit DATABASE_ADMIN_URL for isolated test databases'
  )
}
const runnerEnvironment = { ...process.env }
let postgresWasRunning = false
let ownsComposeProject = false
let startupAttempted = false
let verificationError
let cleanupError
let interruptedSignal = null
let cleanupPromise

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : 143
}

// Cleanup runs at most once and is shared by the normal path and an
// interruption. It removes only what the runner started: a freshly generated
// project's containers, network and volumes, or the caller project's
// PostgreSQL service. Never a shared project, cache or unrelated resource.
async function cleanupRunnerResources() {
  if (cleanupPromise !== undefined) return cleanupPromise
  cleanupPromise = (async () => {
    if (!startupAttempted) return
    try {
      if (ownsComposeProject) {
        await run(
          'docker',
          ['compose', 'down', '--volumes', '--remove-orphans', '--timeout', '60'],
          {
            allowInterrupted: true,
          }
        )
      } else {
        await run('docker', ['compose', 'stop', '--timeout', '60', 'postgres'], {
          allowInterrupted: true,
        })
      }
    } catch (error) {
      cleanupError = error
    }
  })()
  return cleanupPromise
}

// A first SIGINT/SIGTERM reaps only runner-owned child process groups and lets
// the shared cleanup path run once before the retained status is written. A
// second signal stops immediately with the signal's status. The original
// verification failure stays observable rather than being masked by the signal.
function handleInterruption(signal) {
  if (interruptedSignal !== null) {
    terminateActiveChildren()
    process.exit(signalExitCode(signal))
  }
  interruptedSignal = signal
  console.error(`Received ${signal}; stopping runner-owned commands and cleaning up.`)
  terminateActiveChildren()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => handleInterruption(signal))
}

// Last-resort synchronous reap for any still-tracked child on a normal or
// first-signal exit. A SIGKILL of the runner itself bypasses this, which is why
// runner-owned children also share the runner's process group.
process.on('exit', terminateActiveChildren)

async function main() {
  try {
    if (!remoteDatabase) {
      const runningServices = (
        await run('docker', ['compose', 'ps', '--status', 'running', '--services'], {
          capture: true,
        })
      )
        .split('\n')
        .filter(Boolean)
      postgresWasRunning = runningServices.includes('postgres')
      if (!postgresWasRunning) {
        // A caller's explicit project belongs to that caller (for example the
        // recovery matrix). Only our freshly generated project permits volume
        // deletion; never sweep another project or the shared Docker cache.
        if (!runnerEnvironment.COMPOSE_PROJECT_NAME) {
          ownsComposeProject = true
          const project = `control-plane-integration-${process.pid}-${randomUUID()}`
          runnerEnvironment.COMPOSE_PROJECT_NAME = project
          console.log(`Starting isolated integration PostgreSQL in project ${project}.`)
        } else {
          console.log('Starting integration PostgreSQL in the caller-owned project.')
        }
        startupAttempted = true
        await composeUpPostgres()
      }
    }
    if (!remoteDatabase) await waitForPostgres(() => interruptedSignal !== null)
    else console.log('Using remote database target from the environment.')
    const integrationEnvironment = {
      ...runnerEnvironment,
      DATABASE_ADMIN_URL:
        process.env.DATABASE_ADMIN_URL ??
        'postgresql://control_plane_admin:local-admin-only@127.0.0.1:54329/postgres',
      DATABASE_MIGRATION_URL:
        process.env.DATABASE_MIGRATION_URL ??
        'postgresql://control_plane_migrator:local-migration-only@127.0.0.1:54329/control_plane',
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://control_plane_app:local-application-only@127.0.0.1:54329/control_plane',
      RUN_DATABASE_INTEGRATION: 'true',
      // Suites scale their explicit per-test and per-hook budgets through
      // integrationTestTimeout(); an explicit bun test() timeout argument
      // always overrides the CLI --timeout default, so the ceiling has to
      // reach them through the environment.
      INTEGRATION_TEST_TIMEOUT_MS: remoteDatabase ? '120000' : undefined,
    }
    if (integrationShard === null && remoteDatabase) {
      // Preserve the full remote command for callers that do not select explicit
      // integration shards; trusted-main provider compatibility is a separate
      // bounded workflow and does not invoke this portable suite.
      await run(
        'bun',
        ['x', '--no-install', 'vp', 'run', '--concurrency=1', 'orch:test:integration'],
        {
          environment: integrationEnvironment,
        }
      )
      // Root-level scenarios import these workspace packages through their built entry
      // points. the package integration graph builds only the upstream packages of the
      // integration packages, so build the root's own imports before those scenarios run.
      await run('bun', ['x', '--no-install', 'vp', 'run', 'orch:build:integration-roots'], {
        environment: integrationEnvironment,
      })
      // Repository-owned scenarios span composition roots; keep their fixtures
      // outside individual workspace packages.
      await run(
        'bun',
        [
          'test',
          '--timeout',
          remoteDatabase ? '120000' : '30000',
          './tests/child-progress-scanner.integration.test.mjs',
          './tests/child-progress-sqlite-feed-replay.integration.test.mjs',
          './tests/memory-process-loss.integration.test.mjs',
          './tests/acp-remote-device-postgres.integration.test.mjs',
          './tests/langgraph-retirement-inventory-pg.integration.test.mjs',
          './tests/langgraph-retirement-status-adapter.integration.test.mjs',
          './tests/runtime-node-credential-revocation.integration.test.mjs',
        ],
        {
          environment: integrationEnvironment,
        }
      )
    } else if (integrationShard === null) {
      // The local runner owns one disposable PostgreSQL service. Build package
      // entrypoints once, then run the complete disjoint partition concurrently;
      // files remain serial within each shard to avoid cross-project contention.
      await run('bun', ['run', 'build'], { environment: integrationEnvironment })
      await runLocalIntegrationShards(integrationEnvironment)
    } else {
      // Explicit local shard runs need the same built package entrypoints as the
      // default local lane. Remote callers may build their shared source first.
      if (!remoteDatabase)
        await run('bun', ['run', 'build'], { environment: integrationEnvironment })
      await runIntegrationShardStreaming(integrationShard, integrationEnvironment, remoteDatabase)
    }
    // One drill execution per verification: shard 1 owns it in sharded runs.
    if (integrationShard === null || integrationShard === 1) {
      await run('bun', ['scripts/run-cloud-remote-drill.mjs'], {
        environment: integrationEnvironment,
      })
    }
    if (remoteDatabase) {
      console.log('Skipping PostgreSQL disruption and restore drills against a remote target.')
    } else {
      if (!postgresWasRunning) {
        await run('bun', ['scripts/run-postgres-disruption-drill.mjs'], {
          environment: { ...integrationEnvironment, POSTGRES_DISRUPTION_ALLOWED: 'true' },
        })
      } else {
        console.log(
          'Skipping PostgreSQL disruption drill because the runner did not start the service.'
        )
      }
      await run('bun', ['scripts/run-postgres-restore-drill.mjs'], {
        environment: integrationEnvironment,
      })
    }
  } catch (error) {
    verificationError = error
  } finally {
    await cleanupRunnerResources()
  }
  if (verificationError && cleanupError) {
    throw new AggregateError([verificationError, cleanupError], 'Integration and cleanup failed', {
      cause: verificationError,
    })
  }
  if (cleanupError) throw cleanupError
  if (verificationError) throw verificationError
}

try {
  await main()
} catch (error) {
  if (interruptedSignal === null) throw error
  // The interruption owns the exit status, but the original failure stays
  // observable instead of being masked by the signal or by cleanup.
  console.error(error)
  console.error(`Integration run interrupted by ${interruptedSignal}.`)
}
if (interruptedSignal !== null) process.exitCode = signalExitCode(interruptedSignal)

void COMPOSE_COMMAND
