import { spawnSync } from 'node:child_process'
import process from 'node:process'

// Read-only production retention dry run. Derives the target host/database from
// the injected DATABASE_URL so the operator CLI's target-confusion guard stays
// intact, and never prints the URL itself.
const url = process.env.DATABASE_URL
if (url === undefined) throw new Error('DATABASE_URL is not present in the environment')
const parsed = new URL(url)
const host = parsed.hostname
const database = decodeURIComponent(parsed.pathname.slice(1))
for (const classId of ['command-inbox', 'execution-events']) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/retention-apply.mjs',
      '--backend',
      'postgres',
      '--class',
      classId,
      '--database',
      database,
      '--host',
      host,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env }
  )
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.exitCode = result.status ?? 1
    break
  }
  process.stdout.write(result.stdout)
}
