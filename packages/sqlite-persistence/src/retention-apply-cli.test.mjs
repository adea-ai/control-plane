import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { CommandInboxError, CommandInboxService } from '@control-plane/domain'
import { SqliteCommandAcceptanceRepository, SqlitePersistenceProvider } from './index.js'

const script = fileURLToPath(new URL('../../../scripts/retention-apply.mjs', import.meta.url))
const ids = {
  commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionPlanId: 'pln_01ARZ3NDEKTSV4RRFFQ69G5FAV',
}
const receivedAt = '2026-08-24T10:00:00.000Z'
const expiredAt = '2026-09-23T10:00:00.000Z'
const assessedAt = '2026-09-24T12:00:00.000Z'
const scope = {
  callerPrincipalId: 'svc_agent-hq',
  operation: 'execution.accept',
  workspaceId: ids.workspaceId,
  projectId: ids.projectId,
  idempotencyKey: 'retention-apply-0001',
}

function run(database, extra = []) {
  return spawnSync(
    process.execPath,
    [
      script,
      '--backend',
      'sqlite',
      '--class',
      'command-inbox',
      '--database',
      database,
      '--now',
      assessedAt,
      ...extra,
    ],
    { encoding: 'utf8', timeout: 30000 }
  )
}

async function patchSingleton(provider, namespace, patch) {
  await provider.transaction(async (transaction) => {
    const [record] = await transaction.list(namespace)
    await transaction.put({
      namespace,
      id: record.id,
      value: { ...record.value, ...patch },
      expectedRevision: record.revision,
    })
  })
}

async function seedTerminalCommand(provider) {
  const repository = new SqliteCommandAcceptanceRepository(provider)
  await new CommandInboxService({
    repository,
    executionIdFactory: () => ids.executionId,
    executionPlanValidator: { validate: async () => true },
    now: () => receivedAt,
  }).acceptExecution({
    callerPrincipalId: scope.callerPrincipalId,
    operation: scope.operation,
    commandId: ids.commandId,
    requestId: ids.requestId,
    idempotencyKey: scope.idempotencyKey,
    payloadHash: 'a'.repeat(64),
    correlation: {
      workspaceId: ids.workspaceId,
      projectId: ids.projectId,
      taskId: ids.taskId,
      agentId: ids.agentId,
    },
    executionPlan: {
      executionPlanId: ids.executionPlanId,
      contentDigest: `sha256:${'b'.repeat(64)}`,
      schemaVersion: 1,
    },
    receivedAt,
    retentionExpiresAt: expiredAt,
  })
  await patchSingleton(provider, 'executions', { state: 'completed', terminalAt: expiredAt })
  await patchSingleton(provider, 'command-inbox', {
    status: 'completed',
    terminalAt: expiredAt,
    resultReference: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  })
  return repository
}

describe('retention apply CLI (#194)', () => {
  test('dry run reports eligibility, apply deletes the record and keeps the rejection key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-apply-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const repository = await seedTerminalCommand(provider)
      expect(await repository.retireExpiredCommand(scope, assessedAt)).toBe(true)

      // Dry run first: eligible but untouched.
      const dry = run(path)
      expect(dry.status).toBe(0)
      const dryReport = JSON.parse(dry.stdout)
      expect(dryReport.dryRun).toBe(true)
      expect(dryReport.result.deleted).toBe(0)
      expect(dryReport.result.eligible).toBe(1)
      expect(await repository.getByExecutionId(ids.executionId)).toBeDefined()

      // Applying without the confirmation value is refused.
      const unconfirmed = run(path, ['--apply'])
      expect(unconfirmed.status).toBe(1)
      expect(unconfirmed.stderr.trim()).toBe('RETENTION_APPLY_FAILED')

      // Apply: the record and its index go, the rejection key stays.
      const applied = run(path, ['--apply', '--confirm', 'command-inbox'])
      expect(applied.status).toBe(0)
      const appliedReport = JSON.parse(applied.stdout)
      expect(appliedReport.dryRun).toBe(false)
      expect(appliedReport.result.deleted).toBe(1)
      expect(appliedReport.result.raced).toBe(0)
      expect(await repository.getByExecutionId(ids.executionId)).toBeUndefined()
      expect(await provider.transaction((t) => t.list('command-inbox'))).toHaveLength(0)
      expect(await provider.transaction((t) => t.list('retired-command-keys'))).toHaveLength(1)

      // A replay of the same scoped key still fails closed.
      const error = await repository.get(scope).catch((thrown) => thrown)
      expect(error).toBeInstanceOf(CommandInboxError)
      expect(error.code).toBe('COMMAND_RETENTION_EXPIRED')

      // Second pass has nothing left to do.
      const again = JSON.parse(run(path, ['--apply', '--confirm', 'command-inbox']).stdout)
      expect(again.result.deleted).toBe(0)
      expect(again.result.scanned).toBe(0)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('a terminal command without its rejection key is never deleted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-apply-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const repository = await seedTerminalCommand(provider)

      const applied = run(path, ['--apply', '--confirm', 'command-inbox'])
      expect(applied.status).toBe(0)
      const report = JSON.parse(applied.stdout)
      expect(report.result.deleted).toBe(0)
      expect(report.result.retainedByReason).toEqual({ rejection_key_absent: 1 })
      expect(await repository.getByExecutionId(ids.executionId)).toBeDefined()
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('live and unresolved commands survive an apply pass', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-apply-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const repository = await seedTerminalCommand(provider)
      await repository.retireExpiredCommand(scope, assessedAt)
      // An otherwise eligible record with an unresolved reconciliation must
      // survive: reference holders outrank age.
      await patchSingleton(provider, 'command-inbox', { reconciliationRequiredAt: expiredAt })
      // A second, live command in the same namespace.
      const [existing] = await provider.transaction((transaction) =>
        transaction.list('command-inbox')
      )
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'command-inbox',
          id: 'live-command',
          value: {
            ...existing.value,
            idempotencyKey: 'retention-apply-live',
            retentionExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      )

      const applied = run(path, ['--apply', '--confirm', 'command-inbox'])
      expect(applied.status).toBe(0)
      const report = JSON.parse(applied.stdout)
      expect(report.result.deleted).toBe(0)
      expect(report.result.retainedByReason).toEqual({ reference_pending: 1 })
      expect(await provider.transaction((t) => t.list('command-inbox'))).toHaveLength(2)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('unsupported classes, relative paths and bad instants fail with one sanitized code', async () => {
    const unsupported = spawnSync(
      process.execPath,
      [script, '--backend', 'sqlite', '--class', 'executions', '--database', '/tmp/x.sqlite'],
      { encoding: 'utf8', timeout: 30000 }
    )
    expect(unsupported.status).toBe(1)
    expect(unsupported.stderr.trim()).toBe('RETENTION_APPLY_FAILED')

    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-apply-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const relative = spawnSync(
        process.execPath,
        [script, '--backend', 'sqlite', '--class', 'command-inbox', '--database', 'state.sqlite'],
        { encoding: 'utf8', timeout: 30000 }
      )
      expect(relative.status).toBe(1)
      expect(relative.stderr.trim()).toBe('RETENTION_APPLY_FAILED')

      const badInstant = spawnSync(
        process.execPath,
        [
          script,
          '--backend',
          'sqlite',
          '--class',
          'command-inbox',
          '--database',
          path,
          '--now',
          'yesterday',
        ],
        { encoding: 'utf8', timeout: 30000 }
      )
      expect(badInstant.status).toBe(1)
      expect(badInstant.stderr.trim()).toBe('RETENTION_APPLY_FAILED')
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)
})
