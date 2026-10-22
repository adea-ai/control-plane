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
// against one runner-owned disposable PostgreSQL service. Trusted-main PostgreSQL
// verification does not invoke this full portable integration suite.
const integrationShard = parseIntegrationShard(
  process.argv.find((argument) => argument.startsWith('--shard='))?.slice('--shard='.length) ??
    process.env.INTEGRATION_SHARD
)
if (integrationShard !== null) {
  console.log(`Running integration shard ${integrationShard} of the partitioned suite.`)
}

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.environment ?? runnerEnvironment,
    timeout: options.timeout ?? (command === 'docker' ? 90_000 : undefined),
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (options.capture && result.stderr) process.stderr.write(result.stderr)
    throw new Error(`${command} exited with status ${String(result.status)}`)
  }
  return result.stdout ?? ''
}

// Retry only the digest-pinned image pull. Container startup and health checks
// run once, so a startup failure cannot be hidden by repeating `compose up`.
async function composeUpPostgres() {
  const { image } = await pullPostgresImage({ environment: runnerEnvironment })
  // A rate-limited registry falls over to the same digest elsewhere; compose then has to
  // start the image that is now present locally, here and in every later compose command.
  if (image !== undefined) runnerEnvironment[postgresImageVariable] = image
  run('docker', ['compose', 'up', '-d', '--wait', 'postgres'], {
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
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? process.cwd(),
      env: options.environment ?? runnerEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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

async function waitForPostgres() {
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
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const result = spawnSync('docker', readinessCommand, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
      env: runnerEnvironment,
      timeout: Math.min(5000, remaining),
    })
    if (result.error) throw result.error
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

// A remote target (PostgreSQL preview branch or similar) replaces the local Docker
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

try {
  if (!remoteDatabase) {
    const runningServices = run('docker', ['compose', 'ps', '--status', 'running', '--services'], {
      capture: true,
    })
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
  if (!remoteDatabase) await waitForPostgres()
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
    run('bun', ['x', '--no-install', 'vp', 'run', '--concurrency=1', 'orch:test:integration'], {
      environment: integrationEnvironment,
    })
    // Root-level scenarios import these workspace packages through their built entry
    // points. the package integration graph builds only the upstream packages of the
    // integration packages, so build the root's own imports before those scenarios run.
    run('bun', ['x', '--no-install', 'vp', 'run', 'orch:build:integration-roots'], {
      environment: integrationEnvironment,
    })
    // Repository-owned scenarios span composition roots; keep their fixtures
    // outside individual workspace packages.
    run(
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
    run('bun', ['run', 'build'], { environment: integrationEnvironment })
    await runLocalIntegrationShards(integrationEnvironment)
  } else {
    // Explicit local shard runs need the same built package entrypoints as the
    // default local lane. Remote callers may build their shared source first.
    if (!remoteDatabase) run('bun', ['run', 'build'], { environment: integrationEnvironment })
    await runIntegrationShardStreaming(integrationShard, integrationEnvironment, remoteDatabase)
  }
  // One drill execution per verification: shard 1 owns it in sharded runs.
  if (integrationShard === null || integrationShard === 1) {
    run('bun', ['scripts/run-cloud-remote-drill.mjs'], { environment: integrationEnvironment })
  }
  if (remoteDatabase) {
    console.log('Skipping PostgreSQL disruption and restore drills against a remote target.')
  } else {
    if (!postgresWasRunning) {
      run('bun', ['scripts/run-postgres-disruption-drill.mjs'], {
        environment: { ...integrationEnvironment, POSTGRES_DISRUPTION_ALLOWED: 'true' },
      })
    } else {
      console.log(
        'Skipping PostgreSQL disruption drill because the runner did not start the service.'
      )
    }
    run('bun', ['scripts/run-postgres-restore-drill.mjs'], {
      environment: integrationEnvironment,
    })
  }
} catch (error) {
  verificationError = error
} finally {
  if (startupAttempted) {
    try {
      if (ownsComposeProject) {
        run('docker', ['compose', 'down', '--volumes', '--remove-orphans', '--timeout', '60'])
      } else {
        run('docker', ['compose', 'stop', '--timeout', '60', 'postgres'])
      }
    } catch (error) {
      cleanupError = error
    }
  }
}
if (verificationError && cleanupError) {
  throw new AggregateError([verificationError, cleanupError], 'Integration and cleanup failed', {
    cause: verificationError,
  })
}
if (cleanupError) throw cleanupError
if (verificationError) throw verificationError

void COMPOSE_COMMAND
