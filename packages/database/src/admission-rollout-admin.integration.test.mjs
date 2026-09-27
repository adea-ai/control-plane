import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadDatabaseCredentials } from '@control-plane/config'
import { createIsolatedTestDatabase } from './testing.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const script = fileURLToPath(
  new URL('../../../scripts/admission-rollout-admin.mjs', import.meta.url)
)
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

describe.skipIf(!enabled)('PostgreSQL admission rollout operator CLI', () => {
  test('checks actual DB authority and retains pause across separate operator processes', async () => {
    const credentials = {
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    }
    const isolated = await createIsolatedTestDatabase(credentials)
    try {
      await isolated.migrate()
      const run = (verb, profile) => {
        const url = new URL(credentials[profile].url)
        url.pathname = `/${isolated.name}`
        return spawnSync(
          process.execPath,
          [
            script,
            verb,
            '--host',
            url.hostname,
            '--port',
            url.port || '5432',
            '--database',
            isolated.name,
            ...(verb === 'pause' ? ['--confirm', 'pause'] : []),
          ],
          {
            cwd: repositoryRoot,
            env: { ...process.env, DATABASE_MIGRATION_URL: url.href },
            encoding: 'utf8',
            timeout: 15_000,
            maxBuffer: 1_048_576,
          }
        )
      }
      const denied = run('pause', 'application')
      expect(denied.error).toBeUndefined()
      expect(denied.status).toBe(1)
      expect(denied.stdout).toBe('')
      expect(denied.stderr).toBe('ADMISSION_ROLLOUT_ADMIN_FAILED\n')

      const initial = run('status', 'migration')
      expect(initial.error).toBeUndefined()
      expect(initial.status).toBe(0)
      expect(JSON.parse(initial.stdout).state).toBe('open')

      const paused = run('pause', 'migration')
      expect(paused.error).toBeUndefined()
      expect(paused.status).toBe(0)
      const pause = JSON.parse(paused.stdout)
      expect(pause.state).toBe('paused')
      expect(pause.updatedBy).toBe(new URL(credentials.migration.url).username)

      const restarted = run('status', 'migration')
      expect(restarted.error).toBeUndefined()
      expect(restarted.status).toBe(0)
      expect(JSON.parse(restarted.stdout)).toEqual(pause)
    } finally {
      await isolated.dispose()
    }
  }, 60_000)
})
