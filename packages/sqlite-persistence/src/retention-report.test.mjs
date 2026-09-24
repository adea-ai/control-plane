import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { SqlitePersistenceProvider } from './index.js'

const script = fileURLToPath(new URL('../../../scripts/retention-report.mjs', import.meta.url))

function run(database, now) {
  return spawnSync(
    process.execPath,
    [script, '--backend', 'sqlite', '--database', database, '--now', now],
    { encoding: 'utf8', timeout: 30000 }
  )
}

// The report reads the same namespaced records and canonical expiry fields the
// durable repositories write, so the fixtures seed those records directly:
// this suite covers counting and read-only behavior, not the repositories'
// own lifecycle rules.
async function seed(provider, namespace, id, value) {
  await provider.transaction((transaction) => transaction.put({ namespace, id, value }))
}

describe('retention report (#194)', () => {
  test('counts expired candidates without deleting anything', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-report-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await seed(provider, 'command-inbox', 'expired-command', {
        commandId: 'cmd_report_0001',
        retentionExpiresAt: '2020-01-01T00:00:00.000Z',
      })
      await seed(provider, 'command-inbox', 'live-command', {
        commandId: 'cmd_report_0002',
        retentionExpiresAt: '2099-01-01T00:00:00.000Z',
      })
      await seed(provider, 'execution-events', 'expired-event', {
        eventId: 'evt_report_0001',
        retentionExpiresAt: '2020-01-01T00:00:00.000Z',
      })
      await seed(provider, 'retired-command-keys', 'retired-key', {
        commandId: 'cmd_report_0001',
        retiredAt: '2026-09-01T00:00:00.000Z',
      })

      const result = run(path, '2026-09-24T00:00:00.000Z')
      expect(result.status).toBe(0)
      const report = JSON.parse(result.stdout)
      expect(report.report).toBe('retention')
      expect(report.deletion).toBe('fail_closed')
      expect(report.policy.schemaVersion).toBe(1)
      expect(report.classes.commandInbox).toEqual({ expiredCandidates: 1, retained: 2 })
      expect(report.classes.executionEvents).toEqual({ expiredCandidates: 1, retained: 1 })
      expect(report.classes.retiredCommandKeys).toEqual({ retained: 1 })

      // Read-only: every record is still present after the report.
      const remaining = await provider.transaction((transaction) =>
        transaction.get('command-inbox', 'expired-command')
      )
      expect(remaining).toBeDefined()
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)

  test('ignores records whose expiry is not a canonical instant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-report-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await seed(provider, 'command-inbox', 'malformed', {
        commandId: 'cmd_report_0003',
        retentionExpiresAt: '2020-01-01 00:00:00',
      })
      const result = run(path, '2026-09-24T00:00:00.000Z')
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout).classes.commandInbox).toEqual({
        expiredCandidates: 0,
        retained: 1,
      })
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)

  test('rejects a relative path, a missing target and an unparseable clock', async () => {
    const relative = run('state.sqlite', '2026-09-24T00:00:00.000Z')
    expect(relative.status).toBe(1)
    expect(relative.stderr.trim()).toBe('RETENTION_REPORT_FAILED')
    expect(relative.stdout).toBe('')

    const missing = run(
      '/tmp/control-plane-retention-report-missing/state.sqlite',
      '2026-09-24T00:00:00.000Z'
    )
    expect(missing.status).toBe(1)
    expect(missing.stderr.trim()).toBe('RETENTION_REPORT_FAILED')

    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-report-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const badClock = run(path, 'not-an-instant')
      expect(badClock.status).toBe(1)
      expect(badClock.stderr.trim()).toBe('RETENTION_REPORT_FAILED')
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
})
