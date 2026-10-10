import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  discoverIntegrationInventory,
  parseIntegrationShard,
  planIntegrationRun,
} from './integration-inventory.mjs'

const root = resolve(import.meta.dirname, '..')
const localDatabaseEnvironment = {
  DATABASE_URL:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_URL_UNPOOLED:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_MIGRATION_URL:
    'postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55432/agent_hq?sslmode=disable',
}

// ADEA_INTEGRATION_SHARD=<index>/<total> runs one explicit slice of the package suites, so a lane
// can split them across independent databases. Unset runs everything, route flow included. The
// route flow belongs to shard 1 only. See integration-inventory.mjs for the inventory and the split.
const shard = parseIntegrationShard(process.env.ADEA_INTEGRATION_SHARD)
const plan = planIntegrationRun(discoverIntegrationInventory(root), shard)

// --plan prints this invocation's selection and exits before any build, Docker, or database work.
if (process.argv.includes('--plan')) {
  console.log(JSON.stringify({ shard, ...plan }, null, 2))
  process.exit(0)
}

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

function runningComposeServices() {
  const result = spawnSync('docker', ['compose', 'ps', '--status', 'running', '--services'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Error('Docker is required when DATABASE_URL is not set')
  if (result.status !== 0) {
    throw new Error('Docker Compose is required when DATABASE_URL is not set')
  }
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

// The migration-snapshot capture proofs build a disposable PostgreSQL scratch
// database per run: a capture inventories the whole app schema and the
// comparator refuses unbounded shared state. Creating and dropping that
// database needs CREATEDB, which the provisioned application roles
// deliberately do not have (the database health gate enforces it), so the
// instance the proofs run against is test infrastructure: a throwaway
// postgres container dedicated to this run, provisioned here and always
// removed afterwards. It is independent of DATABASE_URL — its admin URL is
// exported as MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL, the capture file
// refuses to run without it, and no destructive step in this lane ever
// targets the database DATABASE_URL names. A superuser inside an ephemeral,
// randomly-passworded container that exists only for this run is the point;
// widening an application role to make room for a test would not be.
const captureProvisioningDatabaseUrlVariable = 'MIGRATION_SNAPSHOT_CAPTURE_DATABASE_URL'
const captureProvisioningImage =
  'public.ecr.aws/docker/library/postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873'

function dockerDaemonAvailable() {
  const result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return !result.error && result.status === 0
}

function dockerCaptureRun(args, what, timeoutMs) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${what} failed: ${result.stderr.trim() || `exit code ${result.status}`}`)
  }
  return result.stdout.trim()
}

function startCaptureProvisioning() {
  if (!dockerDaemonAvailable()) return null
  // Random hex doubles as URL-safe: no percent-encoding concerns in the URL.
  const password = randomBytes(24).toString('hex')
  const name = `adea-capture-prov-${randomBytes(6).toString('hex')}`
  // Register the removal handle BEFORE the container exists: a timeout or
  // crash anywhere after `docker run` must still reach the lane's cleanup,
  // so a slow or failed start can never leak the container. The stop THROWS
  // on failure so the lane's cleanup can report it — a leaked container must
  // fail a green run instead of being ignored.
  const handle = {
    databaseUrl: null,
    stop() {
      dockerCaptureRun(['rm', '-f', name], 'removing the throwaway capture provisioning container')
    },
  }
  captureProvisioning = handle
  dockerCaptureRun(
    [
      'run',
      '-d',
      '--rm',
      // Loopback-only ephemeral host port: a plain `-P` publishes the port on
      // every host interface, which would put the throwaway instance on the
      // LAN. The mapping is read back below instead of guessing a port.
      '-p',
      '127.0.0.1::5432',
      '--name',
      name,
      '-e',
      `POSTGRES_PASSWORD=${password}`,
      captureProvisioningImage,
    ],
    `starting the throwaway capture provisioning container (${captureProvisioningImage})`,
    120_000
  )
  try {
    // Read the loopback ephemeral host port mapping back instead of guessing
    // one. The image's default POSTGRES_USER (postgres, superuser) owns the
    // default `postgres` admin database.
    const mapping = dockerCaptureRun(
      ['port', name, '5432/tcp'],
      'reading the provisioning port mapping'
    )
    const port = mapping.split(/\r?\n/).at(-1)?.split(':').at(-1)
    if (!port) throw new Error(`unreadable provisioning port mapping: ${mapping}`)
    const deadline = Date.now() + 60_000
    let ready = false
    while (Date.now() < deadline) {
      const probe = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      })
      if (probe.error) throw probe.error
      if (probe.status === 0) {
        ready = true
        break
      }
      // Synchronous sleep between readiness probes; the runner is single-
      // threaded and the next step needs the instance healthy.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
    }
    if (!ready) throw new Error('the throwaway capture provisioning instance never became ready')
    handle.databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres?sslmode=disable`
    return handle
  } catch (error) {
    // A container that started but never became healthy must not leak. The
    // removal failure is surfaced on stderr but never replaces the original
    // error — the lane's cleanup would report it again anyway.
    try {
      handle.stop()
    } catch (cleanupError) {
      console.error(`capture provisioning cleanup failed: ${cleanupError.message}`)
    }
    throw error
  }
}

const usesExplicitDatabase = Boolean(process.env.DATABASE_URL)
if (usesExplicitDatabase) {
  const missingVariables = ['DATABASE_URL_UNPOOLED', 'DATABASE_MIGRATION_URL'].filter(
    (name) => !process.env[name]
  )
  if (missingVariables.length > 0) {
    throw new Error(
      `${missingVariables.join(', ')} ${missingVariables.length === 1 ? 'is' : 'are'} required when DATABASE_URL is supplied; use an isolated test target`
    )
  }
}

const environment = usesExplicitDatabase
  ? { ...process.env }
  : { ...process.env, ...localDatabaseEnvironment }
let startedLocalPostgres = false
let captureProvisioning = null
let primaryFailure

try {
  // The database producer consumes the package's compiled public envelope
  // entry. Integration also runs independently from the workspace build.
  run('bun', ['run', '--cwd', 'packages/remote-content', 'build'], process.env)
  run('bun', ['run', '--cwd', 'packages/types', 'build'], process.env)
  run('bun', ['run', '--cwd', 'packages/auth', 'build'], process.env)
  // API regression cases exercise the production server handler through the
  // compiled database entry, with the explicit server-only runtime condition.
  run('bun', ['run', '--cwd', 'packages/db', 'build'], process.env)
  if (!usesExplicitDatabase && !runningComposeServices().includes('postgres')) {
    run(
      'docker',
      ['compose', 'up', '-d', '--wait', '--wait-timeout', '30', 'postgres'],
      process.env
    )
    startedLocalPostgres = true
  }

  run('node', ['scripts/database-health.mjs'], environment)
  run('bun', ['run', '--cwd', 'packages/db', 'db:verify'], environment)
  // Remote Neon branches serve 50-150ms roundtrips (vs sub-millisecond local
  // Postgres) and the heavier integration cases issue hundreds of queries in
  // sequence. Measured: `read-state-search.test.ts` issues ~270 sequential
  // round-trips for a single test, so at the documented 50-150ms range that
  // one test legitimately needs 13.5s-40.6s. A single 30s ceiling therefore
  // failed the upper half of the very range this comment documents.
  //
  // So the ceiling follows the target: sub-millisecond loopback keeps the
  // fast signal that catches hung code, while an explicitly supplied remote
  // target gets a ceiling sized to its own latency. Both still terminate.
  const remoteTarget = usesExplicitDatabase
  const timeoutMs = remoteTarget
    ? Number(process.env.ADEA_INTEGRATION_TIMEOUT_MS ?? 120_000)
    : Number(process.env.ADEA_INTEGRATION_TIMEOUT_MS ?? 30_000)
  // Test-only provisioning for the capture proofs, independent of DATABASE_URL
  // (see startCaptureProvisioning). Without docker the proofs skip cleanly;
  // with docker a failed provisioning fails the lane instead of silently
  // shrinking the coverage the capture file exists to prove.
  captureProvisioning = startCaptureProvisioning()
  if (captureProvisioning) {
    environment[captureProvisioningDatabaseUrlVariable] = captureProvisioning.databaseUrl
  } else {
    console.warn(
      `Docker is unavailable; ${captureProvisioningDatabaseUrlVariable} is not provisioned and the migration-snapshot capture proofs will skip`
    )
  }

  run(
    'bun',
    [
      '--conditions=react-server',
      'test',
      '--timeout',
      String(timeoutMs),
      ...plan.packageFiles.map((file) => resolve(root, file)),
    ],
    environment
  )
  // The route flow imports the compiled @adea-ai/api-client entry (the package
  // suites above read their own src relatively; the database entry is already
  // built before provisioning), so it must be built on a clean checkout before
  // the route tests run. Like the builds above, this keeps integration
  // runnable independently from a workspace-wide turbo build.
  if (plan.routeFiles.length > 0) {
    run('bun', ['run', '--cwd', 'packages/api-client', 'build'], process.env)
    // The apps/web route-flow tests run under the react-server export condition, which the runner
    // supplies: the route modules carry the `server-only` marker and cannot initialize under bun's
    // default conditions. The shared database environment and the same latency-sized ceiling apply.
    run(
      'bun',
      [
        'test',
        '--conditions=react-server',
        '--timeout',
        String(timeoutMs),
        ...plan.routeFiles.map((file) => resolve(root, file)),
      ],
      environment
    )
  }
} catch (error) {
  primaryFailure = error
}

if (startedLocalPostgres) {
  // Cleanup runs on success AND failure, and never hides the primary result:
  // when the lane already failed, a broken stop is reported to stderr instead
  // of replacing the real failure; when the lane was green, a leaked container
  // still fails the run.
  try {
    run('docker', ['compose', 'stop', 'postgres'], process.env)
  } catch (error) {
    console.error(`docker compose stop postgres failed: ${error.message}`)
    primaryFailure ??= error
  }
}

if (captureProvisioning) {
  // Same contract as the compose cleanup above: the throwaway capture
  // provisioning container is removed on success AND failure, a broken
  // removal is reported without hiding the primary result, and a leak after a
  // green run fails the lane.
  try {
    captureProvisioning.stop()
  } catch (error) {
    console.error(`removing the capture provisioning container failed: ${error.message}`)
    primaryFailure ??= error
  }
}

if (primaryFailure) throw primaryFailure
