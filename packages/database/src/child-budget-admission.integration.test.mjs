import { describe, expect, test } from 'bun:test'
import process from 'node:process'
import { contextPackageSerializationFixtures, deriveContextPackage } from '@control-plane/context'
import { loadDatabaseCredentials } from '@control-plane/config'
import {
  ExecutionAttemptSchema,
  ExecutionLifecycleService,
  ExecutionSchema,
  previewLifecycleTransition,
} from '@control-plane/domain'
import { deriveExecutionPlan, ExecutionPlanCompiler } from '@control-plane/execution-plan'
import { createExecutionPlanTestFixtureInputs } from '@control-plane/execution-plan/testing'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { PostgresDelegationRepository } from './delegation-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresDurableUsageStore } from './usage-store.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const acceptedAt = '2026-10-09T12:00:00.000Z'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const parentExecutionId = 'exe_01JABCDEF0123456789ABCDEFG'
const parentAttemptId = 'att_01JABCDEF0123456789ABCDEFG'
const parentContext = contextPackageSerializationFixtures.futurePi
const digest = (character) => `sha256:${character.repeat(64)}`

describe.skipIf(!enabled)('PostgreSQL child budget admission', () => {
  test('denials leave no allocation and concurrent requests serialize the parallel limit', async () => {
    const credentials = {
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    }
    const isolated = await createIsolatedTestDatabase(credentials)
    try {
      await isolated.migrate()
      const plans = new PostgresExecutionPlanRepository(isolated.application)
      const contexts = new PostgresContextPackageRepository(isolated.application)
      const parentInput = createExecutionPlanTestFixtureInputs({ contextPackage: parentContext })
      parentInput.correlation.workspaceId = workspaceId
      parentInput.constraints.limits.childExecutions.maximumTotal = 2
      parentInput.constraints.limits.concurrency.maximumParallel = 1
      const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(parentInput)
      await contexts.put(parentContext)
      await plans.put(parentPlan)

      const executions = new PostgresExecutionRepository(isolated.application)
      const lifecycle = new ExecutionLifecycleService(executions)
      await lifecycle.createExecution({
        executionId: parentExecutionId,
        correlation: parentPlan.correlation,
        executionPlan: {
          executionPlanId: parentPlan.executionPlanId,
          contentDigest: parentPlan.contentDigest,
          schemaVersion: parentPlan.schemaVersion,
        },
        acceptedAt,
      })
      await lifecycle.createAttempt({
        executionId: parentExecutionId,
        attemptId: parentAttemptId,
        expectedExecutionVersion: 1,
        queuedAt: acceptedAt,
      })
      await lifecycle.transitionExecution({
        executionId: parentExecutionId,
        expectedVersion: 2,
        to: 'queued',
        transitionedAt: '2026-10-09T12:00:01.000Z',
      })
      await lifecycle.transitionExecution({
        executionId: parentExecutionId,
        expectedVersion: 3,
        to: 'running',
        transitionedAt: '2026-10-09T12:00:02.000Z',
      })
      await lifecycle.transitionAttempt({
        attemptId: parentAttemptId,
        expectedVersion: 1,
        to: 'running',
        transitionedAt: '2026-10-09T12:00:02.000Z',
      })
      const usageStore = new PostgresDurableUsageStore(isolated.application)
      const ledger = new DurableUsageLedger({ store: usageStore, now: () => acceptedAt })
      await ledger.openBudget({
        workspaceId,
        executionId: parentExecutionId,
        currency: 'USD',
        maximumMicrounits: 100_000_000,
        maximumTokens: 100_000,
        source: { sourceId: 'child-admission-parent-budget', idempotencyKey: 'parent-open' },
      })

      const delegations = new PostgresDelegationRepository(isolated.application)
      let ordinal = 0
      async function candidate() {
        ordinal += 1
        const suffix = ['B', 'C', 'D'][ordinal - 1]
        const childExecutionId = `exe_01JABCDEF0123456789ABCDE${suffix}1`
        const childAttemptId = `att_01JABCDEF0123456789ABCDE${suffix}1`
        const delegationId = `dlg_01JABCDEF0123456789ABCDE${suffix}1`
        const taskId = `tsk_01JABCDEF0123456789ABCDE${suffix}1`
        const requestId = `req_01JABCDEF0123456789ABCDE${suffix}1`
        const childContext = deriveContextPackage(parentContext, {
          objective: `Child ${suffix}`,
          allowedStateItemIds: [],
          allowedArtifactIds: [],
          budgets: {
            maximumBytes: Math.min(512, parentContext.budgets.maximumBytes),
            maximumTokens: Math.min(128, parentContext.budgets.maximumTokens),
          },
          successCriteria: ['Return bounded child evidence'],
          returnContract: { contractRef: 'contract://adapter-result/v1' },
          compiledAt: acceptedAt,
        })
        await contexts.put(childContext)
        const childPlan = deriveExecutionPlan(parentPlan, {
          correlation: { ...parentPlan.correlation, taskId, requestId },
          contextPackage: childContext,
          constraints: parentPlan.constraints,
          runtimeRequirements: parentPlan.runtimeRequirements,
          outputContract: parentPlan.outputContract,
          compiledAt: acceptedAt,
        })
        await plans.put(childPlan)
        const execution = ExecutionSchema.parse({
          executionId: childExecutionId,
          correlation: childPlan.correlation,
          executionPlan: {
            executionPlanId: childPlan.executionPlanId,
            contentDigest: childPlan.contentDigest,
            schemaVersion: childPlan.schemaVersion,
          },
          parentExecutionId,
          state: 'accepted',
          version: 1,
          attemptCount: 0,
          acceptedAt,
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        })
        const attempt = ExecutionAttemptSchema.parse({
          attemptId: childAttemptId,
          executionId: childExecutionId,
          sequence: 1,
          state: 'queued',
          version: 1,
          acceptedAt,
          queuedAt: acceptedAt,
          runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        })
        const queuedExecution = ExecutionSchema.parse({
          ...previewLifecycleTransition(execution, { to: 'queued', transitionedAt: acceptedAt }),
          attemptCount: 1,
          latestAttemptId: childAttemptId,
        })
        const childDispatch = {
          delegationId,
          childAttemptId,
          runtime: { runtimeConnectionId: 'rtc_01JABCDEF0123456789ABCDEFG' },
          dispatchedAt: acceptedAt,
        }
        const request = {
          workspaceId,
          parentIntentId: 'intent:integration-parent',
          parentExecutionId,
          parentAttemptId,
          parentExecutionVersion: 4,
          parentPlan: {
            executionPlanId: parentPlan.executionPlanId,
            contentDigest: parentPlan.contentDigest,
            schemaVersion: parentPlan.schemaVersion,
          },
          admittedToolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
          delegationId,
          childRequestId: requestId,
          childExecutionId,
          childAttemptId,
          childDispatch,
          childPlan: {
            executionPlanId: childPlan.executionPlanId,
            contentDigest: childPlan.contentDigest,
            schemaVersion: childPlan.schemaVersion,
          },
          role: 'researcher',
          profileVersionId: parentPlan.profile.profileVersionId,
          originalActorPrincipalId: 'usr_01JABCDEF0123456789ABCDEFG',
          childRequestDigest: digest(suffix.toLowerCase()),
          acceptedAt,
        }
        const delegation = {
          delegationId,
          parentExecutionId,
          parentAttemptId,
          admittedToolCallId: request.admittedToolCallId,
          childExecutionId,
          parentExecutionPlanId: parentPlan.executionPlanId,
          parentExecutionPlanDigest: parentPlan.contentDigest,
          childExecutionPlanId: childPlan.executionPlanId,
          childExecutionPlanDigest: childPlan.contentDigest,
          contextPackageId: childContext.contextPackageId,
          contextPackageDigest: childContext.contentDigest,
          role: request.role,
          profileVersionId: request.profileVersionId,
          objective: `Child ${suffix}`,
          policy: {
            cancellation: 'cascade',
            deadline: 'bounded_by_parent',
            failure: 'manual',
            maximumRetries: 0,
          },
          state: 'requested',
          pendingDispatch: childDispatch,
          retryCount: 0,
          inputDigest: request.childRequestDigest,
          revision: 1,
          acceptedAt,
          updatedAt: acceptedAt,
        }
        const receipt = {
          schemaVersion: 'pi-child-admission/v1',
          ...request,
          authorityRevision: 1,
          productRevision: 'product:rev-1',
          productReaderPrincipalId: 'svc_product-reader',
          selectionRef: `selection:child-${suffix}`,
          selectionRevision: ordinal,
          expiresAt: '2999-01-01T00:00:00.000Z',
        }
        return {
          childExecutionId,
          childAttemptId,
          delegationId,
          request,
          receipt,
          execution: queuedExecution,
          attempt,
          delegation,
        }
      }

      const denied = await candidate()
      await expect(
        delegations.allocate({
          ...denied,
          assertCurrent: async () => {
            throw new Error('child audience revoked')
          },
        })
      ).rejects.toThrow('child audience revoked')
      expect(await executions.getExecution(denied.childExecutionId)).toBeUndefined()
      expect(await executions.getAttempt(denied.childAttemptId)).toBeUndefined()
      expect(await delegations.get(denied.delegationId)).toBeUndefined()
      await expect(
        usageStore.transaction(workspaceId, (transaction) =>
          transaction.getBudget(denied.childExecutionId)
        )
      ).resolves.toBeUndefined()
      expect(
        (
          await usageStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(parentExecutionId)
          )
        )?.reservations
      ).toEqual([])

      const contenders = [await candidate(), await candidate()]
      const results = await Promise.allSettled(
        contenders.map((childCandidate) =>
          delegations.allocate({
            ...childCandidate,
            assertCurrent: async () => undefined,
          })
        )
      )
      expect(
        results.filter((result) => result.status === 'fulfilled' && result.value)
      ).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
        code: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED',
      })
      expect(await delegations.listByParent(parentExecutionId)).toHaveLength(1)
      const winnerIndex = results.findIndex((result) => result.status === 'fulfilled')
      const loser = contenders[1 - winnerIndex]
      expect(await executions.getExecution(loser.childExecutionId)).toBeUndefined()
      expect(await executions.getAttempt(loser.childAttemptId)).toBeUndefined()
      expect(await delegations.get(loser.delegationId)).toBeUndefined()
      await expect(
        usageStore.transaction(workspaceId, (transaction) =>
          transaction.getBudget(loser.childExecutionId)
        )
      ).resolves.toBeUndefined()
      expect(
        (
          await usageStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(parentExecutionId)
          )
        )?.reservations
      ).toHaveLength(1)

      const winner = contenders[winnerIndex]
      const retainedWinner = await delegations.get(winner.delegationId)
      expect(retainedWinner).toMatchObject({
        state: 'requested',
        pendingDispatch: winner.request.childDispatch,
      })
      expect(
        await delegations.compareAndSet(retainedWinner.revision, {
          ...retainedWinner,
          childAttemptId: winner.childAttemptId,
          pendingDispatch: undefined,
          runtimeConnectionId: winner.request.childDispatch.runtime.runtimeConnectionId,
          state: 'dispatched',
          revision: retainedWinner.revision + 1,
          updatedAt: winner.request.childDispatch.dispatchedAt,
        })
      ).toBe(true)
      expect(await delegations.get(winner.delegationId)).toMatchObject({
        childAttemptId: winner.childAttemptId,
        state: 'dispatched',
      })
    } finally {
      await isolated.dispose()
    }
  }, 60_000)
})
