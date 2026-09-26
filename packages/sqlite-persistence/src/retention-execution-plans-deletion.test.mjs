import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CommandInboxService } from '@control-plane/domain'
import { contextPackageSerializationFixtures } from '@control-plane/context'
import { deriveExecutionPlan, ExecutionPlanCompiler } from '@control-plane/execution-plan'
import {
  createExecutionPlanTestFixture,
  createExecutionPlanTestFixtureInputs,
} from '@control-plane/execution-plan/testing'
import {
  SqliteContextPackageRepository,
  SqliteCommandAcceptanceRepository,
  SqliteExecutionPlanRepository,
  SqlitePersistenceProvider,
} from './index.js'

const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000
// The compiler stamps `compiledAt`, so the clock is derived from the fixture it
// produces rather than the fixture from the clock.
const fixtureCompiledAt = createExecutionPlanTestFixture().compiledAt
const retentionDeadline = new Date(Date.parse(fixtureCompiledAt) + ninetyDaysMs + 60_000)

function storedId(value) {
  return `r-${createHash('sha256').update(value).digest('hex')}`
}

function planAt(compiledAt) {
  return new ExecutionPlanCompiler('1.0.0').compile({
    ...createExecutionPlanTestFixtureInputs(),
    compiledAt,
  })
}

function childPlanAt(parent, compiledAt) {
  return deriveExecutionPlan(parent, {
    correlation: parent.correlation,
    contextPackage: contextPackageSerializationFixtures.futurePi,
    constraints: parent.constraints,
    runtimeRequirements: parent.runtimeRequirements,
    outputContract: parent.outputContract,
    compiledAt,
  })
}

