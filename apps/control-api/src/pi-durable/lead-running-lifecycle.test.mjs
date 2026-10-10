import { test, expect } from 'bun:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionLifecycleService } from '@control-plane/domain'
import {
  SqlitePersistenceProvider,
  SqliteExecutionRepository,
  SqliteExecutionPlanRepository,
  SqliteContextPackageRepository,
} from '@control-plane/sqlite-persistence'
import { ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { SqlitePiLeadRunningLifecycle } from './lead-running-lifecycle.ts'
const at = '2026-10-08T00:00:00.000Z'
const later = '2026-10-08T00:01:00.000Z'
async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-lead-running-'))
  const path = join(directory, 'canonical.sqlite')
  let provider, database, executions
  async function open() {
    provider = new SqlitePersistenceProvider({ path })
    await provider.migrate()
    database = new DatabaseSync(path)
    executions = new SqliteExecutionRepository(provider)
  }
  async function close() {
    database.close()
    await provider.close()
  }
  try {
    await open()
    const inputs = createExecutionPlanTestFixtureInputs()
    const plan = new ExecutionPlanCompiler('1.0.0').compile(inputs)
    await new SqliteContextPackageRepository(provider).put(inputs.contextPackage)
    await new SqliteExecutionPlanRepository(provider).put(plan)
    const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
    const attemptId = 'att_01JABCDEF0123456789ABCDEFG'
    const lifecycle = new ExecutionLifecycleService(executions)
    const execution = await lifecycle.createExecution({
      executionId,
      correlation: plan.correlation,
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      acceptedAt: at,
    })
    await lifecycle.createAttempt({
      executionId,
      attemptId,
      expectedExecutionVersion: execution.version,
      queuedAt: at,
    })
    const authority = {
      request: { executionId, attemptId, idempotencyKey: 'lead:one', executionPlan: plan },
      admission: {},
      handle: {
        handleId: 'pi-durable:one',
        attemptId,
        externalSessionId: 'ses_01JABCDEF0123456789ABCDEFG',
        startedAt: at,
      },
      observedAt: later,
    }
    let current = true,
      reads = 0,
      onRead
    const create = (repository = executions) =>
      new SqlitePiLeadRunningLifecycle({
        database,
        executions: repository,
        assertAuthority: async () => {
          reads++
          await onRead?.(reads)
          if (!current) throw new Error('current-revoked')
        },
      })
    await run({
      authority,
      create,
      close,
      open,
      get executions() {
        return executions
      },
      get database() {
        return database
      },
      revoke: () => {
        current = false
      },
      observe: (callback) => {
        onRead = callback
      },
      get reads() {
        return reads
      },
    })
  } finally {
    try {
      await close()
    } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
}

test('actual canonical CAS and retained runtime handle survive SQLite close/reopen without mutating attempt runtime', async () => {
  await fixture(async (f) => {
    await f.create().onExecutionRunning(f.authority)
    const execution = await f.executions.getExecution(f.authority.request.executionId)
    const attempt = await f.executions.getAttempt(f.authority.request.attemptId)
    expect(execution.state).toBe('running')
    expect(attempt.state).toBe('running')
    expect(attempt.runtime).toBeUndefined()
    const receipt = f.database.prepare('SELECT * FROM pi_lead_running_receipts').get()
    expect(JSON.parse(receipt.receipt_json).handle).toEqual(f.authority.handle)
    await f.close()
    await f.open()
    await f.create().onExecutionRunning(f.authority)
    expect(await f.executions.getExecution(execution.executionId)).toEqual(execution)
    expect(await f.executions.getAttempt(attempt.attemptId)).toEqual(attempt)
    await expect(
      f.create().onExecutionRunning({
        ...f.authority,
        handle: { ...f.authority.handle, externalSessionId: 'ses_01JABCDEF0123456789ABCDEFH' },
      })
    ).rejects.toThrow('PI_LEAD_RUNNING_AUTHORITY_REJECTED')
    expect(
      f.database.prepare('SELECT receipt_json FROM pi_lead_running_receipts').get().receipt_json
    ).toBe(receipt.receipt_json)
  })
})

test('restart repairs a crash after canonical starting CAS using the retained exact handle', async () => {
  await fixture(async (f) => {
    const base = f.executions
    const repository = {
      getExecution: (id) => base.getExecution(id),
      getAttempt: (id) => base.getAttempt(id),
      compareAndSetExecution: (version, value) => base.compareAndSetExecution(version, value),
      compareAndSetAttempt: async (version, value) => {
        await base.compareAndSetAttempt(version, value)
        throw new Error('crash-after-attempt-CAS')
      },
    }
    await expect(f.create(repository).onExecutionRunning(f.authority)).rejects.toThrow(
      'crash-after-attempt-CAS'
    )
    expect((await base.getExecution(f.authority.request.executionId)).state).toBe('starting')
    expect((await base.getAttempt(f.authority.request.attemptId)).state).toBe('starting')
    await f.close()
    await f.open()
    await f.create().onExecutionRunning(f.authority)
    expect((await f.executions.getExecution(f.authority.request.executionId)).state).toBe('running')
    expect((await f.executions.getAttempt(f.authority.request.attemptId)).state).toBe('running')
    expect(
      f.database.prepare('SELECT count(*) AS count FROM pi_lead_running_receipts').get().count
    ).toBe(1)
  })
})

for (const race of ['cancel', 'latest-attempt', 'authority-revoked'])
  test(`current ${race} while trusted policy awaits denies lifecycle publication`, async () => {
    await fixture(async (f) => {
      f.observe(async (n) => {
        if (n !== 2) return
        const lifecycle = new ExecutionLifecycleService(f.executions)
        const execution = await f.executions.getExecution(f.authority.request.executionId)
        if (race === 'cancel')
          await lifecycle.transitionExecution({
            executionId: execution.executionId,
            expectedVersion: execution.version,
            to: 'cancelled',
            transitionedAt: later,
          })
        else if (race === 'latest-attempt')
          await lifecycle.createAttempt({
            executionId: execution.executionId,
            expectedExecutionVersion: execution.version,
            attemptId: 'att_01JABCDEF0123456789ABCDEFH',
            queuedAt: later,
          })
        else f.revoke()
      })
      await expect(f.create().onExecutionRunning(f.authority)).rejects.toThrow()
      expect((await f.executions.getAttempt(f.authority.request.attemptId)).state).toBe('queued')
      expect(
        f.database.prepare('SELECT count(*) AS count FROM pi_lead_running_receipts').get().count
      ).toBe(0)
    })
  })

test('foreign attempt, plan and child lineage fail closed without state changes', async () => {
  await fixture(async (f) => {
    for (const authority of [
      {
        ...f.authority,
        handle: { ...f.authority.handle, attemptId: 'att_01JABCDEF0123456789ABCDEFH' },
      },
      {
        ...f.authority,
        request: {
          ...f.authority.request,
          executionPlan: {
            ...f.authority.request.executionPlan,
            contentDigest: `sha256:${'f'.repeat(64)}`,
          },
        },
      },
      {
        ...f.authority,
        request: {
          ...f.authority.request,
          executionPlan: {
            ...f.authority.request.executionPlan,
            parentExecutionPlan: {
              executionPlanId: f.authority.request.executionPlan.executionPlanId,
              contentDigest: f.authority.request.executionPlan.contentDigest,
            },
          },
        },
      },
    ])
      await expect(f.create().onExecutionRunning(authority)).rejects.toThrow()
    expect((await f.executions.getAttempt(f.authority.request.attemptId)).state).toBe('queued')
  })
})
