import { spawnSync } from 'node:child_process'
import process from 'node:process'

// Keep the documented production-like command visible to repository policy tests.
const COMPOSE_COMMAND = 'docker compose'

function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.environment ?? process.env,
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
    const result = spawnSync('docker', readinessCommand, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: 'pipe',
    })
    if (result.error) throw result.error
    if (result.status === 0 && result.stdout.trim() === '1') {
      console.log('PostgreSQL database system is accepting SQL connections')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error('PostgreSQL did not accept SQL connections within 30 seconds')
}

const runningServices = run('docker', ['compose', 'ps', '--status', 'running', '--services'], {
  capture: true,
})
  .split('\n')
  .filter(Boolean)
const postgresWasRunning = runningServices.includes('postgres')
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
    hostname === '' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  )
}
const remoteDatabase = [process.env.DATABASE_URL, process.env.DATABASE_MIGRATION_URL]
  .filter((value) => value !== undefined)
  .some((value) => !isLoopbackHostname(databaseHostname(value)))

try {
  if (!remoteDatabase && !postgresWasRunning)
    run('docker', ['compose', 'up', '-d', '--wait', 'postgres'])
  if (!remoteDatabase) await waitForPostgres()
  else console.log('Using remote database target from the environment.')
  const integrationEnvironment = {
    ...process.env,
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
  }
  run('bun', ['x', 'turbo', 'run', 'test:integration', '--concurrency=1'], {
    environment: integrationEnvironment,
  })
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
} finally {
  if (!remoteDatabase && !postgresWasRunning) {
    run('docker', ['compose', 'stop', '--timeout', '60', 'postgres'])
  }
}

void COMPOSE_COMMAND
