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
  REFERENCE_RETENTION_NAMESPACES,
  SqliteContextPackageRepository,
  SqliteCommandAcceptanceRepository,
  SqliteExecutionPlanRepository,
  SqlitePersistenceProvider,
} from './index.js'

const ninetyDaysMs = 90 * 24 * 60 * 60 * 1_000
// The compiler stamps `compiledAt`, so the clock is derived from the fixture it
// produces rather than the fixture from the clock.
const fixtureCompiledAt = createExecutionPlanTestFixture().compiledAt
const referenceObservedAt = new Date(Date.parse(fixtureCompiledAt) + ninetyDaysMs + 60_000)
const retentionDeadline = new Date(referenceObservedAt.getTime() + ninetyDaysMs)
const afterRetentionDeadline = new Date(retentionDeadline.getTime() + 1)
const cursorScanAt = new Date('2026-08-27T00:00:00.000Z')

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

      await plans.deleteEligibleExecutionPlans(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      const now = afterRetentionDeadline
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
      expect(second.deleted).toBe(0)
      expect(second.retainedByReason).toEqual({ not_expired: 1 })
      const final = await plans.deleteEligibleExecutionPlans(
        new Date(now.getTime() + ninetyDaysMs + 1),
        { policyRetainMs: ninetyDaysMs, dryRun: false }
      )
      expect(final.deleted).toBe(1)
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
      await plans.deleteEligibleExecutionPlans(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      const now = afterRetentionDeadline
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

  test('a plan receives a full window from the first unreferenced observation', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      const plan = createExecutionPlanTestFixture()
      await putPlanWithContext(provider, plans, plan)

      const dry = await plans.deleteEligibleExecutionPlans(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: true,
      })
      expect(dry.eligible).toBe(0)
      expect(dry.retainedByReason).toEqual({ not_expired: 1 })
      expect(dry.deleted).toBe(0)

      const applied = await plans.deleteEligibleExecutionPlans(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(applied.deleted).toBe(0)
      const expired = await plans.deleteEligibleExecutionPlans(afterRetentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(expired.deleted).toBe(1)
      const metadataNamespace = REFERENCE_RETENTION_NAMESPACES.executionPlans
      const targetId = storedId(plan.executionPlanId)
      expect(
        await provider.transaction((transaction) => transaction.get(metadataNamespace, targetId))
      ).toBeUndefined()
      expect(
        await plans.get({
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
        })
      ).toBeUndefined()
      await plans.put(plan)
      expect(
        await provider.transaction((transaction) => transaction.get(metadataNamespace, targetId))
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
      expect(freed.deleted).toBe(0)
      expect(freed.retainedByReason).toEqual({ not_expired: 1 })
      const expired = await plans.deleteEligibleExecutionPlans(
        new Date(retentionDeadline.getTime() + ninetyDaysMs + 1),
        { policyRetainMs: ninetyDaysMs, dryRun: false }
      )
      expect(expired.deleted).toBe(1)
      expect(
        await plans.get({
          executionPlanId: plan.executionPlanId,
          contentDigest: plan.contentDigest,
        })
      ).toBeUndefined()
    })
  }, 60000)

  test('the reference window respects boundaries and unbounded policy retains plans', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      const plan = createExecutionPlanTestFixture()
      await putPlanWithContext(provider, plans, plan)

      expect(
        (
          await plans.deleteEligibleExecutionPlans(referenceObservedAt, {
            policyRetainMs: null,
            dryRun: false,
          })
        ).retainedByReason
      ).toEqual({ unbounded_class: 1 })

      const observed = await plans.deleteEligibleExecutionPlans(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(observed.retainedByReason).toEqual({ not_expired: 1 })
      const inside = new Date(retentionDeadline.getTime() - 1)
      expect(
        (
          await plans.deleteEligibleExecutionPlans(inside, {
            policyRetainMs: ninetyDaysMs,
            dryRun: false,
          })
        ).retainedByReason
      ).toEqual({ not_expired: 1 })

      const atBoundary = await plans.deleteEligibleExecutionPlans(retentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(atBoundary.deleted).toBe(0)
      expect(atBoundary.retainedByReason).toEqual({ not_expired: 1 })

      const past = await plans.deleteEligibleExecutionPlans(afterRetentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(past.deleted).toBe(1)
    })
  }, 60000)

  test('new descendant plans clear both windows and a short reference restarts the clock', async () => {
    await withProvider(async (provider) => {
      const contextPackage = contextPackageSerializationFixtures.futurePi
      const packages = new SqliteContextPackageRepository(provider)
      const plans = new SqliteExecutionPlanRepository(provider)
      await packages.put(contextPackage)
      await packages.deleteEligibleContextPackages(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      const contextId = storedId(contextPackage.contextPackageId)
      const contextWindowNamespace = REFERENCE_RETENTION_NAMESPACES.contextPackages
      expect(
        await provider.transaction((transaction) =>
          transaction.get(contextWindowNamespace, contextId)
        )
      ).toBeDefined()

      const parent = planAt('2026-08-01T00:00:00.000Z')
      await plans.put(parent)
      expect(
        await provider.transaction((transaction) =>
          transaction.get(contextWindowNamespace, contextId)
        )
      ).toBeUndefined()

      await plans.deleteEligibleExecutionPlans(referenceObservedAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      const planId = storedId(parent.executionPlanId)
      const planWindowNamespace = REFERENCE_RETENTION_NAMESPACES.executionPlans
      expect(
        await provider.transaction((transaction) => transaction.get(planWindowNamespace, planId))
      ).toBeDefined()

      const child = childPlanAt(parent, '2026-08-02T00:00:00.000Z')
      await plans.put(child)
      expect(
        await provider.transaction((transaction) => transaction.get(planWindowNamespace, planId))
      ).toBeUndefined()
      expect(
        await provider.transaction((transaction) =>
          transaction.get(contextWindowNamespace, contextId)
        )
      ).toBeUndefined()

      await provider.transaction(async (transaction) => {
        const childId = storedId(child.executionPlanId)
        const childRow = await transaction.get('execution-plans', childId)
        expect(childRow).toBeDefined()
        await transaction.delete('execution-plans', childId, childRow.revision)
      })
      const planReobserved = await plans.deleteEligibleExecutionPlans(afterRetentionDeadline, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
      })
      expect(planReobserved.deleted).toBe(0)
      expect(planReobserved.retainedByReason).toEqual({ not_expired: 1 })
      await provider.transaction(async (transaction) => {
        const parentId = storedId(parent.executionPlanId)
        const parentRow = await transaction.get('execution-plans', parentId)
        expect(parentRow).toBeDefined()
        await transaction.delete('execution-plans', parentId, parentRow.revision)
      })
      const contextReobserved = await packages.deleteEligibleContextPackages(
        afterRetentionDeadline,
        { policyRetainMs: ninetyDaysMs, dryRun: false }
      )
      expect(contextReobserved.deleted).toBe(0)
      expect(contextReobserved.retainedByReason).toEqual({ not_expired: 1 })
    })
  })

  test('plan continuation visits young targets in key order and dry-run or bound zero writes no clocks', async () => {
    await withProvider(async (provider) => {
      const plans = new SqliteExecutionPlanRepository(provider)
      await putPlanWithContext(provider, plans, planAt('2026-08-24T00:00:00.000Z'))
      await putPlanWithContext(provider, plans, planAt('2026-08-25T00:00:00.000Z'))
      await putPlanWithContext(provider, plans, planAt('2026-08-26T00:00:00.000Z'))
      const ids = await provider.transaction(async (transaction) =>
        (await transaction.scan('execution-plans', { limit: 128 })).map((record) => record.id)
      )

      const zero = await plans.deleteEligibleExecutionPlans(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        bound: 0,
      })
      expect(zero.scanned).toBe(0)
      expect(zero.truncated).toBe(true)
      expect(
        await provider.transaction((transaction) =>
          transaction.list(REFERENCE_RETENTION_NAMESPACES.executionPlans)
        )
      ).toEqual([])

      const dry = await plans.deleteEligibleExecutionPlans(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: true,
        bound: 1,
      })
      expect(dry.nextAfterId).toBe(ids[0])
      expect(dry.scanned).toBe(1)
      expect(dry.truncated).toBe(true)
      expect(
        await provider.transaction((transaction) =>
          transaction.list(REFERENCE_RETENTION_NAMESPACES.executionPlans)
        )
      ).toEqual([])

      const first = await plans.deleteEligibleExecutionPlans(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        bound: 1,
      })
      expect(first.nextAfterId).toBe(ids[0])
      const second = await plans.deleteEligibleExecutionPlans(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        bound: 1,
        afterId: first.nextAfterId,
      })
      expect(second.nextAfterId).toBe(ids[1])
      const final = await plans.deleteEligibleExecutionPlans(cursorScanAt, {
        policyRetainMs: ninetyDaysMs,
        dryRun: false,
        bound: 1,
        afterId: second.nextAfterId,
      })
      expect(final.scanned).toBe(1)
      expect(final.truncated).toBe(false)
      expect(final.nextAfterId).toBeUndefined()
    })
  })
})
