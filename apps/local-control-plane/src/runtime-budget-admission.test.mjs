import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CommandInboxService, ExecutionLifecycleService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import {
  SqliteCommandAcceptanceRepository,
  SqliteContextPackageRepository,
  SqliteDurableUsageStore,
  SqliteExecutionPlanRepository,
  SQLITE_USAGE_NAMESPACES,
} from '@control-plane/sqlite-persistence'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { LocalControlPlaneComposition } from './composition.ts'

const at = '2026-09-27T00:00:00.000Z'
const executionId = 'exe_01JABCDEF0123456789ABCDEFG'
const workflowId = 'wfl_01JABCDEF0123456789ABCDEFG'

for (const profile of ['local', 'hosted-simple']) {
  test.each([
    'missing-command',
    'missing-budget',
    'settled-budget',
    'missing-receipt',
    'corrupt-fingerprint',
    'wrong-opening-source',
    'valid',
  ])(
    `${profile} runtime checks durable accepted allowance before starting: %s`,
    async (scenario) => {
      const directory = await mkdtemp(join(tmpdir(), 'm11-runtime-admission-root-'))
      let starts = 0
      let handle
      const composition = new LocalControlPlaneComposition({
        profile,
        dataDirectory: directory,
        runtimeTransport: {
          transportKind: 'direct-local',
          start: async ({ attemptId }) => {
            const store = new SqliteDurableUsageStore(composition.persistence)
            const budget = await store.transaction(
              createExecutionPlanTestFixture().correlation.workspaceId,
              (transaction) => transaction.getBudget(executionId)
            )
            expect(budget.reservations).toContainEqual({
              reservationKey: `runtime-attempt:${attemptId}`,
              attemptId,
              maximumMicrounits: budget.maximumMicrounits,
              maximumTokens: budget.maximumTokens,
              chargedMicrounits: 0,
              chargedTokens: 0,
              status: 'open',
            })
            starts++
            handle = { handleId: 'native:admission-test', attemptId, startedAt: at }
            return handle
          },
          async *progress() {},
          status: async () => ({
            handle,
            state: 'completed',
            observedAt: at,
            result: {
              outcome: 'completed',
              output: 'done',
              artifacts: [],
              usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
            },
          }),
        },
      })
      try {
        await composition.persistence.migrate()
        const plan = createExecutionPlanTestFixture()
        await new SqliteContextPackageRepository(composition.persistence).put(
          contextPackageSerializationFixtures.futurePi
        )
        const executionPlan = {
          ...(await new SqliteExecutionPlanRepository(composition.persistence).put(plan)),
          schemaVersion: plan.schemaVersion,
        }
        if (scenario === 'missing-command') {
          await new ExecutionLifecycleService(composition.executions).createExecution({
            executionId,
            correlation: plan.correlation,
            executionPlan,
            acceptedAt: at,
          })
        } else {
          const commands = new CommandInboxService({
            repository: new SqliteCommandAcceptanceRepository(composition.persistence, {
              budgetAdmission: scenario !== 'missing-budget',
            }),
            executionIdFactory: () => executionId,
            executionPlanValidator: { validate: async () => true },
            now: () => at,
          })
          await commands.acceptExecution({
            callerPrincipalId: 'svc_runtime-admission-test',
            operation: 'execution.accept',
            commandId: 'cmd_01JABCDEF0123456789ABCDEFG',
            requestId: plan.correlation.requestId,
            idempotencyKey: 'runtime-admission-test-0001',
            payloadHash: 'a'.repeat(64),
            correlation: {
              workspaceId: plan.correlation.workspaceId,
              projectId: plan.correlation.projectId,
              taskId: plan.correlation.taskId,
              agentId: plan.correlation.agentId,
            },
            executionPlan,
            receivedAt: at,
            retentionExpiresAt: '2026-10-27T00:00:00.000Z',
          })
          if (scenario === 'settled-budget') {
            await new DurableUsageLedger({
              store: new SqliteDurableUsageStore(composition.persistence),
            }).finalizeBudget({
              workspaceId: plan.correlation.workspaceId,
              executionId,
              source: { sourceId: 'fixture:finalize', idempotencyKey: 'fixture:finalize' },
            })
          }
          if (['missing-receipt', 'corrupt-fingerprint'].includes(scenario)) {
            // Deliberately corrupt persisted admission; not an operational write API.
            await composition.persistence.transaction(async (transaction) => {
              const key = `execution-budget-open:${executionId}`
              const id = `r-${createHash('sha256')
                .update(JSON.stringify([plan.correlation.workspaceId, key]))
                .digest('hex')}`
              const receipt = await transaction.get(SQLITE_USAGE_NAMESPACES.effects, id)
              expect(receipt).toBeDefined()
              if (scenario === 'missing-receipt') {
                await transaction.delete(SQLITE_USAGE_NAMESPACES.effects, id)
              } else {
                await transaction.put({
                  namespace: SQLITE_USAGE_NAMESPACES.effects,
                  id,
                  expectedRevision: receipt.revision,
                  value: { ...receipt.value, fingerprint: `sha256:${'0'.repeat(64)}` },
                })
              }
            })
          }
          if (scenario === 'wrong-opening-source') {
            await composition.persistence.transaction(async (transaction) => {
              const opening = (await transaction.list(SQLITE_USAGE_NAMESPACES.entries)).find(
                (record) =>
                  record.value.executionId === executionId && record.value.kind === 'credit'
              )
              expect(opening).toBeDefined()
              await transaction.put({
                namespace: SQLITE_USAGE_NAMESPACES.entries,
                id: opening.id,
                expectedRevision: opening.revision,
                value: {
                  ...opening.value,
                  source: { ...opening.value.source, sourceId: 'allocation:other-owner' },
                },
              })
            })
          }
        }
        const { attemptId } = await composition.executionLifecycleActivities.ensureAttempt({
          executionId,
          workflowId,
          effectKey: 'fixture:attempt',
        })
        const dispatchInput = {
          executionId,
          attemptId,
          executionPlan,
          effectKey: 'fixture:dispatch',
        }
        const outcome = composition.executionLifecycleActivities.dispatch(dispatchInput)
        if (scenario === 'valid') {
          expect((await outcome).outcome).toBe('completed')
          expect(starts).toBe(1)
          const ledger = new DurableUsageLedger({
            store: new SqliteDurableUsageStore(composition.persistence),
          })
          const entries = await ledger.entries(plan.correlation.workspaceId, executionId)
          expect(entries.filter((entry) => entry.kind === 'reservation')).toHaveLength(1)
          composition.persistence.close({ checkpoint: true })
          await composition.persistence.migrate()
          expect(
            (await composition.executionLifecycleActivities.dispatch(dispatchInput)).outcome
          ).toBe('completed')
          expect(starts).toBe(1)
          expect(await ledger.entries(plan.correlation.workspaceId, executionId)).toEqual(entries)
        } else {
          await expect(outcome).rejects.toThrow('RUNTIME_BUDGET_ADMISSION_DENIED')
          expect(starts).toBe(0)
        }
      } finally {
        await composition.close()
        composition.persistence.close()
        await rm(directory, { recursive: true, force: true })
      }
    }
  )
}
