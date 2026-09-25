import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExecutionPlanTestFixture } from '@control-plane/execution-plan/testing'
import { SqliteExecutionPlanRepository, SqlitePersistenceProvider } from './index.js'

const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000
// The compiler stamps `compiledAt`, so the clock is derived from the fixture it
// produces rather than the fixture from the clock.
const compiledAt = createExecutionPlanTestFixture().compiledAt
const now = new Date(Date.parse(compiledAt) + ninetyDaysMs + 60_000)

function storedId(value) {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

async function withProvider(run) {
  const directory = await mkdtemp(join(tmpdir(), 'control-plane-plan-retention-'))
  const provider = new SqlitePersistenceProvider({ path: join(directory, 'state.sqlite') })
  try {
    await provider.migrate()
    return await run(provider)
  } finally {
    await provider.close()
    await rm(directory, { recursive: true, force: true })
  }
}

describe('SQLite execution-plan retention deletion (#194)', () => {
  test('an unreferenced plan past its window is deleted', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      const plan = createExecutionPlanTestFixture()
      await plans.put(plan)

      const dry = await plans.deleteEligibleExecutionPlans(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: true,
      })
      expect(dry.eligible).toBe(1)
      expect(dry.deleted).toBe(0)

      const applied = await plans.deleteEligibleExecutionPlans(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(1)
      expect(
        await plans.get({
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
        })
      ).toBeUndefined()
    })
  }, 60000)

  test('pins from executions, acceptance records and validation commands all retain a plan', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      const plan = createExecutionPlanTestFixture()
      await plans.put(plan)
      const pin = { executionPlanId: plan.executionPlanId }

      // An execution compiled from the plan.
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'executions',
          id: storedId('exe-fixture'),
          value: {
            executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            state: 'completed',
            version: 1,
            correlation: {
              workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            },
            executionPlan: { ...pin, contentDigest: plan.contentDigest, schemaVersion: 1 },
            attemptCount: 0,
            acceptedAt: compiledAt,
            terminalAt: compiledAt,
            terminalResultRef: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            createdAt: compiledAt,
            updatedAt: compiledAt,
          },
        })
      )
      const withExecution = await plans.deleteEligibleExecutionPlans(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withExecution.deleted).toBe(0)
      expect(withExecution.retainedByReason).toEqual({ reference_pending: 1 })
      await provider.transaction((transaction) =>
        transaction.delete('executions', storedId('exe-fixture'))
      )

      // An acceptance record that carried the plan.
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'command-inbox',
          id: storedId('cmd-fixture'),
          value: {
            callerPrincipalId: 'svc_agent-hq',
            operation: 'execution.accept',
            workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            idempotencyKey: 'plan-retention-fixture',
            commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            taskId: 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            agentId: 'agt_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            payloadHash: 'a'.repeat(64),
            // Non-terminal: this fixture only carries the plan pin.
            status: 'accepted',
            executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            executionPlan: { ...pin, contentDigest: plan.contentDigest, schemaVersion: 1 },
            version: 1,
            conflictCount: 0,
            receivedAt: compiledAt,
            lastSeenAt: compiledAt,
            retentionExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      )
      const withAcceptance = await plans.deleteEligibleExecutionPlans(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withAcceptance.retainedByReason).toEqual({ reference_pending: 1 })
      await provider.transaction((transaction) =>
        transaction.delete('command-inbox', storedId('cmd-fixture'))
      )

      // A validation command that checked the plan.
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'execution-validation-commands',
          id: storedId('validation-fixture'),
          value: {
            scope: {
              callerPrincipalId: 'svc_agent-hq',
              workspaceId: 'wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              projectId: 'prj_01ARZ3NDEKTSV4RRFFQ69G5FAV',
              operation: 'execution.validate',
              idempotencyKey: 'plan-retention-validation-0001',
            },
            commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FBW',
            requestId: 'req_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            payloadHash: `sha256:${'b'.repeat(64)}`,
            executionPlan: { ...pin, contentDigest: plan.contentDigest },
            recordedAt: compiledAt,
          },
        })
      )
      const withValidation = await plans.deleteEligibleExecutionPlans(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withValidation.retainedByReason).toEqual({ reference_pending: 1 })

      // With every reference gone the plan is freed.
      await provider.transaction((transaction) =>
        transaction.delete('execution-validation-commands', storedId('validation-fixture'))
      )
      const freed = await plans.deleteEligibleExecutionPlans(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(freed.deleted).toBe(1)
      expect(
        await plans.get({
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
        })
      ).toBeUndefined()
    })
  }, 60000)

  test('the window runs from compiledAt and an unbounded policy retains plans', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      const plan = createExecutionPlanTestFixture()
      await plans.put(plan)

      const inside = new Date(Date.parse(compiledAt) + ninetyDaysMs - 1_000)
      expect(
        (
          await plans.deleteEligibleExecutionPlans(inside, {
            policyRetainMs: ninetyDaysMs,
            dryRun: false,
          })
        ).retainedByReason
      ).toEqual({ not_expired: 1 })

      expect(
        (
          await plans.deleteEligibleExecutionPlans(now, {
            policyRetainMs: null,
            dryRun: false,
          })
        ).retainedByReason
      ).toEqual({ unbounded_class: 1 })

      const past = await plans.deleteEligibleExecutionPlans(
        new Date(Date.parse(compiledAt) + ninetyDaysMs + 1),
        { policyRetainMs: ninetyDaysMs, dryRun: false }
      )
      expect(past.deleted).toBe(1)
    })
  }, 60000)
})