function childPlanAfterParentKey(parent) {
  for (let day = 1; day <= 366; day += 1) {
    const compiledAt = new Date(Date.parse(parent.compiledAt) + day * 86_400_000).toISOString()
    const child = childPlanAt(parent, compiledAt)
    if (storedId(parent.executionPlanId) < storedId(child.executionPlanId)) return child
  }
  throw new Error('UNABLE_TO_ORDER_CHILD_PLAN_AFTER_PARENT')
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

async function putPlanWithContext(provider, plans, plan) {
  await new SqliteContextPackageRepository(provider).put(
    contextPackageSerializationFixtures.futurePi
  )
  return plans.put(plan)
}

describe('SQLite execution-plan retention deletion (#194)', () => {
  test('new plans require their exact context package while identical replay survives parent cleanup', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      const plan = createExecutionPlanTestFixture()
      await expect(plans.put(plan)).rejects.toMatchObject({ code: 'MISSING_CONTEXT_PACKAGE' })

      const packages = new SqliteContextPackageRepository(provider)
      const contextPackage = contextPackageSerializationFixtures.futurePi
      await packages.put(contextPackage)
      const reference = await plans.put(plan)
      await provider.transaction(async (transaction) => {
        const stored = (await transaction.list('context-packages')).find(
          (record) => record.value.contextPackageId === contextPackage.contextPackageId
        )
        expect(stored).toBeDefined()
        await transaction.delete('context-packages', stored.id, stored.revision)
      })
      expect(await plans.put(plan)).toEqual(reference)
    })
  })

  test('a child plan pins its parent through deletion and then the ancestor becomes eligible', async () => {
    await withProvider(async (provider) => {
      const parent = planAt('2024-01-01T00:00:00.000Z')
      const child = childPlanAfterParentKey(parent)
      const plans = new SqliteExecutionPlanRepository(provider)
      await putPlanWithContext(provider, plans, parent)
      await plans.put(child)

      const now = new Date(Date.parse(child.compiledAt) + ninetyDaysMs + 60_000)
      const first = await plans.deleteEligibleExecutionPlans(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(first.deleted).toBe(1)
      expect(first.retainedByReason).toEqual({ reference_pending: 1 })
      expect(
        await plans.get({
          executionPlanId: parent.executionPlanId,
          contentDigest: parent.contentDigest,
        })
      ).toBeDefined()
      expect(
        await plans.get({
          executionPlanId: child.executionPlanId,
          contentDigest: child.contentDigest,
        })
      ).toBeUndefined()

      const second = await plans.deleteEligibleExecutionPlans(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(second.deleted).toBe(1)
      expect(
        await plans.get({
          executionPlanId: parent.executionPlanId,
          contentDigest: parent.contentDigest,
        })
      ).toBeUndefined()
    })
  })

  test('new child plans require the exact parent but identical replay survives parent cleanup', async () => {
    await withProvider(async (provider) => {
      const parent = planAt('2024-01-01T00:00:00.000Z')
      const child = childPlanAt(parent, '2024-02-01T00:00:00.000Z')
      const wrongParent = planAt('2024-03-01T00:00:00.000Z')
      const plans = new SqliteExecutionPlanRepository(provider)
      await new SqliteContextPackageRepository(provider).put(
        contextPackageSerializationFixtures.futurePi
      )

      await expect(plans.put(child)).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'execution-plans',
          id: storedId(parent.executionPlanId),
          value: wrongParent,
        })
      )
      await expect(plans.put(child)).rejects.toMatchObject({ code: 'INVALID_REFERENCE' })
      await provider.transaction((transaction) =>
        transaction.delete('execution-plans', storedId(parent.executionPlanId))
      )

      await plans.put(parent)
      const reference = await plans.put(child)
      await provider.transaction((transaction) =>
        transaction.delete('execution-plans', storedId(parent.executionPlanId))
      )
      expect(await plans.put(child)).toEqual(reference)
    })
  })

  test('new command acceptance racing plan deletion fails closed when deletion linearizes first', async () => {
    await withProvider(async (provider) => {
      const plan = createExecutionPlanTestFixture()
      const plans = new SqliteExecutionPlanRepository(provider)
      await putPlanWithContext(provider, plans, plan)
      const now = new Date(Date.parse(plan.compiledAt) + ninetyDaysMs + 60_000)
      const commandService = new CommandInboxService({
        repository: new SqliteCommandAcceptanceRepository(provider),
        executionIdFactory: () => 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        executionPlanValidator: { validate: async () => true },
        now: () => now.toISOString(),
      })
      const input = {
        callerPrincipalId: 'svc_agent-hq',
        operation: 'execution.accept',
        commandId: 'cmd_01ARZ3NDEKTSV4RRFFQ69G5FAW',
        requestId: plan.correlation.requestId,
        idempotencyKey: 'plan-retention-race-0001',
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
        receivedAt: now.toISOString(),
        retentionExpiresAt: new Date(now.getTime() + ninetyDaysMs).toISOString(),
      }
      let competingAcceptance

      const deletion = await plans.deleteEligibleExecutionPlans(now, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        journal: async () => {
          // Do not await from inside the transaction: SQLite holds the writer
          // lock until deletion commits, then the new acceptance must recheck.
          competingAcceptance = commandService.acceptExecution(input)
        },
      })

      expect(deletion.deleted).toBe(1)
      await expect(competingAcceptance).rejects.toMatchObject({
        code: 'INVALID_EXECUTION_PLAN_REFERENCE',
      })
      await provider.transaction(async (transaction) => {
        expect(await transaction.list('command-inbox')).toEqual([])
        expect(await transaction.list('executions')).toEqual([])
      })
    })
  })

  test('an unreferenced plan past its window is deleted', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      const plan = createExecutionPlanTestFixture()
      await putPlanWithContext(provider, plans, plan)

      const dry = await plans.deleteEligibleExecutionPlans(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: true,
      })
      expect(dry.eligible).toBe(1)
      expect(dry.deleted).toBe(0)

      const applied = await plans.deleteEligibleExecutionPlans(retentionDeadline, {
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

  test('pins from executions, acceptance, validation, and workflow jobs all retain a plan', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      const plan = createExecutionPlanTestFixture()
      await putPlanWithContext(provider, plans, plan)
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
            acceptedAt: fixtureCompiledAt,
            terminalAt: fixtureCompiledAt,
            terminalResultRef: 'art_01ARZ3NDEKTSV4RRFFQ69G5FAV',
            createdAt: fixtureCompiledAt,
            updatedAt: fixtureCompiledAt,
          },
        })
      )
      const withExecution = await plans.deleteEligibleExecutionPlans(retentionDeadline, {
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
            receivedAt: fixtureCompiledAt,
            lastSeenAt: fixtureCompiledAt,
            retentionExpiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      )
      const withAcceptance = await plans.deleteEligibleExecutionPlans(retentionDeadline, {
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
            recordedAt: fixtureCompiledAt,
          },
        })
      )
      const withValidation = await plans.deleteEligibleExecutionPlans(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withValidation.retainedByReason).toEqual({ reference_pending: 1 })

      // With every reference gone the plan is freed.
      await provider.transaction((transaction) =>
        transaction.delete('execution-validation-commands', storedId('validation-fixture'))
      )
      await provider.transaction((transaction) =>
        transaction.put({
          namespace: 'workflow-jobs',
          id: storedId('workflow-plan-fixture'),
          value: {
            workflowKey: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW',
            status: 'queued',
            input: {
              executionId: 'exe_01ARZ3NDEKTSV4RRFFQ69G5FAW',
              workflowId: 'wfl_01ARZ3NDEKTSV4RRFFQ69G5FAW',
              executionPlan: {
                executionPlanId: plan.executionPlanId,
                contentDigest: plan.contentDigest,
                schemaVersion: plan.schemaVersion,
              },
              deadlineAt: fixtureCompiledAt,
            },
            attempt: 0,
            maximumAttempts: 5,
            runAt: fixtureCompiledAt,
            createdAt: fixtureCompiledAt,
            updatedAt: fixtureCompiledAt,
          },
        })
      )
      const withWorkflowJob = await plans.deleteEligibleExecutionPlans(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(withWorkflowJob.retainedByReason).toEqual({ reference_pending: 1 })

      await provider.transaction((transaction) =>
        transaction.delete('workflow-jobs', storedId('workflow-plan-fixture'))
      )
      const freed = await plans.deleteEligibleExecutionPlans(retentionDeadline, {
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
      await putPlanWithContext(provider, plans, plan)

      const inside = new Date(Date.parse(fixtureCompiledAt) + ninetyDaysMs - 1_000)
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
          await plans.deleteEligibleExecutionPlans(retentionDeadline, {
            policyRetainMs: null,
            dryRun: false,
          })
        ).retainedByReason
      ).toEqual({ unbounded_class: 1 })

      const past = await plans.deleteEligibleExecutionPlans(
        new Date(Date.parse(fixtureCompiledAt) + ninetyDaysMs + 1),
        { policyRetainMs: ninetyDaysMs, dryRun: false }
      )
      expect(past.deleted).toBe(1)
    })
  }, 60000)
})
