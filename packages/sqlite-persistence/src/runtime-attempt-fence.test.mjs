import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { executionPlanBudgetAllowance } from '@control-plane/execution-plan'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { SqlitePersistenceProvider } from './provider.ts'
import { SqliteContextPackageRepository } from './repositories-extra.ts'
import {
  SqliteCommandAcceptanceRepository,
  SqliteExecutionPlanRepository,
  SqliteExecutionRepository,
} from './repositories.ts'
import { SqliteDurableUsageStore } from './usage-store.ts'

const ids = {
  executionId: 'exe_01JABCDEF0123456789ABCDEFG',
  attemptId: 'att_01JABCDEF0123456789ABCDEFG',
  wrongAttemptId: 'att_01JBBCDEF0123456789ABCDEFG',
}
const acceptedAt = '2026-08-28T12:00:00.000Z'

describe('native runtime attempt fence', () => {
  test('native SQLite concurrent reservation and cold replay converge on one funded attempt', async () => {
    await withNativeAdmission(async ({ persistence, store, allowance }) => {
      await Promise.all([reserveRuntime(store, allowance), reserveRuntime(store, allowance)])
      const beforeReopen = await new DurableUsageLedger({ store }).entries(
        allowance.workspaceId,
        allowance.executionId
      )
      expect(beforeReopen.filter((entry) => entry.kind === 'reservation')).toHaveLength(1)
      persistence.close({ checkpoint: true })
      await persistence.migrate()
      const reopenedStore = new SqliteDurableUsageStore(persistence)
      await reserveRuntime(reopenedStore, allowance)
      const ledger = new DurableUsageLedger({ store: reopenedStore })
      expect(await ledger.entries(allowance.workspaceId, allowance.executionId)).toEqual(
        beforeReopen
      )
      expect(await ledger.summary(allowance.workspaceId, allowance.executionId)).toMatchObject({
        reservedMicrounits: allowance.maximumMicrounits,
        reservedTokens: allowance.maximumTokens,
        spentMicrounits: 0,
        spentTokens: 0,
      })
    })
  })

  for (const ordering of ['reservation-first', 'attempt-first', 'concurrent']) {
    test(`native runtime fence serializes ${ordering} and survives reopen`, async () => {
      await withNativeAdmission(
        async ({ persistence, store, allowance, lifecycle, executions }) => {
          const reserve = () => reserveRuntime(store, allowance)
          const supersede = async () => {
            const current = await lifecycle.getExecution(ids.executionId)
            return lifecycle.createAttempt({
              executionId: ids.executionId,
              attemptId: ids.wrongAttemptId,
              expectedExecutionVersion: current.version,
              queuedAt: acceptedAt,
            })
          }
          if (ordering === 'reservation-first') {
            await reserve()
            persistence.close({ checkpoint: true })
            await persistence.migrate()
            await expect(supersede()).rejects.toThrow('SETTLEMENT_INCOMPLETE')
            expect(await executions.getAttempt(ids.wrongAttemptId)).toBeUndefined()
            const current = await lifecycle.getExecution(ids.executionId)
            expect(
              await executions.compareAndSetExecution(current.version, {
                ...current,
                version: current.version + 1,
                latestAttemptId: ids.wrongAttemptId,
              })
            ).toBe(false)
            const ledger = new DurableUsageLedger({ store })
            // Synthetic known-no-effect settlement is explicit; uncertainty never auto-releases.
            await ledger.settle({
              workspaceId: allowance.workspaceId,
              executionId: ids.executionId,
              reservationKey: `runtime-attempt:${ids.attemptId}`,
              source: { sourceId: 'known-no-effect', idempotencyKey: 'known-no-effect:settle' },
            })
            await supersede()
          } else if (ordering === 'attempt-first') {
            await supersede()
            await expect(reserve()).rejects.toThrow('USAGE_LEDGER_SCOPE_MISMATCH')
          } else {
            const outcomes = await Promise.allSettled([reserve(), supersede()])
            expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
          }
          const current = await lifecycle.getExecution(ids.executionId)
          const entries = await new DurableUsageLedger({ store }).entries(
            allowance.workspaceId,
            ids.executionId
          )
          if (current.latestAttemptId === ids.wrongAttemptId && ordering !== 'reservation-first') {
            expect(entries.filter((entry) => entry.kind === 'reservation')).toHaveLength(0)
          }
          expect((await executions.listAttempts(ids.executionId)).length).toBe(current.attemptCount)
        }
      )
    })
  }

  test('native missing budget state never releases an uncertain runtime fence', async () => {
    await withNativeAdmission(async ({ persistence, store, allowance, lifecycle, executions }) => {
      await reserveRuntime(store, allowance)
      await persistence.transaction(async (transaction) => {
        for (const record of await transaction.list('usage-budgets')) {
          await transaction.delete('usage-budgets', record.id, record.revision)
        }
      })
      const current = await lifecycle.getExecution(ids.executionId)
      await expect(
        lifecycle.createAttempt({
          executionId: ids.executionId,
          attemptId: ids.wrongAttemptId,
          expectedExecutionVersion: current.version,
          queuedAt: acceptedAt,
        })
      ).rejects.toThrow('STORE_STATE_INVALID')
      expect(await executions.getAttempt(ids.wrongAttemptId)).toBeUndefined()
      expect((await lifecycle.getExecution(ids.executionId)).latestAttemptId).toBe(ids.attemptId)
    })
  })

  test('a surviving runtime receipt fences a valid budget restored before reservation', async () => {
    await withNativeAdmission(async ({ persistence, store, allowance, lifecycle, executions }) => {
      const originalBudget = await store.transaction(allowance.workspaceId, (transaction) =>
        transaction.getBudget(ids.executionId)
      )
      await reserveRuntime(store, allowance)
      await persistence.transaction(async (transaction) => {
        for (const record of await transaction.list('usage-budgets')) {
          await transaction.put({
            namespace: record.namespace,
            id: record.id,
            expectedRevision: record.revision,
            value: originalBudget,
          })
        }
        for (const namespace of ['usage-ledger-entries', 'usage-entry-sequences']) {
          for (const record of await transaction.list(namespace)) {
            if (record.value.sequence >= originalBudget.nextSequence) {
              await transaction.delete(namespace, record.id, record.revision)
            }
          }
        }
      })
      persistence.close({ checkpoint: true })
      await persistence.migrate()
      const ledger = new DurableUsageLedger({ store })
      expect(await ledger.summary(allowance.workspaceId, ids.executionId)).toMatchObject({
        reservedMicrounits: 0,
        reservedTokens: 0,
      })
      const current = await lifecycle.getExecution(ids.executionId)
      await expect(
        lifecycle.createAttempt({
          executionId: ids.executionId,
          attemptId: ids.wrongAttemptId,
          expectedExecutionVersion: current.version,
          queuedAt: acceptedAt,
        })
      ).rejects.toThrow('STORE_STATE_INVALID')
      expect(await executions.getAttempt(ids.wrongAttemptId)).toBeUndefined()
      expect((await lifecycle.getExecution(ids.executionId)).latestAttemptId).toBe(ids.attemptId)
    })
  })
})

