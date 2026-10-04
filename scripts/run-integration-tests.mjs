import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import {
  integrationFileArguments,
  parseIntegrationShard,
  selectIntegrationShard,
} from './integration-shards.mjs'

// Keep the documented production-like command visible to repository policy tests.
const COMPOSE_COMMAND = 'docker compose'

// `--shard=<n>` (or INTEGRATION_SHARD) runs one explicit slice of the suite
// from scripts/integration-shards.mjs instead of the full turbo sweep. The
// Neon workflow pairs each shard with its own disposable branch; unsharded
// runs keep the exact historical behavior.
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
        runnerEnvironment.COMPOSE_PROJECT_NAME = `control-plane-integration-${process.pid}-${randomUUID()}`
      }
      console.log(
        `Starting integration PostgreSQL in project ${runnerEnvironment.COMPOSE_PROJECT_NAME ?? 'caller-default'}.`
      )
      startupAttempted = true
      run('docker', ['compose', 'up', '-d', '--wait', 'postgres'])
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
  // Stream progress even while a remote database task is unfinished. Grouped
  // CI logs hide test/setup timing until the whole package exits.
  if (integrationShard === null) {
    run('bun', ['x', 'turbo', 'run', 'test:integration', '--concurrency=1', '--log-order=stream'], {
      environment: integrationEnvironment,
    })
    // Repository-owned scenarios span composition roots without importing
    // repository fixtures from inside an application package.
    run(
      'bun',
      [
        'test',
        '--timeout',
        remoteDatabase ? '120000' : '30000',
        './tests/memory-process-loss.integration.test.mjs',
      ],
      {
        environment: integrationEnvironment,
      }
    )
  } else {
    // A remote branch stretches tests that finish in seconds locally to
    // 30-70 seconds each, and its pooler occasionally severs a pooled
    // connection mid-run (CONNECTION_CLOSED / CONNECTION_ENDED), leaving
    // later queries blocked long enough to trip the per-test timeout. The
    // remote lane therefore raises the ceiling and runs every file in its
    // own process with one retry, so a transient drop costs one file
    // instead of poisoning the rest of the shard. The local lane keeps the
    // fast-fail ceiling and the package-level sweep.
    const perTestTimeoutMs = remoteDatabase ? '120000' : '30000'
    for (const group of selectIntegrationShard(integrationShard)) {
      for (const file of group.files) {
        const testArguments = integrationFileArguments(group, file, perTestTimeoutMs)
        try {
          run('bun', testArguments, {
            cwd: group.package,
            environment: integrationEnvironment,
          })
        } catch {
          console.log(`Integration file ${file} failed; retrying once before failing the shard.`)
          run('bun', testArguments, {
            cwd: group.package,
            environment: integrationEnvironment,
          })
        }
      }
    }
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
