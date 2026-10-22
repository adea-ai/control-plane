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
import { DelegationService } from '@control-plane/orchestration'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { eq } from 'drizzle-orm'
import { PostgresDelegationRepository } from './delegation-repository.ts'
import { PostgresContextPackageRepository } from './context-package-repository.ts'
import { createPostgresConnection } from './connection.ts'
import { PostgresExecutionPlanRepository } from './execution-plan-repository.ts'
import { PostgresExecutionRepository } from './execution-repository.ts'
import { PostgresToolCallRepository } from './tool-repositories.ts'
import { usageBudgetStates } from './schema/usage-budget-state.ts'
import { createIsolatedTestDatabase } from './testing.ts'
import { PostgresDurableUsageStore } from './usage-store.ts'

const enabled = process.env.RUN_DATABASE_INTEGRATION === 'true'
const acceptedAt = '2026-10-09T12:00:00.000Z'
const workspaceId = 'wsp_01JABCDEF0123456789ABCDEFG'
const parentExecutionId = 'exe_01JABCDEF0123456789ABCDEFG'
const parentAttemptId = 'att_01JABCDEF0123456789ABCDEFG'
const parentContext = contextPackageSerializationFixtures.futurePi
const digest = (character) => `sha256:${character.repeat(64)}`
const parentToolCallId = 'tlc_01JABCDEF0123456789ABCDEFG'
const originalActorPrincipalId = 'usr_01JABCDEF0123456789ABCDEFG'

/**
 * The parent world a governed child is admitted against: one running parent
 * execution and attempt, the parent budget a child reservation is held out of,
 * and the admitted parent tool call. The parent's stated child allowance is
 * what caps what a single child can be funded from.
 */
async function createChildAdmissionWorld(database, limits = {}) {
  const contexts = new PostgresContextPackageRepository(database)
  const plans = new PostgresExecutionPlanRepository(database)
  const parentInput = createExecutionPlanTestFixtureInputs({ contextPackage: parentContext })
  parentInput.correlation.workspaceId = workspaceId
  parentInput.constraints.limits.childExecutions.maximumTotal = limits.maximumTotal ?? 2
  parentInput.constraints.limits.concurrency.maximumParallel = limits.maximumParallel ?? 1
  parentInput.constraints.limits.childExecutions.budgetAllowance = {
    maximumMicrounits: 4_000_000,
    maximumTokens: 100_000,
  }
  const parentPlan = new ExecutionPlanCompiler('1.0.0').compile(parentInput)
  await contexts.put(parentContext)
  await plans.put(parentPlan)
  const executions = new PostgresExecutionRepository(database)
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
  const usageStore = new PostgresDurableUsageStore(database)
  const ledger = new DurableUsageLedger({ store: usageStore, now: () => acceptedAt })
  await ledger.openBudget({
    workspaceId,
    executionId: parentExecutionId,
    currency: 'USD',
    maximumMicrounits: 100_000_000,
    maximumTokens: 100_000,
    source: { sourceId: 'child-admission-parent-budget', idempotencyKey: 'parent-open' },
  })
  const toolCalls = new PostgresToolCallRepository(database, workspaceId)
  const parentToolCall = {
    toolCallId: parentToolCallId,
    requestDigest: digest('a'),
    executionId: parentExecutionId,
    attemptId: parentAttemptId,
    workspaceId,
    profileId: 'prf_01JABCDEF0123456789ABCDEFG',
    principalRef: 'service:runtime-worker',
    toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
    toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
    operation: 'records.write',
    inputDigest: digest('b'),
    policySnapshotRef: 'policy://workspace/v1',
    executor: { type: 'connector', reference: 'records-v1' },
    idempotencyKey: 'child-admission-parent-tool-call-0001',
    status: 'requested',
    revision: 1,
    requestedAt: acceptedAt,
    history: [{ status: 'requested', at: acceptedAt }],
  }
  expect(await toolCalls.insert(parentToolCall)).toBe(true)
  return {
    contexts,
    executions,
    lifecycle,
    parentPlan,
    parentToolCall,
    plans,
    usageStore,
  }
}

/**
 * One governed child, expressed both as the storage allocation request and as
 * the service-level delegation input that produces the same identity.
 */
