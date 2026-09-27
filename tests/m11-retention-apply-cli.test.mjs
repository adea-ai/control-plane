import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { CommandInboxError, CommandInboxService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteExecutionPlanRepository,
  SqlitePersistenceProvider,
} from '../packages/sqlite-persistence/src/index.ts'
import { retentionApply } from '../scripts/retention-apply.mjs'
import {
  sqliteOperatorSession,
  writeOperatorPolicyFixture,
} from './fixtures/retention-hold-operator-fixtures.mjs'

const script = fileURLToPath(new URL('../scripts/retention-apply.mjs', import.meta.url))

/** Runs the command in this process: spawning per case cost the lane its budget. */
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
  idempotencyKey: 'retention-apply-0001',
}

function run(database, extra = []) {
  return apply([
    '--backend',
    'sqlite',
    '--class',
    'command-inbox',
    '--database',
    database,
    '--now',
    assessedAt,
    ...extra,
  ])
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
  // New admission requires real parents. The validator stub does not waive
  // durable reference integrity enforced by the repository transaction.
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
  return repository
}

describe('retention apply CLI (#194)', () => {
  test('a storage close failure is returned as failure, not overwritten by the entrypoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-close-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    const { SqlitePersistenceProvider: OperatorProvider } =
      await import('@control-plane/sqlite-persistence')
    const originalClose = OperatorProvider.prototype.close
    const originalExitCode = process.exitCode
    try {
      await provider.migrate()
      provider.close()
      OperatorProvider.prototype.close = function () {
        originalClose.call(this)
        throw new Error('test-owned close failure')
      }
      const result = await run(path)
      expect(result.stderr).toBe('RETENTION_APPLY_CLOSE_FAILED\n')
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('test-owned')
    } finally {
      OperatorProvider.prototype.close = originalClose
      process.exitCode = originalExitCode
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('the real operator path preserves held records, denies scoped sweeps and deletes only after authorized release', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-hold-path-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const repository = await seedTerminalCommand(provider)
      expect(await repository.retireExpiredCommand(scope, assessedAt)).toBe(true)
      const configured = await writeOperatorPolicyFixture(path)
      const holdScope = { kind: 'project', workspaceId: ids.workspaceId, projectId: ids.projectId }
      const input = join(directory, 'request.json')
      const holdId = randomUUID()
      await writeFile(
        input,
        JSON.stringify({
          operation: 'create',
          holdId,
          classId: 'command-inbox',
          scope: holdScope,
          reasonCode: 'legal-case',
          ...sqliteOperatorSession,
        }),
        { mode: 0o600 }
      )
      const adminScript = fileURLToPath(
        new URL('../scripts/retention-hold-admin.mjs', import.meta.url)
      )
      // Keep a real process boundary: entrypoint exit codes and sanitized output
      // must be proven in addition to testing the command function.
      const created = spawnSync(
        process.execPath,
        [
          adminScript,
          '--backend',
          'sqlite',
          '--database',
          path,
          '--hold-policy',
          configured.path,
          '--input',
          input,
        ],
        { encoding: 'utf8', timeout: 15000 }
      )
      expect(created.status).toBe(0)
      expect(created.stderr).toBe('')
      expect(JSON.parse(created.stdout)).toEqual({
        status: 'applied',
        operation: 'create',
        holdId,
        revision: 0,
      })
      const policyArgs = ['--hold-policy', configured.path, '--apply', '--confirm', 'command-inbox']
      const held = await run(path, policyArgs)
      expect(held.status).toBe(0)
      expect(JSON.parse(held.stdout).result).toMatchObject({
        retainedByReason: { hold_recorded: 1 },
        eligible: 0,
        deleted: 0,
      })
      expect(await repository.getByExecutionId(ids.executionId)).toBeDefined()
      const journal = `${path}.retention-journal.jsonl`
      await expect(readFile(journal, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      await writeOperatorPolicyFixture(path, {
        grants: [
          {
            ...sqliteOperatorSession,
            classId: 'command-inbox',
            scope: holdScope,
            actions: ['create', 'release', 'sweep', 'assess'],
          },
        ],
      })
      expect(await run(path, policyArgs)).toEqual({
        status: 1,
        stdout: '',
        stderr: 'RETENTION_APPLY_FAILED\n',
      })
      expect(await repository.getByExecutionId(ids.executionId)).toBeDefined()
      await expect(readFile(journal, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await writeOperatorPolicyFixture(path)
      const { retentionHoldAdmin } = await import('../scripts/retention-hold-admin.mjs')
      const release = {
        operation: 'release',
        holdId,
        requestId: randomUUID(),
        expectedRevision: 0,
        ...sqliteOperatorSession,
      }
      await writeFile(input, JSON.stringify(release))
      const releaseArgs = [
        '--backend',
        'sqlite',
        '--database',
        path,
        '--hold-policy',
        configured.path,
        '--input',
        input,
      ]
      let releasedOutput = ''
      expect(
        await retentionHoldAdmin({
          argv: releaseArgs,
          writeOut: (text) => {
            releasedOutput += text
          },
          writeErr: () => {},
        })
      ).toBe(0)
      expect(JSON.parse(releasedOutput)).toEqual({
        status: 'applied',
        operation: 'release',
        holdId,
        revision: 1,
      })
      const removed = await apply([
        '--backend',
        'sqlite',
        '--class',
        'command-inbox',
        '--database',
        path,
        '--now',
        new Date(Date.now() + 1).toISOString(),
        ...policyArgs,
      ])
      expect(removed.status).toBe(0)
      expect(JSON.parse(removed.stdout).result).toMatchObject({ retainedByReason: {}, deleted: 1 })
      expect(await repository.getByExecutionId(ids.executionId)).toBeUndefined()
      const lines = (await readFile(journal, 'utf8')).trim().split('\n').map(JSON.parse)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({ backend: 'sqlite', classId: 'command-inbox' })
      expect(JSON.stringify(lines)).not.toContain('legal-case')
      expect(JSON.stringify(lines)).not.toContain(sqliteOperatorSession.actorPrincipalRef)
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('physical deletion requires explicit operator policy even when no holds exist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-authority-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const repository = await seedTerminalCommand(provider)
      expect(await repository.retireExpiredCommand(scope, assessedAt)).toBe(true)
      const denied = await run(path, ['--apply', '--confirm', 'command-inbox'])
      expect(denied).toEqual({ status: 1, stdout: '', stderr: 'RETENTION_APPLY_FAILED\n' })
      expect(await repository.getByExecutionId(ids.executionId)).toBeDefined()
      expect(
        await provider.transaction((transaction) => transaction.list('retention-holds'))
      ).toEqual([])
    } finally {
      provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('dry run reports eligibility, apply deletes the record and keeps the rejection key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-apply-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const repository = await seedTerminalCommand(provider)
      expect(await repository.retireExpiredCommand(scope, assessedAt)).toBe(true)

      // Dry run first: eligible but untouched.
      const dry = await run(path)
      expect(dry.status).toBe(0)
      const dryReport = JSON.parse(dry.stdout)
      expect(dryReport.dryRun).toBe(true)
      expect(dryReport.result.deleted).toBe(0)
      expect(dryReport.result.eligible).toBe(1)
      expect(await repository.getByExecutionId(ids.executionId)).toBeDefined()

      // Applying without the confirmation value is refused.
      const unconfirmed = await run(path, ['--apply'])
      expect(unconfirmed.status).toBe(1)
      expect(unconfirmed.stderr.trim()).toBe('RETENTION_APPLY_FAILED')

      // Apply: the record and its index go, the rejection key stays.
      const { path: operatorPolicy } = await writeOperatorPolicyFixture(path)
      const policyArgs = ['--hold-policy', operatorPolicy]
      const applied = await run(path, ['--apply', '--confirm', 'command-inbox', ...policyArgs])
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
      const again = JSON.parse(
        (await run(path, ['--apply', '--confirm', 'command-inbox', ...policyArgs])).stdout
      )
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

      const { path: operatorPolicy } = await writeOperatorPolicyFixture(path)
      const applied = await run(path, [
        '--apply',
        '--confirm',
        'command-inbox',
        '--hold-policy',
        operatorPolicy,
      ])
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

      const { path: operatorPolicy } = await writeOperatorPolicyFixture(path)
      const applied = await run(path, [
        '--apply',
        '--confirm',
        'command-inbox',
        '--hold-policy',
        operatorPolicy,
      ])
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

  test('a class with no path on the requested backend is refused', async () => {
    // messaging is PostgreSQL-only: the SQLite profiles carry no inbox or
    // outbox tables, so the command refuses instead of reporting zero work.
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-apply-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const refused = await apply([
        '--backend',
        'sqlite',
        '--class',
        'messaging',
        '--database',
        path,
        '--now',
        assessedAt,
      ])
      expect(refused.status).toBe(1)
      expect(refused.stderr.trim()).toMatch(/^RETENTION_APPLY_FAILED/)
      expect(refused.stdout).toBe('')
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('the script entrypoint maps the command result to its exit code', () => {
    // One spawned case on purpose: everything else runs in this process.
    const child = spawnSync(
      process.execPath,
      [script, '--backend', 'sqlite', '--class', 'command-inbox', '--database', 'relative.sqlite'],
      { encoding: 'utf8', timeout: 30000 }
    )
    expect(child.status).toBe(1)
    expect(child.stderr.trim()).toBe('RETENTION_APPLY_FAILED')
    expect(child.stdout).toBe('')
  }, 60000)

  test('unsupported classes, relative paths and bad instants fail with one sanitized code', async () => {
    const unsupported = await apply([
      '--backend',
      'sqlite',
      '--class',
      'not-a-class',
      '--database',
      '/tmp/x.sqlite',
    ])
    expect(unsupported.status).toBe(1)
    expect(unsupported.stderr.trim()).toBe('RETENTION_APPLY_FAILED')

    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-apply-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const relative = await apply([
        '--backend',
        'sqlite',
        '--class',
        'command-inbox',
        '--database',
        'state.sqlite',
      ])
      expect(relative.status).toBe(1)
      expect(relative.stderr.trim()).toBe('RETENTION_APPLY_FAILED')

      const badInstant = await apply([
        '--backend',
        'sqlite',
        '--class',
        'command-inbox',
        '--database',
        path,
        '--now',
        'yesterday',
      ])
      expect(badInstant.status).toBe(1)
      expect(badInstant.stderr.trim()).toBe('RETENTION_APPLY_FAILED')
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)

  test('rejects malformed bounds and unsupported or malformed continuation before storage', async () => {
    for (const extra of [
      ['--bound', '1junk'],
      ['--bound', '1.5'],
      ['--bound', '0'],
      ['--bound', '9007199254740992'],
      ['--after-id', 'target'],
    ]) {
      const result = await run('/tmp/absent-retention-cursor-fixture.sqlite', extra)
      expect(result).toEqual({ status: 1, stdout: '', stderr: 'RETENTION_APPLY_FAILED\n' })
    }
    for (const afterId of ['', 'private/data', 'x'.repeat(129)]) {
      const result = await apply([
        '--backend',
        'sqlite',
        '--class',
        'execution-plans',
        '--database',
        '/tmp/absent-retention-cursor-fixture.sqlite',
        '--after-id',
        afterId,
      ])
      expect(result).toEqual({ status: 1, stdout: '', stderr: 'RETENTION_APPLY_FAILED\n' })
    }
  })

  test('reference-class continuation visits each young target once without skipping a bounded page', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'control-plane-retention-cursor-'))
    const path = join(directory, 'state.sqlite')
    const provider = new SqlitePersistenceProvider({ path })
    try {
      await provider.migrate()
      const packages = new SqliteContextPackageRepository(provider)
      for (const package_ of Object.values(contextPackageSerializationFixtures))
        await packages.put(package_)
      const targetIds = await provider.transaction(async (transaction) =>
        (await transaction.list('context-packages')).map((record) => record.id).toSorted()
      )
      expect(targetIds).toHaveLength(3)
      let afterId
      for (let page = 0; page < targetIds.length; page++) {
        const result = await apply([
          '--backend',
          'sqlite',
          '--class',
          'context-packages',
          '--database',
          path,
          '--now',
          assessedAt,
          '--bound',
          '1',
          ...(afterId === undefined ? [] : ['--after-id', afterId]),
        ])
        expect(result.status).toBe(0)
        const report = JSON.parse(result.stdout)
        expect(report.dryRun).toBe(true)
        expect(report.result.scanned).toBe(1)
        expect(report.result.deleted).toBe(0)
        afterId = report.result.nextAfterId
        expect(afterId).toBe(page < targetIds.length - 1 ? targetIds[page] : undefined)
      }
      // Dry-run pagination cannot establish release clocks or remove content.
      expect(
        await provider.transaction((transaction) => transaction.list('context-packages'))
      ).toHaveLength(3)
      for (const namespace of [
        'retention-plan-reference-windows',
        'retention-context-reference-windows',
      ])
        expect(
          await provider.transaction((transaction) => transaction.list(namespace))
        ).toHaveLength(0)
    } finally {
      await provider.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60000)
})
