import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  CommandInboxError,
  CommandInboxService,
  parseRetentionJournalLine,
} from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  REFERENCE_RETENTION_NAMESPACES,
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqlitePersistenceProvider,
} from '../packages/sqlite-persistence/src/index.ts'
import { retentionApply } from '../scripts/retention-apply.mjs'
import { retentionReapply } from '../scripts/retention-reapply.mjs'

const reapplyScript = fileURLToPath(new URL('../scripts/retention-reapply.mjs', import.meta.url))

/** Both commands run in this process: spawning per case cost the lane its budget. */
async function apply(argv) {
  let stdout = ''
  let stderr = ''
  const status = await retentionApply({
    argv,
    writeOut: (text) => (stdout += text),
    writeErr: (text) => (stderr += text),
  })
  return { status, stdout, stderr }
}

async function reapply(argv) {
  let stdout = ''
  let stderr = ''
  const status = await retentionReapply({
    argv,
    writeOut: (text) => (stdout += text),
    writeErr: (text) => (stderr += text),
  })
  return { status, stdout, stderr }
}
const plan = createExecutionPlanTestFixture()
const ids = {
  commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  workspaceId: plan.correlation.workspaceId,
  projectId: plan.correlation.projectId,
  taskId: plan.correlation.taskId,
  agentId: plan.correlation.agentId,
  executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  executionPlanId: plan.executionPlanId,
}
const receivedAt = '2026-08-24T10:00:00.000Z'
const expiredAt = '2026-09-23T10:00:00.000Z'
const assessedAt = '2026-09-24T12:00:00.000Z'
const scope = {
  callerPrincipalId: 'svc_agent-hq',
  operation: 'execution.accept',
  workspaceId: ids.workspaceId,
  projectId: ids.projectId,
  idempotencyKey: 'retention-restore-reapply-0001',
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

async function seedTerminalRetiredCommand(provider) {
  await new SqliteContextPackageRepository(provider).put(
    contextPackageSerializationFixtures.futurePi
  )
  await new SqliteExecutionPlanRepository(provider).put(plan)
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
      contentDigest: plan.contentDigest,
      schemaVersion: plan.schemaVersion,
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
  expect(await repository.retireExpiredCommand(scope, assessedAt)).toBe(true)
  return repository
}

describe('retention restore-time reapplication (#194)', () => {
  test('an empty valid journal still invalidates restored reference clocks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-clocks-'))
    const path = join(directory, 'restored.sqlite')
    const journalPath = join(directory, 'retention.jsonl')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await provider.transaction(async (transaction) => {
        for (const namespace of [
          ...Object.values(REFERENCE_RETENTION_NAMESPACES),
          'unrelated-metadata',
        ])
          await transaction.put({
            namespace,
            id: 'target',
            value: { unreferencedSince: '2025-01-01T00:00:00.000Z' },
          })
      })
      await writeFile(journalPath, '')
      const result = await reapply([
        '--backend',
        'sqlite',
        '--database',
        path,
        '--journal',
        journalPath,
      ])
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ records: 0, applied: 0, skipped: 0 })
      for (const namespace of Object.values(REFERENCE_RETENTION_NAMESPACES))
        expect(
          await provider.transaction((transaction) => transaction.get(namespace, 'target'))
        ).toBeUndefined()
      expect(
        await provider.transaction((transaction) => transaction.get('unrelated-metadata', 'target'))
      ).toBeDefined()
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
  test('rejects journal operations outside their declared class or backend', () => {
    const record = { version: 1, at: assessedAt, backend: 'sqlite', classId: 'evaluation-runs' }
    for (const operation of [
      { kind: 'sqlite.delete', namespace: 'executions', id: ids.executionId },
      { kind: 'sqlite.put', namespace: 'evaluation-runs', id: 'eval-1', value: {} },
      { kind: 'postgres.deleteEvaluationRun', evalRunId: 'eval-1' },
    ]) {
      expect(() =>
        parseRetentionJournalLine(JSON.stringify({ ...record, operations: [operation] }))
      ).toThrow()
    }
    expect(() =>
      parseRetentionJournalLine(
        JSON.stringify({
          ...record,
          backend: 'postgres',
          operations: [{ kind: 'postgres.deleteExecution', executionId: ids.executionId }],
        })
      )
    ).toThrow()
    expect(
      parseRetentionJournalLine(
        JSON.stringify({
          ...record,
          backend: 'postgres',
          classId: 'executions',
          operations: [
            { kind: 'postgres.deleteAttempt', attemptId: 'att_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
            { kind: 'postgres.deleteExecution', executionId: ids.executionId },
          ],
        })
      ).operations
    ).toHaveLength(2)
    expect(
      parseRetentionJournalLine(
        JSON.stringify({
          ...record,
          operations: [{ kind: 'sqlite.delete', namespace: 'evaluation-runs', id: 'eval-1' }],
        })
      ).operations
    ).toHaveLength(1)
  })

  test('rejects a misclassified journal before changing the restored database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-journal-scope-'))
    const path = join(directory, 'restored.sqlite')
    const journalPath = join(directory, 'retention.jsonl')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'executions',
          id: ids.executionId,
          value: { state: 'running' },
        })
      )
      await writeFile(
        journalPath,
        `${JSON.stringify({ version: 1, at: assessedAt, backend: 'sqlite', classId: 'evaluation-runs', operations: [{ kind: 'sqlite.delete', namespace: 'executions', id: ids.executionId }] })}\n`
      )
      const result = await reapply([
        '--backend',
        'sqlite',
        '--database',
        path,
        '--journal',
        journalPath,
      ])
      expect(result.status).toBe(1)
      expect(
        await provider.transaction((transaction) => transaction.get('executions', ids.executionId))
      ).toBeDefined()
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an older snapshot plus the journal restores deletion and rejection identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-restore-'))
    const path = join(directory, 'state.sqlite')
    const restoredPath = join(directory, 'restored.sqlite')
    const journalPath = join(directory, 'retention.jsonl')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const repository = await seedTerminalRetiredCommand(provider)

      // The snapshot predates the deletion — this is the hazard case.
      const snapshot = await provider.backup()

      const applied = await apply([
        '--backend',
        'sqlite',
        '--class',
        'command-inbox',
        '--database',
        path,
        '--now',
        assessedAt,
        '--apply',
        '--confirm',
        'command-inbox',
        '--journal',
        journalPath,
      ])
      expect(applied.status).toBe(0)
      expect(JSON.parse(applied.stdout).result.deleted).toBe(1)
      expect(JSON.parse(applied.stdout).journal).toBe(journalPath)
      const journalLines = (await readFile(journalPath, 'utf8')).trim().split('\n')
      expect(journalLines).toHaveLength(1)
      // The journal restates the rejection identity as well as the delete,
      // so a snapshot taken before the retirement can regain it.
      expect(JSON.parse(journalLines[0]).operations.map((operation) => operation.kind)).toEqual([
        'sqlite.put',
        'sqlite.delete',
        'sqlite.delete',
      ])
      expect(await repository.getByExecutionId(ids.executionId)).toBeUndefined()
      await provider.close()

      // Restoring the older snapshot resurrects the record AND loses nothing
      // observable at first: the rejection key is still there, so the hazard
      // is the resurrected payload, not a lost tombstone.
      const restored = new SqlitePersistenceProvider({ path: restoredPath })
      await restored.restore(snapshot)
      const restoredRepository = new SqliteCommandAcceptanceRepository(restored)
      expect(await restoredRepository.getByExecutionId(ids.executionId)).toBeDefined()

      // Reapply the journal before exposing the copy.
      const reapplied = await reapply([
        '--backend',
        'sqlite',
        '--database',
        restoredPath,
        '--journal',
        journalPath,
      ])
      expect(reapplied.status).toBe(0)
      const report = JSON.parse(reapplied.stdout)
      expect(report.report).toBe('retention-reapply')
      // The snapshot still carried the rejection key, so only the two deletes
      // applied and the restated key was already present.
      expect(report).toMatchObject({ applied: 2, skipped: 1 })
      expect(await restoredRepository.getByExecutionId(ids.executionId)).toBeUndefined()
      expect(
        await restored.transaction((transaction) => transaction.list('command-by-execution'))
      ).toHaveLength(0)

      // The rejection identity survived the round trip.
      const error = await restoredRepository.get(scope).catch((thrown) => thrown)
      expect(error).toBeInstanceOf(CommandInboxError)
      expect(error.code).toBe('COMMAND_RETENTION_EXPIRED')

      // The harder case: a snapshot that predates the retirement too. Remove
      // the key from the copy and show that a replay would then be accepted
      // silently (no record, no rejection) — the exact hazard the journal
      // exists to prevent.
      const [tombstone] = await restored.transaction((transaction) =>
        transaction.list('retired-command-keys')
      )
      await restored.transaction((transaction) =>
        transaction.delete('retired-command-keys', tombstone.id)
      )
      expect(await restoredRepository.get(scope)).toBeUndefined()

      const restated = await reapply([
        '--backend',
        'sqlite',
        '--database',
        restoredPath,
        '--journal',
        journalPath,
      ])
      expect(restated.status).toBe(0)
      expect(JSON.parse(restated.stdout)).toMatchObject({ applied: 1, skipped: 2 })
      const restoredRejection = await restoredRepository.get(scope).catch((thrown) => thrown)
      expect(restoredRejection).toBeInstanceOf(CommandInboxError)
      expect(restoredRejection.code).toBe('COMMAND_RETENTION_EXPIRED')

      // Reapplying again is a no-op: inserts are guarded and deletes are by
      // identity, so a journal can be replayed without widening its effect.
      const again = await reapply([
        '--backend',
        'sqlite',
        '--database',
        restoredPath,
        '--journal',
        journalPath,
      ])
      expect(again.status).toBe(0)
      expect(JSON.parse(again.stdout)).toMatchObject({ applied: 0, skipped: 3 })

      await restored.close()
    } finally {
      try {
        provider.close()
      } catch {
        // already closed before the snapshot was restored
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 90000)

  test('the script entrypoint maps the command result to its exit code', () => {
    // One spawned case on purpose: everything else runs in this process.
    const child = spawnSync(process.execPath, [reapplyScript, '--backend', 'sqlite'], {
      encoding: 'utf8',
      timeout: 30000,
    })
    expect(child.status).toBe(1)
    expect(child.stderr.trim()).toMatch(/^RETENTION_REAPPLY_FAILED/)
    expect(child.stdout).toBe('')
  }, 60000)

  test('a missing or relative journal is refused with one sanitized code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-restore-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const missing = await reapply([
        '--backend',
        'sqlite',
        '--database',
        path,
        '--journal',
        join(directory, 'absent.jsonl'),
      ])
      expect(missing.status).toBe(1)
      expect(missing.stderr.trim()).toMatch(/^RETENTION_REAPPLY_FAILED/)

      const relative = await reapply([
        '--backend',
        'sqlite',
        '--database',
        path,
        '--journal',
        'retention.jsonl',
      ])
      expect(relative.status).toBe(1)
      expect(relative.stderr.trim()).toMatch(/^RETENTION_REAPPLY_FAILED/)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)
})