async function buildChildCandidate(world, suffix, selectionRevision) {
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
  await world.contexts.put(childContext)
  const childPlanInput = {
    correlation: { ...world.parentPlan.correlation, taskId, requestId },
    contextPackage: childContext,
    constraints: world.parentPlan.constraints,
    runtimeRequirements: world.parentPlan.runtimeRequirements,
    outputContract: world.parentPlan.outputContract,
    compiledAt: acceptedAt,
  }
  const childPlan = deriveExecutionPlan(world.parentPlan, childPlanInput)
  await world.plans.put(childPlan)
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
      executionPlanId: world.parentPlan.executionPlanId,
      contentDigest: world.parentPlan.contentDigest,
      schemaVersion: world.parentPlan.schemaVersion,
    },
    admittedToolCallId: parentToolCallId,
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
    profileVersionId: world.parentPlan.profile.profileVersionId,
    originalActorPrincipalId,
    childRequestDigest: digest(suffix.toLowerCase()),
    acceptedAt,
  }
  const delegation = {
    delegationId,
    parentExecutionId,
    parentAttemptId,
    admittedToolCallId: request.admittedToolCallId,
    childExecutionId,
    parentExecutionPlanId: world.parentPlan.executionPlanId,
    parentExecutionPlanDigest: world.parentPlan.contentDigest,
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
    selectionRevision,
    expiresAt: '2999-01-01T00:00:00.000Z',
  }
  return {
    childAttemptId,
    childDispatch,
    childExecutionId,
    childPlan,
    childPlanInput,
    delegation,
    delegationId,
    request,
    receipt,
    allocation: {
      request,
      receipt,
      execution: queuedExecution,
      attempt,
      delegation,
    },
    delegateInput: {
      delegationId,
      parentIntentId: request.parentIntentId,
      parentExecutionId,
      parentAttemptId,
      admittedToolCallId: parentToolCallId,
      childExecutionId,
      childAttemptId,
      initialDispatch: childDispatch,
      role: request.role,
      profileVersionId: request.profileVersionId,
      objective: `Child ${suffix}`,
      parentPlan: world.parentPlan,
      childPlan: childPlanInput,
      policy: delegation.policy,
      acceptedAt,
    },
  }
}

/** The real delegation service over the given owned client. */
function childAdmissionService(database) {
  const delegations = new PostgresDelegationRepository(database)
  return new DelegationService({
    delegations,
    lifecycle: new ExecutionLifecycleService(new PostgresExecutionRepository(database)),
    plans: new PostgresExecutionPlanRepository(database),
    events: { async publish() {} },
    scopeAdmission: {
      authority: { readCurrent: async () => undefined },
      resolveCallerPrincipalId: async () => originalActorPrincipalId,
      now: () => '2026-10-09T12:00:03.000Z',
    },
    childAdmission: {
      async prepare(prepared) {
        return {
          schemaVersion: 'pi-child-admission/v1',
          ...prepared,
          authorityRevision: 1,
          productRevision: 'product:rev-1',
          productReaderPrincipalId: 'svc_product-reader',
          selectionRef: `selection:child-${prepared.role}`,
          selectionRevision: 1,
          expiresAt: '2999-01-01T00:00:00.000Z',
        }
      },
      async assertCurrent() {},
    },
    childAllocator: delegations,
  })
}

/** The same database, reached through a client this test owns. */
function ownedApplicationConnection(credentials, databaseName) {
  const url = new URL(credentials.url)
  url.pathname = `/${databaseName}`
  return createPostgresConnection({ role: 'application', url: url.toString() })
}

/**
 * The parent budget state as the broader CP #1030 operations measurement
 * producer reads it: the reservation array it sums, and the charged amount it
 * reports as spent.
 */
