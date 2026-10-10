import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { runWithPullBackoff } from './docker-pull-backoff.mjs'

const root = resolve(import.meta.dirname, '..')

// Local development database shared with scripts/test-integration.mjs.
// Used only when DATABASE_URL is not already set (CI provides its own).
const localDatabaseEnvironment = {
  DATABASE_URL:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_URL_UNPOOLED:
    'postgresql://agent_hq_local_app:agent_hq_local_app@127.0.0.1:55432/agent_hq?sslmode=disable',
  DATABASE_MIGRATION_URL:
    'postgresql://agent_hq_local_migration:agent_hq_local_migration@127.0.0.1:55432/agent_hq?sslmode=disable',
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

const usesExplicitDatabase = Boolean(process.env.DATABASE_URL)
const environment = usesExplicitDatabase
  ? { ...process.env }
  : { ...process.env, ...localDatabaseEnvironment }

// This caller is synchronous, so each attempt stays a blocking spawnSync. Output is
// captured to recognize the registry rate limit, and echoed once each attempt settles.
async function composeUpPostgres() {
  const args = ['compose', 'up', '-d', '--wait', '--wait-timeout', '60', 'postgres']
  const result = await runWithPullBackoff(() => {
    const attempt = spawnSync('docker', args, {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      stdio: 'pipe',
    })
    if (attempt.stdout) process.stdout.write(attempt.stdout)
    if (attempt.stderr) process.stderr.write(attempt.stderr)
    return attempt
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed with exit code ${result.status}`)
  }
}

if (!usesExplicitDatabase) {
  await composeUpPostgres()
}

// The E2E web server boots the app, which reads and writes the database on
// first request. Ensure the schema exists before Playwright starts.
run('bun', ['run', '--cwd', 'packages/db', 'db:verify'], environment)