async function withNativeAdmission(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'm11-runtime-reservation-'))
  const persistence = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await persistence.migrate()
    await new SqliteContextPackageRepository(persistence).put(
      contextPackageSerializationFixtures.futurePi
    )
    await new SqliteExecutionPlanRepository(persistence).put(createExecutionPlanTestFixture())
    const store = new SqliteDurableUsageStore(persistence)
    const repository = new SqliteCommandAcceptanceRepository(persistence)
    const plan = createExecutionPlanTestFixture()
    const fixture = await new CommandInboxService({
      repository,
      executionIdFactory: () => ids.executionId,
      executionPlanValidator: { validate: async () => true },
      now: () => acceptedAt,
    }).acceptExecution({
      callerPrincipalId: 'svc_runtime-fence',
      operation: 'execution.accept',
      commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
      requestId: plan.correlation.requestId,
      idempotencyKey: 'native-runtime-fence',
      payloadHash: 'a'.repeat(64),
      correlation: {
        workspaceId: plan.correlation.workspaceId,
        projectId: plan.correlation.projectId,
        taskId: plan.correlation.taskId,
        agentId: plan.correlation.agentId,
      },
      executionPlan: {
        executionPlanId: plan.executionPlanId,
        contentDigest: plan.contentDigest,
        schemaVersion: plan.schemaVersion,
      },
      receivedAt: acceptedAt,
      retentionExpiresAt: '2026-09-27T12:00:00.000Z',
    })
    const allowance = executionPlanBudgetAllowance(fixture.command, fixture.execution, plan)
    await new DurableUsageLedger({ store, now: () => acceptedAt }).openBudget(allowance)
    const executions = new SqliteExecutionRepository(persistence)
    const lifecycle = new ExecutionLifecycleService(executions)
    await lifecycle.createAttempt({
      executionId: ids.executionId,
      attemptId: ids.attemptId,
      expectedExecutionVersion: fixture.execution.version,
      queuedAt: acceptedAt,
      deadlineAt: '2026-08-28T13:00:00.000Z',
    })
    await operation({ persistence, store, repository, fixture, allowance, lifecycle, executions })
  } finally {
    try {
      persistence.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

function reserveRuntime(store, allowance) {
  return new DurableUsageLedger({ store, now: () => acceptedAt }).reserve({
    workspaceId: allowance.workspaceId,
    executionId: allowance.executionId,
    attemptId: ids.attemptId,
    reservationKey: `runtime-attempt:${ids.attemptId}`,
    maximumMicrounits: allowance.maximumMicrounits,
    maximumTokens: allowance.maximumTokens,
    source: { sourceId: ids.attemptId, idempotencyKey: `runtime-attempt:${ids.attemptId}:reserve` },
  })
}