async function readParentReservationState(database) {
  const [row] = await database
    .select({ state: usageBudgetStates.state })
    .from(usageBudgetStates)
    .where(eq(usageBudgetStates.executionId, parentExecutionId))
  return row?.state
}

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
      parentInput.constraints.limits.childExecutions.budgetAllowance = {
        maximumMicrounits: 4_000_000,
        maximumTokens: 100_000,
      }
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

      const toolCalls = new PostgresToolCallRepository(isolated.application, workspaceId)
      const parentToolCall = {
        toolCallId: 'tlc_01JABCDEF0123456789ABCDEFG',
        requestDigest: digest('a'),
        executionId: parentExecutionId,
        attemptId: parentAttemptId,
        workspaceId,
        profileId: 'prf_01JABCDEF0123456789ABCDEFG',
        principalRef: 'service:runtime-worker',
        toolDefinitionId: 'tld_01JABCDEF0123456789ABCDEFG',
        toolVersionId: 'tlv_01JABCDEF0123456789ABCDEFG',
        operation: 'records.write',
        inputDigest: digest('b'),
        policySnapshotRef: 'policy://workspace/v1',
        executor: { type: 'connector', reference: 'records-v1' },
        idempotencyKey: 'child-admission-parent-tool-call-0001',
        status: 'requested',
        revision: 1,
        requestedAt: acceptedAt,
        history: [{ status: 'requested', at: acceptedAt }],
      }
      expect(await toolCalls.insert(parentToolCall)).toBe(true)

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
      let transactionReader
      let observedByReader
      const results = await Promise.allSettled(
        contenders.map((childCandidate) =>
          delegations.allocate({
            ...childCandidate,
            assertCurrent: async (reader) => {
              transactionReader = reader
              observedByReader = {
                execution: await reader.getExecution(parentExecutionId),
                attempt: await reader.getAttempt(parentAttemptId),
                toolCall: await reader.getToolCall(parentToolCall.toolCallId),
              }
            },
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
      // The parent has 100M available and the child plan asks for its whole ceiling, but the
      // parent plan states 4M of 10M (and 100k of 250k tokens, scaled to the 100k parent budget).
      expect(
        await usageStore.transaction(workspaceId, (transaction) =>
          transaction.getBudget(winner.childExecutionId)
        )
      ).toMatchObject({ maximumMicrounits: 4_000_000, maximumTokens: 40_000 })
      expect(observedByReader).toEqual({
        execution: await executions.getExecution(parentExecutionId),
        attempt: await executions.getAttempt(parentAttemptId),
        toolCall: await toolCalls.get(parentToolCall.toolCallId),
      })
      await expect(transactionReader.getExecution(parentExecutionId)).rejects.toThrow(
        'CHILD_ADMISSION_READER_CLOSED'
      )
      await expect(transactionReader.getAttempt(parentAttemptId)).rejects.toThrow(
        'CHILD_ADMISSION_READER_CLOSED'
      )
      await expect(transactionReader.getToolCall(parentToolCall.toolCallId)).rejects.toThrow(
        'CHILD_ADMISSION_READER_CLOSED'
      )
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

  test('a retried original identity allocates once across a client reconnect and keeps the parent reservation', async () => {
    const credentials = {
      administration: loadDatabaseCredentials(process.env, 'administration'),
      application: loadDatabaseCredentials(process.env, 'application'),
      migration: loadDatabaseCredentials(process.env, 'migration'),
    }
    const isolated = await createIsolatedTestDatabase(credentials)
    let owned
    try {
      await isolated.migrate()
      const world = await createChildAdmissionWorld(isolated.application)
      const delegations = new PostgresDelegationRepository(isolated.application)
      const child = await buildChildCandidate(world, 'B', 1)
      const admit = (repository, candidate = child) =>
        repository.allocate({ ...candidate.allocation, assertCurrent: async () => {} })

      // The retry race: the same original identity submitted twice at once. The
      // parent lock serializes them, so exactly one allocates and the other
      // observes the committed identity instead of allocating it again.
      const raced = await Promise.allSettled([admit(delegations), admit(delegations)])
      expect(raced.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
      expect(raced.filter((result) => result.status === 'fulfilled' && result.value)).toHaveLength(
        1
      )
      expect(raced.filter((result) => result.status === 'fulfilled' && !result.value)).toHaveLength(
        1
      )

      // A retry of the original identity after the winner committed is refused.
      expect(await admit(delegations)).toBe(false)

      // Exactly one allocation, delegation, child budget and parent reservation.
      expect(await delegations.listByParent(parentExecutionId)).toHaveLength(1)
      expect(await world.executions.getExecution(child.childExecutionId)).toMatchObject({
        executionId: child.childExecutionId,
        parentExecutionId,
      })
      expect(await world.executions.getAttempt(child.childAttemptId)).toMatchObject({
        attemptId: child.childAttemptId,
      })
      const childBudget = await world.usageStore.transaction(workspaceId, (transaction) =>
        transaction.getBudget(child.childExecutionId)
      )
      expect(childBudget).toMatchObject({ maximumMicrounits: 4_000_000, maximumTokens: 40_000 })
      const parentBudget = await world.usageStore.transaction(workspaceId, (transaction) =>
        transaction.getBudget(parentExecutionId)
      )
      expect(parentBudget?.reservations).toHaveLength(1)
      expect(parentBudget?.maximumMicrounits).toBe(100_000_000)
      expect(parentBudget?.maximumTokens).toBe(100_000)

      // Close and recreate the owned client against the same database, then
      // retry the original identity through the recreated client.
      owned = ownedApplicationConnection(credentials.application, isolated.name)
      expect(await admit(new PostgresDelegationRepository(owned.database))).toBe(false)
      await owned.close()
      owned = ownedApplicationConnection(credentials.application, isolated.name)
      const reconnected = new PostgresDelegationRepository(owned.database)
      expect(await admit(reconnected)).toBe(false)

      // The reconnect changed no ceiling and added no second allocation. The
      // recreated client observes the same committed state: one delegation,
      // one child execution, one child budget and one parent reservation.
      const reconnectedStore = new PostgresDurableUsageStore(owned.database)
      const reconnectedExecutions = new PostgresExecutionRepository(owned.database)
      expect(
        await new PostgresDelegationRepository(owned.database).get(child.delegationId)
      ).toMatchObject({ delegationId: child.delegationId, state: 'requested' })
      expect(await reconnectedExecutions.getExecution(child.childExecutionId)).toMatchObject({
        executionId: child.childExecutionId,
      })
      expect(await delegations.listByParent(parentExecutionId)).toHaveLength(1)
      expect(await world.executions.getExecution(child.childExecutionId)).toMatchObject({
        executionId: child.childExecutionId,
      })
      const childBudgetAfter = await reconnectedStore.transaction(workspaceId, (transaction) =>
        transaction.getBudget(child.childExecutionId)
      )
      expect(childBudgetAfter).toEqual(childBudget)
      const parentBudgetAfter = await reconnectedStore.transaction(workspaceId, (transaction) =>
        transaction.getBudget(parentExecutionId)
      )
      expect(parentBudgetAfter?.maximumMicrounits).toBe(100_000_000)
      expect(parentBudgetAfter?.maximumTokens).toBe(100_000)
      expect(parentBudgetAfter?.reservations).toHaveLength(1)
      const budgetRows = await reconnectedStore.database
        .select({ executionId: usageBudgetStates.executionId })
        .from(usageBudgetStates)
        .where(eq(usageBudgetStates.workspaceId, workspaceId))
      expect(budgetRows.map((row) => row.executionId).toSorted()).toEqual([
        child.childExecutionId,
        parentExecutionId,
      ])

      // The broader CP #1030 operations measurement producer reads this exact
      // reservation array: a non-array is malformed, and every element must
      // carry an integral, non-negative charged amount.
      const parentState = await readParentReservationState(owned.database)
      expect(Array.isArray(parentState?.reservations)).toBe(true)
      expect(parentState?.reservations).toHaveLength(1)
      const [reservation] = parentState?.reservations ?? []
      expect(reservation?.reservationKey).toBe(`child:${child.childExecutionId}`)
      expect(reservation?.childExecutionId).toBe(child.childExecutionId)
      expect(reservation?.status).toBe('open')
      expect(Number.isInteger(reservation?.chargedMicrounits)).toBe(true)
      expect(reservation?.chargedMicrounits).toBeGreaterThanOrEqual(0)
      expect(
        (parentState?.reservations ?? []).reduce((sum, item) => sum + item.chargedMicrounits, 0)
      ).toBe(0)

      // An over-limit sibling is rejected and leaves the ledger unchanged.
      const overLimit = await buildChildCandidate(world, 'C', 2)
      const overLimitOutcome = await admit(delegations, overLimit).then(
        (allocated) => ({ allocated }),
        (error) => ({ error: error.message })
      )
      expect(overLimitOutcome).toEqual({ error: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED' })
      expect(await world.executions.getExecution(overLimit.childExecutionId)).toBeUndefined()
      expect(await world.executions.getAttempt(overLimit.childAttemptId)).toBeUndefined()
      expect(await delegations.get(overLimit.delegationId)).toBeUndefined()
      await expect(
        world.usageStore.transaction(workspaceId, (transaction) =>
          transaction.getBudget(overLimit.childExecutionId)
        )
      ).resolves.toBeUndefined()
      const parentBudgetUnchanged = await world.usageStore.transaction(workspaceId, (transaction) =>
        transaction.getBudget(parentExecutionId)
      )
      expect(parentBudgetUnchanged?.reservations).toHaveLength(1)
      expect(parentBudgetUnchanged?.maximumMicrounits).toBe(100_000_000)
      expect(parentBudgetUnchanged?.maximumTokens).toBe(100_000)
      expect(await delegations.listByParent(parentExecutionId)).toHaveLength(1)
    } finally {
      await owned?.close()
      await isolated.dispose()
    }
  }, 60_000)

  for (const ordering of [
    ['X', 'Y'],
    ['Y', 'X'],
  ]) {
    test(`the delegation service replays a retried child and a sibling race ordered ${ordering.join(' then ')} leaves the ledger unchanged`, async () => {
      const credentials = {
        administration: loadDatabaseCredentials(process.env, 'administration'),
        application: loadDatabaseCredentials(process.env, 'application'),
        migration: loadDatabaseCredentials(process.env, 'migration'),
      }
      const isolated = await createIsolatedTestDatabase(credentials)
      try {
        await isolated.migrate()
        const world = await createChildAdmissionWorld(isolated.application)
        const service = childAdmissionService(isolated.application)
        const delegations = new PostgresDelegationRepository(isolated.application)
        const candidates = []
        for (const [index, suffix] of ordering.entries()) {
          candidates.push(await buildChildCandidate(world, suffix, index + 1))
        }

        // The sibling race: two different children of one parent at once. The
        // parent lock serializes them and the parallel limit admits exactly one.
        const raced = await Promise.allSettled(
          candidates.map((candidate) => service.delegate(candidate.delegateInput))
        )
        expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1)
        expect(raced.find((result) => result.status === 'rejected')?.reason).toMatchObject({
          code: 'DELEGATION_CONCURRENCY_LIMIT_EXCEEDED',
        })
        const winnerIndex = raced.findIndex((result) => result.status === 'fulfilled')
        const winner = candidates[winnerIndex]
        const loser = candidates[1 - winnerIndex]

        // The rejected sibling left nothing behind.
        expect(await delegations.listByParent(parentExecutionId)).toHaveLength(1)
        expect(await world.executions.getExecution(loser.childExecutionId)).toBeUndefined()
        expect(await world.executions.getAttempt(loser.childAttemptId)).toBeUndefined()
        expect(await delegations.get(loser.delegationId)).toBeUndefined()
        await expect(
          world.usageStore.transaction(workspaceId, (transaction) =>
            transaction.getBudget(loser.childExecutionId)
          )
        ).resolves.toBeUndefined()
        const parentBudget = await world.usageStore.transaction(workspaceId, (transaction) =>
          transaction.getBudget(parentExecutionId)
        )
        expect(parentBudget?.reservations).toHaveLength(1)
        expect(parentBudget?.maximumMicrounits).toBe(100_000_000)
        expect(parentBudget?.maximumTokens).toBe(100_000)

        // The real delegation service retry of the admitted child replays it:
        // no second allocation, delegation, child budget or parent reservation.
        const replay = await service.delegate(winner.delegateInput)
        expect(replay.record.delegationId).toBe(winner.delegationId)
        expect(replay.record.revision).toBe(1)
        expect(replay.execution.executionId).toBe(winner.childExecutionId)
        expect(await delegations.listByParent(parentExecutionId)).toHaveLength(1)
        expect(await world.executions.getExecution(winner.childExecutionId)).toMatchObject({
          executionId: winner.childExecutionId,
        })
        const childBudget = await world.usageStore.transaction(workspaceId, (transaction) =>
          transaction.getBudget(winner.childExecutionId)
        )
        expect(childBudget).toMatchObject({ maximumMicrounits: 4_000_000, maximumTokens: 40_000 })
        const parentBudgetAfter = await world.usageStore.transaction(workspaceId, (transaction) =>
          transaction.getBudget(parentExecutionId)
        )
        expect(parentBudgetAfter?.reservations).toHaveLength(1)
        expect(parentBudgetAfter?.maximumMicrounits).toBe(100_000_000)
        expect(parentBudgetAfter?.maximumTokens).toBe(100_000)
        expect(parentBudgetAfter?.reservations).toEqual(parentBudget?.reservations)
      } finally {
        await isolated.dispose()
      }
    }, 60_000)
  }
})
